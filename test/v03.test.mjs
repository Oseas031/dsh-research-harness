import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../lib/ledger.js';
import { aggregate, verdictOf, numericTolerance, setOverlap, meanSemOf } from '../lib/aggregate.js';
import { validateChallenge, downgradedIds } from '../lib/challenge.js';
import { validateCost } from '../lib/cost.js';
import { validateRepro } from '../lib/repro.js';
import { createVerifier } from '../lib/verifier.js';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rh-v03-'));
const ledger = new Ledger(dir).ensure();

test('缺口① aggregate：JUnit 计数 + TAP 文法', () => {
  ledger.record({ claim: '观察到 A', confidence: 'observed', provenance: 'https://arxiv.org/abs/2408.06292' });
  ledger.record({ claim: '推断 B', confidence: 'inferred', provenance: 'tool:web_search' });
  ledger.record({ claim: '待查 C', confidence: 'unknown', provenance: 'src/app.py:42' });
  const r = aggregate(ledger.entries());
  assert.equal(r.counts.tests, 3);
  assert.equal(r.counts.failures, 0);
  assert.ok(r.tap.includes('1..3'));
  assert.ok(r.tap.includes('# TODO'));
  assert.ok(Math.abs(r.rate - 1) < 1e-9);
});

test('缺口① verdict 显式覆盖 + not_ok', () => {
  ledger.record({ claim: '失败的复核', confidence: 'observed', provenance: 'tool:read', verdict: 'not_ok' });
  const r = aggregate(ledger.entries());
  assert.equal(r.counts.failures, 1);
  assert.ok(r.tap.includes('not ok'));
});

test('缺口① mean±SEM 多 seed 聚簇', () => {
  const es = [
    { kind: 'finding', claim: 'acc', confidence: 'observed', provenance: 'x', metric: 0.71 },
    { kind: 'finding', claim: 'acc', confidence: 'observed', provenance: 'x', metric: 0.73 },
    { kind: 'finding', claim: 'acc', confidence: 'observed', provenance: 'x', metric: 0.74 },
  ];
  const ms = meanSemOf(es);
  assert.ok(ms && ms.length === 1);
  assert.ok(Math.abs(ms[0].mean - 0.7266) < 1e-3);
  assert.ok(ms[0].seeds === 3);
});

test('缺口① numericTolerance + setOverlap', () => {
  assert.equal(numericTolerance(1.0, 1.01, 0.01, 1), 'ok');
  assert.equal(numericTolerance(1.0, 1.5, 0.01, 1), 'not_ok');
  const ov = setOverlap(['a', 'b', 'c'], ['a', 'b', 'd']);
  assert.ok(Math.abs(ov.iou - 0.5) < 1e-9);
});

test('缺口② challenge 门：入账 + 降档 + blocker', () => {
  const c1 = ledger.challenge({ ref: 'E1', hypothesis: 'A 未必成立，另有反例', cito: 'refutes', provenance: 'https://arxiv.org/abs/2502.14297' });
  assert.ok(c1.id);
  const dg = downgradedIds(ledger.entries());
  assert.ok(dg.has('E1'));
  // 未决 refutes → blocker
  const bl = ledger.blockers();
  assert.ok(bl.some(b => /未决挑战/.test(String(b.what))));
  // resolve 后恢复
  ledger.resolveChallenge(c1.id, '反例不成立');
  assert.ok(!ledger.blockers().some(b => b.id === c1.id));
  assert.ok(!downgradedIds(ledger.entries()).has('E1'));
});

test('缺口② validateChallenge 拒绝项', () => {
  assert.equal(validateChallenge({ ref: 'E1', hypothesis: '足够长的假设句', cito: 'refutes' })?.code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(validateChallenge({ ref: 'E1', hypothesis: '足够长的假设句', cito: 'bad', provenance: 'https://x' })?.code, 'CHALLENGE_BAD_CITO');
});

test('缺口③ cost 槽：词表校验 + 聚合', () => {
  assert.equal(validateCost({ input_tokens: 100, cost_usd: 0.2 }), null);
  assert.equal(validateCost({ bad_key: 1 })?.code, 'COST_BAD_KEY');
  assert.equal(validateCost({ input_tokens: -5 })?.code, 'COST_BAD_VALUE');
  ledger.record({ claim: '带成本的发现', confidence: 'observed', provenance: 'tool:run_code', tokens: { input_tokens: 1200, output_tokens: 300, 'reasoning.output_tokens': 80, cost_usd: 0.15 } });
  const r = aggregate(ledger.entries());
  assert.equal(r.cost.tokens.input_tokens, 1200);
  assert.equal(r.cost.tokens.reasoning, 80);
  assert.ok(Math.abs(r.cost.cost_usd - 0.15) < 1e-9);
});

test('缺口④ repro 槽：SLSA 字段校验', () => {
  assert.equal(validateRepro({ build_type: 'run.py', subject_digest: 'a'.repeat(64), invocation_id: 'inv-1' }), null);
  assert.equal(validateRepro({ nope: 1 })?.code, 'REPRO_BAD_KEY');
  assert.equal(validateRepro({ subject_digest: 'xyz' })?.code, 'REPRO_BAD_DIGEST');
  ledger.record({ claim: '结果复现成功', confidence: 'observed', provenance: 'tool:run_code', repro: { build_type: 'run.py', subject_digest: 'b'.repeat(64), invocation_id: 'inv-2', started_on: '2026-11-18T09:00:00Z' } });
  const e = ledger.entries().filter(e => e.repro).pop();
  assert.equal(e.repro.build_type, 'run.py');
});

test('verifier 时效降档：stale 条目告警', () => {
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const d2 = mkdtempSync(join(tmpdir(), 'rh-v03b-'));
  const l2 = new Ledger(d2).ensure();
  l2.append({ kind: 'finding', ts: old, claim: '老证据', confidence: 'observed', provenance: 'https://x' });
  const v = createVerifier({ maxAgeHours: 24 });
  const verdict = v.verify(l2);
  assert.equal(verdict.pass, true); // 告警不挡 pass——降档由聚合器处理
  assert.ok(verdict.warnings.length === 1);
  rmSync(d2, { recursive: true, force: true });
});

test('corrupt-line 不炸聚合器', () => {
  appendFileSync(join(dir, 'ledger.jsonl'), '{broken\n');
  const r = aggregate(ledger.entries());
  assert.ok(typeof r.counts.tests === 'number');
});

rmSync(dir, { recursive: true, force: true });
