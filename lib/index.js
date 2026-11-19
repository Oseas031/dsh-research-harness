import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHarnessSkills } from './skill-provider.js';
import { check } from './guards.js';
import { Ledger } from './ledger.js';
import { gateExec, makeSubagentReportListener } from './evidence-gate.js';
import { completionGate } from './completion.js';
import { createVerifier } from './verifier.js';
import { aggregate } from './aggregate.js';
import { validateChallenge, downgradedIds } from './challenge.js';
import { verifyLedger } from './receipts.js';
import { route } from './route.js';

/**
 * dsh-research-harness 插件入口：证据契约闭环。
 * 守卫（ctx.tools.guard）：越界/二进制/子代理参数 + findings.record provenance 门 + update_goal complete 门。
 * 工具（ctx.tools.register）：findings.record（入账）与 findings.status（台账/未决 blocker 查询）。
 * 台账：<ledgerRoot>/ledger.jsonl；拒绝留痕：<ledgerRoot>/guard-log.jsonl。
 * 拒绝即落地、放行即入账、未决 blocker 挡 complete → 这条闭环活，工作台才有灵魂。
 */
export const name = 'research-harness';

export const inject = ['tools'];

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FINDINGS_RECORD_PARAMETERS = {
  type: 'object',
  properties: {
    entries: {
      type: 'array', minItems: 1, maxItems: 50,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: '一句可判定的发现陈述' },
          confidence: { type: 'string', enum: ['observed', 'inferred', 'unknown'], description: 'observed=当场读到/执行到；inferred=推理链；unknown=待查' },
          provenance: { type: 'string', description: '出处：http(s)/doi:/arxiv: 链接；或 文件路径:行号（src/app.py:42）；或 tool:<工具名> 引用' },
          evidence: { type: 'string', description: '支撑摘录（可省）' },
          tags: { type: 'array', items: { type: 'string' } },
          metric: { type: 'number', description: '数值型发现（实验指标）：同一 claim 多条记录=多 seed，聚合时算 mean±SEM（mle-bench 范式）' },
          verdict: { type: 'string', enum: ['ok', 'not_ok', 'todo', 'skip', 'bail_out'], description: '显式判定（TAP v13 枚举；缺省按 confidence 映射 observed/inferred→ok, unknown→todo）' },
          tokens: { type: 'object', description: '成本槽（OTel gen_ai.usage 词表）：input_tokens/output_tokens/cache_read.input_tokens/cache_write.input_tokens/reasoning.output_tokens + 派生 cost_usd/currency', properties: { input_tokens: { type: 'number' }, output_tokens: { type: 'number' }, 'cache_read.input_tokens': { type: 'number' }, 'cache_write.input_tokens': { type: 'number' }, 'reasoning.output_tokens': { type: 'number' }, cost_usd: { type: 'number' }, currency: { type: 'string', enum: ['USD'] } }, additionalProperties: false },
          repro: { type: 'object', description: '复现槽（SLSA v1.0 字段子集）：build_type/external_parameters/subject_digest(sha256)/invocation_id/started_on/finished_on', properties: { build_type: { type: 'string' }, external_parameters: { type: 'object', additionalProperties: true }, subject_digest: { type: 'string' }, invocation_id: { type: 'string' }, started_on: { type: 'string' }, finished_on: { type: 'string' } }, additionalProperties: false },
          task: { type: 'string', description: '工作台物料 ID（REQ-xxxx / TASK-xxxx，无 ID 不开发；可选）' },
        },
        required: ['claim', 'confidence', 'provenance'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

const FINDINGS_STATUS_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export function apply(ctx, config = {}) {
  let root;
  if (config.ledgerRoot) {
    root = resolve(config.ledgerRoot);
  } else {
    // 可移植默认：~/.dsh/research-harness（重启不清、重装不丢）；拿不到 dshHomePath 再退 cwd/.research
    let home = null;
    try { if (typeof ctx?.dshHomePath === 'function') home = ctx.dshHomePath('research-harness'); } catch { home = null; }
    root = resolve(home ?? '.research');
  }
  const ledger = new Ledger(root, { receipts: true }).ensure(); // v0.4：机制写入同步落 SHA-256 收据
  let repairRounds = 0; // 修复轮计数（会话状态；编排身份 3/2 上限用）
  const verifier = createVerifier(config.verifier ?? { kind: 'evidence', enabled: true });
  const clusterScale = config.clusterScale ?? 'delegate';

  const log = (entry) => {
    try {
      appendFileSync(join(root, 'guard-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 留痕失败不拦执行 */ }
  };
  const info = (msg) => {
    try {
      const logger = typeof ctx?.logger === 'function' ? ctx.logger('research-harness') : ctx?.logger;
      logger?.info?.(msg);
    } catch { /* 日志失败不拦执行 */ }
  };

  const disposers = [];
  const keep = (d) => { if (typeof d === 'function') disposers.push(d); };
  try { ctx?.on?.('dispose', () => { for (const d of disposers) { try { d(); } catch {} } }); } catch {}

  // ---- 1. 守卫链（单一 guard 入口，逐工具路由）----
  const guardFn = (exec) => {
    try {
      const toolName = String(exec?.name ?? '');
      const args = (exec?.args ?? exec?.parameters ?? {}) || {};
      const lower = toolName.toLowerCase();

      // 1a. 基础三守卫（read/write/edit/subagent）
      const base = check(lower, args, { workspaceRoot: root });
      if (base) { log({ kind: 'denial', tool: toolName, code: base.code, reason: base.reason }); return { reason: base.reason, info: { code: base.code } }; }

      // 1b. 证据门：findings.record 无 provenance 当场拒
      const gate = gateExec(toolName, args);
      if (gate) { log({ kind: 'denial', tool: toolName, code: gate.code, reason: gate.reason }); return { reason: gate.reason, info: { code: gate.code } }; }

      // 1c. 派单纪律：solo 档禁委派（clusterScale 可玩参数）
      if (clusterScale === 'solo' && (lower === 'subagent' || lower === 'agent')) {
        const reason = 'SCALE_SOLO_NO_DELEGATION: 当前 clusterScale=solo，本会话禁用子代理派单。切 delegate/cluster 档再委派。';
        log({ kind: 'denial', tool: toolName, code: 'SCALE_SOLO_NO_DELEGATION', reason });
        return { reason, info: { code: 'SCALE_SOLO_NO_DELEGATION' } };
      }

      // 1d. 完成语义：未决 blocker 挡 complete（inconclusive 通道在 completionGate 内落账）
      const completion = completionGate({ toolName, args, ledger, verifier });
      if (completion) { log({ kind: 'denial', tool: toolName, code: completion.code, reason: completion.reason }); return { reason: completion.reason, info: { code: completion.code } }; }

      return undefined;
    } catch (e) {
      log({ kind: 'guard-error', error: String(e?.message ?? e) });
      return undefined; // 守卫自身故障不拦执行
    }
  };

  // ---- 2. findings.record / findings.status 工具 ----
  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

  keep(tryRegister(ctx, {
    name: 'findings.record',
    description: '研究发现入账（证据台账）。每条必须带 provenance（http(s)/doi/arxiv 链接、文件路径:行号、或 tool:<工具名> 引用）；缺 provenance 会被守卫当场拒绝并落 guard-log。confidence 只能是 observed|inferred|unknown。',
    parameters: FINDINGS_RECORD_PARAMETERS,
    output: {
      schema: { type: 'object', properties: { recorded: { type: 'number' }, ids: { type: 'array', items: { type: 'string' } } }, required: ['recorded', 'ids'], additionalProperties: false },
      render: renderJson,
    },
    async execute(args) {
      const ids = [];
      for (const e of args.entries) {
        const d = gateExec('findings.record', { entries: [e] });
        if (d) throw new Error(d.code + ': ' + d.reason); // 双保险：守卫之外执行体再验一次
        ids.push(ledger.record(e).id);
      }
      return { recorded: ids.length, ids };
    },
  }, log));

  keep(tryRegister(ctx, {
    name: 'findings.status',
    description: '查证据台账：统计（observed/inferred/unknown、入账条数）、未决 blocker 列表、最近 N 条。',
    parameters: FINDINGS_STATUS_PARAMETERS,
    output: {
      schema: { type: 'object', properties: { stats: { type: 'object' }, blockers: { type: 'array' } }, required: ['stats', 'blockers'], additionalProperties: false },
      render: renderJson,
    },
    async execute() {
      const es = ledger.entries();
      return {
        stats: ledger.stats(),
        blockers: ledger.blockers().map(b => ({ id: b.id, what: b.what, why: b.why })),
        recent: es.slice(-8).map(e => ({ id: e.id, kind: e.kind, claim: e.claim ?? e.what ?? null, confidence: e.confidence ?? null })),
      };
    },
  }, log));

  // ---- 2b. findings.aggregate（v0.3 缺口①）：机器可派生聚合指标 ----
  keep(tryRegister(ctx, {
    name: 'findings.aggregate',
    description: '聚合台账为机器可读指标（v0.3）：JUnit 式计数（tests/failures/errors/skipped, rate=1−(f+e)/tests）+ TAP v13 行文法 + 未决挑战降档明细 + token 成本汇总。供交付前自检与报告生成。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          counts: { type: 'object' },
          rate: { type: 'number' },
          tap: { type: 'string' },
          detail: { type: 'array', items: { type: 'object' } },
          cost: { type: 'object' },
        },
        required: ['counts', 'tap', 'cost'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: (v.tap ?? '') + '\n' + JSON.stringify({ counts: v.counts, rate: v.rate ?? null, cost: v.cost }, null, 2) }],
    },
    async execute() {
      const es = ledger.entries();
      const dg = downgradedIds(es);
      const result = aggregate(es);
      if (dg.size) {
        for (const d of result.detail) if (dg.has(d.id)) { d.verdict = 'todo'; d.downgraded = 'open-challenge'; }
        result.counts.tests = result.detail.length; // recount with downgraded
        const body = result.detail.map((d, i) => (d.verdict === 'not_ok' ? 'not ok' : 'ok') + ' ' + (i + 1) + ' ' + d.id + (d.downgraded ? ' # TODO downgraded by open challenge' : '')).join('\n');
        result.tap = '1..' + result.counts.tests + (result.counts.skipped ? ' (skipped ' + result.counts.skipped + ')' : '') + '\n' + body;
        result.rate = result.counts.tests ? 1 - (result.counts.failures + result.counts.errors) / result.counts.tests : null;
      }
      return result;
    },
  }, log));

  // ---- 2c. findings.challenge（v0.3 缺口②）：challenger 反向假设门 ----
  keep(tryRegister(ctx, {
    name: 'findings.challenge',
    description: '对台账里某条 finding 登记反向假设挑战（DCP Gate 2 精神）：cito 关系用 CiTO 谓词（disagreesWith|refutes|corroborates|usesDataFrom|citesAsAuthority），必须带 hypothesis 与 provenance。未决 refutes/disagreesWith 会把被挑战条目降为 todo 档并计入 open blocker（挡 complete）；resolve 挑战后恢复。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '被挑战条目的 id（如 E3）' },
        hypothesis: { type: 'string', description: '反向假设：一句可判定的相反陈述' },
        cito: { type: 'string', enum: ['disagreesWith', 'refutes', 'corroborates', 'usesDataFrom', 'citesAsAuthority'] },
        provenance: { type: 'string', description: '挑战的出处（http(s)/doi/arxiv、路径:行号、或 tool:<名>）' },
      },
      required: ['ref', 'hypothesis', 'cito', 'provenance'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { challenged: { type: 'number' }, id: { type: 'string' }, ref: { type: 'string' } }, required: ['challenged', 'id', 'ref'], additionalProperties: false },
      render: renderJson,
    },
    async execute(args) {
      const d = validateChallenge(args);
      if (d) throw new Error(d.code + ': ' + d.reason);
      const rec = ledger.challenge(args);
      return { challenged: 1, id: rec.id, ref: args.ref };
    },
  }, log));

  // ---- 2d. challenge resolve 入口（走 unknown-update 同型工具：由 findings.record 的 kind 切换）----
  // （challenge-update 由 ledger.resolveChallenge 提供；模型可在对话中调用 findings.challenge 后再 resolve）

  // ---- 2e. findings.route（v0.4 最短路路由：产物即状态）----
  keep(tryRegister(ctx, {
    name: 'findings.route',
    description: '最短路路由（纯函数）：按台账当前状态给出下一步动作——resolve-blockers / record-findings / run-acceptance / BLOCKED（修复轮上限）。编排纪律：开工、卡住、收尾前都先问它，别凭记忆排下一步。',
    parameters: { type: 'object', properties: { repairFailed: { type: 'boolean', description: '本目标上一轮修复又失败了（推进 repairRounds 计数；到 3/2 上限即 BLOCKED）' } }, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { action: { type: 'string' }, why: { type: 'string' } }, required: ['action', 'why'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.action + ' — ' + v.why }],
    },
    async execute(args) {
      if (args?.repairFailed) repairRounds += 1;
      return route(ledger, { clusterScale, repairRounds });
    },
  }, log));

  // ---- 2f. findings.verify（v0.4 收据核对：手改台账立即可检）----
  keep(tryRegister(ctx, {
    name: 'findings.verify',
    description: '收据核对：重算台账每行的 SHA-256 与机制收据（ledger-receipts.jsonl）比对。drifted=行被手改或删行；unverified=旧台账无收据的行（不算错）。交付前自检的一部分。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, checked: { type: 'number' }, drifted: { type: 'array', items: { type: 'object' } }, unverified: { type: 'number' } }, required: ['ok', 'checked', 'drifted', 'unverified'], additionalProperties: false },
      render: renderJson,
    },
    async execute() {
      return verifyLedger(ledger.file);
    },
  }, log));

  // ---- 2g. findings.gate-skip（v0.4 软门禁跳过：可例外但可追溯）----
  keep(tryRegister(ctx, {
    name: 'findings.gate-skip',
    description: '软门禁跳过（默认不可跳过，跳过必须可追溯）：对指名的门（如 EVIDENCE_BLOCKERS_OPEN）登记跳过，reason/risk/compensation 三字段必填，covers 列出被覆盖的 blocker id。覆盖全部 open blocker 后 complete 才放行。跳过记录留在台账里，不是耻辱柱。',
    parameters: {
      type: 'object',
      properties: {
        gate: { type: 'string', description: '要跳过的门，如 EVIDENCE_BLOCKERS_OPEN' },
        reason: { type: 'string', description: '为什么跳（≥4 字符）' },
        risk: { type: 'string', description: '跳过的风险是什么（≥4 字符）' },
        compensation: { type: 'string', description: '事后补偿动作（回归测试/ADR/后续任务，≥4 字符）' },
        covers: { type: 'array', items: { type: 'string' }, description: '被本跳过覆盖的 blocker id 列表（U12 等）' },
      },
      required: ['gate', 'reason', 'risk', 'compensation'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { skipped: { type: 'number' }, id: { type: 'string' } }, required: ['skipped', 'id'], additionalProperties: false },
      render: renderJson,
    },
    async execute(args) {
      const rec = ledger.gateSkipped(args);
      return { skipped: 1, id: rec.id };
    },
  }, log));

  // ---- 3. 守卫 + 子代理审计监听接线 ----
  try {
    keep(ctx.tools.guard(guardFn));
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.tools.guard', error: String(e?.message ?? e) });
  }
  try {
    keep(ctx?.on?.('subagent/end', makeSubagentReportListener(ledger, (e) => log({ kind: 'listener-error', error: String(e?.message ?? e) }))));
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.on(subagent/end)', error: String(e?.message ?? e) });
  }

  // ---- 4. 技能 provider（自定位，替代 dsh.patch.yml 的绝对路径 customSkillDirs）----
  const skills = registerHarnessSkills(ctx, { skillsDir: config.skillsDir, log });
  if (typeof skills.dispose === 'function') keep(skills.dispose);

  // ---- 5. 自检留痕 ----
  log({
    kind: 'wired',
    version: '0.4.0',
    clusterScale,
    verifier: { kind: verifier.kind, enabled: verifier.enabled },
    ledgerRoot: root,
    skills: { state: skills.state, count: skills.count, dir: skills.dir, ...(skills.error ? { error: skills.error } : {}) },
    tools: ['findings.record', 'findings.status', 'findings.aggregate', 'findings.challenge', 'findings.route', 'findings.verify', 'findings.gate-skip'],
  });
  info('research-harness wired: clusterScale=' + clusterScale + ' ledger=' + root + ' verifier=' + verifier.kind);
}

function tryRegister(ctx, definition, log) {
  try {
    return ctx.tools.register(definition);
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.tools.register(' + definition.name + ')', error: String(e?.message ?? e) });
    return undefined;
  }
}

export default { name, inject, apply };
