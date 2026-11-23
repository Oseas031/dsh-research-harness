import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProvenance, gateEntry, gateExec } from '../lib/evidence-gate.js';
import { Ledger } from '../lib/ledger.js';
import { completionGate } from '../lib/completion.js';
import { createVerifier } from '../lib/verifier.js';
import { apply } from '../lib/index.js';

const T = () => mkdtempSync(join(tmpdir(), 'rh-test-'));

test('evidence-gate: provenance 形态判定', () => {
  assert.equal(validateProvenance('https://arxiv.org/html/x'), null);
  assert.equal(validateProvenance('doi:10.1234/x'), null);
  assert.equal(validateProvenance('arxiv:2610.30808'), null);
  assert.equal(validateProvenance('src/app.py:42'), null);
  assert.equal(validateProvenance('E:/ws/data.csv:10-18'), null);
  assert.equal(validateProvenance('tool:web_search "pricing"'), null);
  assert.equal(validateProvenance('').code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(validateProvenance('我觉得是这样').code, 'EVIDENCE_BAD_PROVENANCE');
});
test('evidence-gate: gateEntry 与 gateExec', () => {
  assert.equal(gateEntry({ claim: 'ok', confidence: 'observed', provenance: 'a.py:1' }), null);
  assert.equal(gateEntry({ claim: 'xx', confidence: 'observed' }).code, 'EVIDENCE_NO_PROVENANCE');
  assert.equal(gateEntry({ claim: 'xx', confidence: 'maybe', provenance: 'a.py:1' }).code, 'EVIDENCE_BAD_CONFIDENCE');
  const d = gateExec('findings_record', { entries: [{ claim: 'xx', confidence: 'observed' }] });
  assert.equal(d.code, 'EVIDENCE_NO_PROVENANCE');
  assert.ok(d.reason.includes('entries[0]'));
  assert.equal(gateExec('findings_record', { entries: [{ claim: 'xx', confidence: 'observed', provenance: 'a.py:1' }] }), null);
  assert.equal(gateExec('other.tool', { entries: [] }), null);
});

test('ledger: 入账/unknown/blocker/resolve/stats', () => {
  const l = new Ledger(T()).ensure();
  const a = l.record({ claim: 'A', confidence: 'observed', provenance: 'a.py:1' });
  const b = l.record({ claim: 'B', confidence: 'inferred', provenance: 'https://x' });
  const u1 = l.addUnknown({ what: '模型来源未定', classification: 'blocker' });
  l.addUnknown({ what: '次要口径', classification: 'non-blocker' });
  assert.equal(l.blockers().length, 1);
  assert.equal(l.blockers()[0].id, u1.id);
  l.resolve(u1.id, '已核对官方页面');
  assert.equal(l.blockers().length, 0);
  const s = l.stats();
  assert.equal(s.byKind.finding, 2);
  assert.equal(s.byConfidence.observed, 1);
  assert.equal(s.openUnknowns['non-blocker'], 1);
  assert.equal(a.id, 'E1');
  assert.equal(u1.id, 'U3');
});

test('completion: blocker 挡 complete，清零放行', () => {
  const l = new Ledger(T()).ensure();
  l.addUnknown({ what: '缺口X', classification: 'blocker' });
  const v = createVerifier({ kind: 'evidence', enabled: false });
  const d = completionGate({ toolName: 'update_goal', args: { action: 'complete' }, ledger: l, verifier: v });
  assert.equal(d.code, 'EVIDENCE_BLOCKERS_OPEN');
  assert.equal(l.entries().at(-1).outcome, 'inconclusive');
  l.resolve(l.blockers().length ? l.entries().filter(e => e.kind === 'unknown')[0].id : null, 'done');
  assert.equal(l.blockers().length, 0);
  assert.equal(completionGate({ toolName: 'update_goal', args: { action: 'complete' }, ledger: l, verifier: v }), null);
  assert.equal(completionGate({ toolName: 'update_goal', args: { action: 'pause' }, ledger: l, verifier: v }), null);
  assert.equal(completionGate({ toolName: 'todo_write', args: { action: 'complete' }, ledger: l, verifier: v }), null);
});

test('verifier: evidence 复验抓坏条目', () => {
  const l = new Ledger(T()).ensure();
  l.record({ claim: 'good', confidence: 'observed', provenance: 'https://x' });
  l.record({ claim: 'bad', confidence: 'observed', provenance: '我猜的' });
  const v = createVerifier({ kind: 'evidence', enabled: true });
  const r = v.verify(l);
  assert.equal(r.pass, false);
  assert.equal(r.failed.length, 1);
});

test('apply(): 守卫与工具挂载、拒无 provenance、放行有 provenance、solo 拒派单', () => {
  const root = T();
  const guards = [];
  const tools = [];
  const events = {};
  const ctx = {
    logger: { info() {}, error() {} },
    tools: {
      guard(fn) { guards.push(fn); return () => {}; },
      register(def) { tools.push(def); return () => {}; },
    },
    on(ev, fn) { events[ev] = fn; return () => {}; },
  };
  apply(ctx, { ledgerRoot: root, clusterScale: 'delegate' });
  assert.equal(guards.length, 1);
  const names = tools.map(t => t.name);
  assert.ok(names.includes('findings_record'));
  assert.ok(names.includes('findings_status'));
  const rec = tools.find(t => t.name === 'findings_record');
  assert.ok(rec.parameters.properties.entries);
  assert.ok(typeof rec.output.render === 'function');

  const g = guards[0];
  // 拒：无 provenance
  const d1 = g({ name: 'findings_record', args: { entries: [{ claim: 'xx', confidence: 'observed' }] } });
  assert.equal(d1.info.code, 'EVIDENCE_NO_PROVENANCE');
  // 放行 + 执行入账
  assert.equal(g({ name: 'findings_record', args: { entries: [{ claim: 'xx', confidence: 'observed', provenance: 'a.py:1' }] } }), undefined);
  // guard-log 已落两条（一条 wired + 一条拒绝）
  const log = readFileSync(join(root, 'guard-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some(e => e.code === 'EVIDENCE_NO_PROVENANCE'));
  assert.ok(log.some(e => e.kind === 'wired'));
  // 执行体入账
  const out = rec.execute({ entries: [{ claim: 'works', confidence: 'observed', provenance: 'https://x' }] });
  // 同步 execute 返回 promise —— findings_record 是 async
  Promise.resolve(out).then(r => assert.equal(r.recorded, 1));
  const st = tools.find(t => t.name === 'findings_status');
  // 完成语义拒
  const l2 = new Ledger(root);
  l2.addUnknown({ what: '缺', classification: 'blocker' });
  const d2 = g({ name: 'update_goal', args: { action: 'complete' } });
  assert.equal(d2.info.code, 'EVIDENCE_BLOCKERS_OPEN');
  // solo 拒派单
  apply({ ...ctx, tools: { guard(fn) { guards.push(fn); return () => {}; }, register(def) { tools.push(def); return () => {}; } } }, { ledgerRoot: T(), clusterScale: 'solo' });
  const d3 = guards.at(-1)({ name: 'subagent', args: { description: 'd', prompt: 'p' } });
  assert.equal(d3.info.code, 'SCALE_SOLO_NO_DELEGATION');
});
