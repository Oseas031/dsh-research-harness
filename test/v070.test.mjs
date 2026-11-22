import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, truncateSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, extractPatchPaths, guardPathEscape } from '../lib/guards.js';
import { apply, PKG_VERSION, resolveLedgerDir, resolveWorkspaceRoot, workspaceSlug } from '../lib/index.js';
import { Ledger, withLock } from '../lib/ledger.js';
import { verifyLedger } from '../lib/receipts.js';
import { createVerifier, parseCommandSpec } from '../lib/verifier.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'research-harness.mjs');
const tmp = (prefix = 'rh-v070-') => mkdtempSync(join(tmpdir(), prefix));

test('P0-1 guards: 相对路径解析、apply_patch 路径提取、真实磁盘 >20MB 拦截', (t) => {
  const ws = tmp('rh-ws-');
  t.after(() => rmSync(ws, { recursive: true, force: true }));

  // 相对路径相对 workspaceRoot 解析，而非 process.cwd()
  assert.equal(guardPathEscape({ root: ws, target: 'sub/note.md' }), null);
  assert.equal(guardPathEscape({ root: ws, target: '../escape.md' }).code, 'WRITE_OUTSIDE_WORKSPACE');

  // apply_patch 多路径提取与越界拦截
  const patchOk = [
    '*** Begin Patch',
    '*** Add File: docs/a.md',
    '+hello',
    '*** Update File: src/b.js',
    '*** Move to: src/c.js',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(extractPatchPaths(patchOk), ['docs/a.md', 'src/b.js', 'src/c.js']);
  assert.equal(check('apply_patch', { patchText: patchOk }, { workspaceRoot: ws }), null);

  const patchEscape = '*** Begin Patch\n*** Update File: docs/a.md\n*** Move to: ../outside.js\n*** End Patch';
  assert.equal(check('apply_patch', { patchText: patchEscape }, { workspaceRoot: ws }).code, 'WRITE_OUTSIDE_WORKSPACE');

  // read 不传 size 时通过 statSync 探测真实文件大小（21MB 稀疏文件）
  const bigFile = join(ws, 'huge.txt');
  writeFileSync(bigFile, '', 'utf8');
  truncateSync(bigFile, 21 * 1024 * 1024);
  assert.equal(check('read', { filePath: bigFile }, { workspaceRoot: ws }).code, 'READ_TOO_LARGE');

  const smallFile = join(ws, 'small.txt');
  writeFileSync(smallFile, 'ok\n', 'utf8');
  assert.equal(check('read', { filePath: smallFile }, { workspaceRoot: ws }), null);
});

test('P0-1 index: 对接 DSH exec.arguments 与 workingDirectory，写入工作区不被 ledgerRoot 误拦', (t) => {
  const base = tmp('rh-idx-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ledgerHome = join(base, 'ledger-home');
  const wsPaper = join(base, 'paper-proj');
  mkdirSync(ledgerHome, { recursive: true });
  mkdirSync(wsPaper, { recursive: true });

  const guards = [];
  const tools = [];
  const session = { id: 'sess-1', header: { cwd: wsPaper } };
  const ctx = {
    dshHomePath: () => ledgerHome,
    get(service) {
      if (service === 'workingDirectory') return { defaultDirectory: wsPaper, get: () => wsPaper };
      return undefined;
    },
    logger: { info() {}, error() {} },
    tools: { guard(fn) { guards.push(fn); return () => {}; }, register(def) { tools.push(def); return () => {}; } },
    on() { return () => {}; },
  };
  apply(ctx, { clusterScale: 'delegate' });
  const guard = guards[0];

  // DSH 真实 exec.arguments（驼峰 filePath）：工作区内写放行，写到 ledgerHome 或上层越界被拒
  assert.equal(
    guard({ name: 'write', arguments: { filePath: join(wsPaper, 'draft.tex') }, agent: { session } }),
    undefined,
  );
  assert.equal(
    guard({ name: 'edit', arguments: { filePath: join(ledgerHome, 'tamper.txt') }, agent: { session } }).info.code,
    'WRITE_OUTSIDE_WORKSPACE',
  );
  assert.equal(
    guard({ name: 'apply_patch', arguments: { patchText: '*** Begin Patch\n*** Add File: ../evil.txt\n*** End Patch' }, agent: { session } }).info.code,
    'WRITE_OUTSIDE_WORKSPACE',
  );
  // exec.arguments 上的 findings.record 无 provenance 被拦截
  assert.equal(
    guard({ name: 'findings.record', arguments: { entries: [{ claim: '无来源断言', confidence: 'observed' }] }, agent: { session } }).info.code,
    'EVIDENCE_NO_PROVENANCE',
  );
});

test('P0-2 多项目分账隔离：不同工作区互不阻塞 complete，各自落 workspace.json', async (t) => {
  const base = tmp('rh-scope-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ledgerHome = join(base, 'home');
  const wsA = join(base, 'proj-alpha');
  const wsB = join(base, 'proj-beta');
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });

  const guards = [];
  const tools = [];
  const sessA = { id: 'A', header: { cwd: wsA } };
  const sessB = { id: 'B', header: { cwd: wsB } };
  const ctx = {
    dshHomePath: () => ledgerHome,
    get(service) {
      if (service === 'workingDirectory') {
        return { get: (s) => (s === sessA ? wsA : s === sessB ? wsB : null) };
      }
      return undefined;
    },
    logger: { info() {}, error() {} },
    tools: { guard(fn) { guards.push(fn); return () => {}; }, register(def) { tools.push(def); return () => {}; } },
    on() { return () => {}; },
  };

  apply(ctx, {});
  const guard = guards[0];
  const getTool = (n) => tools.find(item => item.name === n);
  const execA = { agent: { session: sessA } };
  const execB = { agent: { session: sessB } };

  assert.notEqual(resolveLedgerDir(ctx, execA, {}), resolveLedgerDir(ctx, execB, {}));
  assert.equal(resolveWorkspaceRoot(ctx, execA, {}), wsA);

  await getTool('findings.unknown').execute({ what: '项目 A 缺实验数据', classification: 'blocker' }, execA);
  await getTool('findings.record').execute({
    entries: [{ claim: '项目 B 指标已确认', confidence: 'observed', provenance: 'results.csv:2' }],
  }, execB);

  // 项目 A 被 blocker 挡下，项目 B 不受影响直接放行
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' }, ...execA }).info.code, 'EVIDENCE_BLOCKERS_OPEN');
  assert.equal(guard({ name: 'update_goal', arguments: { action: 'complete' }, ...execB }), undefined);

  const dirA = join(ledgerHome, 'projects', workspaceSlug(wsA));
  const dirB = join(ledgerHome, 'projects', workspaceSlug(wsB));
  assert.ok(existsSync(join(dirA, 'workspace.json')));
  assert.ok(existsSync(join(dirB, 'workspace.json')));
  assert.equal(JSON.parse(readFileSync(join(dirA, 'workspace.json'), 'utf8')).workspace, wsA);
  assert.equal((await getTool('findings.status').execute({}, execB)).blockers.length, 0);
});

test('P0-2 跨进程排他锁：6 进程并发 60 条入账 seq 无碰撞且收据 0 漂移，支持僵尸锁回收', async (t) => {
  const dir = tmp('rh-lock-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const ledgerUrl = pathToFileURL(join(ROOT, 'lib', 'ledger.js')).href;
  const workerCode = [
    'import { Ledger } from ' + JSON.stringify(ledgerUrl) + ';',
    'const [dir, wid, count] = process.argv.slice(1);',
    'const led = new Ledger(dir, { receipts: true });',
    'for (let i = 0; i < Number(count); i++) {',
    '  led.record({ claim: "worker-" + wid + "-" + i, confidence: "observed", provenance: "worker.js:" + (i + 1) });',
    '}',
  ].join('\n');

  const workers = 6;
  const perWorker = 10;
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, dir, String(w), String(perWorker)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error('worker ' + w + ' exit ' + code + ': ' + stderr))));
    child.on('error', rejectPromise);
  })));

  const led = new Ledger(dir, { receipts: true });
  const entries = led.entries();
  assert.equal(entries.length, workers * perWorker);
  const seqs = entries.map(e => e.seq);
  assert.deepEqual(seqs, Array.from({ length: workers * perWorker }, (_, i) => i + 1));
  const verified = verifyLedger(led.file);
  assert.equal(verified.ok, true);
  assert.equal(verified.checked, workers * perWorker);
  assert.equal(verified.drifted.length, 0);
  assert.equal(existsSync(led.lockFile), false);

  // 僵尸锁自动回收
  writeFileSync(led.lockFile, '{"pid":999999}\n', 'utf8');
  const past = new Date(Date.now() - 60000);
  utimesSync(led.lockFile, past, past);
  let entered = false;
  withLock(led.lockFile, () => { entered = true; }, { staleMs: 1000, timeoutMs: 2000 });
  assert.equal(entered, true);
  assert.equal(existsSync(led.lockFile), false);
});

test('P0-3 verifier(command)：拒绝 shell 元字符、env 隔离、JSON 协议、异步非阻塞超时与 CLI verify-cmd', async (t) => {
  const dir = tmp('rh-ver-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const led = new Ledger(dir, { receipts: true }).ensure();
  led.record({ claim: 'cmd check', confidence: 'observed', provenance: 'script.py:1' });

  // 拒绝 shell 注入元字符
  for (const bad of ['node -e 1; echo pwned', 'python a.py | cat', 'a.exe && b.exe', 'echo $(id)']) {
    assert.throws(() => parseCommandSpec(bad), /VERIFIER_UNSAFE_COMMAND/);
    assert.throws(() => createVerifier({ kind: 'command', command: bad }), /VERIFIER_UNSAFE_COMMAND/);
  }

  // 安全 argv 数组同步 + 异步校验，以及 JSON pass=false 解析
  const vFail = createVerifier({
    kind: 'command',
    command: [process.execPath, '-e', 'console.log(JSON.stringify({ pass: false, failed: ["proof gap"] }))'],
  });
  const syncRes = vFail.verify(led);
  assert.equal(syncRes.pass, false);
  assert.deepEqual(syncRes.failed, ['proof gap']);
  const asyncRes = await vFail.verifyAsync(led);
  assert.equal(asyncRes.pass, false);
  assert.deepEqual(asyncRes.failed, ['proof gap']);

  // 敏感宿主环境变量隔离 + RESEARCH_LEDGER_FILE 透传
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    DSH_SECRET_TEST: process.env.DSH_SECRET_TEST,
  };
  try {
    process.env.OPENAI_API_KEY = 'secret-openai';
    process.env.GITHUB_TOKEN = 'secret-gh';
    process.env.DSH_SECRET_TEST = 'secret-dsh';
    const vEnv = createVerifier({
      kind: 'command',
      command: [
        process.execPath,
        '-e',
        'const ok = !process.env.OPENAI_API_KEY && !process.env.GITHUB_TOKEN && !process.env.DSH_SECRET_TEST && !!process.env.RESEARCH_LEDGER_FILE; console.log(JSON.stringify({ pass: ok }));',
      ],
    });
    const envRes = await vEnv.verifyAsync(led);
    assert.equal(envRes.pass, true, JSON.stringify(envRes));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // 异步超时杀树且不阻塞事件循环
  const vTimeout = createVerifier({
    kind: 'command',
    command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    timeoutMs: 180,
  });
  let ticks = 0;
  const iv = setInterval(() => { ticks += 1; }, 20);
  const tRes = await vTimeout.verifyAsync(led);
  clearInterval(iv);
  assert.equal(tRes.pass, false);
  assert.equal(tRes.timedOut, true);
  assert.ok(ticks >= 3, '事件循环应保持响应，实际 ticks=' + ticks);

  // CLI verify-cmd
  const cliOk = spawnSync(process.execPath, [BIN, 'verify-cmd', '--cmd', JSON.stringify([process.execPath, '-e', 'process.exit(0)']), '--ledger', dir], { encoding: 'utf8' });
  assert.equal(cliOk.status, 0, cliOk.stderr);
  assert.equal(JSON.parse(cliOk.stdout).pass, true);
  const cliBad = spawnSync(process.execPath, [BIN, 'verify-cmd', '--cmd', 'echo ok; echo evil', '--ledger', dir], { encoding: 'utf8' });
  assert.notEqual(cliBad.status, 0);
});

test('P0-4 技能长度门禁：全 10 个 SKILL.md <= 8192 字符，validate-data 围栏闭合且保留评估核心规则', () => {
  const skillsDir = join(ROOT, 'skills');
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  assert.equal(dirs.length, 10);
  for (const d of dirs) {
    const content = readFileSync(join(skillsDir, d.name, 'SKILL.md'), 'utf8');
    assert.ok(content.length <= 8192, d.name + '/SKILL.md 超长: ' + content.length + ' > 8192');
  }

  const vd = readFileSync(join(skillsDir, 'validate-data', 'SKILL.md'), 'utf8');
  const fenceCount = (vd.match(/^```/gm) || []).length;
  assert.equal(fenceCount % 2, 0, 'validate-data/SKILL.md 存在未闭合代码围栏');
  for (const needle of [
    'Reconcile mixed sources before comparing',
    'Expose sampling risk',
    'Make every finding traceable',
    'Independently recompute derived arithmetic',
    'Denominator correctness',
    'Population definition',
  ]) {
    assert.ok(vd.includes(needle), 'validate-data 缺少关键条款: ' + needle);
  }
  assert.ok(PKG_VERSION);
});
