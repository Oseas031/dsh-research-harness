/** 缺口② challenger 反向假设门（v0.3）：DCP Gate 2 精神——对 PASS 条目跑反向假设。
 * 采纳：AI-Scientist perform_review 的 ensemble 结构思想（不抄代码）；CiTO 谓词作反证关系标注。
 * 设计：challenge 由模型/审计者显式调用；台账落 challenge 条目（ref 指向被挑战 finding），
 *       带 cito 关系（disagreesWith | refutes | corroborates | usesDataFrom）；
 *       一个未决 refutes 挑战将把被挑战条目的聚合 verdict 降为 todo（UNVERIFIED 档），
 *       并算作 open blocker（挡 complete）——与 DCP「挑战者恢复」对应。
 */
const CITO = new Set(['disagreesWith', 'refutes', 'corroborates', 'usesDataFrom', 'citesAsAuthority']);

export function validateChallenge(c) {
  if (!c || typeof c !== 'object') return { code: 'CHALLENGE_BAD_ENTRY', reason: 'CHALLENGE_BAD_ENTRY: 挑战必须是对象。' };
  if (!c.ref || typeof c.ref !== 'string') return { code: 'CHALLENGE_NO_REF', reason: 'CHALLENGE_NO_REF: 必须指向被挑战条目的 id（ref）。' };
  if (!c.hypothesis || String(c.hypothesis).trim().length < 2) {
    return { code: 'CHALLENGE_NO_HYPOTHESIS', reason: 'CHALLENGE_NO_HYPOTHESIS: 反向假设必须成句（hypothesis）。' };
  }
  const rel = String(c.cito ?? 'disagreesWith');
  if (!CITO.has(rel)) {
    return { code: 'CHALLENGE_BAD_CITO', reason: 'CHALLENGE_BAD_CITO: cito 必须是 ' + [...CITO].join('|') + '。' };
  }
  if (!c.provenance || typeof c.provenance !== 'string') {
    return { code: 'EVIDENCE_NO_PROVENANCE', reason: 'EVIDENCE_NO_PROVENANCE: 挑战也要有出处（provenance）——反向假设同样不许空口。' };
  }
  return null;
}

/** 挑战条目是否构成降档（未决 refutes/disagreesWith 把被挑战条目压成 todo 档）。 */
export function isDowngrading(challengeEntry) {
  return challengeEntry.kind === 'challenge'
    && challengeEntry.status !== 'resolved'
    && (challengeEntry.cito === 'refutes' || challengeEntry.cito === 'disagreesWith');
}

/** 聚合时应用挑战降档：返回被降档条目 id 集合。 */
export function downgradedIds(entries) {
  const dg = new Set();
  const resolved = new Set();
  for (const e of entries) {
    if (e.kind === 'challenge-update' && e.status === 'resolved' && e.ref) resolved.add(e.ref);
  }
  for (const e of entries) {
    if (isDowngrading(e) && !resolved.has(e.id)) dg.add(e.ref);
  }
  return dg;
}
