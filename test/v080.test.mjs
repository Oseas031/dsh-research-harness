import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyPlugin, PKG_VERSION } from '../lib/index.js';
import { Ledger } from '../lib/ledger.js';
import { route } from '../lib/route.js';
import { aggregate } from '../lib/aggregate.js';
import { verifyFileProvenance } from '../lib/evidence-gate.js';
import { createVerifier } from '../lib/verifier.js';
import { SpanRecorder, readSpans, summarizeInput, summarizeSpans } from '../lib/spans.js';
import {
  ALIGNMENT_LAYERS,
  PROBE_VERDICTS,
  readAlignmentCard,
  syncAlignmentToLedger,
  validateAlignmentCard,
  writeAlignmentCard,
} from '../lib/alignment.js';
import { Evolver, sha256Bytes } from '../lib/evolve.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'research-harness.mjs');
const tmp = (prefix = 'harness-v080-') => mkdtempSync(join(tmpdir(), prefix));

function assertNoUnionTypeArrays(schema, path = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, idx) => assertNoUnionTypeArrays(item, path + '[' + idx + ']'));
    return;
  }
  if ('type' in schema) {
    assert.ok(!Array.isArray(schema.type), path + '.type 不能是联合数组');
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k !== 'type' && v && typeof v === 'object') assertNoUnionTypeArrays(v, path + '.' + k);
  }
}

test('v0.8.0 P1: Ledger 按任务持久化 repairRounds 且 route() 自动消费并重置', () => {
  const dir = tmp();
  try {
    const l1 = new Ledger(dir, { receipts: true }).ensure();
    l1.record({ claim: '基线结果可复现', confidence: 'observed', provenance: 'tool:pytest', task: 'TASK-0001' });
    l1.recordRepairFailure({ task: 'TASK-0001', reason: '单测超时' });
    l1.recordRepairFailure({ task: 'TASK-0002', reason: '另一任务失败' });

    // 重新实例化 Ledger 模拟跨会话重启后继续路由
    const l2 = new Ledger(dir, { receipts: true });
    assert.equal(l2.repairRoundsOf('TASK-0001'), 1);
    assert.equal(l2.repairRoundsOf('TASK-0002'), 1);
    assert.equal(route(l2, { clusterScale: 'delegate', task: 'TASK-0001' }).action, 'run-acceptance');

    l2.recordRepairFailure({ task: 'TASK-0001', reason: '二次修复仍失败' });
    const blocked = route(l2, { clusterScale: 'delegate', task: 'TASK-0001' });
    assert.equal(blocked.action, 'BLOCKED');
    assert.equal(blocked.detail.task, 'TASK-0001');
    assert.equal(blocked.detail.repairRounds, 2);

    // TASK-0002 不受 TASK-0001 阻塞影响
    assert.equal(route(l2, { clusterScale: 'delegate', task: 'TASK-0002' }).action, 'run-acceptance');

    // complete 或 resetRepairRounds 后归零
    l2.resetRepairRounds('TASK-0001');
    assert.equal(l2.repairRoundsOf('TASK-0001'), 0);
    assert.equal(route(l2, { clusterScale: 'delegate', task: 'TASK-0001' }).action, 'run-acceptance');

    l2.recordRepairFailure({ task: 'TASK-0002' });
    l2.recordRepairFailure({ task: 'TASK-0002' });
    assert.equal(route(l2, { clusterScale: 'delegate', task: 'TASK-0002' }).action, 'BLOCKED');
    l2.append({ kind: 'completion-attempt', outcome: 'complete', task: 'TASK-0002' });
    assert.equal(l2.repairRoundsOf('TASK-0002'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: aggregate() maxAgeHours 时效降档与 stale 计数', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const freshTs = '2026-11-22T10:30:00Z'; // 1.5h 前
  const staleTs = '2026-11-21T00:00:00Z'; // 36h 前
  const entries = [
    { kind: 'finding', id: 'E1', claim: '新结论', confidence: 'observed', provenance: 'tool:pytest', ts: freshTs },
    { kind: 'finding', id: 'E2', claim: '过期结论', confidence: 'observed', provenance: 'tool:pytest', ts: staleTs },
    { kind: 'finding', id: 'E3', claim: '失败结论保持 not_ok', confidence: 'observed', verdict: 'not_ok', provenance: 'tool:pytest', ts: staleTs },
  ];
  const res = aggregate(entries, { maxAgeHours: 24, nowMs: now });
  assert.equal(res.counts.tests, 3);
  assert.equal(res.counts.failures, 1);
  assert.equal(res.counts.stale, 1);
  assert.equal(res.detail[0].verdict, 'ok');
  assert.equal(res.detail[0].stale, undefined);
  assert.equal(res.detail[1].verdict, 'todo');
  assert.equal(res.detail[1].confidence, 'unknown');
  assert.equal(res.detail[1].stale, true);
  assert.equal(res.detail[2].verdict, 'not_ok');
  assert.ok(res.tap.includes('ok 2 E2 # TODO stale'));
});

test('v0.8.0 P1: verifyFileProvenance 与 evidence verifier checkFileExists', () => {
  const ws = tmp('harness-prov-');
  const ledgerDir = join(ws, '.research');
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'metrics.py'), 'a = 1\nb = 2\nc = 3\n', 'utf8');

    assert.equal(verifyFileProvenance('src/metrics.py:1-3', ws).ok, true);
    assert.equal(verifyFileProvenance('https://arxiv.org/abs/2501.00001', ws).skipped, true);
    assert.equal(verifyFileProvenance('tool:pytest', ws).skipped, true);

    const missing = verifyFileProvenance('src/not-found.py:1', ws);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'EVIDENCE_FILE_MISSING');

    const oob = verifyFileProvenance('src/metrics.py:2-9', ws);
    assert.equal(oob.ok, false);
    assert.equal(oob.code, 'EVIDENCE_LINE_OUT_OF_RANGE');

    const ledger = new Ledger(ledgerDir, { receipts: true }).ensure();
    ledger.record({ claim: '源码第 2 行有效', confidence: 'observed', provenance: 'src/metrics.py:2' });
    const vOk = createVerifier({ kind: 'evidence', checkFileExists: true, workspaceRoot: ws });
    assert.equal(vOk.verify(ledger).pass, true);

    ledger.record({ claim: '引用了越界行号', confidence: 'observed', provenance: 'src/metrics.py:1-10' });
    const vFail = vOk.verify(ledger);
    assert.equal(vFail.pass, false);
    assert.ok(vFail.failed.some(msg => msg.includes('EVIDENCE_LINE_OUT_OF_RANGE')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: spans.js 脱敏、截断、过期清理、写盘与排名聚合', () => {
  const dir = tmp('harness-spans-');
  try {
    const s = summarizeInput({
      filePath: 'data/exp.csv',
      apiKey: 'sk-super-secret',
      auth_token: 'tok-xyz',
      nested: { password: '123', query: 'x'.repeat(250) },
    });
    assert.ok(s.includes('[REDACTED]'));
    assert.ok(!s.includes('sk-super-secret'));
    assert.ok(!s.includes('tok-xyz'));
    assert.ok(!s.includes('"123"'));
    assert.ok(s.length <= 160);

    let tick = 1000000;
    const rec = new SpanRecorder({ now: () => tick, staleMs: 5000 });
    const e1 = { name: 'read', callId: 'c1', arguments: { filePath: 'a.txt' } };
    const eStale = { name: 'bash', callId: 'c-stale', arguments: {} };
    rec.start(eStale);
    tick += 6000; // 使 c-stale 超过 staleMs
    rec.start(e1);
    assert.equal(rec.byCallId.has('c-stale'), false);

    tick += 120;
    rec.end(e1, { content: [{ type: 'text', text: 'done' }], isError: false }, dir);

    const e2 = { name: 'write', callId: 'c2', arguments: { filePath: 'b.txt' } };
    rec.start(e2);
    tick += 350;
    rec.end(e2, { isError: true, error: { message: 'WRITE_DENIED' } }, dir);

    const rows = readSpans(join(dir, 'spans.jsonl'));
    assert.equal(rows.length, 2);
    const summary = summarizeSpans(rows, { limit: 1 });
    assert.equal(summary.totalCalls, 2);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.totalDurationMs, 470);
    assert.equal(summary.ranking[0].tool, 'write');
    assert.equal(summary.ranking[0].errors, 1);
    assert.equal(summary.recent.length, 1);
    assert.equal(summary.recent[0].callId, 'c2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: alignment.js 6 层校验、Markdown 无损往返与 Ledger 同步', () => {
  const ws = tmp('harness-align-');
  try {
    assert.equal(ALIGNMENT_LAYERS.length, 6);
    assert.deepEqual(PROBE_VERDICTS, ['adopt', 'reject', 'reframe']);
    assert.throws(() => validateAlignmentCard({ topic: 'T', layers: { goal: 'only one' } }), /ALIGNMENT_INCOMPLETE/);
    assert.throws(
      () => validateAlignmentCard({
        topic: 'T',
        layers: { goal: 'g', constraints: 'c', deliverables: 'd', success_criteria: 's', assumptions: 'a', non_goals: 'n' },
        probes: [{ question: 'q', verdict: 'invalid-verdict' }],
      }),
      /ALIGNMENT_BAD_PROBE/,
    );

    const card = {
      slug: 'exp-alignment',
      topic: '消融实验预期对齐',
      layers: {
        goal: '验证特征工程对基线 F1 的贡献',
        constraints: ['单卡显存 <= 16GB', '保持随机种子固定'],
        deliverables: '3 组消融表格 + SVG 图件',
        success_criteria: '至少一项 F1 提升且给出显著性误差棒',
        assumptions: '输入训练集与验证集无标签泄漏',
        non_goals: '不改下游服务 API',
      },
      probes: [
        { id: 'P1', layer: 'goal', question: '是否同时做超参网格搜索?', verdict: 'reject', note: '先固定超参测特征' },
        { id: 'P2', layer: 'non_goals', question: '需不需要重构数据清洗脚本?', verdict: 'reframe', note: '改为单独记录 unknown 后置评估' },
      ],
      open_unknowns: [
        { what: '验证集边缘样本占比未知', classification: 'non-blocker', why: '首轮报告前统计即可' },
      ],
    };

    const written = writeAlignmentCard(ws, card);
    assert.ok(written.path.endsWith(join('.research', 'alignment', 'exp-alignment.md')));
    const loaded = readAlignmentCard(written.path);
    assert.equal(loaded.topic, card.topic);
    assert.deepEqual(loaded.layers.constraints, card.layers.constraints);
    assert.equal(loaded.probes.length, 2);
    assert.equal(loaded.probes[1].verdict, 'reframe');

    const ledger = new Ledger(join(ws, '.research'), { receipts: true }).ensure();
    const synced = syncAlignmentToLedger(loaded, ledger);
    assert.equal(synced.unknownsAdded, 1);
    assert.equal(synced.reframesRecorded, 1);
    const es = ledger.entries();
    assert.ok(es.some(e => e.kind === 'unknown' && e.what === '验证集边缘样本占比未知'));
    assert.ok(es.some(e => e.kind === 'alignment-reframe' && e.probeId === 'P2'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: Evolver.runEvaluator 隔离评审 + rollback/champion 重放闭环', async () => {
  const root = tmp('harness-evolve-v080-');
  try {
    mkdirSync(join(root, 'skills', 'demo-skill'), { recursive: true });
    mkdirSync(join(root, 'evals', 'skills', 'demo-skill'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    const skillPath = join(root, 'skills', 'demo-skill', 'SKILL.md');
    writeFileSync(skillPath, '# V0 baseline\n', 'utf8');
    writeFileSync(join(root, 'lib', 'dummy.js'), 'export const v = 1;\n', 'utf8');
    writeFileSync(
      join(root, 'evals', 'skills', 'demo-skill', 'behavior-cases.json'),
      JSON.stringify({ cases: [{ id: 'c1', prompt: 'must state V1+', hard: true }] }),
      'utf8',
    );
    writeFileSync(join(root, 'evals', 'skills', 'demo-skill', 'rubric.md'), '# Rubric\nPass if mentions V1 or V2.\n', 'utf8');

    const evalScript = join(root, 'run-eval.mjs');
    writeFileSync(
      evalScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const packet = JSON.parse(readFileSync(process.env.EVOLVE_PACKET_PATH, "utf8"));',
        'const text = packet.files.map(f => f.content).join("\\n");',
        'const pass = /V[12]/.test(text);',
        'writeFileSync(process.env.EVOLVE_VERDICT_PATH, JSON.stringify({ packet_id: packet.packet_id, results: { c1: pass ? "pass" : "fail" } }), "utf8");',
      ].join('\n'),
      'utf8',
    );

    const ev = new Evolver(root, 'demo');
    ev.init({ surface: 'skills/demo-skill/**' });
    const ledger = new Ledger(join(root, '.research'), { receipts: true }).ensure();

    const p1 = join(root, 'p1.json');
    writeFileSync(p1, JSON.stringify({
      id: 'cand-1',
      rationale: '升级到 V1 候选版本以通过评测规则',
      mutations: [{ file: 'skills/demo-skill/SKILL.md', expected_parent_sha256: sha256Bytes(readFileSync(skillPath)), new_content: '# V1 upgraded\n' }],
    }), 'utf8');
    const a1 = ev.applyProposal(p1);
    assert.equal(a1.status, 'applied', JSON.stringify(a1));

    const evalOut = await ev.runEvaluator([process.execPath, evalScript], { timeoutMs: 15000 });
    assert.equal(evalOut.status, 'evaluated');
    const sel1 = ev.select({ ledger });
    assert.equal(sel1.decision, 'kept');
    assert.equal(ev.champion().candidate, 'cand-1');

    // 应用 gen2 并跑隔离评审；因与 V1 同分且无 hard failure 修复，select 自动 revert 保留 V1
    const p2 = join(root, 'p2.json');
    writeFileSync(p2, JSON.stringify({
      id: 'cand-2',
      rationale: '升级到 V2 候选版本以验证平分回退机制',
      mutations: [{ file: 'skills/demo-skill/SKILL.md', expected_parent_sha256: sha256Bytes(readFileSync(skillPath)), new_content: '# V2 second\n' }],
    }), 'utf8');
    const a2 = ev.applyProposal(p2);
    assert.equal(a2.status, 'applied', JSON.stringify(a2));
    await ev.runEvaluator([process.execPath, evalScript], { timeoutMs: 15000 });
    assert.equal(ev.select({ ledger }).decision, 'reverted');

    // 模拟外部把技能文本弄脏后用 rollback({ gen: 1 }) 恢复至 gen1 treatment
    writeFileSync(skillPath, '# corrupted manually\n', 'utf8');
    const rb1 = ev.rollback({ gen: 1, reason: '恢复 V1 冠军快照', ledger });
    assert.equal(rb1.status, 'rolled_back');
    assert.equal(readFileSync(skillPath, 'utf8'), '# V1 upgraded\n');
    assert.equal(ev.champion().candidate, 'cand-1');

    // rollback({ gen: 1, toParent: true }) 撤回 gen1 至最初基线 V0，champion 回到 null
    const rbParent = ev.rollback({ gen: 1, toParent: true, reason: '撤回 V1 回归基线', ledger });
    assert.equal(rbParent.to_parent, true);
    assert.equal(readFileSync(skillPath, 'utf8'), '# V0 baseline\n');
    assert.equal(ev.champion(), null);
    assert.equal(ev.verifyArchive().ok, true);
    assert.ok(ledger.entries().filter(e => e.kind === 'evolve-rollback').length === 2);

    // 拒绝含 shell 注入字符的 evaluator 命令
    await assert.rejects(() => ev.runEvaluator('echo hi && evil'), /VERIFIER_UNSAFE_COMMAND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: applyPlugin 注册全部 13 个合法 schema 工具并闭环运行', async () => {
  const ws = tmp('harness-p1-ws-');
  const ledgerDir = join(ws, '.research');
  try {
    const tools = [];
    const handlers = new Map();
    let registeredGuard = null;
    const ctx = {
      logger: { info() {}, error() {} },
      tools: {
        guard(fn) { registeredGuard = fn; return () => {}; },
        register(def) { tools.push(def); return () => {}; },
      },
      on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    };

    applyPlugin(ctx, { ledgerRoot: ledgerDir, workspaceRoot: ws, verifier: { kind: 'evidence', maxAgeHours: 24 } });
    assert.equal(tools.length, 13);
    for (const def of tools) {
      assertNoUnionTypeArrays(def.parameters, def.name + '.parameters');
      assertNoUnionTypeArrays(def.output?.schema, def.name + '.output');
    }

    // 触发一次 guard -> tools/result 产生 span
    const execObj = { name: 'findings.status', callId: 't-1', arguments: { apiKey: 'hidden-val' } };
    assert.equal(registeredGuard(execObj), undefined);
    handlers.get('tools/result')(execObj, { content: [{ type: 'text', text: 'ok' }], isError: false });

    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    const spanRes = await byName['findings.spans'].execute({ limit: 5 }, { name: 'findings.spans' });
    assert.equal(spanRes.totalCalls, 1);
    assert.ok(spanRes.recent[0].inputSummary.includes('[REDACTED]'));

    // findings.ingest + mark-verified
    const ing = await byName['findings.ingest'].execute({
      source: 'unit-md',
      task: 'TASK-0800',
      markdown: '```findings\n[{"claim":"P1 ingest 测试通过","confidence":"observed","provenance":"tool:node-test"}]\n```\n',
    }, { name: 'findings.ingest' });
    assert.equal(ing.ingested, 1);
    const mv = await byName['findings.mark-verified'].execute({ id: ing.ids[0], note: '已复验' }, { name: 'findings.mark-verified' });
    assert.equal(mv.status, 'lead-verified');

    // alignment.record
    const alignOut = await byName['alignment.record'].execute({
      slug: 'p1-unit',
      topic: '单测对齐',
      layers: {
        goal: 'g', constraints: 'c', deliverables: 'd', success_criteria: 's', assumptions: 'a', non_goals: 'n',
      },
      probes: [{ layer: 'goal', question: 'q1', verdict: 'reframe', note: 'adjusted' }],
      open_unknowns: [{ what: '待定边界', classification: 'non-blocker' }],
    }, { name: 'alignment.record' });
    assert.equal(alignOut.unknownsAdded, 1);
    assert.equal(alignOut.reframesRecorded, 1);
    assert.ok(existsSync(alignOut.path));

    // findings.route 持久化按 task 计算 repairFailed
    const r1 = await byName['findings.route'].execute({ task: 'TASK-0800', repairFailed: true }, { name: 'findings.route' });
    assert.notEqual(r1.action, 'BLOCKED');
    const r2 = await byName['findings.route'].execute({ task: 'TASK-0800', repairFailed: true }, { name: 'findings.route' });
    assert.equal(r2.action, 'BLOCKED');
    assert.equal(r2.detail.task, 'TASK-0800');

    // findings.aggregate 带入 maxAgeHours
    const l = new Ledger(ledgerDir, { receipts: true });
    l.append({ kind: 'finding', id: 'E99', claim: '陈旧条目', confidence: 'observed', provenance: 'tool:x', ts: '2020-01-01T00:00:00Z' });
    const aggOut = await byName['findings.aggregate'].execute({}, { name: 'findings.aggregate' });
    assert.equal(aggOut.counts.stale, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('v0.8.0 P1: CLI 新增 spans、alignment、route --repair-failed 与 evolve eval/rollback', () => {
  const ws = tmp('harness-cli-v080-');
  const ledgerDir = join(ws, '.research');
  try {
    mkdirSync(join(ws, 'skills', 's1'), { recursive: true });
    mkdirSync(join(ws, 'evals', 'skills', 's1'), { recursive: true });
    const skillFile = join(ws, 'skills', 's1', 'SKILL.md');
    writeFileSync(skillFile, '# Base\n', 'utf8');
    writeFileSync(join(ws, 'evals', 'skills', 's1', 'behavior-cases.json'), JSON.stringify({ cases: [{ id: 'c1', prompt: 'p', hard: true }] }), 'utf8');
    writeFileSync(join(ws, 'evals', 'skills', 's1', 'rubric.md'), '# R\nMust have Candidate.\n', 'utf8');

    const evalScript = join(ws, 'ev.mjs');
    writeFileSync(evalScript, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const p = JSON.parse(readFileSync(process.env.EVOLVE_PACKET_PATH, "utf8"));',
      'const ok = p.files.some(f => f.content.includes("Candidate"));',
      'writeFileSync(process.env.EVOLVE_VERDICT_PATH, JSON.stringify({ packet_id: p.packet_id, results: { c1: ok ? "pass" : "fail" } }), "utf8");',
    ].join('\n'), 'utf8');

    const runCli = (argv) => {
      const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: 'utf8', cwd: ws });
      assert.equal(r.status, 0, argv.join(' ') + '\n' + r.stderr);
      return JSON.parse(r.stdout);
    };

    runCli(['init', '--ledger', ledgerDir]);
    const recOut = runCli(['record', '--claim', 'cli test', '--provenance', 'tool:cli', '--task', 'TASK-0099', '--ledger', ledgerDir]);
    assert.ok(recOut.ok);

    // alignment save + read
    const cardPath = join(ws, 'card.json');
    writeFileSync(cardPath, JSON.stringify({
      slug: 'cli-card',
      topic: 'CLI 对齐',
      layers: { goal: 'g', constraints: 'c', deliverables: 'd', success_criteria: 's', assumptions: 'a', non_goals: 'n' },
      open_unknowns: [{ what: 'cli unknown', classification: 'non-blocker' }],
    }), 'utf8');
    const saved = runCli(['alignment', 'save', '--file', cardPath, '--root', ws, '--ledger', ledgerDir, '--sync']);
    assert.equal(saved.synced.unknownsAdded, 1);
    const readBack = runCli(['alignment', 'read', '--file', saved.path]);
    assert.equal(readBack.card.topic, 'CLI 对齐');

    // route --repair-failed --task
    const r1 = runCli(['route', '--scale', 'delegate', '--task', 'TASK-0099', '--repair-failed', '--ledger', ledgerDir]);
    assert.notEqual(r1.action, 'BLOCKED');
    const r2 = runCli(['route', '--scale', 'delegate', '--task', 'TASK-0099', '--repair-failed', '--ledger', ledgerDir]);
    assert.equal(r2.action, 'BLOCKED');

    // spans
    writeFileSync(join(ledgerDir, 'spans.jsonl'), JSON.stringify({ ts: new Date().toISOString(), tool: 'read', callId: 'x', durationMs: 12, ok: true, inputSummary: '{}' }) + '\n', 'utf8');
    const sp = runCli(['spans', '--limit', '5', '--ledger', ledgerDir]);
    assert.equal(sp.totalCalls, 1);
    assert.equal(sp.ranking[0].tool, 'read');

    // evolve init -> apply -> eval -> select -> rollback
    runCli(['evolve', 'init', '--name', 'expcli', '--surface', 'skills/s1/**', '--root', ws]);
    const propPath = join(ws, 'prop.json');
    writeFileSync(propPath, JSON.stringify({
      id: 'c-cli',
      rationale: 'add Candidate',
      mutations: [{ file: 'skills/s1/SKILL.md', expected_parent_sha256: sha256Bytes(readFileSync(skillFile)), new_content: '# Candidate\n' }],
    }), 'utf8');
    runCli(['evolve', 'apply', '--name', 'expcli', '--candidate', propPath, '--root', ws]);
    const evOut = runCli(['evolve', 'eval', '--name', 'expcli', '--cmd', JSON.stringify([process.execPath, evalScript]), '--root', ws]);
    assert.equal(evOut.status, 'evaluated');
    const selOut = runCli(['evolve', 'select', '--name', 'expcli', '--root', ws, '--ledger', ledgerDir]);
    assert.equal(selOut.decision, 'kept');
    const rbOut = runCli(['evolve', 'rollback', '--name', 'expcli', '--gen', '1', '--to-parent', '--reason', 'cli test rollback', '--root', ws, '--ledger', ledgerDir]);
    assert.equal(rbOut.to_parent, true);
    assert.equal(rbOut.champion, null);
    assert.equal(readFileSync(skillFile, 'utf8'), '# Base\n');

    // PKG_VERSION 与当前 package.json 一致
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(PKG_VERSION, pkg.version);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
