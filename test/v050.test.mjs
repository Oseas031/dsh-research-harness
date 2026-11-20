import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Evolver, globToRe, hashTree, surfaceViolation,
} from '../lib/evolve.js';
import { Ledger } from '../lib/ledger.js';
import { route } from '../lib/route.js';

const SURFACE = 'skills/validate-data/**';
const SKILL = 'skills/validate-data/SKILL.md';
const ORIGINAL = '# Validate data\n\nCheck accuracy before sharing.\n';
const CASE_IDS = ['case-a', 'case-b', 'case-hard'];
const BS = String.fromCharCode(92);

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeEvalAssets(root, { cases = true, rubric = true } = {}) {
  const dir = join(root, 'evals/skills/validate-data');
  if (cases) {
    writeJson(join(dir, 'behavior-cases.json'), {
      cases: [
        { id: 'case-a', prompt: 'Check an ordinary table.' },
        { id: 'case-b', prompt: 'Check mixed sources in one table.' },
        { id: 'case-hard', prompt: 'Reject an irreproducible sampling claim.', hard: true },
      ],
    });
  }
  if (rubric) {
    writeJson(join(dir, 'ignored.json'), { note: 'auxiliary frozen evaluator asset' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rubric.md'), '# Frozen rubric\n\nPass only when the text addresses every case.\n', 'utf8');
  }
}

function fixture(t, { evals = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rh-v050-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const files = {
    [SKILL]: ORIGINAL,
    'lib/frozen-evaluator.js': 'export const frozen = true;\n',
    'bin/frozen-evaluator.mjs': '# frozen evaluator entry\n',
    'test/frozen-evaluator.test.mjs': '# frozen evaluator test\n',
    'harness-lab/frozen.mjs': '# frozen protocol\n',
    'instructions/frozen.md': '# frozen instructions\n',
    'docs/frozen.md': '# frozen docs\n',
    '.research/ledger.jsonl': '',
    'package.json': '{"name":"isolated-evolution-fixture"}\n',
    'dsh.patch.yml': '# frozen patch\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  if (evals) writeEvalAssets(root);
  return {
    root,
    skillFile: join(root, SKILL),
    rubricFile: join(root, 'evals/skills/validate-data/rubric.md'),
  };
}

function initialized(t) {
  const f = fixture(t);
  const evolver = new Evolver(f.root, 'poc');
  const contract = evolver.init({ surface: SURFACE });
  assert.equal(contract.surface, SURFACE);
  assert.match(contract.evaluator_id, /^[0-9a-f]{64}$/);
  return { ...f, evolver };
}

function proposal(root, id, mutations) {
  const file = join(root, '.tmp', id + '.json');
  writeJson(file, {
    id,
    rationale: 'Evidence driven isolated test proposal.',
    mutations,
  });
  return file;
}

function applyText(f, evolver, id, text, expectedParent) {
  const mutation = { file: SKILL, new_content: text };
  if (expectedParent !== undefined) mutation.expected_parent_sha256 = expectedParent;
  return evolver.applyProposal(proposal(f.root, id, [mutation]));
}

function packetFor(applied, label) {
  return readJson(applied.packets[label].path);
}

function isTreatmentPacket(packet, treatmentText) {
  return packet.files.some(file => file.content === treatmentText);
}

function writeVerdict(packet, passes, { packetId = packet.packet_id, omit, raw } = {}) {
  if (raw !== undefined) {
    mkdirSync(dirname(packet.verdict_path), { recursive: true });
    writeFileSync(packet.verdict_path, raw, 'utf8');
    return;
  }
  const results = {};
  const evidence = {};
  for (const item of packet.cases) {
    if (item.id !== omit) results[item.id] = passes.includes(item.id) ? 'pass' : 'fail';
    evidence[item.id] = 'Quoted skill text for ' + item.id;
  }
  writeJson(packet.verdict_path, { packet_id: packetId, results, evidence });
}

function judge(applied, treatmentText, { treatmentPass, controlPass }) {
  for (const label of ['A', 'B']) {
    const packet = packetFor(applied, label);
    const treatment = isTreatmentPacket(packet, treatmentText);
    writeVerdict(packet, treatment ? treatmentPass : controlPass);
  }
}

function applyJudgeSelect(f, evolver, id, text, scores) {
  const applied = applyText(f, evolver, id, text);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  judge(applied, text, scores);
  return evolver.select();
}

function bytesSha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('globToRe：*、?、** 与 Windows 分隔符遵循路径 glob', () => {
  const one = globToRe('skills/*/SKILL.md');
  assert.equal(one.test('skills/validate-data/SKILL.md'), true);
  assert.equal(one.test('skills/nested/validate-data/SKILL.md'), false);
  assert.equal(globToRe('skills/????/SKILL.md').test('skills/data/SKILL.md'), true);
  assert.equal(globToRe('skills/????/SKILL.md').test('skills/validate/SKILL.md'), false);
  const recursive = globToRe('skills/**/SKILL.md');
  assert.equal(recursive.test('skills/SKILL.md'), true);
  assert.equal(recursive.test('skills/a/b/SKILL.md'), true);
  assert.equal(recursive.test('skills/a/b/OTHER.md'), false);
  assert.equal(globToRe(['skills', 'validate-data', '**'].join(BS)).test('skills/validate-data/references/a.md'), true);
});

test('surfaceViolation：拒绝绝对路径、POSIX 根路径与任意 .. 段', () => {
  assert.equal(surfaceViolation(SKILL, SURFACE), null);
  assert.equal(surfaceViolation(['skills', 'validate-data', 'SKILL.md'].join(BS), SURFACE), null);
  for (const file of [
    '/outside/SKILL.md',
    'C:/outside/SKILL.md',
    ['C:', 'outside', 'SKILL.md'].join(BS),
    '../outside.md',
    'skills/validate-data/../other/SKILL.md',
    ['skills', 'validate-data', '..', 'other', 'SKILL.md'].join(BS),
  ]) {
    const violation = surfaceViolation(file, SURFACE);
    assert.equal(violation?.code, 'EVOLVE_SURFACE_OUTSIDE', file);
  }
  assert.equal(surfaceViolation('skills/other/SKILL.md', SURFACE)?.code, 'EVOLVE_SURFACE_OUTSIDE');
});

test('surfaceViolation：隐式排除覆盖 include，三禁及机制资产全部命中', () => {
  const excluded = [
    'evals/skills/validate-data/rubric.md',
    '.research/ledger.jsonl',
    '.evolve/poc/archive.jsonl',
    'lib/evolve.js',
    'bin/research-harness.mjs',
    'test/v050.test.mjs',
    'harness-lab/protocol.mjs',
    'instructions/RESEARCH.md',
    'docs/README.md',
    'package.json',
    'dsh.patch.yml',
  ];
  for (const file of excluded) {
    assert.equal(surfaceViolation(file, '**')?.code, 'EVOLVE_SURFACE_EXCLUDED', file);
    assert.equal(surfaceViolation(file, file)?.code, 'EVOLVE_SURFACE_EXCLUDED', file + ' include 绕过');
  }
});

test('hashTree：排序确定、内容/文件名敏感，模式外文件不影响身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-v050-hash-'));
  try {
    mkdirSync(join(root, 'tree/sub'), { recursive: true });
    writeFileSync(join(root, 'tree/z.txt'), 'z\n');
    writeFileSync(join(root, 'tree/sub/a.txt'), 'a\n');
    writeFileSync(join(root, 'other.txt'), 'outside\n');
    const first = hashTree(root, ['tree/**']);
    assert.equal(first.files, 2);
    assert.deepEqual(hashTree(root, ['**', 'tree/**']).id, hashTree(root, ['tree/**', '**']).id);
    assert.equal(hashTree(root, ['tree/**']).id, first.id);
    writeFileSync(join(root, 'other.txt'), 'changed outside\n');
    assert.equal(hashTree(root, ['tree/**']).id, first.id);
    writeFileSync(join(root, 'tree/sub/a.txt'), 'changed\n');
    assert.notEqual(hashTree(root, ['tree/**']).id, first.id);
    const changed = hashTree(root, ['tree/**']).id;
    writeFileSync(join(root, 'tree/sub/a.txt'), 'a\n');
    assert.equal(hashTree(root, ['tree/**']).id, first.id);
    writeFileSync(join(root, 'tree/sub/b.txt'), 'a\n');
    rmSync(join(root, 'tree/sub/a.txt'));
    assert.notEqual(hashTree(root, ['tree/**']).id, changed);
    assert.notEqual(hashTree(root, ['tree/**']).id, first.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashTree：任意深度的运行台账与进化状态不参与评估器身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-v050-prune-'));
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'harness-lab/.research'), { recursive: true });
    mkdirSync(join(root, 'evals/skills/x/.evolve'), { recursive: true });
    mkdirSync(join(root, 'test/fixtures/node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'lib/evaluator.js'), 'export const frozen = true;\n');
    writeFileSync(join(root, 'harness-lab/.research/ledger.jsonl'), 'one\n');
    writeFileSync(join(root, 'evals/skills/x/.evolve/packet.json'), '{}\n');
    writeFileSync(join(root, 'test/fixtures/node_modules/pkg/index.js'), 'noise\n');
    const first = hashTree(root, ['**']);
    assert.equal(first.files, 1);
    writeFileSync(join(root, 'harness-lab/.research/ledger.jsonl'), 'changed\n');
    writeFileSync(join(root, 'harness-lab/.research/guard-log.jsonl'), 'new log\n');
    writeFileSync(join(root, 'evals/skills/x/.evolve/packet.json'), '{"changed":true}\n');
    assert.equal(hashTree(root, ['**']).id, first.id);
    assert.equal(hashTree(root, ['**']).files, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init：behavior-cases.json 与 rubric.md 缺一即拒绝，补齐后冻结指纹', (t) => {
  const f = fixture(t, { evals: false });
  const evolver = new Evolver(f.root, 'missing-evals');
  assert.throws(() => evolver.init({ surface: SURFACE }), /EVOLVE_NO_EVALS/);
  writeEvalAssets(f.root, { rubric: false });
  assert.throws(() => evolver.init({ surface: SURFACE }), /EVOLVE_NO_EVALS/);
  rmSync(join(f.root, 'evals/skills/validate-data/behavior-cases.json'));
  writeEvalAssets(f.root, { cases: false });
  assert.throws(() => evolver.init({ surface: SURFACE }), /EVOLVE_NO_EVALS/);
  writeEvalAssets(f.root);
  const contract = evolver.init({ surface: SURFACE });
  assert.equal(contract.evals_dir, 'evals/skills/validate-data');
  assert.equal(contract.gen, 0);
  assert.equal(evolver.verifyArchive().ok, true);
});

test('applyProposal：评估资产、台账、机制与 package 候选均 invalid 且原字节不变', (t) => {
  const { evolver, root } = initialized(t);
  const targets = [
    'evals/skills/validate-data/rubric.md',
    '.research/ledger.jsonl',
    'lib/frozen-evaluator.js',
    'bin/frozen-evaluator.mjs',
    'package.json',
  ];
  const before = new Map(targets.map(file => [file, readFileSync(join(root, file), 'utf8')]));
  for (const [index, file] of targets.entries()) {
    const result = evolver.applyProposal(proposal(root, 'forbidden-' + index, [{
      file,
      new_content: 'tampered by candidate\n',
    }]));
    assert.equal(result.status, 'invalid', file);
    assert.equal(result.code, 'EVOLVE_SURFACE_EXCLUDED', file);
  }
  for (const [file, text] of before) assert.equal(readFileSync(join(root, file), 'utf8'), text, file);
  const invalid = evolver.log().filter(event => event.event === 'invalid');
  assert.equal(invalid.length, targets.length);
  assert.ok(invalid.every(event => event.code === 'EVOLVE_SURFACE_EXCLUDED'));
  assert.equal(evolver.contract().gen, 0);
});

test('applyProposal：expected_parent_sha256 防陈旧覆盖，正确父哈希才应用', (t) => {
  const f = initialized(t);
  const stale = applyText(f, f.evolver, 'stale-parent', ORIGINAL + 'stale\n', '0'.repeat(64));
  assert.equal(stale.status, 'invalid');
  assert.equal(stale.code, 'EVOLVE_STALE_PARENT');
  assert.equal(readFileSync(f.skillFile, 'utf8'), ORIGINAL);
  assert.equal(existsSync(join(f.root, '.evolve/poc/gens/gen1.json')), false);
  const next = ORIGINAL + 'fresh candidate\n';
  const applied = applyText(f, f.evolver, 'fresh-parent', next, bytesSha256(f.skillFile));
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.equal(applied.gen, 1);
  assert.equal(readFileSync(f.skillFile, 'utf8'), next);
});

test('pending selection：缺双 verdict 时挂起，未 select 前下一候选被拒', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'pending candidate\n';
  const applied = applyText(f, f.evolver, 'pending-one', candidate);
  assert.equal(applied.status, 'applied');
  assert.throws(() => f.evolver.select(), /EVOLVE_NO_VERDICTS/);
  writeVerdict(packetFor(applied, 'A'), CASE_IDS);
  assert.throws(() => f.evolver.select(), /EVOLVE_NO_VERDICTS/);
  const blocked = applyText(f, f.evolver, 'pending-two', ORIGINAL + 'must not apply\n');
  assert.equal(blocked.status, 'invalid');
  assert.equal(blocked.code, 'EVOLVE_PENDING_SELECTION');
  assert.equal(readFileSync(f.skillFile, 'utf8'), candidate);
  assert.equal(f.evolver.contract().gen, 1);
  judge(applied, candidate, { treatmentPass: CASE_IDS, controlPass: ['case-a'] });
  assert.equal(f.evolver.select().decision, 'kept');
});

test('select：双 verdict 揭盲后 treatment 提分 keep，并保留候选文本', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Add mixed-source and reproducible-seed checks.\n';
  const applied = applyText(f, f.evolver, 'keep-winner', candidate);
  assert.equal(applied.status, 'applied');
  judge(applied, candidate, { treatmentPass: CASE_IDS, controlPass: ['case-a'] });
  const selected = f.evolver.select();
  assert.equal(selected.decision, 'kept');
  assert.equal(selected.candidate, 'keep-winner');
  assert.equal(selected.treatment_score, 1);
  assert.equal(selected.control_score, 0.333);
  assert.deepEqual(selected.treatment_hard_failures, []);
  assert.deepEqual(selected.control_hard_failures, ['case-hard']);
  assert.equal(readFileSync(f.skillFile, 'utf8'), candidate);
  assert.deepEqual(f.evolver.champion(), {
    candidate: 'keep-winner', gen: 1, ts: f.evolver.champion().ts,
  });
});

test('select：平分但修复 control hard failure 时 keep', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Repair the hard case at equal total score.\n';
  const selected = applyJudgeSelect(f, f.evolver, 'tie-hard-repair', candidate, {
    controlPass: ['case-a', 'case-b'],
    treatmentPass: ['case-a', 'case-hard'],
  });
  assert.equal(selected.control_score, 0.667);
  assert.equal(selected.treatment_score, 0.667);
  assert.deepEqual(selected.control_hard_failures, ['case-hard']);
  assert.deepEqual(selected.treatment_hard_failures, []);
  assert.equal(selected.decision, 'kept');
  assert.equal(readFileSync(f.skillFile, 'utf8'), candidate);
});

test('select：无提升且未修复 hard failure 时 revert，逐字节恢复父本', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Rewrite without behavioral improvement.\n';
  const selected = applyJudgeSelect(f, f.evolver, 'no-improvement', candidate, {
    controlPass: CASE_IDS,
    treatmentPass: ['case-a', 'case-hard'],
  });
  assert.equal(selected.decision, 'reverted');
  assert.equal(selected.control_score, 1);
  assert.equal(selected.treatment_score, 0.667);
  assert.deepEqual(selected.treatment_hard_failures, []);
  assert.equal(readFileSync(f.skillFile, 'utf8'), ORIGINAL);
  assert.equal(f.evolver.champion(), null);
  assert.equal(f.evolver.log().at(-1).event, 'reverted');
});

test('select：treatment 任一 hard fail 一票否决，即使总分更高也回滚', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Higher score but still misses the hard case.\n';
  const selected = applyJudgeSelect(f, f.evolver, 'hard-fail', candidate, {
    controlPass: ['case-a'],
    treatmentPass: ['case-a', 'case-b'],
  });
  assert.equal(selected.control_score, 0.333);
  assert.equal(selected.treatment_score, 0.667);
  assert.deepEqual(selected.treatment_hard_failures, ['case-hard']);
  assert.equal(selected.decision, 'reverted');
  assert.equal(readFileSync(f.skillFile, 'utf8'), ORIGINAL);
});

test('select：坏 JSON、packet_id 不匹配、案例缺项均为坏裁决，修正后仍可评审', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Valid candidate awaiting valid verdicts.\n';
  const applied = applyText(f, f.evolver, 'bad-verdict', candidate);
  assert.equal(applied.status, 'applied');
  judge(applied, candidate, { treatmentPass: CASE_IDS, controlPass: ['case-a'] });
  const packetA = packetFor(applied, 'A');
  const validA = readJson(packetA.verdict_path);

  writeJson(packetA.verdict_path, { ...validA, packet_id: 'wrong-packet' });
  assert.throws(() => f.evolver.select(), /EVOLVE_BAD_VERDICT: packet_id 不匹配/);
  writeJson(packetA.verdict_path, { ...validA, results: { 'case-a': 'pass' } });
  assert.throws(() => f.evolver.select(), /EVOLVE_BAD_VERDICT: 案例未全覆盖/);
  writeVerdict(packetA, CASE_IDS, { raw: '{not json' });
  assert.throws(() => f.evolver.select(), /EVOLVE_BAD_VERDICT: .*不是合法 JSON/);
  assert.equal(readFileSync(f.skillFile, 'utf8'), candidate);

  judge(applied, candidate, { treatmentPass: CASE_IDS, controlPass: ['case-a'] });
  assert.equal(f.evolver.select().decision, 'kept');
});

test('evaluator drift：apply 前指纹变化被拒绝，技能保持父本', (t) => {
  const f = initialized(t);
  appendFileSync(f.rubricFile, 'Drift before proposal.\n', 'utf8');
  const result = applyText(f, f.evolver, 'drift-before-apply', ORIGINAL + 'candidate\n');
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'EVOLVE_EVALUATOR_DRIFT');
  assert.equal(readFileSync(f.skillFile, 'utf8'), ORIGINAL);
  assert.equal(f.evolver.contract().gen, 0);
});

test('evaluator drift：applied 后评估资产变化，select 拒绝并回滚候选', (t) => {
  const f = initialized(t);
  const candidate = ORIGINAL + 'Candidate must be rolled back after evaluator drift.\n';
  const applied = applyText(f, f.evolver, 'drift-after-apply', candidate);
  assert.equal(applied.status, 'applied');
  judge(applied, candidate, { treatmentPass: CASE_IDS, controlPass: ['case-a'] });
  appendFileSync(f.rubricFile, 'Drift after blind packets were issued.\n', 'utf8');
  assert.throws(() => f.evolver.select(), /EVOLVE_EVALUATOR_DRIFT/);
  assert.equal(readFileSync(f.skillFile, 'utf8'), ORIGINAL);
  assert.equal(f.evolver.champion(), null);
});

test('archive receipts：篡改历史事件立即检出对应行', (t) => {
  const f = initialized(t);
  const archive = join(f.root, '.evolve/poc/archive.jsonl');
  const original = readFileSync(archive, 'utf8');
  assert.match(original, /"event":"init"/);
  writeFileSync(archive, original.replace('"event":"init"', '"event":"INIT"'), 'utf8');
  const verified = f.evolver.verifyArchive();
  assert.equal(verified.ok, false);
  assert.equal(verified.checked, 1);
  assert.equal(verified.receipts, 1);
  assert.deepEqual(verified.drifted.map(item => item.line), [1]);
});

test('champion：每次从 kept 事件重算，后续 keep 更新、revert 不覆盖', (t) => {
  const f = initialized(t);
  const firstText = ORIGINAL + 'First evidence improvement.\n';
  const first = applyJudgeSelect(f, f.evolver, 'champion-one', firstText, {
    controlPass: ['case-a'], treatmentPass: CASE_IDS,
  });
  assert.equal(first.decision, 'kept');
  assert.equal(f.evolver.champion().candidate, 'champion-one');

  const secondText = firstText + 'Second evidence improvement.\n';
  const second = applyJudgeSelect(f, f.evolver, 'champion-two', secondText, {
    controlPass: ['case-a'], treatmentPass: CASE_IDS,
  });
  assert.equal(second.decision, 'kept');
  assert.equal(f.evolver.champion().candidate, 'champion-two');
  assert.equal(f.evolver.champion().gen, 2);

  const reverted = applyJudgeSelect(f, f.evolver, 'champion-revert', secondText + 'No gain.\n', {
    controlPass: CASE_IDS, treatmentPass: ['case-a', 'case-hard'],
  });
  assert.equal(reverted.decision, 'reverted');
  assert.equal(readFileSync(f.skillFile, 'utf8'), secondText);
  const lastKept = f.evolver.log().filter(event => event.event === 'kept').at(-1);
  assert.deepEqual(f.evolver.champion(), {
    candidate: lastKept.candidate,
    gen: lastKept.gen,
    ts: lastKept.ts,
  });
  assert.equal(f.evolver.champion().candidate, 'champion-two');
});

test('route acceptance.task：findings/observed 只看本任务，缺省仍按共享台账', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-v050-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir, { receipts: true }).ensure();
  ledger.record({ claim: 'other observed 1', confidence: 'observed', provenance: 'file:other:1', task: 'TASK-0002' });
  ledger.record({ claim: 'other observed 2', confidence: 'observed', provenance: 'file:other:2', task: 'TASK-0002' });
  ledger.record({ claim: 'current observed', confidence: 'observed', provenance: 'file:current:1', task: 'TASK-0003' });
  ledger.record({ claim: 'current inferred', confidence: 'inferred', provenance: 'file:current:2', task: 'TASK-0003' });

  const scoped = route(ledger, {
    acceptance: { task: 'TASK-0003', minFindings: 3, minObservedRatio: 0.75 },
  });
  assert.equal(scoped.action, 'continue-recording');
  assert.equal(scoped.detail.findings, 2);
  assert.equal(scoped.detail.observed, 1);
  assert.deepEqual(scoped.detail.short.map(({ check, need, have }) => ({ check, need, have })), [
    { check: 'minFindings', need: 3, have: 2 },
    { check: 'minObservedRatio', need: 0.75, have: 0.5 },
  ]);

  const unscoped = route(ledger, {
    acceptance: { minFindings: 3, minObservedRatio: 0.75 },
  });
  assert.equal(unscoped.action, 'run-acceptance');
  assert.equal(unscoped.detail.findings, 4);
  assert.equal(unscoped.detail.observed, 3);
});

test('route acceptance.task：其他任务不能顶开验收门，route-check 仍全局计数', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-v050-route-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir, { receipts: true }).ensure();
  ledger.record({ claim: 'other only', confidence: 'observed', provenance: 'file:other:1', task: 'TASK-0002' });
  const emptyCurrent = route(ledger, {
    acceptance: { task: 'TASK-0003', minFindings: 1, minObservedRatio: 1 },
  });
  assert.equal(emptyCurrent.action, 'continue-recording');
  assert.equal(emptyCurrent.detail.findings, 0);
  assert.equal(emptyCurrent.detail.observed, 0);

  ledger.record({ claim: 'current only', confidence: 'observed', provenance: 'file:current:1', task: 'TASK-0003' });
  ledger.append({ kind: 'route-check', action: 'run-acceptance', why: 'global checkpoint', task: 'TASK-0002' });
  const ready = route(ledger, {
    acceptance: { task: 'TASK-0003', minFindings: 1, minObservedRatio: 1, requiredRouteChecks: 1 },
  });
  assert.equal(ready.action, 'run-acceptance');
  assert.equal(ready.detail.findings, 1);
  assert.equal(ready.detail.observed, 1);
  assert.equal(ready.detail.routeChecks, 1);
});
