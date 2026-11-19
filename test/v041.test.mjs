import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../lib/ledger.js';
import { route } from '../lib/route.js';
import { verifyLedger } from '../lib/receipts.js';
import { parseFindingsBlocks, ingestReport, markVerified, checkProvenance } from '../lib/ingest.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'rh041-'));
const BIN = fileURLToPath(new URL('../bin/research-harness.mjs', import.meta.url));
const NODE = process.execPath;
const cli = (args, cwd) => spawnSync(NODE, [BIN, ...args], { encoding: 'utf8', timeout: 60000, ...(cwd ? { cwd } : {}) });
const FB = '```findings';

test('route：充分性不足 → continue-recording（issue #6 核心）', () => {
  const d = tmp(); const led = new Ledger(d, { receipts: true }).ensure();
  led.record({ claim: 'a', confidence: 'observed', provenance: 'file:x:1' });
  led.record({ claim: 'b', confidence: 'observed', provenance: 'file:x:2' });
  led.record({ claim: 'c', confidence: 'inferred', provenance: 'file:x:3' });
  const r = route(led, { acceptance: { minFindings: 5 } });
  assert.equal(r.action, 'continue-recording');
  assert.ok(r.detail.short.some(s => s.check === 'minFindings' && s.have === 3 && s.need === 5));
  const r2 = route(led, { acceptance: { minObservedRatio: 0.9 } });
  assert.equal(r2.action, 'continue-recording'); // 2/3=0.667 < 0.9
  const r3 = route(led, { acceptance: { requiredRouteChecks: 1 } });
  assert.equal(r3.action, 'continue-recording');
  led.append({ kind: 'route-check', action: 'run-acceptance', why: 'x' });
  const r4 = route(led, { acceptance: { requiredRouteChecks: 1 } });
  assert.equal(r4.action, 'run-acceptance');
  rmSync(d, { recursive: true, force: true });
});

test('route：无 acceptance 规格 → 行为与 v0.4 一致（向后兼容）', () => {
  const d = tmp(); const led = new Ledger(d, { receipts: true }).ensure();
  led.record({ claim: 'a', confidence: 'observed', provenance: 'file:x:1' });
  assert.equal(route(led, {}).action, 'run-acceptance');
  assert.equal(route(led).action, 'run-acceptance');
  rmSync(d, { recursive: true, force: true });
});

test('record：verifiedBy 枚举校验', () => {
  const d = tmp(); const led = new Ledger(d, { receipts: true }).ensure();
  const rec = led.record({ claim: 'a', confidence: 'observed', provenance: 'file:x:1', verifiedBy: 'agent-reported' });
  assert.equal(rec.verifiedBy, 'agent-reported');
  assert.throws(() => led.record({ claim: 'b', confidence: 'observed', provenance: 'file:x:2', verifiedBy: 'bogus' }), /EVIDENCE_BAD_VERIFIED_BY/);
  rmSync(d, { recursive: true, force: true });
});

test('ingest：findings 块解析 + 入账 + verifiedBy 缺省 agent-reported', () => {
  const d = tmp(); const led = new Ledger(d, { receipts: true }).ensure();
  const md = [
    '# 报告', '',
    FB,
    JSON.stringify([
      { claim: '发现一', confidence: 'observed', provenance: 'file:main.tex:42', task: 'TASK-0002', tags: ['x'] },
      { claim: '发现二', confidence: 'inferred', provenance: 'no-prefix-provenance' },
    ]),
    '```', '',
    FB,
    JSON.stringify({ claim: '发现三', provenance: 'url:https://example.com' }),
    '```', '',
    FB,
    '{broken json',
    '```',
  ].join('\n');
  const p = join(d, 'report.md'); writeFileSync(p, md, 'utf8');
  const r = ingestReport(led, p, { source: 'TEST-R' });
  assert.equal(r.ingested, 3);
  assert.equal(r.errors.length, 1);
  assert.ok(r.warnings.some(w => /无建议前缀/.test(w.warning)));
  const es = led.entries().filter(e => e.kind === 'finding');
  assert.equal(es.length, 3);
  assert.ok(es.every(e => e.provenance.startsWith('report:TEST-R | ')));
  assert.ok(es.every(e => e.verifiedBy === 'agent-reported'));
  assert.equal(es[0].task, 'TASK-0002');
  const up = markVerified(led, es[0].id, 'lead 亲验');
  assert.equal(up.kind, 'finding-update'); assert.equal(up.status, 'lead-verified');
  assert.equal(verifyLedger(led.file).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test('parseFindingsBlocks：缺 claim 收进 errors；checkProvenance 前缀建议', () => {
  const { findings, errors } = parseFindingsBlocks(FB + '\n' + JSON.stringify({ claim: '', provenance: 'file:a:1' }) + '\n```');
  assert.equal(findings.length, 0); assert.equal(errors.length, 1);
  assert.equal(checkProvenance('file:a:1'), null);
  assert.ok(checkProvenance('随便一句话') !== null);
});

test('CLI：record→route(落 route-check)→verify→status 全链（issue #4）', () => {
  const d = tmp();
  let r = cli(['record', '--claim', 'cli 发现', '--provenance', 'file:a:1', '--task', 'TASK-0002', '--ledger', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  r = cli(['route', '--ledger', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, 'run-acceptance'); // 1 finding 无 blocker → run-acceptance
  r = cli(['route', '--ledger', d]);
  assert.equal(JSON.parse(r.stdout).detail.routeChecks, 1); // 计算时点已有 1 条（第一次调用落的）
  r = cli(['verify', '--ledger', d]);
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).ok, true);
  r = cli(['status', '--ledger', d]);
  assert.equal(JSON.parse(r.stdout).stats.byKind['route-check'], 2);
  r = cli(['route', '--acceptance', 'nope.json', '--ledger', d]);
  assert.notEqual(r.status, 0); // 坏路径报错而非静默
  rmSync(d, { recursive: true, force: true });
});

test('CLI：gate-skip 校验与 ingest 子命令', () => {
  const d = tmp();
  let r = cli(['gate-skip', '--gate', 'gate-1', '--reason', '为啥跳过', '--risk', '风险描述', '--compensation', '事后补偿', '--ledger', d]);
  assert.equal(r.status, 0);
  r = cli(['gate-skip', '--gate', 'gate-1', '--reason', '为啥跳过', '--ledger', d]);
  assert.notEqual(r.status, 0); // 缺 compensation 拒
  const md = join(d, 'rep.md'); writeFileSync(md, FB + '\n' + JSON.stringify({ claim: 'c1', provenance: 'file:a:1' }) + '\n```', 'utf8');
  r = cli(['ingest', '--file', md, '--source', 'S', '--task', 'TASK-0002', '--ledger', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ingested, 1);
  rmSync(d, { recursive: true, force: true });
});
