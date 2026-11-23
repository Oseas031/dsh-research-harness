import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyPlugin, TOOL_NAME_RE } from '../lib/index.js';
import { check, guardBinaryRead } from '../lib/guards.js';
import { Ledger } from '../lib/ledger.js';
import { completionGate } from '../lib/completion.js';
import { Evolver, sha256Bytes, surfaceViolation } from '../lib/evolve.js';
import { createHarnessSkillProvider } from '../lib/skill-provider.js';
import { gateExec, validateProvenance, verifyFileProvenance } from '../lib/evidence-gate.js';
import { createVerifier } from '../lib/verifier.js';
import { verifyLedger } from '../lib/receipts.js';
import { validateChallenge } from '../lib/challenge.js';
import { validateRepro } from '../lib/repro.js';
import { summarizeInput } from '../lib/spans.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'research-harness.mjs');
const tmp = (prefix = 'rh-v081-') => mkdtempSync(join(tmpdir(), prefix));

test('v0.8.1 P0-1 guards: symlink/junction 逃逸、尾部空格二进制、apply_patch input、str_replace_editor 与 subagent', (t) => {
  const base = tmp('rh-guard-v081-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'confidential\n', 'utf8');
  writeFileSync(join(ws, 'ok.txt'), 'hello\n', 'utf8');

  // Junction / symlink 指向工作区外目录，写与严格读均必须被阻断
  const junc = join(ws, 'escape-link');
  symlinkSync(outside, junc, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(
    check('write', { filePath: join(junc, 'pwn.txt') }, { workspaceRoot: ws }).code,
    'WRITE_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    check('read', { filePath: join(junc, 'secret.txt') }, { workspaceRoot: ws, enforceReadInsideWorkspace: true }).code,
    'READ_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    check('read', { filePath: join(ws, 'ok.txt') }, { workspaceRoot: ws, enforceReadInsideWorkspace: true }),
    null,
  );

  // guardBinaryRead trim + extname（阻断尾部空格绕过，不误杀目录名中的点号）
  assert.equal(guardBinaryRead({ path: join(ws, 'report.pdf   ') }).code, 'READ_BINARY');
  assert.equal(guardBinaryRead({ path: join(ws, 'dir.with.dot', 'notes'), size: 12 }), null);

  // apply_patch 对齐真实 DSH `input` 参数（同时兼容 patchText / patch）
  assert.equal(
    check('apply_patch', { input: '*** Begin Patch\n*** Add File: ../outside.txt\n*** End Patch' }, { workspaceRoot: ws }).code,
    'WRITE_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    check('apply_patch', { input: '*** Begin Patch\n*** Add File: ok-in-ws.txt\n*** End Patch' }, { workspaceRoot: ws }),
    null,
  );

  // str_replace_editor: view 走读守卫；create/str_replace/insert 走写守卫
  assert.equal(
    check('str_replace_editor', { command: 'view', path: join(ws, 'weights.safetensors') }, { workspaceRoot: ws }).code,
    'READ_BINARY',
  );
  assert.equal(
    check('str_replace_editor', { command: 'view', path: join(outside, 'secret.txt') }, { workspaceRoot: ws, enforceReadInsideWorkspace: true }).code,
    'READ_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    check('str_replace_editor', { command: 'view', path: join(ws, 'ok.txt') }, { workspaceRoot: ws, enforceReadInsideWorkspace: true }),
    null,
  );
  for (const cmd of ['create', 'str_replace', 'insert']) {
    assert.equal(
      check('str_replace_editor', { command: cmd, path: join(outside, 'bad.txt') }, { workspaceRoot: ws }).code,
      'WRITE_OUTSIDE_WORKSPACE',
    );
    assert.equal(
      check('str_replace_editor', { command: cmd, path: join(ws, 'ok.txt') }, { workspaceRoot: ws }),
      null,
    );
  }

  // subagent / agent 禁用工具扩充（apply_patch / str_replace_editor / terminal_open / terminal_send）与 cwd 越界拦截
  for (const toolName of ['apply_patch', 'str_replace_editor', 'terminal_open', 'terminal_send']) {
    assert.equal(
      check('subagent', { description: '子任务', prompt: '执行', tools: [toolName], cwd: ws }, { workspaceRoot: ws }).code,
      'AGENT_FORBIDDEN_TOOLS',
    );
  }
  assert.equal(
    check('agent', { description: '子任务', prompt: '执行', tools: ['read'], cwd: outside }, { workspaceRoot: ws }).code,
    'WRITE_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    check('subagent', { description: '子任务', prompt: '执行', tools: ['read'], cwd: ws }, { workspaceRoot: ws }),
    null,
  );
});

test('v0.8.1 P0-2 completionGate: gate-skip 不得跳过 verifier，且通过时落 completion-attempt 重置 repairRounds', (t) => {
  const ws = tmp('rh-comp-v081-');
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const okFile = join(ws, 'evidence.csv');
  writeFileSync(okFile, 'col\n1\n', 'utf8');

  const l = new Ledger(join(ws, '.research'), { receipts: true }).ensure();
  const blk = l.addUnknown({ what: '边缘样本不足', classification: 'blocker' });
  l.recordRepairFailure({ task: 'TASK-0810', reason: '第1次修复失败' });
  assert.equal(l.repairRoundsOf('TASK-0810'), 1);

  l.record({ claim: '引用不存在的文件', confidence: 'observed', provenance: 'missing.csv:1', task: 'TASK-0810' });
  l.append({
    kind: 'gate_skipped',
    gate: 'EVIDENCE_BLOCKERS_OPEN',
    reason: '受限于外部采集窗口',
    risk: '泛化范围受限',
    compensation: '下一轮补全样本',
    covers: [blk.id],
  });

  const verifier = createVerifier({ kind: 'evidence', checkFileExists: true, workspaceRoot: ws });
  const denied = completionGate({
    toolName: 'update_goal',
    args: { action: 'complete', task: 'TASK-0810' },
    ledger: l,
    verifier,
    verifyOpts: { workspaceRoot: ws },
  });
  assert.ok(denied !== null, 'gate-skip 覆盖 blocker 后仍必须运行 verifier');
  assert.equal(denied.code, 'EVIDENCE_VERIFY_FAILED');

  // 新建一条有效台账，测试全量 skip + verifier 通过后写 completion-attempt: complete-with-skips 且归零 repairRounds
  const l2 = new Ledger(join(ws, '.research-pass'), { receipts: true }).ensure();
  const b2 = l2.addUnknown({ what: '边缘项', classification: 'blocker' });
  l2.recordRepairFailure({ task: 'TASK-0810', reason: '待复核' });
  l2.record({ claim: '有效实测文件', confidence: 'observed', provenance: 'evidence.csv:1-2', task: 'TASK-0810' });
  l2.append({
    kind: 'gate_skipped',
    gate: 'EVIDENCE_BLOCKERS_OPEN',
    reason: '窗口期限制',
    risk: '仅覆盖已知子集',
    compensation: '下周补充全量对比',
    covers: [b2.id],
  });
  const allowed = completionGate({
    toolName: 'update_goal',
    args: { action: 'complete', task: 'TASK-0810' },
    ledger: l2,
    verifier,
    verifyOpts: { workspaceRoot: ws },
  });
  assert.equal(allowed, null);
  const lastAttempt = l2.entries().filter(e => e.kind === 'completion-attempt').at(-1);
  assert.equal(lastAttempt.outcome, 'complete-with-skips');
  assert.equal(lastAttempt.task, 'TASK-0810');
  assert.equal(l2.repairRoundsOf('TASK-0810'), 0);
});

test('v0.8.1 P0-3 evolve: 大小写不敏感排除拦截与 rollback evaluator/surface 校验', (t) => {
  for (const upperPath of ['LIB/evolve.js', 'EVALS/skills/demo/rubric.md', '.RESEARCH/ledger.jsonl', '.EVOLVE/x/c.json']) {
    const v = surfaceViolation(upperPath, '**');
    assert.equal(v?.code, 'EVOLVE_SURFACE_EXCLUDED', '应忽略大小写拦截 ' + upperPath);
  }

  const root = tmp('rh-evolve-v081-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'skills', 's1'), { recursive: true });
  mkdirSync(join(root, 'evals', 'skills', 's1'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  const skillFile = join(root, 'skills', 's1', 'SKILL.md');
  writeFileSync(skillFile, '# Base\n', 'utf8');
  writeFileSync(join(root, 'lib', 'eval.js'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(root, 'evals', 'skills', 's1', 'behavior-cases.json'), JSON.stringify({ cases: [{ id: 'c1', prompt: 'p', hard: true }] }), 'utf8');
  writeFileSync(join(root, 'evals', 'skills', 's1', 'rubric.md'), '# Rubric\nCheck Base.\n', 'utf8');

  const ev = new Evolver(root, 'sec');
  ev.init({ surface: 'skills/s1/**' });
  const prop = join(root, 'prop.json');
  writeFileSync(prop, JSON.stringify({
    id: 'c1',
    rationale: 'update skill',
    mutations: [{ file: 'skills/s1/SKILL.md', expected_parent_sha256: sha256Bytes(readFileSync(skillFile)), new_content: '# V1\n' }],
  }), 'utf8');
  assert.equal(ev.applyProposal(prop).status, 'applied');

  // 1. evaluator 指纹被外部篡改后，rollback 必须拒绝写盘
  writeFileSync(join(root, 'lib', 'eval.js'), 'export const x = 999;\n', 'utf8');
  assert.throws(() => ev.rollback({ gen: 1, toParent: true }), /EVOLVE_EVALUATOR_DRIFT/);
  assert.equal(readFileSync(skillFile, 'utf8'), '# V1\n');

  // 恢复 evaluator 指纹后，若 gen manifest 中的文件路径违背 surface，rollback 亦必须拒绝
  writeFileSync(join(root, 'lib', 'eval.js'), 'export const x = 1;\n', 'utf8');
  const genFile = join(root, '.evolve', 'sec', 'gens', 'gen1.json');
  const genManifest = JSON.parse(readFileSync(genFile, 'utf8'));
  genManifest.treatment[0].file = 'lib/eval.js';
  writeFileSync(genFile, JSON.stringify(genManifest, null, 2), 'utf8');
  assert.throws(() => ev.rollback({ gen: 1 }), /EVOLVE_SURFACE_EXCLUDED|EVOLVE_SURFACE_OUTSIDE/);
  assert.equal(readFileSync(join(root, 'lib', 'eval.js'), 'utf8'), 'export const x = 1;\n');
});

test('v0.8.1 P0-4 skill-provider: realpath containment 阻断越界路径与符号链接逃逸', async (t) => {
  const base = tmp('rh-sp-v081-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const skillsDir = join(base, 'skills');
  const validDir = join(skillsDir, 'valid-skill');
  const secretDir = join(base, 'outside-secret');
  mkdirSync(validDir, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(validDir, 'SKILL.md'), '---\nname: valid-skill\ndescription: Valid test skill for harness.\n---\nBody\n', 'utf8');
  writeFileSync(join(secretDir, 'SKILL.md'), '---\nname: evil-skill\ndescription: Secret outside skillsDir.\n---\nSecret\n', 'utf8');
  symlinkSync(secretDir, join(skillsDir, 'linked-evil'), process.platform === 'win32' ? 'junction' : 'dir');

  const provider = createHarnessSkillProvider({ skillsDir });
  const okDef = await provider.get({ path: join(validDir, 'SKILL.md') }, {});
  assert.equal(okDef.name, 'valid-skill');
  assert.equal(await provider.get({ path: join(secretDir, 'SKILL.md') }, {}), undefined);
  assert.equal(await provider.get({ path: join(skillsDir, 'linked-evil', 'SKILL.md') }, {}), undefined);
});

test('v0.8.1 P0-5/6/7 provenance report: 解包、工作区/20MB 校验、严格读与 completion 透传 workspaceRoot', (t) => {
  const base = tmp('rh-prov-v081-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const outDir = join(base, 'outside');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(ws, 'src', 'a.py'), 'x = 1\ny = 2\n', 'utf8');
  writeFileSync(join(outDir, 'ext.txt'), 'outside content\n', 'utf8');

  // validateProvenance 识别 report:<source> | <inner>，拒绝占位符与坏内部引用
  assert.equal(validateProvenance('report:sub-1 | src/a.py:1-2'), null);
  assert.equal(validateProvenance('report:sub-1 | tool:pytest'), null);
  assert.equal(validateProvenance('report:sub-1 | url:https://example.org/r'), null);
  assert.equal(validateProvenance('report:sub-1 | file:src/a.py:1'), null);
  assert.equal(validateProvenance('report:sub-1 | (report 未标 provenance)').code, 'EVIDENCE_BAD_PROVENANCE');
  assert.equal(validateProvenance('report:sub-1 | 猜出来的').code, 'EVIDENCE_BAD_PROVENANCE');

  // verifyFileProvenance 解包 report: 前缀 + 拦截工作区外文件 + 拦截 >20MB 文件
  assert.equal(verifyFileProvenance('report:sub-1 | src/a.py:1-2', ws).ok, true);
  assert.equal(verifyFileProvenance('../outside/ext.txt:1', ws).code, 'EVIDENCE_FILE_OUTSIDE_WORKSPACE');
  assert.equal(verifyFileProvenance('../outside/ext.txt:1', ws, { restrictToBaseDir: false }).ok, true);

  const huge = join(ws, 'huge.csv');
  writeFileSync(huge, '', 'utf8');
  truncateSync(huge, 21 * 1024 * 1024);
  assert.equal(verifyFileProvenance('huge.csv:1', ws).code, 'EVIDENCE_FILE_TOO_LARGE');

  // apply() enforceReadInsideWorkspace 与 completion verifyOpts workspaceRoot 透传
  const ledgerRoot = join(base, 'ledger');
  const guards = [];
  const ctx = {
    logger: { info() {}, error() {} },
    tools: { guard(fn) { guards.push(fn); return () => {}; }, register() { return () => {}; } },
    on() { return () => {}; },
  };
  applyPlugin(ctx, {
    ledgerRoot,
    workspaceRoot: ws,
    enforceReadInsideWorkspace: true,
    verifier: { kind: 'evidence', enabled: true, checkFileExists: true },
  });
  const guard = guards[0];
  const wired = readFileSync(join(ledgerRoot, 'guard-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.kind === 'wired');
  assert.equal(wired.enforceReadInsideWorkspace, true);

  assert.equal(guard({ name: 'read', arguments: { filePath: join(outDir, 'ext.txt') } }).info.code, 'READ_OUTSIDE_WORKSPACE');
  assert.equal(guard({ name: 'read', arguments: { filePath: join(ws, 'src', 'a.py') } }), undefined);

  const l = new Ledger(ledgerRoot, { receipts: true });
  l.record({ claim: '引用工作区相对路径文件', confidence: 'observed', provenance: 'src/missing-in-ws.py:1' });
  const compDeny = guard({ name: 'update_goal', arguments: { action: 'complete' } });
  assert.equal(compDeny.info.code, 'EVIDENCE_VERIFY_FAILED');
  assert.ok(compDeny.reason.includes('EVIDENCE_FILE_MISSING'));
});

test('v0.8.1 P1-1/2/3: CRLF 收据兼容、challenge/repro/addUnknown 强校验、spans 内联脱敏', (t) => {
  const dir = tmp('rh-p1-v081-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const led = new Ledger(dir, { receipts: true }).ensure();
  led.record({ claim: 'CRLF 实测', confidence: 'observed', provenance: 'tool:node' });

  // Windows CRLF 转换不误报 drifted
  const lfContent = readFileSync(led.file, 'utf8');
  const rcptFile = join(dir, 'ledger-receipts.jsonl');
  const rContent = readFileSync(rcptFile, 'utf8');
  writeFileSync(led.file, lfContent.replace(/\n/g, '\r\n'), 'utf8');
  writeFileSync(rcptFile, rContent.replace(/\n/g, '\r\n'), 'utf8');
  const crlfVerify = verifyLedger(led.file);
  assert.equal(crlfVerify.ok, true, JSON.stringify(crlfVerify));

  // 行尾被人为加空格依然必检出 drifted
  writeFileSync(led.file, lfContent.replace(/\n$/, ' \n').replace(/\n/g, '\r\n'), 'utf8');
  assert.equal(verifyLedger(led.file).ok, false);
  assert.equal(verifyLedger(led.file).drifted.length, 1);

  // P1-2: challenge/repro/addUnknown 强校验
  assert.equal(validateChallenge({ ref: 'E1', hypothesis: '足够长的挑战假设', cito: 'refutes' }).code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(validateChallenge({ ref: 'E1', hypothesis: '足够长的挑战假设', cito: 'refutes', provenance: '拍脑袋' }).code, 'EVIDENCE_BAD_PROVENANCE');
  assert.equal(validateChallenge({ ref: 'E1', hypothesis: '足够长的挑战假设', cito: 'refutes', provenance: 'src/a.py:1' }), null);

  assert.equal(validateRepro({ build_type: 'run.py', subject_digest: 12345 })?.code, 'REPRO_BAD_DIGEST');
  assert.throws(() => led.record({ claim: 'c', confidence: 'observed', provenance: 'tool:x', repro: { build_type: 'run.py', subject_digest: 999 } }), /REPRO_BAD_DIGEST/);
  assert.throws(() => led.addUnknown({ what: '未知项', classification: 'invalid-class' }), /EVIDENCE_BAD_CLASSIFICATION/);

  // P1-3: spans 内联 Bearer / GitHub / sk- / 带密码 URL 凭据脱敏
  const summary = summarizeInput({
    cmd: 'curl -H "Authorization: Bearer super_secret_99" https://u:pw99@host/api ghp_AbCdEfGh123456 sk-liveSecret987654',
  });
  assert.ok(summary.includes('[REDACTED]'), summary);
  assert.ok(!summary.includes('super_secret_99'));
  assert.ok(!summary.includes('pw99'));
  assert.ok(!summary.includes('ghp_AbCdEfGh123456'));
  assert.ok(!summary.includes('sk-liveSecret987654'));
});

test('v0.8.1 P1-4/5: compile.py --timeout/MIKTEX_AUTOINSTALL 与 CLI UTF-8 BOM JSON 读取', () => {
  // P1-4: 两个 compile.py 脚本均支持 --timeout、MIKTEX_AUTOINSTALL=no、超时返回 124
  const pyBin = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ? 'python3' : 'python';
  const pyCode = [
    'import contextlib, importlib.util, io, json, subprocess, sys, tempfile',
    'from pathlib import Path',
    'sys.dont_write_bytecode = True',
    'results = []',
    'for rel in ["skills/latex-paper-en/scripts/compile.py", "skills/latex-thesis-zh/scripts/compile.py"]:',
    '    script_dir = str(Path(rel).resolve().parent)',
    '    sys.path.insert(0, script_dir)',
    '    try:',
    '        spec = importlib.util.spec_from_file_location("mod_" + Path(rel).parts[1].replace("-", "_"), rel)',
    '        mod = importlib.util.module_from_spec(spec)',
    '        spec.loader.exec_module(mod)',
    '        with tempfile.TemporaryDirectory() as td:',
    '            tex = Path(td) / "main.tex"',
    '            tex.write_text("\\\\documentclass{article}\\n\\\\begin{document}\\nok\\n\\\\end{document}\\n", encoding="utf-8")',
    '            compiler = mod.LaTeXCompiler(str(tex), recipe="xelatex", timeout=1)',
    '            env = compiler._run_env()',
    '            assert env.get("MIKTEX_AUTOINSTALL") == "no", env.get("MIKTEX_AUTOINSTALL")',
    '            orig_which = mod.shutil.which',
    '            orig_run = mod.subprocess.run',
    '            mod.shutil.which = lambda name: name',
    '            def fake_run(cmd, **kw):',
    '                assert kw.get("timeout") == 1',
    '                assert kw.get("stdin") == subprocess.DEVNULL',
    '                assert kw.get("env", {}).get("MIKTEX_AUTOINSTALL") == "no"',
    '                raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)',
    '            mod.subprocess.run = fake_run',
    '            buf = io.StringIO()',
    '            try:',
    '                with contextlib.redirect_stdout(buf):',
    '                    code = compiler.compile()',
    '            finally:',
    '                mod.shutil.which = orig_which',
    '                mod.subprocess.run = orig_run',
    '            assert code == 124, code',
    '            assert "MIKTEX_AUTOINSTALL=no" in buf.getvalue(), buf.getvalue()',
    '            results.append({"rel": rel, "timeout_exit": code})',
    '    finally:',
    '        if script_dir in sys.path:',
    '            sys.path.remove(script_dir)',
    'print(json.dumps(results))',
  ].join('\n');

  const pyRes = spawnSync(pyBin, ['-B', '-'], {
    cwd: ROOT,
    input: pyCode,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(pyRes.status, 0, pyRes.stderr + '\n' + pyRes.stdout);
  const parsedPy = JSON.parse(pyRes.stdout.trim());
  assert.equal(parsedPy.length, 2);

  // P1-5: CLI --acceptance 与 alignment save --file 兼容 UTF-8 BOM JSON 文件
  const ws = tmp('rh-cli-bom-');
  const ledgerDir = join(ws, '.research');
  try {
    spawnSync(process.execPath, [BIN, 'init', '--ledger', ledgerDir], { encoding: 'utf8' });
    spawnSync(process.execPath, [BIN, 'record', '--claim', 'bom 实测', '--provenance', 'tool:test', '--ledger', ledgerDir], { encoding: 'utf8' });

    const accPath = join(ws, 'acc-bom.json');
    writeFileSync(accPath, '\uFEFF' + JSON.stringify({ minFindings: 1, minObservedRatio: 1 }), 'utf8');
    const routeRes = spawnSync(process.execPath, [BIN, 'route', '--acceptance', accPath, '--ledger', ledgerDir], { encoding: 'utf8' });
    assert.equal(routeRes.status, 0, routeRes.stderr);
    assert.equal(JSON.parse(routeRes.stdout).action, 'run-acceptance');

    const cardPath = join(ws, 'card-bom.json');
    writeFileSync(cardPath, '\uFEFF' + JSON.stringify({
      slug: 'bom-card',
      topic: 'BOM 读取验证',
      layers: { goal: 'g', constraints: 'c', deliverables: 'd', success_criteria: 's', assumptions: 'a', non_goals: 'n' },
    }), 'utf8');
    const alignRes = spawnSync(process.execPath, [BIN, 'alignment', 'save', '--file', cardPath, '--root', ws, '--ledger', ledgerDir], { encoding: 'utf8' });
    assert.equal(alignRes.status, 0, alignRes.stderr);
    assert.equal(JSON.parse(alignRes.stdout).slug, 'bom-card');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('v0.8.2 P0 工具命名与 output.schema 对齐：13 个工具合规、findings_status/verify/aggregate 字段完整', async (t) => {
  const ws = tmp('rh-toolnames-v082-');
  const dir = join(ws, '.research');
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const tools = [];
  const ctx = {
    logger: { info() {}, error() {} },
    tools: { guard() { return () => {}; }, register(def) { tools.push(def); return () => {}; } },
    on() { return () => {}; },
  };
  applyPlugin(ctx, { ledgerRoot: dir, workspaceRoot: ws });
  assert.equal(tools.length, 13);
  for (const def of tools) {
    assert.ok(!def.name.includes('.'), '工具名不得包含点号: ' + def.name);
    assert.match(def.name, TOOL_NAME_RE, '工具名不满足上游函数命名正则: ' + def.name);
  }
  assert.equal(gateExec('findings_record', { entries: [{ claim: '合法断言陈述', confidence: 'observed' }] })?.code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(gateExec('findings.record', { entries: [{ claim: '合法断言陈述', confidence: 'observed' }] })?.code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(gateExec('findings_record', { entries: [{ claim: '合法断言陈述', confidence: 'observed', provenance: 'tool:ok' }] }), null);

  const byName = Object.fromEntries(tools.map(d => [d.name, d]));
  const assertKeysDeclared = (name, out) => {
    const sch = byName[name].output.schema;
    for (const req of sch.required ?? []) {
      assert.ok(Object.hasOwn(out, req) && out[req] !== undefined, `${name} 缺少 required 字段: ${req}`);
    }
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(out)) {
        assert.ok(Object.hasOwn(sch.properties, k), `${name} 返回未在 output.schema 声明的字段: ${k}`);
      }
    }
  };

  // 空台账 findings_aggregate (rate === null) 与 findings_status / findings_verify
  const aggEmpty = await byName.findings_aggregate.execute({}, { name: 'findings_aggregate', cwd: ws });
  assert.equal(aggEmpty.rate, null);
  assertKeysDeclared('findings_aggregate', aggEmpty);

  const stEmpty = await byName.findings_status.execute({}, { name: 'findings_status', cwd: ws });
  assert.ok(Array.isArray(stEmpty.recent));
  assertKeysDeclared('findings_status', stEmpty);

  // 多 seed 写入后验证 findings_status (recent)、findings_verify (receipts)、findings_aggregate (meanSem)
  await byName.findings_record.execute({
    entries: [
      { claim: 'acc', confidence: 'observed', provenance: 'tool:s1', metric: 0.81 },
      { claim: 'acc', confidence: 'observed', provenance: 'tool:s2', metric: 0.83 },
    ],
  }, { name: 'findings_record', cwd: ws });

  const stPop = await byName.findings_status.execute({}, { name: 'findings_status', cwd: ws });
  assert.equal(stPop.recent.length, 2);
  assertKeysDeclared('findings_status', stPop);

  const verOut = await byName.findings_verify.execute({}, { name: 'findings_verify', cwd: ws });
  assert.equal(typeof verOut.receipts, 'number');
  assertKeysDeclared('findings_verify', verOut);

  const aggSeed = await byName.findings_aggregate.execute({}, { name: 'findings_aggregate', cwd: ws });
  assert.ok(Array.isArray(aggSeed.meanSem) && aggSeed.meanSem.length === 1);
  assertKeysDeclared('findings_aggregate', aggSeed);
});
