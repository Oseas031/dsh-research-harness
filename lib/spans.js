/** 回合可观测性 Span 记录器：记录工具调用耗时、成功/失败与脱敏参数摘要。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api_key|credential|private_key|auth)/i;
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const SUMMARY_MAX_CHARS = 160;

function redactValue(val, depth = 0) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(val)) return val.slice(0, 8).map(item => redactValue(item, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(val);
}

/** 将工具入参转为脱敏且不超过 160 字符的摘要字符串。 */
export function summarizeInput(args) {
  if (args === undefined || args === null) return '';
  let text;
  if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(redactValue(args));
    } catch {
      text = String(args);
    }
  }
  if (!text) return '';
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS - 3) + '...' : text;
}

function extractError(result) {
  if (!result) return null;
  if (result.error) {
    if (typeof result.error === 'string') return result.error.slice(0, 200);
    if (typeof result.error?.message === 'string') return result.error.message.slice(0, 200);
  }
  if (Array.isArray(result.content)) {
    const text = result.content.map(c => (typeof c?.text === 'string' ? c.text : '')).join(' ').trim();
    if (text) return text.slice(0, 200);
  }
  return result.isError ? 'TOOL_ERROR' : null;
}

/** 跟踪进行中的工具调用并在结束时落盘到 spans.jsonl。 */
export class SpanRecorder {
  constructor(opts = {}) {
    this.byCallId = new Map();
    this.byExec = new WeakMap();
    this.staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : DEFAULT_STALE_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  _sweep(nowMs) {
    for (const [id, rec] of this.byCallId.entries()) {
      if (nowMs - rec.startedAt > this.staleMs) this.byCallId.delete(id);
    }
  }

  start(exec) {
    const nowMs = this.now();
    this._sweep(nowMs);
    const tool = String(exec?.name ?? exec?.tool ?? 'unknown');
    const callId = exec?.callId ? String(exec.callId) : null;
    const inputSummary = summarizeInput(exec?.arguments ?? exec?.args ?? null);
    const rec = { startedAt: nowMs, tool, callId, inputSummary };
    if (exec && typeof exec === 'object') this.byExec.set(exec, rec);
    if (callId) this.byCallId.set(callId, rec);
    return rec;
  }

  end(exec, result, ledgerDir) {
    const nowMs = this.now();
    const callId = exec?.callId ? String(exec.callId) : null;
    let rec = (exec && typeof exec === 'object' ? this.byExec.get(exec) : null) ?? (callId ? this.byCallId.get(callId) : null) ?? null;
    if (exec && typeof exec === 'object') this.byExec.delete(exec);
    if (callId) this.byCallId.delete(callId);

    const tool = String(exec?.name ?? exec?.tool ?? rec?.tool ?? 'unknown');
    const durationMs = rec ? Math.max(0, Math.round(nowMs - rec.startedAt)) : 0;
    const inputSummary = rec ? rec.inputSummary : summarizeInput(exec?.arguments ?? exec?.args ?? null);
    const ok = !(result?.isError || result?.error);
    const error = ok ? null : extractError(result);
    const span = {
      ts: new Date(nowMs).toISOString(),
      tool,
      callId: callId ?? rec?.callId ?? null,
      durationMs,
      ok,
      inputSummary,
      error,
    };
    if (ledgerDir) {
      mkdirSync(ledgerDir, { recursive: true });
      appendFileSync(join(ledgerDir, 'spans.jsonl'), JSON.stringify(span) + '\n', 'utf8');
    }
    return span;
  }
}

/** 读取 spans.jsonl 中的全部 span 记录。 */
export function readSpans(spansFile) {
  if (!spansFile || !existsSync(spansFile)) return [];
  const raw = readFileSync(spansFile, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // 忽略损坏行以保证监控查询可用
    }
  }
  return out;
}

/** 统计 span 总览、工具耗时排行与最近调用列表。 */
export function summarizeSpans(spans, { limit = 20 } = {}) {
  const list = Array.isArray(spans) ? spans : [];
  const byTool = new Map();
  let errorCount = 0;
  let totalDurationMs = 0;
  for (const s of list) {
    const tool = String(s?.tool ?? 'unknown');
    const dur = Number.isFinite(Number(s?.durationMs)) ? Number(s.durationMs) : 0;
    totalDurationMs += dur;
    if (s?.ok === false) errorCount += 1;
    let bucket = byTool.get(tool);
    if (!bucket) {
      bucket = { tool, calls: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, avgDurationMs: 0 };
      byTool.set(tool, bucket);
    }
    bucket.calls += 1;
    if (s?.ok === false) bucket.errors += 1;
    bucket.totalDurationMs += dur;
    if (dur > bucket.maxDurationMs) bucket.maxDurationMs = dur;
  }
  const ranking = [...byTool.values()]
    .map(b => ({ ...b, avgDurationMs: b.calls ? Math.round(b.totalDurationMs / b.calls) : 0 }))
    .sort((a, b) => (b.totalDurationMs - a.totalDurationMs) || (b.calls - a.calls) || a.tool.localeCompare(b.tool));
  const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 20;
  const recent = safeLimit === 0 ? [] : list.slice(-safeLimit);
  return {
    totalCalls: list.length,
    errorCount,
    totalDurationMs,
    ranking,
    recent,
  };
}
