/** 证据门：provenance 校验与 findings.record 入账门控。引用洗白防线。 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { guardPathEscape } from './guards.js';

const CONFIDENCE = new Set(['observed', 'inferred', 'unknown']);
const MAX_PROVENANCE_FILE_BYTES = 20 * 1024 * 1024;

const REPORT_REF_RE = /^report:[^\s|]+\s*\|\s*(.+)$/i;
const URL_RE = /^(?:url:)?(https?:\/\/|doi:|arxiv:)/i;
const FILE_LINE_RE = /^(?:file:)?((?:[A-Za-z]:)?[^:*?"<>|\r\n]+):(\d+)(?:-(\d+))?$/i;
const TOOL_REF_RE = /^tool:[A-Za-z0-9_\-]+(?:\s+\S.*)?$/; // v0.3 修：裸 tool:<名> 合法（原 \b.*\S 误拒无尾随描述的引用）

/** provenance 合法形态：http(s)/doi/arxiv 链接、文件路径:行号、tool:<工具名> 或带合法内层出处的 report:<source> | ... 引用。 */
export function validateProvenance(p, depth = 0) {
  if (typeof p !== 'string' || p.trim().length === 0) {
    return { code: 'EVIDENCE_NO_PROVENANCE', reason: 'EVIDENCE_NO_PROVENANCE: 条目缺 provenance。没有出处的断言不入账。' };
  }
  const s = p.trim();
  const rm = REPORT_REF_RE.exec(s);
  if (rm) {
    if (depth >= 2) {
      return { code: 'EVIDENCE_BAD_PROVENANCE', reason: 'EVIDENCE_BAD_PROVENANCE: 嵌套 report provenance 层数超限。' };
    }
    const inner = rm[1].trim();
    if (!inner || inner === '(report 未标 provenance)') {
      return {
        code: 'EVIDENCE_BAD_PROVENANCE',
        reason: 'EVIDENCE_BAD_PROVENANCE: report 引用的内部 provenance 缺失或无效：' + s.slice(0, 80),
      };
    }
    return validateProvenance(inner, depth + 1);
  }
  if (URL_RE.test(s) || FILE_LINE_RE.test(s) || TOOL_REF_RE.test(s)) return null;
  return {
    code: 'EVIDENCE_BAD_PROVENANCE',
    reason: 'EVIDENCE_BAD_PROVENANCE: provenance 必须是 http(s)/doi:/arxiv: 链接、文件路径:行号（如 src/app.py:42）或 tool:<工具名> 引用；收到的是：' + s.slice(0, 80),
  };
}

/** 校验 file:line provenance 指向的真实文件是否存在、不越界且大小/行号合法；非文件引用返回 skipped。 */
export function verifyFileProvenance(provenance, baseDir = '.', opts = {}) {
  if (typeof provenance !== 'string') return { ok: true, skipped: true };
  let s = provenance.trim();
  for (let d = 0; d < 2; d++) {
    const rm = REPORT_REF_RE.exec(s);
    if (!rm) break;
    s = rm[1].trim();
  }
  if (!s || URL_RE.test(s) || TOOL_REF_RE.test(s)) return { ok: true, skipped: true };
  const m = FILE_LINE_RE.exec(s);
  if (!m) return { ok: true, skipped: true };
  const filePart = m[1];
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  const restrict = opts.restrictToBaseDir !== false;
  if (restrict && baseDir) {
    const esc = guardPathEscape({ root: baseDir, target: filePart, mode: 'read' });
    if (esc) {
      return { ok: false, code: 'EVIDENCE_FILE_OUTSIDE_WORKSPACE', reason: esc.reason, path: resolve(baseDir, filePart) };
    }
  }
  const abs = resolve(baseDir || '.', filePart);
  if (!existsSync(abs)) {
    return { ok: false, code: 'EVIDENCE_FILE_MISSING', reason: '引用文件不存在: ' + filePart, path: abs };
  }
  let st;
  try { st = statSync(abs); } catch { st = null; }
  if (!st || !st.isFile()) {
    return { ok: false, code: 'EVIDENCE_FILE_MISSING', reason: '引用路径不是普通文件: ' + filePart, path: abs };
  }
  if (st.size > MAX_PROVENANCE_FILE_BYTES) {
    return {
      ok: false,
      code: 'EVIDENCE_FILE_TOO_LARGE',
      reason: '引用文件超过 20MB 行号校验上限: ' + filePart + ' (' + st.size + 'B)',
      path: abs,
    };
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { ok: false, code: 'EVIDENCE_BAD_LINES', reason: '行号范围非法: ' + start + '-' + end, path: abs };
  }
  const raw = readFileSync(abs, 'utf8');
  const normalized = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const totalLines = raw.length === 0 ? 0 : normalized.split('\n').length;
  if (end > totalLines) {
    return {
      ok: false,
      code: 'EVIDENCE_LINE_OUT_OF_RANGE',
      reason: '引用行号越界: ' + end + ' > ' + totalLines + ' (' + filePart + ')',
      path: abs,
      totalLines,
    };
  }
  return { ok: true, path: abs, start, end, totalLines };
}

/** 单条发现门控。返回 null 放行 / {code, reason} 拒绝。 */
export function gateEntry(e) {
  if (!e || typeof e !== 'object') return { code: 'EVIDENCE_BAD_ENTRY', reason: 'EVIDENCE_BAD_ENTRY: 条目必须是对象。' };
  if (typeof e.claim !== 'string' || e.claim.trim().length < 2) {
    return { code: 'EVIDENCE_NO_CLAIM', reason: 'EVIDENCE_NO_CLAIM: 条目缺 claim（一句可判定的发现陈述）。' };
  }
  if (!CONFIDENCE.has(e.confidence)) {
    return { code: 'EVIDENCE_BAD_CONFIDENCE', reason: 'EVIDENCE_BAD_CONFIDENCE: confidence 必须是 observed|inferred|unknown 之一。' };
  }
  return validateProvenance(e.provenance);
}

/** 工具调用级门控（findings.record）。返回 null 放行。 */
export function gateExec(toolName, args) {
  if (String(toolName) !== 'findings.record') return null;
  const entries = args?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null; // schema 校验负责报缺参
  for (let i = 0; i < entries.length; i++) {
    const d = gateEntry(entries[i]);
    if (d) return { ...d, reason: d.reason + ' [entries[' + i + ']]' };
  }
  return null;
}

/** subagent/end 审计监听器：每次子代理收尾落一条运行轨迹（context，不占 findings 名额）。 */
export function makeSubagentReportListener(ledger, onError) {
  return (payload) => {
    try {
      const info = payload ?? {};
      const runId = info.runId ?? info.id ?? info.sessionId ?? 'unknown-run';
      const text = Array.isArray(info.lastAssistantMessage) ? JSON.stringify(info.lastAssistantMessage).length : 0;
      ledger.append({
        kind: 'subagent-report',
        runId: String(runId),
        stopReason: info.stopReason ?? null,
        reportChars: text,
        provenance: 'subagent:' + String(runId),
      });
    } catch (e) {
      if (onError) onError(e);
    }
  };
}
