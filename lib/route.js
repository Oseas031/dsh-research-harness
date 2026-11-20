/**
 * 最短路路由（v0.4，scientify BOOTSTRAP 采纳）：纯函数，台账状态决定下一步。
 * 不读时间、不读会话、不读 todo 列表——只看 ledger（产物即状态）。
 * v0.4.1（issue #6）：消费验收充分性规格 acceptance = { minFindings?, minObservedRatio?, requiredRouteChecks? }。
 * 缺规格时行为与 v0.4 完全一致（向后兼容）。route-check 由 CLI/工具层在每次调用后落账，检查点因此可机读。
 * 返回 { action, why, detail? }；findings.route 工具直接暴露本函数。
 */

const REPAIR_CAP = { solo: 3, delegate: 2, cluster: 2 };

/**
 * @param {import('./ledger.js').Ledger} ledger
 * @param {{clusterScale?: 'solo'|'delegate'|'cluster', repairRounds?: number, acceptance?: {minFindings?: number, minObservedRatio?: number, requiredRouteChecks?: number, task?: string}}} [opts]
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

  const findings = stats.byKind.finding ?? 0;
  const observed = stats.byConfidence.observed ?? 0;
  const routeChecks = stats.byKind['route-check'] ?? 0;
  // v0.5.0：共享台账下按 task 限定 findings/observed；routeChecks 仍保持全局。
  let scopedFindings = findings;
  let scopedObserved = observed;
  const task = typeof opts.acceptance?.task === 'string' && /^(REQ|TASK)-\d{4}$/.test(opts.acceptance.task.trim()) ? opts.acceptance.task.trim() : null;
  if (task) {
    const entries = ledger.entries().filter(entry => entry.kind === 'finding' && entry.task === task);
    scopedFindings = entries.length;
    scopedObserved = entries.filter(entry => entry.confidence === 'observed').length;
  }

  // 2.5 v0.4.1 验收充分性（issue #6）：在飞任务不再被提前喊 run-acceptance。
  // 只看机读规格；规格未声明的不查。短版逐项列出，action=continue-recording。
  if (opts.acceptance && typeof opts.acceptance === 'object') {
    const short = [];
    const a = opts.acceptance;
    if (Number.isFinite(a.minFindings) && scopedFindings < a.minFindings) {
      short.push({ check: 'minFindings', need: a.minFindings, have: scopedFindings });
    }
    if (Number.isFinite(a.minObservedRatio)) {
      const ratio = scopedFindings > 0 ? scopedObserved / scopedFindings : 0;
      if (ratio < a.minObservedRatio) short.push({ check: 'minObservedRatio', need: a.minObservedRatio, have: Math.round(ratio * 1000) / 1000 });
    }
    if (Number.isFinite(a.requiredRouteChecks) && routeChecks < a.requiredRouteChecks) {
      short.push({ check: 'requiredRouteChecks', need: a.requiredRouteChecks, have: routeChecks });
    }
    if (short.length > 0) {
      return {
        action: 'continue-recording',
        why: '无未覆盖 blocker，但验收充分性未达标：' + short.map(s => s.check + ' ' + s.have + '/' + s.need).join('、') + '。继续产出发现（或补 route 检查点），达标前不走验收链。',
        detail: { short, findings: scopedFindings, observed: scopedObserved, routeChecks, ...(task ? { task } : {}) },
      };
    }
  }

  // 3. 有产出、无未覆盖 blocker（且充分性达标/未声明）→ 走验收链
  const openUnknowns = stats.openUnknowns['non-blocker'] + stats.openUnknowns.parameterizable;
  const skipped = blockers.length - uncovered.length;
  return {
    action: 'run-acceptance',
    why: '无未覆盖 blocker、台账有 ' + stats.total + ' 条（findings ' + scopedFindings + '）' +
      (skipped > 0 ? '；' + skipped + ' 个 blocker 已被 gate_skipped 显式覆盖（跳过记录在案）' : '') +
      '。下一步=验收链：findings.aggregate 看通过率，verifier 复验 provenance；全绿才 complete。',
    detail: { total: stats.total, findings: scopedFindings, observed: scopedObserved, routeChecks, openUnknowns, skipped, rate: null, ...(task ? { task } : {}) },
  };
}

/** 修复轮计数由调用方维护（会话状态不入台账）；本函数只做判定。 */
export { REPAIR_CAP };
