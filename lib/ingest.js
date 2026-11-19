import { readFileSync } from 'node:fs';

/**
 * 报告入账（v0.4.1，issue #5）：子代理/审阅者报告的结构化 findings 块 → 台账。
 * 报告规范：markdown 中放 \`\`\`findings 围栏块，内容是 JSON（单个对象或数组），
 * 每项 { claim, confidence, provenance, task?, tags?, verifiedBy? }。
 * ingest 后 verifiedBy 缺省为 agent-reported（子代理原文）；lead 亲验后用 markVerified 升级。
 */

const CONF = ['observed', 'inferred', 'unknown'];
const PROV_PREFIX = /^(file|url|tool|report|doi|arxiv):/i;

/** 轻量 provenance 语法检查：建议 file:/url:/tool:/report:/doi:/arxiv: 前缀。返回 null=OK，否则告警文案。 */
export function checkProvenance(p) {
  if (typeof p !== 'string' || p.trim().length === 0) return 'provenance 为空';
  if (!PROV_PREFIX.test(p.trim())) return 'provenance 无建议前缀（file:/url:/tool:/report:/doi:/arxiv:），机器不可验证：' + p.slice(0, 60);
  return null;
}

/** 从报告 markdown 提取 findings 块。返回 { findings, errors }（errors 不中断，逐块收集）。 */
export function parseFindingsBlocks(mdText) {
  const findings = [];
  const errors = [];
  const re = /\`\`\`findings[ \t]*\n([\s\S]*?)\`\`\`/g;
  let m;
  let block = 0;
  while ((m = re.exec(String(mdText))) !== null) {
    block += 1;
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { errors.push({ block, reason: 'JSON 解析失败: ' + String(e.message).slice(0, 120) }); continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const it of items) {
      if (typeof it !== 'object' || it === null) { errors.push({ block, reason: '条目不是对象' }); continue; }
      if (typeof it.claim !== 'string' || it.claim.trim().length === 0) { errors.push({ block, reason: '缺 claim（非空字符串）' }); continue; }
      findings.push({
        claim: it.claim.trim(),
        confidence: CONF.includes(it.confidence) ? it.confidence : 'unknown',
        provenance: typeof it.provenance === 'string' ? it.provenance.trim() : '',
        ...(it.task ? { task: it.task } : {}),
        ...(Array.isArray(it.tags) ? { tags: it.tags.map(String) } : {}),
        ...(it.verifiedBy ? { verifiedBy: it.verifiedBy } : {}),
      });
    }
  }
  return { findings, errors };
}

/**
 * 整份报告入账。source = 报告标识（如 dogfood-B / REVIEW-0007）。
 * provenance 前缀 report:<source> |（原始 provenance 保留在后），verifiedBy 缺省 agent-reported。
 * 返回 { ingested, errors, warnings, ids }。
 */
export function ingestReport(ledger, mdPath, { source = 'unnamed', task } = {}) {
  const md = readFileSync(mdPath, 'utf8');
  const { findings, errors } = parseFindingsBlocks(md);
  const warnings = [];
  const ids = [];
  for (const f of findings) {
    const prov = 'report:' + source + ' | ' + (f.provenance || '(report 未标 provenance)');
    const w = checkProvenance(f.provenance);
    if (w) warnings.push({ claim: f.claim.slice(0, 50), warning: w });
    const rec = ledger.record({
      claim: f.claim,
      confidence: f.confidence,
      provenance: prov,
      tags: Array.isArray(f.tags) ? f.tags : [],
      ...(f.task ? { task: f.task } : (task ? { task } : {})),
      verifiedBy: f.verifiedBy === 'lead-verified' ? 'lead-verified' : 'agent-reported',
    });
    ids.push(rec.id);
  }
  return { ingested: ids.length, errors, warnings, ids };
}

/** lead 亲验升级：把一条 finding 标为 lead-verified（追加 finding-update，不改原行——append-only）。 */
export function markVerified(ledger, ref, note) {
  return ledger.append({ kind: 'finding-update', ref, status: 'lead-verified', ...(note ? { note: String(note) } : {}) });
}
