import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
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
  const ledger = new Ledger(LEDGER_DIR, { receipts: true });
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
  step('P4 技能 provider 挂在真 SkillRegistry（10 技能、bundled 源）',
    ours.length === 10 && wiredSkills?.state === 'ok' && wiredSkills?.count === 10,
    'registry: ' + ours.length + '/10 | wired: ' + JSON.stringify(wiredSkills));
  const def = ours.length ? await skillsSvc.get(ours.find(s => s.name === 'sci-figure').name, {}) : undefined;
  step('P4 skillsSvc.get() 装回技能正文', !!def && def.provider === 'research-harness-skills' && /render\.py/.test(def.content ?? ''),
    'sci-figure content ' + (def?.content?.length ?? 0) + 'B');

  // ---- P5: 收据层（v0.4）：机制行全 ok；手改立检；还原恢复 ----
  const verifyDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings.verify') : null;
  const v1 = verifyDef ? await verifyDef.execute({}, { name: 'findings.verify' }) : null;
  step('P5 findings.verify 收据核对（机制写入行全 ok）',
    v1?.ok === true && v1?.checked >= 1 && (v1?.drifted?.length ?? 1) === 0, JSON.stringify(v1));
  const lf = LEDGER_DIR + '/ledger.jsonl';
  const rawLines = readFileSync(lf, 'utf8').split('\n').filter(Boolean);
  const backupLine = rawLines[rawLines.length - 1];
  rawLines[rawLines.length - 1] = backupLine + ' '; // 手改：行尾加空格（JSON 仍可解析，哈希必变）
  writeFileSync(lf, rawLines.join('\n') + '\n', 'utf8');
  const v2 = verifyDef ? await verifyDef.execute({}, { name: 'findings.verify' }) : null;
  step('P5 手改一行 → drifted 立即可检',
    v2?.ok === false && v2?.drifted?.length === 1, JSON.stringify(v2?.drifted));
  rawLines[rawLines.length - 1] = backupLine;
  writeFileSync(lf, rawLines.join('\n') + '\n', 'utf8');
  const v3 = verifyDef ? await verifyDef.execute({}, { name: 'findings.verify' }) : null;
  step('P5 还原后 verify 恢复 ok', v3?.ok === true, 'unverified=' + (v3?.unverified ?? '?'));

  // ---- P6: 软门禁跳过（v0.4）：缺字段拒；全字段覆盖后放行 ----
  const skipDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings.gate-skip') : null;
  const u6 = ledger.addUnknown({ what: '上游数据集未发布', classification: 'blocker' });
  const deny6 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P6 新 blocker 再挡 complete',
    String(deny6?.reason ?? '').includes('EVIDENCE_BLOCKERS_OPEN'), '');
  let skipErr = '';
  try { await skipDef.execute({ gate: 'EVIDENCE_BLOCKERS_OPEN', reason: '等上游发布', risk: '结论外推受限', compensation: '' }, { name: 'findings.gate-skip' }); }
  catch (e) { skipErr = String(e?.message ?? e); }
  step('P6 gate-skip 缺 compensation 被拒', skipErr.includes('GATE_SKIP_BAD_FIELD'), skipErr.slice(0, 90));
  const skipOut = await skipDef.execute({
    gate: 'EVIDENCE_BLOCKERS_OPEN',
    reason: '上游数据集未发布，无法获取',
    risk: '结论对该数据集外推受限',
    compensation: '上游发布后补跑基准并 record 新条目',
    covers: [u6.id],
  }, { name: 'findings.gate-skip' });
  const pass6 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P6 全字段 skip 覆盖后 complete 放行',
    skipOut?.skipped === 1 && pass6 === undefined, 'skip id=' + skipOut?.id + ' covers=' + u6.id);

  // ---- P7: 最短路路由（v0.4）：台账状态决定下一步 ----
  const routeDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings.route') : null;
  const r7 = routeDef ? await routeDef.execute({}, { name: 'findings.route' }) : null;
  step('P7 findings.route 无 blocker 有产出 → run-acceptance',
    r7?.action === 'run-acceptance', JSON.stringify(r7?.why ?? '').slice(0, 80));
  const r7b = routeDef ? await routeDef.execute({ repairFailed: true }, { name: 'findings.route' }) : null;
  const r7c = routeDef ? await routeDef.execute({ repairFailed: true }, { name: 'findings.route' }) : null;
  step('P7 修复轮 2/2（delegate）→ BLOCKED',
    r7b?.action !== 'BLOCKED' && r7c?.action === 'BLOCKED', 'round1=' + r7b?.action + ' round2=' + r7c?.action);

  // ---- verdict ----
  const fails = results.filter(r => !r.pass);
  console.log('\n===== harness-lab 验收: ' + (results.length - fails.length) + '/' + results.length + ' =====');
  if (fails.length) { console.log('FAILED: ' + fails.map(f => f.name).join(' ; ')); process.exitCode = 1; }
} finally {
  try { await ctx.fiber.dispose(); } catch {}
}
