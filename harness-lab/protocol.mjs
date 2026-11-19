import { readFileSync, existsSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { boot } from "file:///C:/Users/ASUS/AppData/Local/Programs/DeepSeek%20Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";
import { Ledger } from "file:///E:/dsh-research-harness/lib/ledger.js";

const ROOT_YML = 'E:/dsh-research-harness/harness-lab/profile/cordis.yml';
const LEDGER_DIR = 'E:/dsh-research-harness/harness-lab/.research';
const results = [];
const step = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

if (existsSync(LEDGER_DIR)) rmSync(LEDGER_DIR, { recursive: true, force: true });

const ctx = await boot('harness-lab', ROOT_YML, [], undefined, "file:///C:/Users/ASUS/AppData/Local/Programs/DeepSeek%20Harness/resources/app/dsh/node_modules/");

try {
  // ---- P0: real services + registration via official definitions() ----
  step('P0 真实服务挂载（ToolsService + SystemPrompt）',
    !!(ctx.tools && typeof ctx.tools.guard === 'function' && typeof ctx.tools.checkGuards === 'function'));
  let defs = [];
  try { defs = ctx.tools.definitions(undefined); } catch (e) { defs = { err: String(e) }; }
  const names = Array.isArray(defs) ? defs.map(d => d.name) : defs;
  step('P0 findings.record / findings.status 注册在案（官方 definitions() 可见）',
    Array.isArray(names) && names.includes('findings.record') && names.includes('findings.status'),
    Array.isArray(names) ? names.join(',') : JSON.stringify(names).slice(0, 120));
  const recDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings.record') : null;
  step('P0 注册定义带 schema + execute + render',
    !!(recDef?.parameters?.properties?.entries && typeof recDef?.execute === 'function' && typeof recDef?.output?.render === 'function'));

  // ---- P1: 无 provenance 当场拒（官方守卫链）----
  const deny = ctx.tools.checkGuards({ name: 'findings.record', args: { entries: [{ claim: '无出处的断言内容', confidence: 'observed' }] } });
  step('P1 无 provenance 被官方守卫链拒绝',
    String(deny?.reason ?? '').includes('EVIDENCE_NO_PROVENANCE'),
    '模型可见: ' + (deny ? ('Error: ' + deny.reason.slice(0, 80) + '…') : '(放行了!)'));

  // ---- P1b: 真执行入账（带 provenance，走 def.execute 真路径）----
  const out = await recDef.execute({ entries: [{ claim: 'example.com 主从模式 Plus 档开放', confidence: 'observed', provenance: 'https://arxiv.org/html/2610.30808v1' }] }, { name: 'findings.record', agent: undefined });
  step('P1b def.execute 真执行入账', out?.recorded === 1 && out?.ids?.length === 1, JSON.stringify(out));
  const ledgerText = readFileSync(LEDGER_DIR + '/ledger.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  step('P1b ledger.jsonl 物化且可溯源', ledgerText.some(e => e.kind === 'finding' && e.provenance?.startsWith('https://arxiv')),
    'lines: ' + ledgerText.map(e => e.kind).join(','));
  const guardLog = readFileSync(LEDGER_DIR + '/guard-log.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  step('P1 拒绝留痕 guard-log.jsonl（wired + denial）',
    guardLog.some(g => g.kind === 'wired') && guardLog.some(g => g.code === 'EVIDENCE_NO_PROVENANCE'),
    guardLog.map(g => g.kind + (g.code ? ':' + g.code : '')).join(' | '));

  // ---- P2: 未决 blocker 挡 complete ----
  const ledger = new Ledger(LEDGER_DIR);
  ledger.addUnknown({ what: '模型后端档位未证实', classification: 'blocker' });
  const goalDeny = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  const lastEntry = new Ledger(LEDGER_DIR).entries().at(-1);
  step('P2 未决 blocker 挡 update_goal complete',
    String(goalDeny?.reason ?? '').includes('EVIDENCE_BLOCKERS_OPEN'),
    'inconclusive 落账: ' + (lastEntry?.outcome ?? '(none)') + ' / blockers=' + new Ledger(LEDGER_DIR).blockers().length);

  // ---- P3: resolve 后放行 ----
  const u = new Ledger(LEDGER_DIR).entries().filter(e => e.kind === 'unknown')[0];
  ledger.resolve(u.id, '已由官方定价页核对');
  const goalPass = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P3 blocker resolve 后 complete 放行', goalPass === undefined, 'checkGuards → undefined（放行）');


  // ---- P4: 技能 provider 真挂载（可移植性验收）----
  const skillsSvc = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
  const listed = skillsSvc ? await skillsSvc.list({}) : [];
  const ours = listed.filter(s => s.provider === 'research-harness-skills');
  const wiredSkills = guardLog.filter(e => e.kind === 'wired')[0]?.skills;
  step('P4 技能 provider 挂在真 SkillRegistry（9 技能、bundled 源）',
    ours.length === 9 && wiredSkills?.state === 'ok' && wiredSkills?.count === 9,
    'registry: ' + ours.length + '/9 | wired: ' + JSON.stringify(wiredSkills));
  const def = ours.length ? await skillsSvc.get(ours.find(s => s.name === 'sci-figure').name, {}) : undefined;
  step('P4 skillsSvc.get() 装回技能正文', !!def && def.provider === 'research-harness-skills' && /render\.py/.test(def.content ?? ''),
    'sci-figure content ' + (def?.content?.length ?? 0) + 'B');

  // ---- verdict ----
  const fails = results.filter(r => !r.pass);
  console.log('\n===== harness-lab 验收: ' + (results.length - fails.length) + '/' + results.length + ' =====');
  if (fails.length) { console.log('FAILED: ' + fails.map(f => f.name).join(' ; ')); process.exitCode = 1; }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
}
