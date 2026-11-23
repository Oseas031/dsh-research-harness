import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply, PKG_VERSION } from '../lib/index.js';
import { Ledger } from '../lib/ledger.js';
import { Evolver } from '../lib/evolve.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'research-harness.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'rh-v060-'));

function assertNoUnionTypeArrays(schema, path = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, idx) => assertNoUnionTypeArrays(item, path + '[' + idx + ']'));
    return;
  }
  if ('type' in schema) {
    assert.ok(!Array.isArray(schema.type), path + '.type 不能是联合数组（DSH assertSupportedJsonSchema 会拒绝）');
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k !== 'type' && v && typeof v === 'object') assertNoUnionTypeArrays(v, path + '.' + k);
  }
}

test('v0.6.0 版本对齐：PKG_VERSION、wired 日志与 CLI --version 一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(PKG_VERSION, pkg.version);

  const root = tmp();
  try {
    const tools = [];
    const ctx = {
      logger: { info() {}, error() {} },
      tools: { guard() { return () => {}; }, register(def) { tools.push(def); return () => {}; } },
      on() { return () => {}; },
    };
    apply(ctx, { ledgerRoot: root, clusterScale: 'delegate' });
    assert.equal(tools.length, 13);
    const guardLog = readFileSync(join(root, 'guard-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const wired = guardLog.find(e => e.kind === 'wired');
    assert.ok(wired);
    assert.equal(wired.version, pkg.version);
    assert.equal(wired.tools.length, 13);

    for (const flag of ['--version', '-v', 'version']) {
      const r = spawnSync(process.execPath, [BIN, flag], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.name, pkg.name);
      assert.equal(parsed.version, pkg.version);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v0.6.0 全部 9 个注册工具 schema 不含联合 type 数组', () => {
  const root = tmp();
  try {
    const tools = [];
    const ctx = {
      logger: { info() {}, error() {} },
      tools: { guard() { return () => {}; }, register(def) { tools.push(def); return () => {}; } },
      on() { return () => {}; },
    };
    apply(ctx, { ledgerRoot: root });
    const names = tools.map(t => t.name);
    for (const expected of [
      'findings_record', 'findings_status', 'findings_aggregate', 'findings_challenge',
      'findings_route', 'findings_verify', 'findings_gate_skip', 'findings_unknown', 'findings_resolve',
    ]) {
      assert.ok(names.includes(expected), '缺少工具: ' + expected);
    }
    for (const tool of tools) {
      assertNoUnionTypeArrays(tool.parameters, tool.name + '.parameters');
      assertNoUnionTypeArrays(tool.output?.schema, tool.name + '.output.schema');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v0.6.0 插件工具对齐：findings_unknown / findings_resolve / verifiedBy / findings_route(acceptance)', async () => {
  const root = tmp();
  try {
    const guards = [];
    const tools = [];
    const ctx = {
      logger: { info() {}, error() {} },
      tools: { guard(fn) { guards.push(fn); return () => {}; }, register(def) { tools.push(def); return () => {}; } },
      on() { return () => {}; },
    };
    apply(ctx, { ledgerRoot: root, clusterScale: 'delegate' });
    const get = (name) => tools.find(t => t.name === name);
    const guard = guards[0];

    const recOut = await get('findings_record').execute({
      entries: [{ claim: '观测数据通过复核', confidence: 'observed', provenance: 'data/metrics.csv:2', task: 'TASK-0600', verifiedBy: 'lead-verified' }],
    });
    assert.equal(recOut.recorded, 1);

    const uOut = await get('findings_unknown').execute({ what: '对照组缺失种子 44', why: '尚待补跑', classification: 'blocker' });
    assert.equal(uOut.classification, 'blocker');
    assert.equal(uOut.status, 'open');
    assert.equal(guard({ name: 'update_goal', args: { action: 'complete' } }).info.code, 'EVIDENCE_BLOCKERS_OPEN');

    await assert.rejects(() => get('findings_unknown').execute({ what: '   ' }), /EVIDENCE_BAD_UNKNOWN/);
    await assert.rejects(() => get('findings_resolve').execute({ id: '', resolution: 'ok' }), /EVIDENCE_BAD_RESOLVE/);

    const resOut = await get('findings_resolve').execute({ id: uOut.id, resolution: '已补跑种子 44 并核验' });
    assert.equal(resOut.ref, uOut.id);
    assert.equal(resOut.status, 'resolved');
    assert.equal(guard({ name: 'update_goal', args: { action: 'complete' } }), undefined);

    const cOut = await get('findings_challenge').execute({
      ref: recOut.ids[0],
      hypothesis: '对照组数据存在口径偏移',
      cito: 'disagreesWith',
      provenance: 'data/metrics.csv:3',
    });
    assert.equal(guard({ name: 'update_goal', args: { action: 'complete' } }).info.code, 'EVIDENCE_BLOCKERS_OPEN');

    const cRes = await get('findings_resolve').execute({ id: cOut.id, resolution: '核对一致，未偏移', kind: 'challenge' });
    assert.equal(cRes.ref, cOut.id);
    assert.equal(guard({ name: 'update_goal', args: { action: 'complete' } }), undefined);

    const rCont = await get('findings_route').execute({ acceptance: { minFindings: 3, task: 'TASK-0600' } });
    assert.equal(rCont.action, 'continue-recording');
    const rPass = await get('findings_route').execute({ acceptance: { minFindings: 1, minObservedRatio: 1, requiredRouteChecks: 1, task: 'TASK-0600' } });
    assert.equal(rPass.action, 'run-acceptance');

    const routeChecks = new Ledger(root).entries().filter(e => e.kind === 'route-check');
    assert.equal(routeChecks.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v0.6.0 evals/skills 10/10 完整覆盖且均可通过 Evolver.init() 校验', () => {
  const skillNames = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  const evalNames = readdirSync(join(ROOT, 'evals', 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  assert.equal(skillNames.length, 10);
  assert.deepEqual(evalNames, skillNames);

  const stage = tmp();
  try {
    for (const sub of ['lib', 'bin', 'test', 'harness-lab']) {
      mkdirSync(join(stage, sub), { recursive: true });
      writeFileSync(join(stage, sub, 'stub.txt'), 'stub\n', 'utf8');
    }
    for (const name of skillNames) {
      const casesFile = join(ROOT, 'evals', 'skills', name, 'behavior-cases.json');
      const rubricFile = join(ROOT, 'evals', 'skills', name, 'rubric.md');
      assert.ok(existsSync(casesFile), name + ' 缺少 behavior-cases.json');
      assert.ok(existsSync(rubricFile), name + ' 缺少 rubric.md');
      const parsed = JSON.parse(readFileSync(casesFile, 'utf8'));
      assert.ok(Array.isArray(parsed.cases) && parsed.cases.length >= 4, name + ' 案例数不足');
      assert.ok(parsed.cases.some(c => c.hard === true), name + ' 必须至少含 1 条 hard=true 案例');

      const destEval = join(stage, 'evals', 'skills', name);
      mkdirSync(destEval, { recursive: true });
      writeFileSync(join(destEval, 'behavior-cases.json'), readFileSync(casesFile, 'utf8'), 'utf8');
      writeFileSync(join(destEval, 'rubric.md'), readFileSync(rubricFile, 'utf8'), 'utf8');

      const ev = new Evolver(stage, 'check-' + name);
      const contract = ev.init({ surface: 'skills/' + name + '/**' });
      assert.match(contract.evaluator_id, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('v0.6.0 skills 目录无硬编码本机路径且无 __pycache__', () => {
  // 拼接字面量以免测试文件本身触发打包卫生红线扫描
  const forbidden = new RegExp([
    'E:[/\\\\]+dsh-' + 'research-' + 'harness',
    'E:[/\\\\]+hack4' + 'claws' + 'go',
    'C:[/\\\\]+Users[/\\\\]+' + 'ASUS',
    'hack4' + 'claws',
    'claws' + 'go',
  ].join('|'), 'i');

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        assert.notEqual(entry.name, '__pycache__', '残留目录: ' + fp);
        walk(fp);
      } else {
        const text = readFileSync(fp, 'utf8');
        assert.ok(!forbidden.test(text), '发现禁止的路径或旧标识于: ' + fp);
      }
    }
  };
  walk(join(ROOT, 'skills'));
});
