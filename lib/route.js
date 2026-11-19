/**
 * 最短路路由（v0.4，scientify BOOTSTRAP 采纳）：纯函数，台账状态决定下一步。
 * 不读时间、不读会话、不读 todo 列表——只看 ledger（产物即状态）。
 * 返回 { action, why, detail? }；findings.route 工具直接暴露本函数。
 */

const REPAIR_CAP = { solo: 3, delegate: 2, cluster: 2 };

/**
 * @param {import('./ledger.js').Ledger} ledger
 * @param {{clusterScale?: 'solo'|'delegate'|'cluster', repairRounds?: number}} [opts]
 */
export function route(ledger, opts = {}) {
  const scale = opts.clusterScale ?? 'delegate';
  const cap = REPAIR_CAP[scale] ?? 2;
  const rounds = Number.isFinite(opts.repairRounds) ? opts.repairRounds : 0;

  const stats = ledger.stats();
  const blockers = ledger.blockers();
  // v0.4 与 completionGate 同判据：被 gate_skipped 显式覆盖（reason/risk/compensation）的 blocker 不再指挥路由
  const covered = typeof ledger.skippedBlockerIds === 'function' ? ledger.skippedBlockerIds() : new Set();
  const uncovered = blockers.filter(b => !covered.has(b.id));

  // 0. 修复轮上限：同一目标反复修复仍失败 → BLOCKED，禁止无限重试
  if (rounds >= cap) {
    return {
      action: 'BLOCKED',
      why: '修复轮数已达上限（' + rounds + '/' + cap + '，clusterScale=' + scale + '）。停止重试：把失败证据 record 成 unknown(blocker)，以 inconclusive 收尾或请人裁决。',
      detail: { repairRounds: rounds, cap },
    };
  }

  // 1. 未覆盖的未决 blocker 存在 → 先解 blocker（最短路径的第一优先）
  if (uncovered.length > 0) {
    return {
      action: 'resolve-blockers',
      why: '台账存在 ' + uncovered.length + ' 个未决 blocker，complete 被挡。最短路=先解它们（resolve 或降级 non-blocker），其余都是绕路。',
      detail: uncovered.map(b => ({ id: b.id, what: b.what, classification: b.classification })),
    };
  }

  // 2. 台账为空 → 先产出发现
  if (stats.total === 0) {
    return { action: 'record-findings', why: '台账为空：先做研究动作并把发现 findings.record 入账，无产出时登记 unknown。' };
  }

  // 3. 有产出、无未覆盖 blocker → 走验收链（聚合 + 校验），过了才 complete
  const findings = stats.byKind.finding ?? 0;
  const openUnknowns = stats.openUnknowns['non-blocker'] + stats.openUnknowns.parameterizable;
  const skipped = blockers.length - uncovered.length;
  return {
    action: 'run-acceptance',
    why: '无未覆盖 blocker、台账有 ' + stats.total + ' 条（findings ' + findings + '）' +
      (skipped > 0 ? '；' + skipped + ' 个 blocker 已被 gate_skipped 显式覆盖（跳过记录在案）' : '') +
      '。下一步=验收链：findings.aggregate 看通过率，verifier 复验 provenance；全绿才 complete。',
    detail: { total: stats.total, findings, openUnknowns, skipped, rate: null },
  };
}

/** 修复轮计数由调用方维护（会话状态不入台账）；本函数只做判定。 */
export { REPAIR_CAP };
