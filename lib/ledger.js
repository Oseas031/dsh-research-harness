import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateChallenge } from './challenge.js';
import { validateCost } from './cost.js';
import { appendReceipt } from './receipts.js';

/** 证据台账：append-only JSONL。每条一行，坏行跳过，不阻塞读取。 */
export class Ledger {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.file = join(dir, 'ledger.jsonl');
    this.withReceipts = opts.receipts === true; // v0.4 收据层：机制写入的行同步落 SHA-256 收据
  }
  ensure() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    return this;
  }
  append(entry) {
    this.ensure();
    const seq = this.count() + 1;
    const rec = { seq, ts: new Date().toISOString(), ...entry };
    if (!rec.id) rec.id = (entry.kind === 'unknown' ? 'U' : 'E') + seq;
    const line = JSON.stringify(rec) + '\n';
    appendFileSync(this.file, line, 'utf8');
    if (this.withReceipts) { try { appendReceipt(this.file, line); } catch { /* 收据失败不拦入账 */ } }
    return rec;
  }
  count() {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, 'utf8').split('\n').filter(l => l.trim().length > 0).length;
  }
  entries() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => { try { return JSON.parse(l); } catch { return { kind: 'corrupt-line', raw: l.slice(0, 120) }; } });
  }
  /** 一条发现入账。confidence: observed | inferred | unknown。
   * v0.3 扩展槽：tokens（OTel gen_ai.usage 词表，cost.js 校验）、metric（数值型发现，聚簇用）、
   *             repro（SLSA buildDefinition 字段子集，Results-to-Code 用）、verdict（显式覆盖）。 */
  record({ claim, confidence, provenance, evidence, tags, tokens, metric, repro, verdict, task, verifiedBy }) {
    const badCost = validateCost(tokens);
    if (badCost) throw new Error(badCost.code + ': ' + badCost.reason);
    if (task !== undefined) {
      const t = String(task).trim();
      if (!/^(REQ|TASK)-\d{4}$/.test(t)) {
        throw new Error('EVIDENCE_BAD_TASK: task 字段必须是 REQ-xxxx / TASK-xxxx 形式（工作台物料 ID，无 ID 不开发）；收到：' + t.slice(0, 40));
      }
    }
    if (verifiedBy !== undefined && !['agent-reported', 'lead-verified'].includes(verifiedBy)) {
      throw new Error('EVIDENCE_BAD_VERIFIED_BY: verifiedBy 只能是 agent-reported | lead-verified；收到：' + String(verifiedBy));
    }
    return this.append({
      kind: 'finding', claim, confidence, provenance,
      evidence: evidence ?? null, tags: tags ?? [],
      ...(tokens ? { tokens } : {}), ...(typeof metric === 'number' ? { metric } : {}),
      ...(repro ? { repro } : {}), ...(verdict ? { verdict } : {}), ...(task ? { task: String(task).trim() } : {}), ...(verifiedBy ? { verifiedBy } : {}),
    });
  }
  /** 缺口② challenger 门：登记一条对既有 finding 的反向假设挑战。 */
  challenge({ ref, hypothesis, cito = 'disagreesWith', provenance, status = 'open' }) {
    const d = validateChallenge({ ref, hypothesis, cito, provenance });
    if (d) throw new Error(d.code + ': ' + d.reason);
    return this.append({ kind: 'challenge', ref, hypothesis, cito, provenance, status });
  }
  resolveChallenge(id, resolution) {
    return this.append({ kind: 'challenge-update', ref: id, status: 'resolved', resolution });
  }
  /** 登记一个 unknown。classification: blocker | non-blocker | parameterizable。 */
  addUnknown({ what, why, classification = 'non-blocker' }) {
    return this.append({ kind: 'unknown', status: 'open', what, why: why ?? null, classification });
  }
  resolve(id, resolution) {
    return this.append({ kind: 'unknown-update', ref: id, status: 'resolved', resolution });
  }
  /** v0.4 软门禁跳过：默认不可跳过，跳过必须写 reason/risk/compensation 三字段（进台账，不进耻辱柱）。 */
  gateSkipped({ gate, reason, risk, compensation, covers = [] }) {
    for (const [k, v] of [['gate', gate], ['reason', reason], ['risk', risk], ['compensation', compensation]]) {
      if (typeof v !== 'string' || v.trim().length < 4) {
        throw new Error('GATE_SKIP_BAD_FIELD: 跳过 ' + String(gate ?? '?') + ' 必须写 ' + k + '（≥4 字符）：为什么跳、风险是什么、事后怎么补偿。');
      }
    }
    return this.append({ kind: 'gate_skipped', gate, reason: reason.trim(), risk: risk.trim(), compensation: compensation.trim(), covers: Array.isArray(covers) ? covers : [] });
  }
  /** 当前 open blocker 是否全部被 gate_skipped 显式覆盖（completionGate 的放行判据）。 */
  skippedBlockerIds() {
    const covered = new Set();
    for (const e of this.entries()) {
      if (e.kind === 'gate_skipped' && Array.isArray(e.covers)) for (const id of e.covers) covered.add(String(id));
    }
    return covered;
  }
  /** 当前未决 blocker 列表（open 状态 + classification=blocker，且未被 unknown-update resolve）。 */
  blockers() {
    const resolvedU = new Set();
    const openU = new Map();
    const resolvedC = new Set();
    for (const e of this.entries()) {
      if (e.kind === 'unknown' && e.status === 'open') openU.set(e.id, e);
      if (e.kind === 'unknown-update' && e.status === 'resolved' && e.ref) resolvedU.add(e.ref);
      if (e.kind === 'challenge-update' && e.status === 'resolved' && e.ref) resolvedC.add(e.ref);
    }
    const out = [...openU.values()].filter(e => e.classification === 'blocker' && !resolvedU.has(e.id));
    // v0.3 缺口②：未决的降档挑战（refutes/disagreesWith）也算 open blocker（DCP Gate 2：挑战者未恢复不得收尾）
    for (const e of this.entries()) {
      if (e.kind === 'challenge' && (e.cito === 'refutes' || e.cito === 'disagreesWith') && e.status !== 'resolved' && !resolvedC.has(e.id)) {
        out.push({ id: e.id, what: '未决挑战: ' + String(e.hypothesis ?? '').slice(0, 60), why: 'cito:' + e.cito + ' → 被挑战条目 ' + e.ref + ' 降为 todo 档', classification: 'blocker' });
      }
    }
    return out;
  }
  stats() {
    const es = this.entries();
    const byKind = {};
    const byConfidence = {};
    const openUnknowns = { blocker: 0, 'non-blocker': 0, parameterizable: 0 };
    const resolved = new Set();
    for (const e of es) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      if (e.kind === 'finding') byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1;
      if (e.kind === 'unknown-update' && e.status === 'resolved' && e.ref) resolved.add(e.ref);
    }
    for (const e of es) {
      if (e.kind === 'unknown' && e.status === 'open' && !resolved.has(e.id) && openUnknowns[e.classification] !== undefined) {
        openUnknowns[e.classification] += 1;
      }
    }
    return { total: es.length, byKind, byConfidence, openUnknowns, blockers: this.blockers().length };
  }
}
