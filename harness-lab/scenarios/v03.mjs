/** v0.3 验收场景：四缺口端到端（真实 cordis 装配 + 官方 definitions/execute）。 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default async function run({ ctx, defs, step, ledgerDir }) {
  const defsArr = Array.isArray(defs) ? defs : (typeof defs === 'function' ? defs() : []);
  const find = (name) => defsArr.find(d => d.name === name);

  // P0: 四工具全部注册在案（官方 definitions）
  step('P0 四工具注册在案', ['findings.record', 'findings.status', 'findings.aggregate', 'findings.challenge'].every(n => !!find(n)),
    ['findings.record', 'findings.status', 'findings.aggregate', 'findings.challenge'].join(','));
  const aggDef = find('findings.aggregate');
  const chDef = find('findings.challenge');
  step('P0 aggregate/challenge 定义带 schema+execute+render', !!(aggDef?.parameters && aggDef?.execute && aggDef?.output?.render && chDef?.parameters && chDef?.execute && chDef?.output?.render));

  const recDef = find('findings.record');
  // P1: 成本槽入账（OTel 词表）
  const r1 = await recDef.execute({ entries: [{ claim: 'v03 数值发现', confidence: 'observed', provenance: 'tool:run_code', metric: 0.71, tokens: { input_tokens: 1200, output_tokens: 300, 'reasoning.output_tokens': 80, cost_usd: 0.15 } }] });
  step('P1 cost+metric 槽入账', r1.recorded === 1, JSON.stringify(r1.ids));
  // P1b: 坏 token 键被拒
  let denied = false;
  try { await recDef.execute({ entries: [{ claim: '坏成本', confidence: 'observed', provenance: 'tool:x', tokens: { bad_key: 1 } }] }); } catch { denied = true; }
  step('P1b COST_BAD_KEY 拒绝', denied);
  // P1c: repro 槽（SLSA）
  const r3 = await recDef.execute({ entries: [{ claim: '结果复现成功', confidence: 'observed', provenance: 'tool:run_code', repro: { build_type: 'run.py', subject_digest: 'a'.repeat(64), invocation_id: 'inv-1', started_on: '2026-11-18T09:00:00Z' } }] });
  step('P1c repro 槽入账', r3.recorded === 1);

  // P2: challenge 门——refutes 落账 + blocker + complete 被挡
  const recDefIds = r1.ids;
  const ch = await chDef.execute({ ref: recDefIds[0], hypothesis: '该数值在反向假设下不成立', cito: 'refutes', provenance: 'https://arxiv.org/abs/2502.14297' });
  step('P2 challenge 落账', !!ch.id && ch.ref === recDefIds[0], ch.id);
  const stDef = find('findings.status');
  const st1 = await stDef.execute({});
  const hasChBl = (st1.blockers ?? []).some(b => /未决挑战/.test(String(b.what)));
  step('P2 未决挑战计 blocker', hasChBl, JSON.stringify((st1.blockers ?? []).map(b => b.id)));
  // complete 被挡（需要 goal 工具在场；lab 场景里用 completionGate 等价物=blockers 非空）
  step('P2 blocker 非空即挡 complete（契约同型）', (st1.blockers ?? []).length > 0);

  // P3: aggregate 输出 JUnit 计数 + TAP + 降档
  const agg = await aggDef.execute({});
  step('P3 aggregate counts+rate', !!agg.counts && typeof agg.counts.tests === 'number' && agg.tap.includes('1..'), 'tests=' + agg.counts.tests + ' rate=' + agg.rate);
  const dg = (agg.detail ?? []).some(d => d.downgraded === 'open-challenge');
  step('P3 被挑战条目降 todo 档', dg);
  const tapHasTodo = /# TODO downgraded/.test(agg.tap);
  step('P3 TAP 含 TODO 降档行', tapHasTodo);
  step('P3 cost 聚合', agg.cost?.tokens?.input_tokens >= 1200 && Math.abs((agg.cost?.cost_usd ?? 0) - 0.15) < 1e-9);

  // P4: ledger.jsonl 物化（挑战+成本+repro 三类条目都在盘上）
  const lines = existsSync(join(ledgerDir, 'ledger.jsonl')) ? readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').split('\n').filter(l => l.trim()) : [];
  const kinds = lines.map(l => { try { return JSON.parse(l).kind; } catch { return 'corrupt'; } });
  step('P4 ledger 物化含 challenge/tokens/repro', kinds.includes('challenge') && kinds.includes('finding') && lines.some(l => /"tokens"/.test(l)) && lines.some(l => /"repro"/.test(l)), kinds.join(','));

  // P5: challenge 无 provenance 被拒
  let chDenied = false;
  try { await chDef.execute({ ref: 'E1', hypothesis: '足够长假设', cito: 'refutes', provenance: '' }); } catch { chDenied = true; }
  step('P5 challenge 缺 provenance 拒绝', chDenied);
}
