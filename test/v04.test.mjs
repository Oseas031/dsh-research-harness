import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../lib/ledger.js';
import { verifyLedger, appendReceipt, receiptOf } from '../lib/receipts.js';
import { route, REPAIR_CAP } from '../lib/route.js';
import { completionGate } from '../lib/completion.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'rh-v04-'));

test('v0.4 收据层：正常写入后 verify 全 ok', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: true }).ensure();
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  l.record({ claim: 'B', confidence: 'inferred', provenance: 'src/b.js:2' });
  const v = verifyLedger(l.file);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 2);
  assert.equal(v.unverified, 0);
  assert.equal(v.drifted.length, 0);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 收据层：手改一行 → drifted 立即可检', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: true }).ensure();
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  l.record({ claim: 'B', confidence: 'inferred', provenance: 'src/b.js:2' });
  // 手改第二行
  const lines = readFileSync(l.file, 'utf8').split('\n').filter(Boolean);
  lines[1] = lines[1].replace('"claim":"B"', '"claim":"B-tampered"');
  writeFileSync(l.file, lines.join('\n') + '\n', 'utf8');
  const v = verifyLedger(l.file);
  assert.equal(v.ok, false);
  assert.equal(v.drifted.length, 1);
  assert.equal(v.drifted[0].line, 2);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 收据层：删行 → drifted（收据比行多）', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: true }).ensure();
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  l.record({ claim: 'B', confidence: 'inferred', provenance: 'src/b.js:2' });
  const lines = readFileSync(l.file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(l.file, lines[0] + '\n', 'utf8'); // 删第二行
  const v = verifyLedger(l.file);
  assert.equal(v.ok, false);
  assert.equal(v.drifted.length, 1);
  assert.equal(v.unverified, 0);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 收据层：旧台账（无收据）→ unverified 不报错', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: false }).ensure(); // 旧模式
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  const v = verifyLedger(l.file);
  assert.equal(v.ok, true); // 无 drifted
  assert.equal(v.unverified, 1);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 task 字段：合法 REQ/TASK 入账，非法格式拒绝', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: true }).ensure();
  const r = l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1', task: 'REQ-0002' });
  assert.equal(r.task, 'REQ-0002');
  assert.throws(() => l.record({ claim: 'B', confidence: 'observed', provenance: 'src/b.js:2', task: '随便写' }), /EVIDENCE_BAD_TASK/);
  assert.throws(() => l.record({ claim: 'C', confidence: 'observed', provenance: 'src/c.js:3', task: 'REQ-2' }), /EVIDENCE_BAD_TASK/);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 gate_skipped：三字段校验 + 覆盖放行路径', () => {
  const d = tmp();
  const l = new Ledger(d, { receipts: true }).ensure();
  const u = l.addUnknown({ what: '缺基准数据', why: '数据集未发布', classification: 'blocker' });
  // 缺字段拒
  assert.throws(() => l.gateSkipped({ gate: 'EVIDENCE_BLOCKERS_OPEN', reason: 'x', risk: 'y', compensation: '' }), /GATE_SKIP_BAD_FIELD/);
  // completionGate 挡
  const deny = completionGate({ toolName: 'update_goal', args: { action: 'complete' }, ledger: l });
  assert.equal(deny.code, 'EVIDENCE_BLOCKERS_OPEN');
  // 合法 skip 覆盖该 blocker → 放行
  l.gateSkipped({ gate: 'EVIDENCE_BLOCKERS_OPEN', reason: '基准数据未发布，等上游', risk: '结论外推受限', compensation: '上线后补跑基准并 record', covers: [u.id] });
  const pass = completionGate({ toolName: 'update_goal', args: { action: 'complete' }, ledger: l });
  assert.equal(pass, null);
  // 落账留痕
  const kinds = l.entries().map(e => e.kind);
  assert.ok(kinds.includes('gate_skipped'));
  assert.ok(kinds.includes('completion-attempt'));
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 route()：空台账 → record-findings', () => {
  const d = tmp();
  const l = new Ledger(d).ensure();
  assert.equal(route(l).action, 'record-findings');
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 route()：有 blocker → resolve-blockers', () => {
  const d = tmp();
  const l = new Ledger(d).ensure();
  l.addUnknown({ what: 'x', classification: 'blocker' });
  const r = route(l);
  assert.equal(r.action, 'resolve-blockers');
  assert.equal(r.detail.length, 1);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 route()：blocker 被 gate_skipped 覆盖 → run-acceptance（与 completionGate 同判据）', () => {
  const d = tmp();
  const l = new Ledger(d).ensure();
  const u = l.addUnknown({ what: 'x', classification: 'blocker' });
  l.gateSkipped({ gate: 'EVIDENCE_BLOCKERS_OPEN', reason: '上游未发布', risk: '外推受限', compensation: '后续补跑', covers: [u.id] });
  const r = route(l);
  assert.equal(r.action, 'run-acceptance');
  assert.equal(r.detail.skipped, 1);
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 route()：有产出无 blocker → run-acceptance', () => {
  const d = tmp();
  const l = new Ledger(d).ensure();
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  assert.equal(route(l).action, 'run-acceptance');
  rmSync(d, { recursive: true, force: true });
});

test('v0.4 route()：修复轮上限 → BLOCKED（solo=3 / delegate=2）', () => {
  const d = tmp();
  const l = new Ledger(d).ensure();
  l.record({ claim: 'A', confidence: 'observed', provenance: 'src/a.js:1' });
  assert.equal(route(l, { repairRounds: 1, clusterScale: 'delegate' }).action, 'run-acceptance'); // 1<2 未到
  assert.equal(route(l, { repairRounds: 2, clusterScale: 'delegate' }).action, 'BLOCKED');
  assert.equal(route(l, { repairRounds: 2, clusterScale: 'solo' }).action, 'run-acceptance'); // 2<3 未到
  assert.equal(route(l, { repairRounds: 3, clusterScale: 'solo' }).action, 'BLOCKED');
  assert.equal(REPAIR_CAP.solo, 3);
  assert.equal(REPAIR_CAP.delegate, 2);
  rmSync(d, { recursive: true, force: true });
});
