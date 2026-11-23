// 场景模板：拿到 { ctx, defs, step, ledgerDir }，用官方 checkGuards / def.execute 直接驱动。
export default async ({ ctx, defs, step }) => {
  const deny = ctx.tools.checkGuards({ name: 'findings_record', args: { entries: [{ claim: '无出处断言若干字', confidence: 'observed' }] } });
  step('无 provenance 拒', String(deny?.reason ?? '').includes('EVIDENCE_NO_PROVENANCE'));
  const rec = defs.find(d => d.name === 'findings_record');
  const out = await rec.execute({ entries: [{ claim: '冒烟条目带出处', confidence: 'observed', provenance: 'lab/smoke.mjs:5' }] }, {});
  step('带 provenance 入账', out?.recorded === 1);
};
