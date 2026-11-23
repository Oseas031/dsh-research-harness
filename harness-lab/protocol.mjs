import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../lib/ledger.js';
import { Evolver } from '../lib/evolve.js';
import { createVerifier } from '../lib/verifier.js';
import { createHarnessLab, REPO_ROOT } from './runtime.mjs';

const PKG_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const lab = await createHarnessLab();
const LEDGER_DIR = lab.ledgerDir;
const results = [];
const step = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

let ctx;
try {
  if (existsSync(LEDGER_DIR)) rmSync(LEDGER_DIR, { recursive: true, force: true });
  ctx = await lab.boot('harness-lab', lab.profilePath, [], undefined, lab.bareModuleBaseUrl);
  // ---- P0: real services + registration via official definitions() ----
  step('P0 真实服务挂载（ToolsService + SystemPrompt）',
    !!(ctx.tools && typeof ctx.tools.guard === 'function' && typeof ctx.tools.checkGuards === 'function'));
  let defs = [];
  try { defs = ctx.tools.definitions(undefined); } catch (e) { defs = { err: String(e) }; }
  const names = Array.isArray(defs) ? defs.map(d => d.name) : defs;
  step('P0 全部 13 个研究契约工具注册在案（官方 definitions() 可见）',
    Array.isArray(names) && [
      'findings_record', 'findings_status', 'findings_aggregate', 'findings_challenge',
      'findings_route', 'findings_verify', 'findings_gate_skip', 'findings_unknown', 'findings_resolve',
      'findings_ingest', 'findings_mark_verified', 'findings_spans', 'alignment_record',
    ].every(n => names.includes(n)),
    Array.isArray(names) ? names.join(',') : JSON.stringify(names).slice(0, 120));
  const recDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_record') : null;
  step('P0 注册定义带 schema + execute + render',
    !!(recDef?.parameters?.properties?.entries && typeof recDef?.execute === 'function' && typeof recDef?.output?.render === 'function'));

  // ---- P1: 无 provenance 当场拒（官方守卫链）----
  const deny = ctx.tools.checkGuards({ name: 'findings_record', args: { entries: [{ claim: '无出处的断言内容', confidence: 'observed' }] } });
  step('P1 无 provenance 被官方守卫链拒绝',
    String(deny?.reason ?? '').includes('EVIDENCE_NO_PROVENANCE'),
    '模型可见: ' + (deny ? ('Error: ' + deny.reason.slice(0, 80) + '…') : '(放行了!)'));

  // ---- P1b: 真执行入账（带 provenance，走 def.execute 真路径）----
  const out = await recDef.execute({ entries: [{ claim: 'example.com 主从模式 Plus 档开放', confidence: 'observed', provenance: 'https://arxiv.org/html/2610.30808v1' }] }, { name: 'findings_record', agent: undefined });
  step('P1b def.execute 真执行入账', out?.recorded === 1 && out?.ids?.length === 1, JSON.stringify(out));
  const ledgerText = readFileSync(LEDGER_DIR + '/ledger.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  step('P1b ledger.jsonl 物化且可溯源', ledgerText.some(e => e.kind === 'finding' && e.provenance?.startsWith('https://arxiv')),
    'lines: ' + ledgerText.map(e => e.kind).join(','));
  const guardLog = readFileSync(LEDGER_DIR + '/guard-log.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const wiredEntry = guardLog.find(g => g.kind === 'wired');
  step('P1 拒绝留痕 guard-log.jsonl（wired 版本对齐 + denial）',
    wiredEntry?.version === PKG_VERSION && wiredEntry?.tools?.length === 13 && guardLog.some(g => g.code === 'EVIDENCE_NO_PROVENANCE'),
    'v=' + wiredEntry?.version + ' | ' + guardLog.map(g => g.kind + (g.code ? ':' + g.code : '')).join(' | '));

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
  const verifyDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_verify') : null;
  const v1 = verifyDef ? await verifyDef.execute({}, { name: 'findings_verify' }) : null;
  step('P5 findings_verify 收据核对（机制写入行全 ok）',
    v1?.ok === true && v1?.checked >= 1 && (v1?.drifted?.length ?? 1) === 0, JSON.stringify(v1));
  const lf = LEDGER_DIR + '/ledger.jsonl';
  const rawLines = readFileSync(lf, 'utf8').split('\n').filter(Boolean);
  const backupLine = rawLines[rawLines.length - 1];
  rawLines[rawLines.length - 1] = backupLine + ' '; // 手改：行尾加空格（JSON 仍可解析，哈希必变）
  writeFileSync(lf, rawLines.join('\n') + '\n', 'utf8');
  const v2 = verifyDef ? await verifyDef.execute({}, { name: 'findings_verify' }) : null;
  step('P5 手改一行 → drifted 立即可检',
    v2?.ok === false && v2?.drifted?.length === 1, JSON.stringify(v2?.drifted));
  rawLines[rawLines.length - 1] = backupLine;
  writeFileSync(lf, rawLines.join('\n') + '\n', 'utf8');
  const v3 = verifyDef ? await verifyDef.execute({}, { name: 'findings_verify' }) : null;
  step('P5 还原后 verify 恢复 ok', v3?.ok === true, 'unverified=' + (v3?.unverified ?? '?'));

  // ---- P6: 软门禁跳过（v0.4）：缺字段拒；全字段覆盖后放行 ----
  const skipDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_gate_skip') : null;
  const u6 = ledger.addUnknown({ what: '上游数据集未发布', classification: 'blocker' });
  const deny6 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P6 新 blocker 再挡 complete',
    String(deny6?.reason ?? '').includes('EVIDENCE_BLOCKERS_OPEN'), '');
  let skipErr = '';
  try { await skipDef.execute({ gate: 'EVIDENCE_BLOCKERS_OPEN', reason: '等上游发布', risk: '结论外推受限', compensation: '' }, { name: 'findings_gate_skip' }); }
  catch (e) { skipErr = String(e?.message ?? e); }
  step('P6 gate-skip 缺 compensation 被拒', skipErr.includes('GATE_SKIP_BAD_FIELD'), skipErr.slice(0, 90));
  const skipOut = await skipDef.execute({
    gate: 'EVIDENCE_BLOCKERS_OPEN',
    reason: '上游数据集未发布，无法获取',
    risk: '结论对该数据集外推受限',
    compensation: '上游发布后补跑基准并 record 新条目',
    covers: [u6.id],
  }, { name: 'findings_gate_skip' });
  const pass6 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P6 全字段 skip 覆盖后 complete 放行',
    skipOut?.skipped === 1 && pass6 === undefined, 'skip id=' + skipOut?.id + ' covers=' + u6.id);

  // ---- P7: 插件工具对齐（v0.6 unknown/resolve + 带 acceptance 的 route + 修复轮上限）----
  const unknownDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_unknown') : null;
  const resolveDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_resolve') : null;
  const u7 = unknownDef ? await unknownDef.execute({ what: '协议测试缺口', classification: 'blocker' }, { name: 'findings_unknown' }) : null;
  const deny7 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  const res7 = resolveDef && u7?.id ? await resolveDef.execute({ id: u7.id, resolution: '真实上下文已验证解决' }, { name: 'findings_resolve' }) : null;
  const pass7 = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
  step('P7b findings_unknown(blocker) → 挡 complete → findings_resolve 放行',
    !!u7?.id && String(deny7?.reason ?? '').includes('EVIDENCE_BLOCKERS_OPEN') && res7?.status === 'resolved' && pass7 === undefined,
    'id=' + u7?.id + ' resolved=' + res7?.id);

  const routeDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_route') : null;
  const r7cont = routeDef ? await routeDef.execute({ acceptance: { minFindings: 99 } }, { name: 'findings_route' }) : null;
  const r7 = routeDef ? await routeDef.execute({ acceptance: { minFindings: 1, minObservedRatio: 1 } }, { name: 'findings_route' }) : null;
  const routeCheckCount = new Ledger(LEDGER_DIR).entries().filter(e => e.kind === 'route-check').length;
  step('P7 findings_route acceptance 充分性路由并自动落 route-check',
    r7cont?.action === 'continue-recording' && r7?.action === 'run-acceptance' && routeCheckCount >= 2,
    'cont=' + r7cont?.action + ' pass=' + r7?.action + ' checks=' + routeCheckCount);
  const r7b = routeDef ? await routeDef.execute({ repairFailed: true }, { name: 'findings_route' }) : null;
  const r7c = routeDef ? await routeDef.execute({ repairFailed: true }, { name: 'findings_route' }) : null;
  step('P7 修复轮 2/2（delegate）→ BLOCKED',
    r7b?.action !== 'BLOCKED' && r7c?.action === 'BLOCKED', 'round1=' + r7b?.action + ' round2=' + r7c?.action);

  // ---- P8: 技能进化闭环（v0.5）：真实 boot 内跑独立临时 fixture，结束后无残留 ----
  const p8Expect = (condition, message) => { if (!condition) throw new Error(message); };
  const p8Check = (name, check) => {
    try {
      const detail = check();
      step(name, true, typeof detail === 'string' ? detail : JSON.stringify(detail));
    } catch (error) {
      step(name, false, String(error?.message ?? error).slice(0, 240));
    }
  };
  const p8SkillRel = 'skills/p8-fixture/SKILL.md';
  const p8EvalsRel = 'evals/skills/p8-fixture';
  const p8Parent = '# P8 fixture\n\nBase guidance.\n';
  const p8Kept = p8Parent + '\nAlways record the random seed for reproducible sampling.\n';
  const p8FixtureLib = '// fixture evaluator code; never imported or executed\n';
  let p8Root = '';
  let p8Main;
  let p8Forbidden;
  const p8WriteProposal = (id, file, newContent) => {
    p8Expect(p8Root, 'fixture 尚未创建');
    const path = join(p8Root, '.tmp', 'proposals', id + '.json');
    writeFileSync(path, JSON.stringify({
      id, rationale: 'P8 isolated fixture behavior proposal',
      mutations: [{ file, new_content: newContent }],
    }, null, 2) + '\n', 'utf8');
    return path;
  };
  const p8WriteVerdicts = (applied, controlHardPass, treatmentHardPass) => {
    const manifest = JSON.parse(readFileSync(join(
      p8Root, '.evolve', 'p8-main', 'gens', 'gen' + applied.gen + '.json'), 'utf8'));
    const cases = JSON.parse(readFileSync(join(
      p8Root, p8EvalsRel, 'behavior-cases.json'), 'utf8')).cases;
    for (const label of ['A', 'B']) {
      const role = manifest.labels[label];
      const hardPass = role === 'control' ? controlHardPass : treatmentHardPass;
      const results = Object.fromEntries(cases.map(item => [
        item.id, !item.hard || hardPass ? 'pass' : 'fail',
      ]));
      const evidence = Object.fromEntries(cases.map(item => [
        item.id, role + ' fixture text for ' + item.id,
      ]));
      writeFileSync(manifest.packets[label].verdict_path, JSON.stringify({
        packet_id: manifest.packets[label].packet_id, results, evidence,
      }, null, 2) + '\n', 'utf8');
    }
  };
  try {
    p8Root = mkdtempSync(join(tmpdir(), 'dsh-research-harness-p8-'));
    for (const dir of [
      join(p8Root, 'skills', 'p8-fixture'), join(p8Root, p8EvalsRel),
      join(p8Root, 'lib'), join(p8Root, 'bin'), join(p8Root, 'test'),
      join(p8Root, 'harness-lab'), join(p8Root, '.tmp', 'proposals'),
    ]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(p8Root, p8SkillRel), p8Parent, 'utf8');
    writeFileSync(join(p8Root, p8EvalsRel, 'behavior-cases.json'), JSON.stringify({
      cases: [
        { id: 'base', prompt: 'Does the fixture retain its base guidance?' },
        { id: 'seed', prompt: 'Does the fixture require a reproducible random seed?', hard: true },
      ],
    }, null, 2) + '\n', 'utf8');
    writeFileSync(join(p8Root, p8EvalsRel, 'rubric.md'),
      '# Frozen P8 rubric\n\nPass seed only when reproducible random-seed guidance is explicit.\n', 'utf8');
    writeFileSync(join(p8Root, 'lib', 'evolve.js'), p8FixtureLib, 'utf8');
    writeFileSync(join(p8Root, 'bin', 'fixture.mjs'), '// fixture bin\n', 'utf8');
    writeFileSync(join(p8Root, 'test', 'fixture.test.mjs'), '// fixture test\n', 'utf8');
    writeFileSync(join(p8Root, 'harness-lab', 'protocol.mjs'), '// fixture protocol\n', 'utf8');
    p8Main = new Evolver(p8Root, 'p8-main');

    p8Check('P8 真实 boot 上下文 init：独立 surface + 冻结 evaluator', () => {
      const contract = p8Main.init({ surface: 'skills/p8-fixture/**', evalsDir: p8EvalsRel });
      p8Expect(!!ctx.tools && contract.gen === 0, '真实 boot 或 gen=0 不成立');
      p8Expect(contract.surface === 'skills/p8-fixture/**' && contract.evals_dir === p8EvalsRel,
        'surface/evals_dir 契约不符');
      p8Expect(/^[0-9a-f]{64}$/.test(contract.evaluator_id), 'evaluator_id 不是 SHA-256');
      return 'evaluator=' + contract.evaluator_id.slice(0, 12) + ' fixture=' + p8Root;
    });

    let applied;
    p8Check('P8 applyProposal：候选落盘并生成随机 A/B packet', () => {
      applied = p8Main.applyProposal(p8WriteProposal('p8-keep', p8SkillRel, p8Kept));
      p8Expect(applied?.status === 'applied' && applied.gen === 1, JSON.stringify(applied));
      p8Expect(readFileSync(join(p8Root, p8SkillRel), 'utf8') === p8Kept, '候选正文未落盘');
      for (const label of ['A', 'B']) {
        const packet = JSON.parse(readFileSync(applied.packets[label].path, 'utf8'));
        p8Expect(packet.packet_id === applied.packets[label].packet_id && packet.cases.length === 2,
          'packet ' + label + ' 不完整');
        p8Expect(!JSON.stringify(packet).includes('"labels"'), 'packet 泄漏 control/treatment 映射');
      }
      return 'gen=1 packets=' + applied.verdict_paths.length;
    });

    p8Check('P8 select：配对揭盲 keep + Ledger champion 记录', () => {
      p8WriteVerdicts(applied, false, true);
      const fixtureLedger = new Ledger(join(p8Root, '.research'), { receipts: true });
      const selected = p8Main.select({ ledger: fixtureLedger });
      p8Expect(selected.decision === 'kept' && selected.gen === 1 && selected.candidate === 'p8-keep',
        JSON.stringify(selected));
      p8Expect(selected.control_score === 0.5 && selected.treatment_score === 1, '配对评分不符');
      p8Expect(selected.champion_record && fixtureLedger.entries().some(entry =>
        entry.kind === 'evolve-champion' && entry.candidate === 'p8-keep'), 'champion 未落 Ledger');
      return 'decision=kept score=0.5→1 record=' + selected.champion_record;
    });

    p8Check('P8 verifyArchive + champion：kept 谱系与收据一致', () => {
      const verified = p8Main.verifyArchive();
      const champion = p8Main.champion();
      p8Expect(verified.ok && verified.checked >= 3 && verified.drifted.length === 0, JSON.stringify(verified));
      p8Expect(champion?.candidate === 'p8-keep' && champion.gen === 1, JSON.stringify(champion));
      return 'checked=' + verified.checked + ' champion=' + champion.candidate + '@gen' + champion.gen;
    });

    p8Check('P8 第二候选 apply：从 champion 父本派生 gen2', () => {
      const styleOnly = '# P8 fixture\n\nBase guidance, style-only rewrite.\n';
      applied = p8Main.applyProposal(p8WriteProposal('p8-revert', p8SkillRel, styleOnly));
      p8Expect(applied?.status === 'applied' && applied.gen === 2, JSON.stringify(applied));
      p8Expect(readFileSync(join(p8Root, p8SkillRel), 'utf8') === styleOnly, 'gen2 候选未落盘');
      return 'gen=2 candidate=' + applied.candidate;
    });

    p8Check('P8 select revert：恢复 champion 字节且 champion 不后退', () => {
      p8WriteVerdicts(applied, true, false);
      const selected = p8Main.select();
      p8Expect(selected.decision === 'reverted' && selected.gen === 2, JSON.stringify(selected));
      p8Expect(readFileSync(join(p8Root, p8SkillRel), 'utf8') === p8Kept, 'revert 未恢复父本原字节');
      p8Expect(selected.champion?.candidate === 'p8-keep' && selected.champion.gen === 1,
        'revert 后 champion 漂移');
      return 'decision=reverted restored=' + selected.champion.candidate + '@gen1';
    });

    p8Check('P8 三禁 init：include ** 也不能覆盖隐式排除', () => {
      p8Forbidden = new Evolver(p8Root, 'p8-forbidden');
      const contract = p8Forbidden.init({ surface: '**', evalsDir: p8EvalsRel });
      p8Expect(contract.evaluator_id === p8Main.contract().evaluator_id, '同 fixture evaluator 指纹不一致');
      return 'surface=** evaluator=' + contract.evaluator_id.slice(0, 12);
    });

    const p8ApplyForbidden = (id, file) => {
      const before = readFileSync(join(p8Root, p8SkillRel), 'utf8');
      const outcome = p8Forbidden.applyProposal(p8WriteProposal(id, file, 'forbidden mutation\n'));
      p8Expect(outcome?.status === 'invalid' && outcome.code === 'EVOLVE_SURFACE_EXCLUDED', JSON.stringify(outcome));
      p8Expect(outcome.candidate === id && p8Forbidden.contract().gen === 0, 'invalid 候选或 gen 记账不符');
      p8Expect(readFileSync(join(p8Root, p8SkillRel), 'utf8') === before, 'invalid 改动了 genome');
      p8Expect(p8Forbidden.log().some(event => event.event === 'invalid' && event.candidate === id &&
        event.code === 'EVOLVE_SURFACE_EXCLUDED'), 'invalid 未入谱系');
      return outcome.code + ' ' + file;
    };
    p8Check('P8 三禁① 评估资产 invalid（evals/**）',
      () => p8ApplyForbidden('p8-ban-evals', p8EvalsRel + '/rubric.md'));
    p8Check('P8 三禁② ledger invalid（.research/**）',
      () => p8ApplyForbidden('p8-ban-ledger', '.research/ledger.jsonl'));
    p8Check('P8 三禁③ 插件代码 invalid（lib/**）',
      () => p8ApplyForbidden('p8-ban-code', 'lib/evolve.js'));

    p8Check('P8 evaluator 指纹漂移 invalid 且不写候选', () => {
      const before = readFileSync(join(p8Root, p8SkillRel), 'utf8');
      let outcome;
      try {
        writeFileSync(join(p8Root, 'lib', 'evolve.js'), p8FixtureLib + '// external drift\n', 'utf8');
        outcome = p8Main.applyProposal(p8WriteProposal('p8-drift', p8SkillRel, p8Kept + '\nDrift attempt.\n'));
        p8Expect(outcome?.status === 'invalid' && outcome.code === 'EVOLVE_EVALUATOR_DRIFT', JSON.stringify(outcome));
        p8Expect(readFileSync(join(p8Root, p8SkillRel), 'utf8') === before, '指纹漂移后候选被写入');
      } finally {
        writeFileSync(join(p8Root, 'lib', 'evolve.js'), p8FixtureLib, 'utf8');
      }
      return outcome.code + ' genome=unchanged';
    });

    p8Check('P8 终态 verify/champion：三禁 invalid 全留痕且收据可验', () => {
      const mainVerified = p8Main.verifyArchive();
      const forbiddenVerified = p8Forbidden.verifyArchive();
      const invalid = p8Forbidden.log().filter(event => event.event === 'invalid');
      p8Expect(mainVerified.ok && forbiddenVerified.ok, JSON.stringify({ mainVerified, forbiddenVerified }));
      p8Expect(invalid.length === 3 && ['p8-ban-evals', 'p8-ban-ledger', 'p8-ban-code'].every(id =>
        invalid.some(event => event.candidate === id)), '三禁 invalid 谱系不完整');
      p8Expect(p8Main.log().some(event => event.event === 'invalid' && event.candidate === 'p8-drift' &&
        event.code === 'EVOLVE_EVALUATOR_DRIFT'), '指纹漂移 invalid 未留痕');
      p8Expect(p8Main.champion()?.candidate === 'p8-keep' && p8Main.champion()?.gen === 1, '终态 champion 不符');
      return 'main=' + mainVerified.checked + ' forbidden=' + forbiddenVerified.checked + ' invalid=3+drift';
    });
  } catch (error) {
    step('P8 fixture 流程异常', false, String(error?.message ?? error).slice(0, 240));
  } finally {
    if (p8Root) {
      try {
        rmSync(p8Root, { recursive: true, force: true });
        step('P8 独立临时 fixture 已清理（发布树无残留）', !existsSync(p8Root), p8Root);
      } catch (error) {
        step('P8 独立临时 fixture 已清理（发布树无残留）', false, String(error?.message ?? error).slice(0, 240));
      }
    }
  }

  // ---- P9: v0.7.0 P0 加固（真实 exec.arguments + 工作区解耦 + verifyAsync）----
  const p9Ws = mkdtempSync(join(tmpdir(), 'dsh-research-harness-p9-'));
  try {
    const p9Pass = ctx.tools.checkGuards({
      name: 'write',
      cwd: p9Ws,
      arguments: { filePath: join(p9Ws, 'note.md') },
    });
    const p9DenyOutside = ctx.tools.checkGuards({
      name: 'write',
      cwd: p9Ws,
      arguments: { filePath: join(LEDGER_DIR, 'escape.md') },
    });
    const p9DenyArg = ctx.tools.checkGuards({
      name: 'findings_record',
      arguments: { entries: [{ claim: 'exec.arguments 无来源', confidence: 'observed' }] },
    });
    step('P9 真实 DSH exec.arguments + 工作区/台账解耦守卫',
      p9Pass === undefined &&
      String(p9DenyOutside?.info?.code ?? '') === 'WRITE_OUTSIDE_WORKSPACE' &&
      String(p9DenyArg?.info?.code ?? '') === 'EVIDENCE_NO_PROVENANCE',
      'wsAllow=' + String(p9Pass) + ' outside=' + p9DenyOutside?.info?.code + ' argGate=' + p9DenyArg?.info?.code);

    const vAsync = createVerifier({
      kind: 'command',
      command: [process.execPath, '-e', 'console.log(JSON.stringify({ pass: true }))'],
    });
    const p9Cmd = await vAsync.verifyAsync(new Ledger(LEDGER_DIR));
    step('P9 verifier(command) verifyAsync 安全执行与 JSON 协议',
      p9Cmd.pass === true && p9Cmd.exitCode === 0,
      JSON.stringify(p9Cmd));
  } finally {
    rmSync(p9Ws, { recursive: true, force: true });
  }

  // ---- P10: v0.8.0 P1 工具面扩展（ingest/mark-verified、spans、alignment_record、按 task 持久化 repairFailed）----
  const p10Ws = mkdtempSync(join(tmpdir(), 'dsh-research-harness-p10-'));
  try {
    const ingestDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_ingest') : null;
    const mvDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_mark_verified') : null;
    const ingOut = ingestDef
      ? await ingestDef.execute({
          source: 'p10-subagent',
          task: 'TASK-1001',
          markdown: '```findings\n[{"claim":"P10 子代理实测吞吐提升 12%","confidence":"observed","provenance":"tool:pytest"}]\n```\n',
        }, { name: 'findings_ingest', cwd: p10Ws })
      : null;
    const mvOut = mvDef && ingOut?.ids?.[0]
      ? await mvDef.execute({ id: ingOut.ids[0], note: 'P10 主控亲验通过' }, { name: 'findings_mark_verified' })
      : null;
    step('P10 findings_ingest + findings_mark_verified 闭环',
      ingOut?.ingested === 1 && mvOut?.status === 'lead-verified' && mvOut?.ref === ingOut.ids[0],
      'ingested=' + JSON.stringify(ingOut?.ids) + ' verified=' + mvOut?.id);

    const spanExec = { name: 'read', callId: 'p10-call-1', cwd: p10Ws, arguments: { filePath: join(p10Ws, 'data.txt') } };
    writeFileSync(join(p10Ws, 'data.txt'), 'ok\n', 'utf8');
    ctx.tools.checkGuards(spanExec);
    ctx.emit('tools/result', spanExec, { content: [{ type: 'text', text: 'ok' }], isError: false });
    const spansDef = Array.isArray(defs) ? defs.find(d => d.name === 'findings_spans') : null;
    const spanOut = spansDef ? await spansDef.execute({ limit: 10 }, { name: 'findings_spans' }) : null;
    step('P10 SpanRecorder + findings_spans 观测闭合',
      existsSync(join(LEDGER_DIR, 'spans.jsonl')) && spanOut?.totalCalls >= 1 && Array.isArray(spanOut?.ranking) && spanOut.ranking.length >= 1,
      'calls=' + spanOut?.totalCalls + ' top=' + spanOut?.ranking?.[0]?.tool);

    const alignDef = Array.isArray(defs) ? defs.find(d => d.name === 'alignment_record') : null;
    const alignOut = alignDef
      ? await alignDef.execute({
          slug: 'p10-proto',
          topic: 'P10 协议预期对齐',
          layers: {
            goal: '验证真实 DSH 上下文持久化对齐卡',
            constraints: '禁止绕过 evidence gate',
            deliverables: ['alignment markdown', 'ledger sync entries'],
            success_criteria: '文件可读且未知项与 reframe 同步入账',
            assumptions: 'p10Ws 为隔离工作区',
            non_goals: '不修改源码树',
          },
          probes: [
            { layer: 'goal', question: '是否重构核心架构?', verdict: 'reframe', note: '仅验证契约闭环' },
          ],
          open_unknowns: [
            { what: '远端指标延迟尚未测量', classification: 'non-blocker', why: '本地协议验收暂不依赖' },
          ],
        }, { name: 'alignment_record', cwd: p10Ws })
      : null;
    const alignFile = join(p10Ws, '.research', 'alignment', 'p10-proto.md');
    const es10 = new Ledger(LEDGER_DIR).entries();
    step('P10 alignment_record 持久化对齐卡与同步 ledger',
      alignOut?.slug === 'p10-proto' && alignOut?.unknownsAdded === 1 && alignOut?.reframesRecorded === 1
      && existsSync(alignFile) && es10.some(e => e.kind === 'alignment-reframe' && e.slug === 'p10-proto'),
      'path=' + alignOut?.path);

    const routeDef10 = Array.isArray(defs) ? defs.find(d => d.name === 'findings_route') : null;
    const rA1 = routeDef10 ? await routeDef10.execute({ task: 'TASK-P10A', repairFailed: true }, { name: 'findings_route' }) : null;
    const rA2 = routeDef10 ? await routeDef10.execute({ task: 'TASK-P10A', repairFailed: true }, { name: 'findings_route' }) : null;
    const rB1 = routeDef10 ? await routeDef10.execute({ task: 'TASK-P10B' }, { name: 'findings_route' }) : null;
    step('P10 findings_route 按 task 持久化 repairFailed（不串任务）',
      rA1?.action !== 'BLOCKED' && rA2?.action === 'BLOCKED' && rA2?.detail?.task === 'TASK-P10A' && rB1?.action !== 'BLOCKED',
      'A1=' + rA1?.action + ' A2=' + rA2?.action + ' B1=' + rB1?.action);
  } finally {
    rmSync(p10Ws, { recursive: true, force: true });
  }

  // ---- P11: v0.8.1 安全与契约加固（真实 apply_patch input / str_replace_editor / ingest-complete 闭环）----
  const p11Ws = mkdtempSync(join(tmpdir(), 'dsh-research-harness-p11-'));
  try {
    writeFileSync(join(p11Ws, 'p11-target.txt'), 'baseline\n', 'utf8');

    const p11PatchDeny = ctx.tools.checkGuards({
      name: 'apply_patch',
      cwd: p11Ws,
      arguments: { input: '*** Begin Patch\n*** Add File: ../p11-evil.txt\n*** End Patch' },
    });
    const p11PatchAllow = ctx.tools.checkGuards({
      name: 'apply_patch',
      cwd: p11Ws,
      arguments: { input: '*** Begin Patch\n*** Add File: p11-ok.txt\n*** End Patch' },
    });
    const p11EditorDeny = ctx.tools.checkGuards({
      name: 'str_replace_editor',
      cwd: p11Ws,
      arguments: { command: 'str_replace', path: join(LEDGER_DIR, 'evil.txt') },
    });
    const p11EditorAllow = ctx.tools.checkGuards({
      name: 'str_replace_editor',
      cwd: p11Ws,
      arguments: { command: 'view', path: join(p11Ws, 'p11-target.txt') },
    });
    step('P11 真实 DSH apply_patch(input) 与 str_replace_editor 守卫',
      p11PatchDeny?.info?.code === 'WRITE_OUTSIDE_WORKSPACE'
      && p11PatchAllow === undefined
      && p11EditorDeny?.info?.code === 'WRITE_OUTSIDE_WORKSPACE'
      && p11EditorAllow === undefined,
      'patch=' + p11PatchDeny?.info?.code + ' editor=' + p11EditorDeny?.info?.code);

    const p11IsoSubWs = join(p11Ws, 'ws');
    const p11IsoLedger = join(p11Ws, 'ledger');
    const p11Profile = join(p11Ws, 'p11-cordis.yml');
    mkdirSync(p11IsoSubWs, { recursive: true });
    writeFileSync(join(p11Ws, 'outside.txt'), 'secret-outside\n', 'utf8');
    writeFileSync(p11Profile, [
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: skill',
      "  name: '@deepseek-ai/dsh-skill'",
      '- id: research-harness-core',
      '  name: ' + JSON.stringify(join(REPO_ROOT, 'lib', 'index.js')),
      '  config:',
      '    clusterScale: delegate',
      '    ledgerRoot: ' + JSON.stringify(p11IsoLedger),
      '    workspaceRoot: ' + JSON.stringify(p11IsoSubWs),
      '    enforceReadInsideWorkspace: true',
      '    verifier:',
      '      kind: evidence',
      '      enabled: true',
      '      checkFileExists: true',
    ].join('\n') + '\n', 'utf8');

    let ctxP11;
    try {
      ctxP11 = await lab.boot('harness-lab-p11', p11Profile, [], undefined, lab.bareModuleBaseUrl);
      const defsP11 = ctxP11.tools.definitions(undefined);
      const ingP11 = defsP11.find(d => d.name === 'findings_ingest');
      const mvP11 = defsP11.find(d => d.name === 'findings_mark_verified');

      const p11ReadDeny = ctxP11.tools.checkGuards({
        name: 'read',
        cwd: p11IsoSubWs,
        arguments: { filePath: join(p11Ws, 'outside.txt') },
      });

      const ingOk1 = await ingP11.execute({
        source: 'p11-sub',
        task: 'TASK-1101',
        markdown: '```findings\n[{"claim":"P11 子报告引用数据文件","confidence":"observed","provenance":"p11-data.csv:1"}]\n```\n',
      }, { name: 'findings_ingest', cwd: p11IsoSubWs });

      const p11CompleteDenyMissing = ctxP11.tools.checkGuards({
        name: 'update_goal',
        cwd: p11IsoSubWs,
        arguments: { action: 'complete' },
      });

      writeFileSync(join(p11IsoSubWs, 'p11-data.csv'), 'x\n1\n', 'utf8');
      const mv11 = await mvP11.execute({ id: ingOk1.ids[0], note: 'P11 文件已落盘核验' }, { name: 'findings_mark_verified', cwd: p11IsoSubWs });
      const p11CompletePass = ctxP11.tools.checkGuards({
        name: 'update_goal',
        cwd: p11IsoSubWs,
        arguments: { action: 'complete' },
      });

      await ingP11.execute({
        source: 'p11-empty',
        task: 'TASK-1102',
        markdown: '```findings\n[{"claim":"P11 无来源子报告占位应被拦截","confidence":"observed"}]\n```\n',
      }, { name: 'findings_ingest', cwd: p11IsoSubWs });
      const p11CompleteDenyPlaceholder = ctxP11.tools.checkGuards({
        name: 'update_goal',
        cwd: p11IsoSubWs,
        arguments: { action: 'complete' },
      });

      step('P11 enforceReadInsideWorkspace + report:<source> file provenance + 无标占位拒绝闭环',
        p11ReadDeny?.info?.code === 'READ_OUTSIDE_WORKSPACE'
        && p11CompleteDenyMissing?.info?.code === 'EVIDENCE_VERIFY_FAILED'
        && mv11?.status === 'lead-verified'
        && p11CompletePass === undefined
        && p11CompleteDenyPlaceholder?.info?.code === 'EVIDENCE_VERIFY_FAILED',
        'read=' + p11ReadDeny?.info?.code
          + ' missing=' + p11CompleteDenyMissing?.info?.code
          + ' pass=' + String(p11CompletePass)
          + ' placeholder=' + p11CompleteDenyPlaceholder?.info?.code);

      // P11b: 用真实 @deepseek-ai/dsh-tools validateJsonSchemaValue 对全部 13 工具真实输出做全量校验
      const { validateJsonSchemaValue, assertSupportedJsonSchema } = await import(
        new URL('@deepseek-ai/dsh-tools/lib/index.js', lab.bareModuleBaseUrl).href
      );
      const p11SchemaWs = join(p11Ws, 'ws-schema');
      const p11SchemaLedger = join(p11Ws, 'ledger-schema');
      const p11SchemaProfile = join(p11Ws, 'p11-schema-cordis.yml');
      mkdirSync(p11SchemaWs, { recursive: true });
      writeFileSync(join(p11SchemaWs, 'd.csv'), 'k\n1\n', 'utf8');
      writeFileSync(p11SchemaProfile, [
        '- id: system-prompt',
        "  name: '@deepseek-ai/dsh-system-prompt'",
        '- id: tools',
        "  name: '@deepseek-ai/dsh-tools'",
        '- id: skill',
        "  name: '@deepseek-ai/dsh-skill'",
        '- id: research-harness-core',
        '  name: ' + JSON.stringify(join(REPO_ROOT, 'lib', 'index.js')),
        '  config:',
        '    clusterScale: delegate',
        '    ledgerRoot: ' + JSON.stringify(p11SchemaLedger),
        '    workspaceRoot: ' + JSON.stringify(p11SchemaWs),
      ].join('\n') + '\n', 'utf8');
      let ctxSchema;
      try {
        ctxSchema = await lab.boot('harness-lab-p11-schema', p11SchemaProfile, [], undefined, lab.bareModuleBaseUrl);
        const sDefs = ctxSchema.tools.definitions(undefined);
        const byS = Object.fromEntries(sDefs.map(d => [d.name, d]));
        const schemaErrs = [];
        const checkOut = async (toolName, execArgs) => {
          const defObj = byS[toolName];
          assertSupportedJsonSchema(defObj.output.schema, toolName + '.output');
          const outVal = await defObj.execute(execArgs, { name: toolName, cwd: p11SchemaWs });
          const v = validateJsonSchemaValue(defObj.output.schema, outVal);
          if (v.length) schemaErrs.push(toolName + ': ' + v.join('; '));
          return outVal;
        };

        await checkOut('findings_aggregate', {}); // empty ledger -> rate: null
        await checkOut('findings_status', {});
        const recS = await checkOut('findings_record', {
          entries: [
            { claim: 'metric_x', confidence: 'observed', provenance: 'd.csv:1', metric: 0.71 },
            { claim: 'metric_x', confidence: 'observed', provenance: 'd.csv:2', metric: 0.75 },
          ],
        });
        await checkOut('findings_status', {});
        await checkOut('findings_aggregate', {}); // multi-seed -> meanSem
        const chS = await checkOut('findings_challenge', {
          ref: recS.ids[0], hypothesis: '反例假设陈述', cito: 'disagreesWith', provenance: 'd.csv:1',
        });
        await checkOut('findings_resolve', { id: chS.id, kind: 'challenge', resolution: '核实成立' });
        const unkS = await checkOut('findings_unknown', { what: '缺口S', classification: 'blocker' });
        await checkOut('findings_gate_skip', {
          gate: 'EVIDENCE_BLOCKERS_OPEN', reason: '验证输出格式', risk: '临时跳过风险', compensation: '即刻验证关闭', covers: [unkS.id],
        });
        await checkOut('findings_route', { task: 'TASK-0011' });
        await checkOut('findings_verify', {});
        const ingS = await checkOut('findings_ingest', {
          source: 'schema-sub', markdown: '```findings\n[{"claim":"ingest output test","confidence":"observed","provenance":"d.csv:1"}]\n```\n',
        });
        await checkOut('findings_mark_verified', { id: ingS.ids[0], note: 'schema 核验' });
        await checkOut('findings_spans', { limit: 5 });
        await checkOut('alignment_record', {
          slug: 'schema-card',
          topic: 'schema validation',
          layers: { goal: 'g', constraints: 'c', deliverables: 'd', success_criteria: 's', assumptions: 'a', non_goals: 'n' },
        });
        step('P11b 全部 13 个工具真实 execute() 返回值均通过 @deepseek-ai/dsh-tools validateJsonSchemaValue',
          schemaErrs.length === 0,
          schemaErrs.length ? schemaErrs.join(' | ') : '13/13 output schemas valid');
      } finally {
        try { await ctxSchema?.fiber?.dispose(); } catch {}
      }
    } finally {
      try { await ctxP11?.fiber?.dispose(); } catch {}
    }
  } finally {
    rmSync(p11Ws, { recursive: true, force: true });
  }

  // ---- P12: v0.9.0 离线 Shell 联网守卫 + 增量入账门 + 预算感知收尾（真实 cordis 运行时）----
  const p12Ws = mkdtempSync(join(tmpdir(), 'dsh-research-harness-p12-'));
  try {
    const p12SubWs = join(p12Ws, 'ws');
    const p12Ledger = join(p12Ws, 'ledger');
    const p12Profile = join(p12Ws, 'p12-cordis.yml');
    mkdirSync(p12SubWs, { recursive: true });
    writeFileSync(join(p12SubWs, 'sample.csv'), 'x,y\n1,2\n', 'utf8');
    writeFileSync(p12Profile, [
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: skill',
      "  name: '@deepseek-ai/dsh-skill'",
      '- id: research-harness-core',
      '  name: ' + JSON.stringify(join(REPO_ROOT, 'lib', 'index.js')),
      '  config:',
      '    clusterScale: delegate',
      '    ledgerRoot: ' + JSON.stringify(p12Ledger),
      '    workspaceRoot: ' + JSON.stringify(p12SubWs),
      '    enforceReadInsideWorkspace: true',
      '    enforceOfflineShell: true',
      '    incrementalCheckpoint:',
      '      enabled: true',
      '      maxAnalysisCalls: 2',
      '    budget:',
      '      maxToolCalls: 6',
      '      warnRatio: 0.5',
      '      hardFinalizeRatio: 0.8',
    ].join('\n') + '\n', 'utf8');

    const { validateJsonSchemaValue } = await import(
      new URL('@deepseek-ai/dsh-tools/lib/index.js', lab.bareModuleBaseUrl).href
    );
    let ctxP12;
    try {
      ctxP12 = await lab.boot('harness-lab-p12', p12Profile, [], undefined, lab.bareModuleBaseUrl);
      const defsP12 = ctxP12.tools.definitions(undefined);
      const byP12 = Object.fromEntries(defsP12.map(d => [d.name, d]));

      const p12NetDeny = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'Invoke-RestMethod https://api.openalex.org/works/1' },
      });
      const p12Local1 = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'python -B analyze1.py' },
      });
      const p12Local2 = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'python -B analyze2.py' },
      });
      const p12IncDeny = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'python -B analyze3.py' },
      });
      const p12ReadOk = ctxP12.tools.checkGuards({
        name: 'read',
        cwd: p12SubWs,
        arguments: { filePath: join(p12SubWs, 'sample.csv') },
      });
      const recArgs = { entries: [{ claim: 'P12 本地样本行数=1', confidence: 'observed', provenance: 'sample.csv:1' }] };
      const p12RecGuard = ctxP12.tools.checkGuards({ name: 'findings_record', cwd: p12SubWs, arguments: recArgs });
      await byP12.findings_record.execute(recArgs, { name: 'findings_record', cwd: p12SubWs });

      // 此时已放行 4 次（pwsh*2 + read*1 + findings_record*1），第 5 次（4/6=0.667 < 0.8 且增量已清零）应放行解锁！
      const p12Unlocked = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'python -B analyze3.py' },
      });
      // 第 6 次（5/6=0.833 >= 0.8）先看 findings_route → finalize-now，再调 pwsh → BUDGET_FINALIZE_REQUIRED
      const p12RouteGuard = ctxP12.tools.checkGuards({ name: 'findings_route', cwd: p12SubWs, arguments: {} });
      const routeOut = await byP12.findings_route.execute({}, { name: 'findings_route', cwd: p12SubWs });
      const routeErrs = validateJsonSchemaValue(byP12.findings_route.output.schema, routeOut);

      const p12BudgetDeny = ctxP12.tools.checkGuards({
        name: 'pwsh',
        cwd: p12SubWs,
        arguments: { command: 'python -B analyze4.py' },
      });
      const p12VerifyGuard = ctxP12.tools.checkGuards({ name: 'findings_verify', cwd: p12SubWs, arguments: {} });
      const verifyOut = await byP12.findings_verify.execute({}, { name: 'findings_verify', cwd: p12SubWs });
      const verifyErrs = validateJsonSchemaValue(byP12.findings_verify.output.schema, verifyOut);

      step('P12 enforceOfflineShell + INCREMENTAL_RECORD_REQUIRED + BUDGET_FINALIZE_REQUIRED 全链真实闭环',
        p12NetDeny?.info?.code === 'SHELL_NETWORK_BLOCKED'
        && p12Local1 === undefined
        && p12Local2 === undefined
        && p12IncDeny?.info?.code === 'INCREMENTAL_RECORD_REQUIRED'
        && p12ReadOk === undefined
        && p12RecGuard === undefined
        && p12Unlocked === undefined
        && p12RouteGuard === undefined
        && routeOut?.action === 'finalize-now'
        && routeErrs.length === 0
        && p12BudgetDeny?.info?.code === 'BUDGET_FINALIZE_REQUIRED'
        && p12VerifyGuard === undefined
        && verifyOut?.ok === true
        && verifyErrs.length === 0,
        'net=' + p12NetDeny?.info?.code
          + ' inc=' + p12IncDeny?.info?.code
          + ' unlocked=' + String(p12Unlocked)
          + ' route=' + routeOut?.action
          + ' budget=' + p12BudgetDeny?.info?.code);
    } finally {
      try { await ctxP12?.fiber?.dispose(); } catch {}
    }
  } finally {
    rmSync(p12Ws, { recursive: true, force: true });
  }

  // ---- verdict ----
  const fails = results.filter(r => !r.pass);
  console.log('\n===== harness-lab 验收: ' + (results.length - fails.length) + '/' + results.length + ' =====');
  if (fails.length) { console.log('FAILED: ' + fails.map(f => f.name).join(' ; ')); process.exitCode = 1; }
} finally {
  try { await ctx?.fiber.dispose(); } catch {}
  lab.cleanup();
}
