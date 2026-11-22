/** 缺口① 聚合指标（v0.3）：机器可派生 rate。
 * 采纳：JUnit XML 计数行文法（tests/failures/errors/skipped, rate=1−(f+e)/tests）
 *     + TAP v13 输出行文法（ok/not ok N desc # directive）+ verdict 枚举。
 * 出处：openai/mle-bench (MIT) Any Medal % mean±SEM 范式；junitxml 事实标准；TAP v13 规范。
 */
const CONFIDENCE_TO_VERDICT = { observed: 'ok', inferred: 'ok', unknown: 'todo' };
export const VERDICTS = new Set(['ok', 'not_ok', 'todo', 'skip', 'bail_out']);

/** confidence → TAP verdict 映射：observed/inferred=ok；unknown=todo（=UNVERIFIED 档）。 */
export function verdictOf(entry) {
  if (entry.verdict && VERDICTS.has(entry.verdict)) return entry.verdict;
  return CONFIDENCE_TO_VERDICT[entry.confidence] ?? 'todo';
}

/** 数值容差判定（core-bench 式 t 区间近似，无 scipy 时用 z≈1.96 简化）。
 * expected/actual 为数值型时：|actual−expected| ≤ z×std×sqrt(1+1/n) → ok，否则 not_ok。 */
export function numericTolerance(expected, actual, std = 0, n = 1) {
  if (typeof expected !== 'number' || typeof actual !== 'number') return null;
  const bound = 1.96 * std * Math.sqrt(1 + 1 / Math.max(n, 1));
  return Math.abs(actual - expected) <= bound ? 'ok' : 'not_ok';
}

/** 集合型指标（AutoResearchBench compute_iou_recall 式）。返回 IoU/recall/precision。 */
export function setOverlap(expected, actual) {
  const E = new Set(expected ?? []), A = new Set(actual ?? []);
  const inter = [...E].filter(x => A.has(x)).length;
  const union = new Set([...E, ...A]).size;
  return {
    iou: union === 0 ? 1 : inter / union,
    recall: E.size === 0 ? 1 : inter / E.size,
    precision: A.size === 0 ? 1 : inter / A.size,
  };
}

/** 主聚合器：从 ledger 条目派生 JUnit 计数 + TAP 报告。纯函数。 */
export function aggregate(entries, opts = {}) {
  const findings = entries.filter(e => e.kind === 'finding');
  const maxAgeMs = typeof opts.maxAgeHours === 'number' && Number.isFinite(opts.maxAgeHours) && opts.maxAgeHours > 0
    ? opts.maxAgeHours * 3600 * 1000
    : null;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  let tests = 0, failures = 0, errors = 0, skipped = 0, stale = 0;
  const tapLines = [];
  const detail = [];
  let n = 0; // bail 出现即终止后续计数
  for (const e of findings) {
    let v = verdictOf(e);
    let isStale = false;
    if (maxAgeMs && v === 'ok' && e.ts) {
      const parsedTs = Date.parse(e.ts);
      if (Number.isFinite(parsedTs) && (nowMs - parsedTs) > maxAgeMs) {
        v = 'todo';
        isStale = true;
        stale += 1;
      }
    }
    tests += 1;
    let directive = '';
    if (v === 'not_ok') { failures += 1; }
    else if (v === 'bail_out') { errors += 1; directive = 'Bail out! ' + String(e.claim ?? '').slice(0, 60); }
    else if (v === 'skip') { skipped += 1; directive = 'SKIP'; }
    else if (v === 'todo') { directive = isStale ? 'TODO stale' : 'TODO ' + String(e.claim ?? '').slice(0, 60); }
    tapLines.push((v === 'not_ok' ? 'not ok' : 'ok') + ' ' + (n + 1) + ' ' + String(e.id ?? e.seq ?? '?') + (directive ? ' # ' + directive : ''));
    detail.push({
      id: e.id ?? 'E' + e.seq,
      claim: String(e.claim ?? '').slice(0, 80),
      verdict: v,
      confidence: isStale ? 'unknown' : (e.confidence ?? null),
      ...(isStale ? { stale: true } : {}),
    });
    n += 1;
  }
  const rate = tests === 0 ? null : 1 - (failures + errors) / tests;
  const header = '1..' + tests + (skipped ? ' (skipped ' + skipped + ')' : '');
  const meanSem = meanSemOf(entries);
  return {
    counts: { tests, failures, errors, skipped, stale },
    rate,
    tap: [header, ...tapLines].join('\n'),
    detail,
    cost: costOf(entries),
    ...(meanSem ? { meanSem } : {}),
  };
}

/** 多 seed mean±SEM（mle-bench Any Medal 范式）：同一 claim 的多个观测值聚簇。 */
export function meanSemOf(entries) {
  const byClaim = new Map();
  for (const e of entries) {
    if (e.kind === 'finding' && typeof e.metric === 'number') {
      const k = String(e.claim ?? '');
      if (!byClaim.has(k)) byClaim.set(k, []);
      byClaim.get(k).push(e.metric);
    }
  }
  const out = [];
  for (const [claim, vals] of byClaim) {
    if (vals.length < 2) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    out.push({ claim: claim.slice(0, 60), seeds: vals.length, mean, sem: sd / Math.sqrt(vals.length) });
  }
  return out.length ? out : null;
}

/** 成本聚合（缺口③）。token 计数求和 + 派生 cost_usd。 */
export function costOf(entries) {
  const tok = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
  let usd = 0, nCosted = 0;
  for (const e of entries) {
    const t = e?.tokens;
    if (t && typeof t === 'object') {
      tok.input_tokens += num(t.input_tokens); tok.output_tokens += num(t.output_tokens);
      tok.cache_read += num(t['cache_read.input_tokens']); tok.cache_write += num(t['cache_write.input_tokens']);
      tok.reasoning += num(t['reasoning.output_tokens']);
      if (typeof t.cost_usd === 'number') { usd += t.cost_usd; nCosted += 1; }
    }
  }
  return { tokens: tok, cost_usd: usd, costed_entries: nCosted, currency: 'USD' };
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
