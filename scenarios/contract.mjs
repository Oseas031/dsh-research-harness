// 证据契约场景：research-harness 的 9 项验收（lab.run / harness-lab 通用契约）。
// 需要挂载 config 提供 ledgerRoot（fresh 临时目录）；targetConfig.ledgerRoot 即本场景台账根。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../lib/ledger.js';

export default async ({ ctx, defs, step, targetConfig }) => {
  const ledgerDir = targetConfig?.ledgerRoot;
  step('P0 前置: config.ledgerRoot 已提供', !!ledgerDir, String(ledgerDir));

  step('P0 真实服务挂载（ToolsService + SystemPrompt）',
    !!(ctx.tools && typeof ctx.tools.checkGuards === 'function'));
  const names = defs.map(d => d.name);
  step('P0 findings.record / findings.status 注册在案（官方 definitions() 可见）',
    names.includes('findings.record') && names.includes('findings.status'), names.join(','));
  const recDef = defs.find(d => d.name === 'findings.record');
  step('P0 注册定义带 schema + execute + render',
    !!(recDef && recDef.parameters && recDef.parameters.properties && recDef.parameters.properties.entries && typeof recDef.execute === 'function' && recDef.output && typeof recDef.output.render === 'function'));

  const deny = ctx.tools.checkGuards({ name: 'findings.record', args: { entries: [{ claim: '无出处断言若干字', confidence: 'observed' }] } });
  step('P1 无 provenance 被官方守卫链拒绝',
    String(deny && deny.reason || '').includes('EVIDENCE_NO_PROVENANCE'),
    '模型可见: ' + (deny ? 'Error: ' + String(deny.reason).slice(0, 80) : '(放行了!)'));

  const out = await recDef.execute({ entries: [{ claim: 'arXiv 论文分工表述', confidence: 'observed', provenance: 'https://arxiv.org/html/2610.30808v1' }] }, { name: 'findings.record', agent: undefined });
  step('P1b def.execute 真执行入账', out && out.recorded === 1 && out.ids && out.ids.length === 1, JSON.stringify(out));
  const entries = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  step('P1b ledger.jsonl 物化且可溯源', entries.some(e => e.kind === 'finding' && String(e.provenance || '').startsWith('https://arxiv')),
    'lines: ' + entries.map(e => e.kind).join(','));
  const guardLog = readFileSync(join(ledgerDir, 'guard-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  step('P1 拒绝留痕 guard-log.jsonl（wired + denial）',
    guardLog.some(g => g.kind === 'wired') && guardLog.some(g => g.code === 'EVIDENCE_NO_PROVENANCE'),
    guardLog.map(g => g.kind + (g.code ? ':' + g.code : '')).join(' | '));

  const ledger = new Ledger(ledgerDir);
  ledger.addUnknown({ what: '模型后端档位未证实', classification: 'blocker' });
  const goalDeny = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  const last = new Ledger(ledgerDir).entries().at(-1);
  step('P2 未决 blocker 挡 update_goal complete',
    String(goalDeny && goalDeny.reason || '').includes('EVIDENCE_BLOCKERS_OPEN'),
    'inconclusive 落账: ' + (last && last.outcome || '(none)'));

  const u = new Ledger(ledgerDir).entries().filter(e => e.kind === 'unknown')[0];
  ledger.resolve(u.id, '已由官方定价页核对');
  const goalPass = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P3 blocker resolve 后 complete 放行', goalPass === undefined, 'checkGuards → undefined（放行）');
};
