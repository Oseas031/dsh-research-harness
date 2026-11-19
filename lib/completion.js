import { gateEntry } from './evidence-gate.js';

/**
 * 完成语义守卫（纯函数）：update_goal action=complete 时，
 * ① 未决 blocker 非空 → 拒，goal 只能 inconclusive / blocked 收尾；
 * ② verifier 启用且复验失败 → 拒。
 * 返回 null 放行 / {code, reason} 拒绝。
 */
export function completionGate({ toolName, args, ledger, verifier }) {
  if (!/goal/i.test(String(toolName ?? ''))) return null;
  const a = args ?? {};
  if (String(a.action ?? '') !== 'complete') return null;

  const blockers = ledger.blockers();
  if (blockers.length > 0) {
    ledger.append({
      kind: 'completion-attempt',
      outcome: 'inconclusive',
      blockers: blockers.map(b => b.id),
      reason: '存在未决 blocker，complete 被证据契约拒下',
    });
    return {
      code: 'EVIDENCE_BLOCKERS_OPEN',
      reason: 'EVIDENCE_BLOCKERS_OPEN: 台账里还有 ' + blockers.length + ' 个未决 blocker（' +
        blockers.map(b => b.id + ': ' + String(b.what).slice(0, 40)).join('; ') +
        '）。goal 不得标 complete。两条路：① 把它们 resolve 或降级为 non-blocker 后再 complete；② 以 inconclusive 收尾——record 一条 unknown 分类 blocker，改走 blocked/说明。台账见 findings.status。',
    };
  }

  if (verifier && verifier.enabled) {
    const verdict = verifier.verify(ledger);
    if (verdict && !verdict.pass) {
      return {
        code: 'EVIDENCE_VERIFY_FAILED',
        reason: 'EVIDENCE_VERIFY_FAILED: 校验器未通过（' + (verdict.failed ?? []).length + ' 项）：' +
          (verdict.failed ?? []).slice(0, 5).join('; ') + '。修完再 complete。',
      };
    }
  }
  return null;
}
