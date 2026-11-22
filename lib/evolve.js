import { createHash, randomInt } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { receiptOf } from './receipts.js';
import { buildSafeEnv, parseCommandSpec, runAsyncCommand } from './verifier.js';

/**
 * 技能进化闭环（v0.5.0，REQ-0004）。
 * 文件是唯一规范接口：提案是 JSON 文件，评审读 packet 文件并写 verdict 文件。
 * 机制从不 import 或执行候选代码。候选只能修改 surface 内的技能文本。
 */

export const IMPLICIT_EXCLUDES = Object.freeze([
  'evals/**', '.research/**', '.evolve/**',
  'lib/**', 'bin/**', 'test/**', 'harness-lab/**', 'instructions/**', 'docs/**',
  'package.json', 'dsh.patch.yml',
]);
export const EVALUATOR_ID_ROOTS = Object.freeze([
  'evals/**', 'lib/**', 'bin/**', 'test/**', 'harness-lab/**',
]);
const PRUNE = new Set(['.git', 'node_modules', '.research', '.evolve', '.tmp', '.dsh-meow']);

export function globToRe(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/\/+/g, '/');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        out += '[\\s\\S]*';
        i++;
        if (p[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      if ('\\^$.|?+()[]{}'.includes(c)) out += '\\';
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function walkFiles(root, base = '') {
  const dir = join(root, base);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (PRUNE.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** 排序相对路径与每文件字节哈希共同决定树身份。 */
export function hashTree(root, patterns) {
  const regexes = patterns.map(globToRe);
  const files = walkFiles(root).filter(f => regexes.some(re => re.test(f))).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file + '\n' + sha256Bytes(readFileSync(join(root, file))) + '\n');
  }
  return { id: hash.digest('hex'), files: files.length };
}

/** 排除优先于 include；返回 null 表示准入。 */
export function surfaceViolation(relPath, include) {
  const raw = String(relPath ?? '');
  const rel = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (isAbsolute(raw) || rel.startsWith('/') || rel.split('/').includes('..')) {
    return { code: 'EVOLVE_SURFACE_OUTSIDE', detail: rel + ' 绝对路径或越界' };
  }
  for (const excluded of IMPLICIT_EXCLUDES) {
    if (globToRe(excluded.toLowerCase()).test(rel.toLowerCase())) {
      return { code: 'EVOLVE_SURFACE_EXCLUDED', detail: rel + ' 命中隐式排除 ' + excluded };
    }
  }
  if (typeof include !== 'string' || !globToRe(include).test(rel)) {
    return { code: 'EVOLVE_SURFACE_OUTSIDE', detail: rel + ' 不在 surface ' + include };
  }
  return null;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
  }
  return value;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

function proposalShapeError(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return '提案必须是对象';
  if (typeof proposal.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(proposal.id)) return 'id 缺失或非法';
  if (typeof proposal.rationale !== 'string' || proposal.rationale.trim().length < 8) return 'rationale 至少 8 字符';
  if (!Array.isArray(proposal.mutations) || proposal.mutations.length === 0) return 'mutations 必须非空';
  for (const mutation of proposal.mutations) {
    if (typeof mutation.file !== 'string' || !mutation.file.trim()) return 'mutation.file 缺失';
    if (typeof mutation.new_content !== 'string') return 'mutation.new_content 必须是字符串';
    if (mutation.expected_parent_sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(mutation.expected_parent_sha256)) {
      return 'expected_parent_sha256 必须是 64 位 hex 或省略';
    }
  }
  return null;
}

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('EVOLVE_BAD_CASES: cases 必须是非空数组');
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('EVOLVE_BAD_CASES: case id 缺失或重复');
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error('EVOLVE_BAD_CASES: ' + item.id + ' 缺 prompt');
    ids.add(item.id);
  }
}

export class Evolver {
  constructor(repoRoot, name) {
    this.root = repoRoot;
    this.name = String(name ?? '');
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(this.name)) throw new Error('EVOLVE_BAD_NAME: 实验名只允许字母数字-_');
    this.dir = join(repoRoot, '.evolve', this.name);
    this.archiveFile = join(this.dir, 'archive.jsonl');
    this.receiptsFile = join(this.dir, 'archive-receipts.jsonl');
    this.contractFile = join(this.dir, 'contract.json');
    this.gensDir = join(this.dir, 'gens');
    this.packetsDir = join(this.dir, 'packets');
    this.verdictsDir = join(this.dir, 'verdicts');
    this.backupsDir = join(this.dir, 'backups');
  }

  init({ surface, evalsDir } = {}) {
    if (existsSync(this.contractFile)) throw new Error('EVOLVE_ALREADY_INIT: 已有 contract');
    if (typeof surface !== 'string' || !surface.includes('**')) throw new Error('EVOLVE_BAD_SURFACE: surface 必须是递归 glob');
    let dir = evalsDir;
    if (!dir) {
      const match = surface.match(/^skills\/([^/*]+)\/\*\*$/);
      if (!match) throw new Error('EVOLVE_NO_EVALS: 非标准技能 surface 必须显式给 evalsDir');
      dir = 'evals/skills/' + match[1];
    }
    dir = String(dir).replace(/\\/g, '/').replace(/\/$/, '');
    if (isAbsolute(dir) || dir.split('/').includes('..') || !dir.startsWith('evals/')) {
      throw new Error('EVOLVE_BAD_EVALS: 评估资产必须位于仓库 evals/ 内');
    }
    if (!existsSync(join(this.root, dir, 'behavior-cases.json')) || !existsSync(join(this.root, dir, 'rubric.md'))) {
      throw new Error('EVOLVE_NO_EVALS: ' + dir + ' 缺 behavior-cases.json 或 rubric.md');
    }
    this._evalAssets(dir);
    const evaluator = hashTree(this.root, EVALUATOR_ID_ROOTS).id;
    for (const path of [this.dir, this.gensDir, this.packetsDir, this.verdictsDir, this.backupsDir]) {
      mkdirSync(path, { recursive: true });
    }
    const contract = {
      experiment: this.name, surface, evals_dir: dir, evaluator_id: evaluator,
      gen: 0, created: new Date().toISOString(),
    };
    writeJson(this.contractFile, contract);
    this._archive({ event: 'init', surface, evals_dir: dir, evaluator_id: evaluator });
    return contract;
  }

  contract() {
    if (!existsSync(this.contractFile)) throw new Error('EVOLVE_NOT_INIT: 先 evolve init');
    return JSON.parse(readFileSync(this.contractFile, 'utf8'));
  }

  _archive(event) {
    const line = JSON.stringify(sorted({ ts: new Date().toISOString(), ...event }));
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.archiveFile, line + '\n', 'utf8');
    appendFileSync(this.receiptsFile, receiptOf(line) + '\n', 'utf8');
  }

  log() {
    if (!existsSync(this.archiveFile)) return [];
    return readFileSync(this.archiveFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  verifyArchive() {
    const lines = existsSync(this.archiveFile) ? readFileSync(this.archiveFile, 'utf8').split('\n').filter(Boolean) : [];
    const receipts = existsSync(this.receiptsFile) ? readFileSync(this.receiptsFile, 'utf8').split('\n').filter(Boolean) : [];
    const drifted = [];
    const common = Math.min(lines.length, receipts.length);
    for (let i = 0; i < common; i++) {
      if (receiptOf(lines[i]) !== receipts[i]) drifted.push({ line: i + 1, expected: receipts[i].slice(0, 12), actual: receiptOf(lines[i]).slice(0, 12) });
    }
    if (lines.length !== receipts.length) {
      for (let i = common; i < Math.max(lines.length, receipts.length); i++) {
        drifted.push({ line: i + 1, expected: receipts[i]?.slice(0, 12) ?? null, actual: lines[i] ? receiptOf(lines[i]).slice(0, 12) : null });
      }
    }
    return {
      ok: drifted.length === 0, checked: common, drifted,
      unverified: Math.max(0, lines.length - receipts.length), receipts: receipts.length,
    };
  }

  _evalAssets(evalsDir) {
    const dir = join(this.root, evalsDir ?? this.contract().evals_dir);
    const parsed = JSON.parse(readFileSync(join(dir, 'behavior-cases.json'), 'utf8'));
    validateCases(parsed.cases);
    const rubric = readFileSync(join(dir, 'rubric.md'), 'utf8');
    if (!rubric.trim()) throw new Error('EVOLVE_BAD_RUBRIC: rubric 为空');
    return { cases: parsed.cases, rubric };
  }

  _pendingSelection() {
    const contract = this.contract();
    if (!existsSync(join(this.gensDir, 'gen' + contract.gen + '.json'))) return false;
    return !this.log().some(event =>
      (event.event === 'kept' || event.event === 'reverted' || (event.event === 'rolled_back' && event.to_parent))
      && event.gen === contract.gen
    );
  }

  _invalid(code, detail, candidate = null) {
    this._archive({ event: 'invalid', code, detail, candidate });
    return { status: 'invalid', code, detail, candidate };
  }

  _restore(backupDir, files) {
    for (const file of files) {
      const rel = file.replace(/\\/g, '/');
      const target = join(this.root, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(backupDir, rel), target);
    }
  }

  applyProposal(proposalPath) {
    const contract = this.contract();
    if (this._pendingSelection()) return this._invalid('EVOLVE_PENDING_SELECTION', 'gen ' + contract.gen + ' 尚未 select');
    let proposal;
    try { proposal = JSON.parse(readFileSync(proposalPath, 'utf8')); }
    catch (error) { throw new Error('EVOLVE_BAD_PROPOSAL: ' + String(error.message).slice(0, 100)); }
    const shapeError = proposalShapeError(proposal);
    if (shapeError) return this._invalid('EVOLVE_BAD_PROPOSAL', shapeError, proposal?.id ?? null);
    const mutations = proposal.mutations.map(item => ({ ...item, file: item.file.replace(/\\/g, '/') }));
    for (const mutation of mutations) {
      const violation = surfaceViolation(mutation.file, contract.surface);
      if (violation) return this._invalid(violation.code, violation.detail, proposal.id);
    }
    const beforeEvaluator = hashTree(this.root, EVALUATOR_ID_ROOTS).id;
    if (beforeEvaluator !== contract.evaluator_id) {
      return this._invalid('EVOLVE_EVALUATOR_DRIFT', '评估器指纹与 init 不一致', proposal.id);
    }
    for (const mutation of mutations) {
      const file = join(this.root, mutation.file);
      if (!existsSync(file)) return this._invalid('EVOLVE_NO_PARENT', mutation.file + ' 不存在', proposal.id);
      if (mutation.expected_parent_sha256 && sha256Bytes(readFileSync(file)) !== mutation.expected_parent_sha256) {
        return this._invalid('EVOLVE_STALE_PARENT', mutation.file + ' 父本哈希不匹配', proposal.id);
      }
    }

    const gen = contract.gen + 1;
    const backupDir = join(this.backupsDir, 'gen' + gen);
    const files = mutations.map(item => item.file);
    const genomeParent = hashTree(this.root, [contract.surface]).id;
    const parent = mutations.map(item => ({ file: item.file, content: readFileSync(join(this.root, item.file), 'utf8') }));
    for (const mutation of mutations) {
      const backup = join(backupDir, mutation.file);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(join(this.root, mutation.file), backup);
    }
    try {
      for (const mutation of mutations) {
        const target = join(this.root, mutation.file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, mutation.new_content, 'utf8');
      }
    } catch (error) {
      this._restore(backupDir, files);
      throw new Error('EVOLVE_APPLY_FAILED: 已回滚；' + String(error.message));
    }
    const afterEvaluator = hashTree(this.root, EVALUATOR_ID_ROOTS).id;
    if (afterEvaluator !== contract.evaluator_id) {
      this._restore(backupDir, files);
      return this._invalid('EVOLVE_EVALUATOR_DRIFT', 'apply 后评估器指纹漂移，已回滚', proposal.id);
    }
    const genomeNew = hashTree(this.root, [contract.surface]).id;
    const { cases, rubric } = this._evalAssets();
    const treatment = mutations.map(item => ({ file: item.file, content: item.new_content }));
    const treatmentIsA = randomInt(2) === 0;
    const labels = treatmentIsA ? { A: 'treatment', B: 'control' } : { A: 'control', B: 'treatment' };
    const packets = {};
    for (const label of ['A', 'B']) {
      const packetId = 'gen' + gen + '-' + label;
      const verdictPath = join(this.verdictsDir, packetId + '.json');
      const packet = {
        packet_id: packetId,
        note: '独立技能文本行为评审。按 rubric 对 cases 全部案例逐一判定，并将 verdict JSON 写入 verdict_path。',
        files: labels[label] === 'treatment' ? treatment : parent,
        cases, rubric, verdict_path: verdictPath,
        verdict_schema: {
          packet_id: '原样回填',
          results: '对象：每个 case id 对应 pass 或 fail，必须全覆盖',
          evidence: '对象：每个 case id 对应技能原文片段',
          notes: '可选字符串',
        },
      };
      const packetPath = join(this.packetsDir, packetId + '.json');
      writeJson(packetPath, packet);
      packets[label] = { packet_id: packetId, path: packetPath, verdict_path: verdictPath };
    }
    writeJson(join(this.gensDir, 'gen' + gen + '.json'), {
      gen, candidate: proposal.id, rationale: proposal.rationale,
      labels, packets, files, parent, treatment,
    });
    this._archive({
      event: 'applied', gen, candidate: proposal.id,
      genome_parent: genomeParent, genome_new: genomeNew, evaluator_id: afterEvaluator,
    });
    writeJson(this.contractFile, { ...contract, gen });
    return {
      status: 'applied', gen, candidate: proposal.id, packets,
      verdict_paths: [packets.A.verdict_path, packets.B.verdict_path],
    };
  }

  select({ ledger } = {}) {
    const contract = this.contract();
    const gen = contract.gen;
    const manifestPath = join(this.gensDir, 'gen' + gen + '.json');
    if (!existsSync(manifestPath)) throw new Error('EVOLVE_NO_GEN: 当前 gen 未 applied');
    if (!this._pendingSelection()) throw new Error('EVOLVE_NOT_PENDING: 当前 gen 已 select');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const currentEvaluator = hashTree(this.root, EVALUATOR_ID_ROOTS).id;
    if (currentEvaluator !== contract.evaluator_id) {
      this._restore(join(this.backupsDir, 'gen' + gen), manifest.files);
      this._archive({
        event: 'reverted', gen, candidate: manifest.candidate,
        reason: 'EVOLVE_EVALUATOR_DRIFT', evaluator_id: currentEvaluator,
      });
      throw new Error('EVOLVE_EVALUATOR_DRIFT: select 前评估器指纹漂移，候选已回滚');
    }
    const { cases } = this._evalAssets();
    const verdicts = {};
    for (const label of ['A', 'B']) {
      const path = manifest.packets[label].verdict_path;
      if (!existsSync(path)) throw new Error('EVOLVE_NO_VERDICTS: ' + path + ' 缺失');
      let verdict;
      try { verdict = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new Error('EVOLVE_BAD_VERDICT: ' + path + ' 不是合法 JSON'); }
      if (verdict.packet_id !== manifest.packets[label].packet_id) throw new Error('EVOLVE_BAD_VERDICT: packet_id 不匹配');
      const missing = cases.filter(item => verdict.results?.[item.id] !== 'pass' && verdict.results?.[item.id] !== 'fail');
      if (missing.length) throw new Error('EVOLVE_BAD_VERDICT: 案例未全覆盖 ' + missing.map(item => item.id).join(','));
      verdicts[label] = verdict;
    }
    const score = verdict => cases.filter(item => verdict.results[item.id] === 'pass').length / cases.length;
    const hardFailures = verdict => cases.filter(item => item.hard && verdict.results[item.id] === 'fail').map(item => item.id);
    const controlLabel = manifest.labels.A === 'control' ? 'A' : 'B';
    const treatmentLabel = controlLabel === 'A' ? 'B' : 'A';
    const controlScore = Math.round(score(verdicts[controlLabel]) * 1000) / 1000;
    const treatmentScore = Math.round(score(verdicts[treatmentLabel]) * 1000) / 1000;
    const controlHard = hardFailures(verdicts[controlLabel]);
    const treatmentHard = hardFailures(verdicts[treatmentLabel]);
    const keep = treatmentHard.length === 0 && (
      treatmentScore > controlScore || (controlHard.length > 0 && treatmentScore === controlScore)
    );
    if (!keep) this._restore(join(this.backupsDir, 'gen' + gen), manifest.files);
    this._archive({
      event: keep ? 'kept' : 'reverted', gen, candidate: manifest.candidate,
      control_score: controlScore, treatment_score: treatmentScore,
      control_hard_failures: controlHard, treatment_hard_failures: treatmentHard,
    });
    let championRecord = null;
    if (keep && ledger) {
      if (typeof ledger.append !== 'function') throw new Error('EVOLVE_BAD_LEDGER: ledger 需要 append 方法');
      championRecord = ledger.append({
        kind: 'evolve-champion', experiment: this.name, candidate: manifest.candidate, gen,
        control_score: controlScore, treatment_score: treatmentScore,
        provenance: 'file:' + this.archiveFile,
      });
    }
    return {
      decision: keep ? 'kept' : 'reverted', gen, candidate: manifest.candidate,
      control_score: controlScore, treatment_score: treatmentScore,
      control_hard_failures: controlHard, treatment_hard_failures: treatmentHard,
      champion: this.champion(),
      ...(championRecord ? { champion_record: championRecord.id } : {}),
    };
  }

  /** 将指定代恢复到磁盘：toParent=true 恢复至该代应用前备份，toParent=false 恢复至该代 treatment 快照。 */
  rollback({ gen, toParent = false, reason, ledger } = {}) {
    const contract = this.contract();
    const curEvaluator = hashTree(this.root, EVALUATOR_ID_ROOTS).id;
    if (curEvaluator !== contract.evaluator_id) {
      throw new Error('EVOLVE_EVALUATOR_DRIFT: rollback 前评估器指纹漂移，禁止回滚');
    }
    const curChamp = this.champion();
    const targetGen = Number.isInteger(gen) && gen >= 1 ? gen : curChamp?.gen;
    if (!Number.isInteger(targetGen) || targetGen < 1) {
      throw new Error('EVOLVE_NO_ROLLBACK_TARGET: 未指定合法 gen 且当前无冠军可回滚');
    }
    const manifestPath = join(this.gensDir, 'gen' + targetGen + '.json');
    if (!existsSync(manifestPath)) {
      throw new Error('EVOLVE_NO_GEN: gen ' + targetGen + ' manifest 不存在');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const targetFiles = toParent
      ? (Array.isArray(manifest.files) && manifest.files.length ? manifest.files : (manifest.parent ?? []).map(i => i.file))
      : (manifest.treatment ?? []).map(i => i.file);
    for (const f of targetFiles) {
      const rel = String(f ?? '').replace(/\\/g, '/');
      const v = surfaceViolation(rel, contract.surface);
      if (v) throw new Error(v.code + ': rollback 目标路径越界: ' + v.detail);
    }
    if (toParent) {
      const backupDir = join(this.backupsDir, 'gen' + targetGen);
      if (existsSync(backupDir)) {
        this._restore(backupDir, manifest.files);
      } else {
        for (const item of manifest.parent ?? []) {
          const target = join(this.root, item.file.replace(/\\/g, '/'));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, item.content, 'utf8');
        }
      }
    } else {
      for (const item of manifest.treatment ?? []) {
        const target = join(this.root, item.file.replace(/\\/g, '/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, item.content, 'utf8');
      }
    }
    const why = reason ? String(reason) : (toParent ? 'rollback-to-parent' : 'rollback-to-gen');
    this._archive({
      event: 'rolled_back',
      gen: targetGen,
      to_parent: Boolean(toParent),
      candidate: manifest.candidate,
      reason: why,
    });
    let rollbackRecord = null;
    if (ledger) {
      if (typeof ledger.append !== 'function') throw new Error('EVOLVE_BAD_LEDGER: ledger 需要 append 方法');
      rollbackRecord = ledger.append({
        kind: 'evolve-rollback',
        experiment: this.name,
        gen: targetGen,
        toParent: Boolean(toParent),
        candidate: manifest.candidate,
        reason: why,
        provenance: 'tool:evolve.rollback',
      });
    }
    return {
      status: 'rolled_back',
      gen: targetGen,
      to_parent: Boolean(toParent),
      candidate: manifest.candidate,
      files: manifest.files,
      champion: this.champion(),
      ...(rollbackRecord ? { rollback_record: rollbackRecord.id } : {}),
    };
  }

  /** 为当前待评审 gen 的 A/B packet 分别拉起隔离异步子进程执行盲评命令。 */
  async runEvaluator(commandSpec, { timeoutMs = 60000 } = {}) {
    const rawCfg = (commandSpec && typeof commandSpec === 'object' && !Array.isArray(commandSpec))
      ? { timeoutMs, ...commandSpec }
      : { command: commandSpec, timeoutMs };
    const spec = parseCommandSpec(rawCfg);
    if (spec.empty) throw new Error('EVOLVE_BAD_EVALUATOR_CMD: evaluator 命令不能为空');
    const contract = this.contract();
    const gen = contract.gen;
    const manifestPath = join(this.gensDir, 'gen' + gen + '.json');
    if (!existsSync(manifestPath)) throw new Error('EVOLVE_NO_GEN: 当前 gen 未 applied');
    if (!this._pendingSelection()) throw new Error('EVOLVE_NOT_PENDING: 当前 gen 已 select');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    const runs = {};
    for (const label of ['A', 'B']) {
      const pkt = manifest.packets[label];
      const argv = [...spec.args, pkt.path, pkt.verdict_path];
      const env = buildSafeEnv({
        ...(spec.env ?? {}),
        EVOLVE_PACKET_PATH: pkt.path,
        EVOLVE_VERDICT_PATH: pkt.verdict_path,
        EVOLVE_PACKET_ID: pkt.packet_id,
        EVOLVE_EXPERIMENT: this.name,
        EVOLVE_GEN: String(gen),
      });
      const res = await runAsyncCommand(
        { ...spec, args: argv },
        { cwd: spec.cwd ?? this.root, env, timeoutMs: spec.asyncTimeoutMs ?? timeoutMs }
      );
      if (res.error) {
        throw new Error('EVOLVE_EVALUATOR_FAILED: packet ' + label + ' spawn 失败: ' + String(res.error.message ?? res.error).slice(0, 200));
      }
      if (res.timedOut) {
        throw new Error('EVOLVE_EVALUATOR_TIMEOUT: packet ' + label + ' 超时');
      }
      if (res.code !== 0) {
        throw new Error('EVOLVE_EVALUATOR_FAILED: packet ' + label + ' exit=' + res.code + ' ' + String(res.stderr ?? '').trim().slice(0, 200));
      }
      if (!existsSync(pkt.verdict_path)) {
        throw new Error('EVOLVE_NO_VERDICTS: evaluator 成功退出但未写入 ' + pkt.verdict_path);
      }
      let verdict;
      try {
        verdict = JSON.parse(readFileSync(pkt.verdict_path, 'utf8'));
      } catch {
        throw new Error('EVOLVE_BAD_VERDICT: evaluator 写入的 ' + pkt.verdict_path + ' 不是合法 JSON');
      }
      if (verdict.packet_id !== pkt.packet_id) {
        throw new Error('EVOLVE_BAD_VERDICT: packet ' + label + ' verdict.packet_id 不匹配');
      }
      runs[label] = { code: res.code, packet_id: pkt.packet_id, verdict_path: pkt.verdict_path };
    }
    return {
      status: 'evaluated',
      gen,
      verdicts: { A: manifest.packets.A.verdict_path, B: manifest.packets.B.verdict_path },
      runs,
    };
  }

  champion() {
    const active = [];
    const byGen = new Map();
    for (const event of this.log()) {
      if (event.event === 'kept') {
        const rec = { candidate: event.candidate, gen: event.gen, ts: event.ts };
        byGen.set(event.gen, rec);
        const filtered = active.filter(item => item.gen !== event.gen);
        active.length = 0;
        active.push(...filtered, rec);
      } else if (event.event === 'rolled_back') {
        if (event.to_parent) {
          const filtered = active.filter(item => item.gen !== event.gen);
          active.length = 0;
          active.push(...filtered);
        } else {
          const rec = byGen.get(event.gen) ?? { candidate: event.candidate, gen: event.gen, ts: event.ts };
          const filtered = active.filter(item => item.gen !== event.gen);
          active.length = 0;
          active.push(...filtered, rec);
        }
      }
    }
    return active.length ? active[active.length - 1] : null;
  }
}
