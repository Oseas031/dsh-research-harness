/**
 * 完成语义守卫（纯函数）：update_goal action=complete 时，
 * ① 未决 blocker 非空且未被 gate_skipped 显式覆盖 → 拒，goal 只能 inconclusive / blocked 收尾；
 * ② verifier 启用且复验失败 → 拒（即使存在 gate_skipped 也不允许跳过证据复验）；
 * ③ 通过后落入 completion-attempt 以便按任务自动归零 repairRounds。
 * 返回 null 放行 / {code, reason} 拒绝。
 */
export function completionGate({ toolName, args, ledger, verifier, verifyOpts }) {
  if (!/goal/i.test(String(toolName ?? ''))) return null;
  const a = args ?? {};
  if (String(a.action ?? '') !== 'complete') return null;

  const blockers = ledger.blockers();
  const taskKey = typeof a.task === 'string' && a.task.trim() ? a.task.trim() : 'default';
  let hasSkips = false;

  if (blockers.length > 0) {
    // v0.4 软门禁跳过：每个 open blocker 都被 gate_skipped 显式覆盖（reason/risk/compensation）→ 不挡门禁本身，但仍须过 verifier
    const covered = ledger.skippedBlockerIds ? ledger.skippedBlockerIds() : new Set();
    const uncovered = blockers.filter(b => !covered.has(b.id));
    if (uncovered.length > 0) {
      ledger.append({
        kind: 'completion-attempt',
        outcome: 'inconclusive',
        blockers: blockers.map(b => b.id),
        task: taskKey,
        reason: '存在未决 blocker，complete 被证据契约拒下',
      });
      return {
        code: 'EVIDENCE_BLOCKERS_OPEN',
        reason: 'EVIDENCE_BLOCKERS_OPEN: 台账里还有 ' + blockers.length + ' 个未决 blocker（' +
          blockers.map(b => b.id + ': ' + String(b.what).slice(0, 40)).join('; ') +
          '）。goal 不得标 complete。两条路：① 把它们 resolve 或降级为 non-blocker 后再 complete；② 以 inconclusive 收尾——record 一条 unknown 分类 blocker，改走 blocked/说明。台账见 findings.status。',
      };
    }
    hasSkips = true;
  }

  if (verifier && verifier.enabled) {
    const verdict = verifier.verify(ledger, verifyOpts);
    if (verdict && !verdict.pass) {
      return {
        code: 'EVIDENCE_VERIFY_FAILED',
        reason: 'EVIDENCE_VERIFY_FAILED: 校验器未通过（' + (verdict.failed ?? []).length + ' 项）：' +
          (verdict.failed ?? []).slice(0, 5).join('; ') + '。修完再 complete。',
      };
    }
  }

  ledger.append({
    kind: 'completion-attempt',
    outcome: hasSkips ? 'complete-with-skips' : 'complete',
    ...(hasSkips ? { blockers: blockers.map(b => b.id) } : {}),
    task: taskKey,
    reason: hasSkips
      ? '全部 open blocker 已被 gate_skipped 显式覆盖（带 reason/risk/compensation），且校验器通过，按软门禁放行'
      : '未决 blocker 为空且校验通过，允许收尾',
  });
  return null;
}
