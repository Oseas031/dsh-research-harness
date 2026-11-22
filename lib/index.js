import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
import { SpanRecorder, readSpans, summarizeSpans } from './spans.js';
import { ALIGNMENT_LAYERS, PROBE_VERDICTS, writeAlignmentCard, syncAlignmentToLedger } from './alignment.js';
import { ingestMarkdown, ingestReport, markVerified } from './ingest.js';

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

/** 从 package.json 动态读取当前版本号，避免启动留痕硬编码滞后。 */
export function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const PKG_VERSION = readPackageVersion();

/** 解析当前执行所属的工作区根目录；绝不用 ledgerRoot 充当工作区。 */
export function resolveWorkspaceRoot(ctx, exec, config = {}, opts = {}) {
  if (typeof config?.workspaceRoot === 'string' && config.workspaceRoot.trim()) {
    return resolve(config.workspaceRoot.trim());
  }
  if (typeof exec?.cwd === 'string' && exec.cwd.trim()) {
    return resolve(exec.cwd.trim());
  }
  let wd = null;
  try {
    wd = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : ctx?.workingDirectory;
  } catch {
    wd = null;
  }
  const session = exec?.agent?.session;
  if (session) {
    try {
      const committed = wd?.get?.(session);
      if (typeof committed === 'string' && committed.trim()) return resolve(committed.trim());
    } catch {}
    const headerCwd = session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd.trim()) return resolve(headerCwd.trim());
  }
  if (typeof wd?.defaultDirectory === 'string' && wd.defaultDirectory.trim()) {
    return resolve(wd.defaultDirectory.trim());
  }
  if (opts.allowProcessCwd !== false) return resolve(process.cwd());
  return null;
}

/** 为工作区路径生成稳定、人类可读的目录名：<basename>-<sha256前8位>。 */
export function workspaceSlug(wsPath) {
  const norm = resolve(wsPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  const rawBase = basename(norm) || 'ws';
  const clean = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'ws';
  return clean + '-' + hash;
}

function resolveBaseLedgerRoot(ctx) {
  let home = null;
  try { if (typeof ctx?.dshHomePath === 'function') home = ctx.dshHomePath('research-harness'); } catch { home = null; }
  return resolve(home ?? '.research');
}

/** 解析当前执行对应的台账目录：显式 ledgerRoot 优先，否则按工作区自动分账隔离。 */
export function resolveLedgerDir(ctx, exec, config = {}) {
  if (typeof config?.ledgerRoot === 'string' && config.ledgerRoot.trim()) {
    return resolve(config.ledgerRoot.trim());
  }
  const baseRoot = resolveBaseLedgerRoot(ctx);
  if (config?.projectScope === 'global') return baseRoot;
  const ws = resolveWorkspaceRoot(ctx, exec, config, { allowProcessCwd: false });
  if (!ws) return baseRoot;
  return join(baseRoot, 'projects', workspaceSlug(ws));
}

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
          verifiedBy: { type: 'string', enum: ['agent-reported', 'lead-verified'], description: '验证状态：agent-reported（子代理/初报）或 lead-verified（主控复验）' },
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
  const baseRoot = typeof config?.ledgerRoot === 'string' && config.ledgerRoot.trim()
    ? resolve(config.ledgerRoot.trim())
    : resolveBaseLedgerRoot(ctx);
  const projectScope = typeof config?.ledgerRoot === 'string' && config.ledgerRoot.trim()
    ? 'explicit'
    : (config?.projectScope ?? 'workspace');
  const ledgerCache = new Map();
  const getLedger = (exec) => {
    const dir = resolveLedgerDir(ctx, exec, config);
    let inst = ledgerCache.get(dir);
    if (!inst) {
      inst = new Ledger(dir, { receipts: true }).ensure();
      if (projectScope === 'workspace' && dir !== baseRoot) {
        const ws = resolveWorkspaceRoot(ctx, exec, config, { allowProcessCwd: false });
        if (ws) {
          const metaFile = join(dir, 'workspace.json');
          if (!existsSync(metaFile)) {
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(metaFile, JSON.stringify({ workspace: ws, slug: workspaceSlug(ws), created: new Date().toISOString() }, null, 2) + '\n', 'utf8');
            } catch { /* 元数据写入失败不拦执行 */ }
          }
        }
      }
      ledgerCache.set(dir, inst);
    }
    return inst;
  };
  const defaultLedger = getLedger(undefined); // v0.7：基础/兜底台账
  const spanRecorder = new SpanRecorder();
  const verifier = createVerifier(config.verifier ?? { kind: 'evidence', enabled: true });
  const clusterScale = config.clusterScale ?? 'delegate';
  const enforceReadInsideWorkspace = config.enforceReadInsideWorkspace === true;

  const log = (entry, exec) => {
    try {
      const logDir = exec ? getLedger(exec).dir : baseRoot;
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'guard-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
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
      // DSH ToolsService 传递参数在 exec.arguments；同时兼容单测常用的 exec.args / exec.parameters
      const args = (exec?.arguments ?? exec?.args ?? exec?.parameters ?? {}) || {};
      const lower = toolName.toLowerCase();
      const wsRoot = resolveWorkspaceRoot(ctx, exec, config, { allowProcessCwd: false });
      const currentLedger = getLedger(exec);

      // 1a. 基础守卫（read/write/edit/apply_patch/str_replace_editor/subagent）
      const base = check(lower, args, { workspaceRoot: wsRoot, enforceReadInsideWorkspace });
      if (base) { log({ kind: 'denial', tool: toolName, code: base.code, reason: base.reason }, exec); return { reason: base.reason, info: { code: base.code } }; }

      // 1b. 证据门：findings.record 无 provenance 当场拒
      const gate = gateExec(toolName, args);
      if (gate) { log({ kind: 'denial', tool: toolName, code: gate.code, reason: gate.reason }, exec); return { reason: gate.reason, info: { code: gate.code } }; }

      // 1c. 派单纪律：solo 档禁委派（clusterScale 可玩参数）
      if (clusterScale === 'solo' && (lower === 'subagent' || lower === 'agent')) {
        const reason = 'SCALE_SOLO_NO_DELEGATION: 当前 clusterScale=solo，本会话禁用子代理派单。切 delegate/cluster 档再委派。';
        log({ kind: 'denial', tool: toolName, code: 'SCALE_SOLO_NO_DELEGATION', reason }, exec);
        return { reason, info: { code: 'SCALE_SOLO_NO_DELEGATION' } };
      }

      // 1d. 完成语义：未决 blocker 挡 complete（inconclusive 通道在 completionGate 内落账）
      const completion = completionGate({
        toolName,
        args,
        ledger: currentLedger,
        verifier,
        verifyOpts: wsRoot ? { workspaceRoot: wsRoot } : undefined,
      });
      if (completion) { log({ kind: 'denial', tool: toolName, code: completion.code, reason: completion.reason }, exec); return { reason: completion.reason, info: { code: completion.code } }; }

      spanRecorder.start(exec);
      return undefined;
    } catch (e) {
      log({ kind: 'guard-error', error: String(e?.message ?? e) }, exec);
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
    async execute(args, exec) {
      const currentLedger = getLedger(exec);
      const ids = [];
      for (const e of args.entries) {
        const d = gateExec('findings.record', { entries: [e] });
        if (d) throw new Error(d.code + ': ' + d.reason); // 双保险：守卫之外执行体再验一次
        ids.push(currentLedger.record(e).id);
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
    async execute(_args, exec) {
      const currentLedger = getLedger(exec);
      const es = currentLedger.entries();
      return {
        stats: currentLedger.stats(),
        blockers: currentLedger.blockers().map(b => ({ id: b.id, what: b.what, why: b.why })),
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
    async execute(_args, exec) {
      const es = getLedger(exec).entries();
      const dg = downgradedIds(es);
      const result = aggregate(es, { maxAgeHours: verifier?.maxAgeHours ?? null });
      if (dg.size) {
        for (const d of result.detail) if (dg.has(d.id)) { d.verdict = 'todo'; d.downgraded = 'open-challenge'; }
        result.counts.tests = result.detail.length; // recount with downgraded
        result.counts.stale = result.detail.filter(d => d.stale).length;
        const body = result.detail.map((d, i) => (d.verdict === 'not_ok' ? 'not ok' : 'ok') + ' ' + (i + 1) + ' ' + d.id + (d.downgraded ? ' # TODO downgraded by open challenge' : (d.stale ? ' # TODO stale' : ''))).join('\n');
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
    async execute(args, exec) {
      const d = validateChallenge(args);
      if (d) throw new Error(d.code + ': ' + d.reason);
      const rec = getLedger(exec).challenge(args);
      return { challenged: 1, id: rec.id, ref: args.ref };
    },
  }, log));

  // ---- 2d. challenge resolve 入口（走 findings.resolve 的 kind='challenge'）----

  // ---- 2e. findings.route（v0.4 最短路路由：产物即状态；v0.6 对齐 acceptance 与 route-check 落账）----
  keep(tryRegister(ctx, {
    name: 'findings.route',
    description: '最短路路由（纯函数）：按台账当前状态给出下一步动作——resolve-blockers / record-findings / continue-recording / run-acceptance / BLOCKED（修复轮上限），并落一条 route-check 检查点。编排纪律：开工、卡住、收尾前都先问它，别凭记忆排下一步。',
    parameters: {
      type: 'object',
      properties: {
        repairFailed: { type: 'boolean', description: '本目标上一轮修复又失败了（按任务持久化推进 repairRounds 计数；到 3/2 上限即 BLOCKED）' },
        task: { type: 'string', description: '可选任务标识（与 repairFailed 共同按任务持久化修复轮数；缺省取 acceptance.task 或 default）' },
        acceptance: {
          type: 'object',
          description: '可选验收充分性规格（task 限定 finding/observed 口径）',
          properties: {
            minFindings: { type: 'number', description: '最少 finding 数' },
            minObservedRatio: { type: 'number', description: 'finding 中 observed 的最低比例（0–1）' },
            requiredRouteChecks: { type: 'number', description: '全台账最少 route-check 数' },
            task: { type: 'string', description: '限定统计到指定 REQ-xxxx / TASK-xxxx' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          why: { type: 'string' },
          detail: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'why'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.action + ' — ' + v.why }],
    },
    async execute(args, exec) {
      const currentLedger = getLedger(exec);
      const taskKey = String(args?.task ?? args?.acceptance?.task ?? 'default');
      if (args?.repairFailed) currentLedger.recordRepairFailure({ task: taskKey, reason: 'findings.route repairFailed' });
      const r = route(currentLedger, { clusterScale, task: taskKey, ...(args?.acceptance ? { acceptance: args.acceptance } : {}) });
      currentLedger.append({ kind: 'route-check', action: r.action, why: r.why, task: taskKey });
      return r;
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
    async execute(_args, exec) {
      return verifyLedger(getLedger(exec).file);
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
    async execute(args, exec) {
      const rec = getLedger(exec).gateSkipped(args);
      return { skipped: 1, id: rec.id };
    },
  }, log));

  // ---- 2h. findings.unknown（v0.6 对齐 CLI：unknown 缺口入账）----
  keep(tryRegister(ctx, {
    name: 'findings.unknown',
    description: '登记一个未查明/未证实的缺口（unknown）。classification=blocker 时会阻止 update_goal complete，直到用 findings.resolve 解决或 findings.gate-skip 显式覆盖。',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: '未知项内容描述（非空）' },
        why: { type: 'string', description: '未证实原因或影响说明（可选）' },
        classification: { type: 'string', enum: ['blocker', 'non-blocker', 'parameterizable'], description: '缺口分类（缺省 non-blocker）' },
      },
      required: ['what'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, classification: { type: 'string' }, status: { type: 'string' } },
        required: ['id', 'classification', 'status'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (typeof args?.what !== 'string' || !args.what.trim()) {
        throw new Error('EVIDENCE_BAD_UNKNOWN: what 不能为空');
      }
      const rec = getLedger(exec).addUnknown({
        what: args.what.trim(),
        why: typeof args.why === 'string' && args.why.trim() ? args.why.trim() : null,
        classification: args.classification ?? 'non-blocker',
      });
      return { id: rec.id, classification: rec.classification, status: rec.status };
    },
  }, log));

  // ---- 2i. findings.resolve（v0.6 对齐 CLI：解决 unknown 或 challenge）----
  keep(tryRegister(ctx, {
    name: 'findings.resolve',
    description: '解决台账中的 unknown（默认）或 challenge，追加一条 *-update 解决记录以解除 blocker 阻塞。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要解决的条目 ID（如 U3 或 C5）' },
        resolution: { type: 'string', description: '解决结论与证据说明（非空）' },
        kind: { type: 'string', enum: ['unknown', 'challenge'], description: '条目类型（缺省 unknown）' },
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, ref: { type: 'string' }, status: { type: 'string' } },
        required: ['id', 'ref', 'status'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('EVIDENCE_BAD_RESOLVE: id 不能为空');
      }
      if (typeof args?.resolution !== 'string' || !args.resolution.trim()) {
        throw new Error('EVIDENCE_BAD_RESOLVE: resolution 不能为空');
      }
      const currentLedger = getLedger(exec);
      const rec = args.kind === 'challenge'
        ? currentLedger.resolveChallenge(args.id.trim(), args.resolution.trim())
        : currentLedger.resolve(args.id.trim(), args.resolution.trim());
      return { id: rec.id, ref: rec.ref, status: rec.status };
    },
  }, log));

  // ---- 2j. findings.ingest（v0.8：报告 findings 围栏块结构化入账）----
  keep(tryRegister(ctx, {
    name: 'findings.ingest',
    description: '将子代理或评审报告 markdown（文件路径或原文）中的 ```findings 围栏块解析并入账，默认 verifiedBy=agent-reported。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '报告 markdown 文件路径（相对工作区或绝对，与 markdown 二选一）' },
        markdown: { type: 'string', description: '直接传入 markdown 文本（与 file 二选一）' },
        source: { type: 'string', description: '报告来源标识（如 subagent-1 / REVIEW-0007，缺省 unnamed）' },
        task: { type: 'string', description: '可选关联任务 ID（TASK-xxxx / REQ-xxxx）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ingested: { type: 'number' },
          ids: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'object' } },
          warnings: { type: 'array', items: { type: 'object' } },
        },
        required: ['ingested', 'ids', 'errors', 'warnings'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const currentLedger = getLedger(exec);
      const opts = {
        source: typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : 'unnamed',
        ...(typeof args?.task === 'string' && args.task.trim() ? { task: args.task.trim() } : {}),
      };
      if (typeof args?.markdown === 'string' && args.markdown.trim()) {
        return ingestMarkdown(currentLedger, args.markdown, opts);
      }
      if (typeof args?.file !== 'string' || !args.file.trim()) {
        throw new Error('EVIDENCE_BAD_INGEST: 必须提供非空 file 或 markdown');
      }
      const wsRoot = resolveWorkspaceRoot(ctx, exec, config, { allowProcessCwd: false });
      const targetPath = resolve(wsRoot ?? process.cwd(), args.file.trim());
      if (wsRoot) {
        const guardRes = check('read', { filePath: targetPath }, { workspaceRoot: wsRoot });
        if (guardRes) throw new Error(guardRes.code + ': ' + guardRes.reason);
      }
      return ingestReport(currentLedger, targetPath, opts);
    },
  }, log));

  // ---- 2k. findings.mark-verified（v0.8：lead 亲验升级）----
  keep(tryRegister(ctx, {
    name: 'findings.mark-verified',
    description: 'lead 亲验升级：将指定 finding ID（如 E5）标记为 lead-verified（append-only finding-update）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要升级的 finding ID（如 E5）' },
        note: { type: 'string', description: '可选核验备注' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, ref: { type: 'string' }, status: { type: 'string' } },
        required: ['id', 'ref', 'status'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('EVIDENCE_BAD_VERIFY: id 不能为空');
      }
      const rec = markVerified(getLedger(exec), args.id.trim(), args.note);
      return { id: rec.id, ref: rec.ref, status: 'lead-verified' };
    },
  }, log));

  // ---- 2l. findings.spans（v0.8：回合调用 span 可观测性聚合）----
  keep(tryRegister(ctx, {
    name: 'findings.spans',
    description: '查询当前项目台账的工具调用耗时与错误 Span 统计（总数、错误数、总耗时、工具排行与最近调用）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近调用条数（缺省 20）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          totalCalls: { type: 'number' },
          errorCount: { type: 'number' },
          totalDurationMs: { type: 'number' },
          ranking: { type: 'array', items: { type: 'object' } },
          recent: { type: 'array', items: { type: 'object' } },
        },
        required: ['totalCalls', 'errorCount', 'totalDurationMs', 'ranking', 'recent'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const currentLedger = getLedger(exec);
      const spans = readSpans(join(currentLedger.dir, 'spans.jsonl'));
      return summarizeSpans(spans, { limit: Number.isFinite(args?.limit) ? args.limit : 20 });
    },
  }, log));

  // ---- 2m. alignment.record（v0.8：6 层结构化预期对齐卡持久化与同步）----
  keep(tryRegister(ctx, {
    name: 'alignment.record',
    description: '校验并持久化 6 层结构化预期对齐卡到 .research/alignment/<slug>.md，并将 open_unknowns 与 reframe 探测同步到台账。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '对齐卡文件名 slug（缺省由 topic 自动派生）' },
        topic: { type: 'string', description: '任务或实验主题' },
        layers: {
          type: 'object',
          description: '6 层结构化预期（全部必填非空）',
          properties: Object.fromEntries(ALIGNMENT_LAYERS.map(l => [
            l,
            {
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              description: l + ' 层预期说明',
            },
          ])),
          required: ALIGNMENT_LAYERS,
          additionalProperties: false,
        },
        probes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              layer: { type: 'string', enum: ALIGNMENT_LAYERS },
              question: { type: 'string' },
              verdict: { type: 'string', enum: PROBE_VERDICTS },
              note: { type: 'string' },
            },
            required: ['question', 'verdict'],
            additionalProperties: false,
          },
        },
        open_unknowns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              what: { type: 'string' },
              classification: { type: 'string', enum: ['blocker', 'non-blocker', 'parameterizable'] },
              why: { type: 'string' },
            },
            required: ['what'],
            additionalProperties: false,
          },
        },
      },
      required: ['topic', 'layers'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          path: { type: 'string' },
          unknownsAdded: { type: 'number' },
          reframesRecorded: { type: 'number' },
        },
        required: ['slug', 'path', 'unknownsAdded', 'reframesRecorded'],
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const currentLedger = getLedger(exec);
      const wsRoot = resolveWorkspaceRoot(ctx, exec, config, { allowProcessCwd: false }) ?? process.cwd();
      const written = writeAlignmentCard(wsRoot, args);
      const synced = syncAlignmentToLedger(written.card, currentLedger);
      return {
        slug: written.slug,
        path: written.path,
        unknownsAdded: synced.unknownsAdded,
        reframesRecorded: synced.reframesRecorded,
      };
    },
  }, log));

  // ---- 3. 守卫 + 子代理审计 + 工具 Span 监听接线 ----
  try {
    keep(ctx.tools.guard(guardFn));
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.tools.guard', error: String(e?.message ?? e) });
  }
  try {
    keep(ctx?.on?.('tools/result', (exec, result) => {
      try {
        const target = getLedger(exec);
        spanRecorder.end(exec, result, target.dir);
      } catch (e) {
        log({ kind: 'listener-error', where: 'tools/result', error: String(e?.message ?? e) }, exec);
      }
    }));
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.on(tools/result)', error: String(e?.message ?? e) });
  }
  try {
    keep(ctx?.on?.('subagent/end', (payload) => {
      const target = getLedger(payload);
      return makeSubagentReportListener(target, (e) => log({ kind: 'listener-error', error: String(e?.message ?? e) }, payload))(payload);
    }));
  } catch (e) {
    log({ kind: 'wiring-error', where: 'ctx.on(subagent/end)', error: String(e?.message ?? e) });
  }

  // ---- 4. 技能 provider（自定位，替代 dsh.patch.yml 的绝对路径 customSkillDirs）----
  const skills = registerHarnessSkills(ctx, { skillsDir: config.skillsDir, log });
  if (typeof skills.dispose === 'function') keep(skills.dispose);

  // ---- 5. 自检留痕 ----
  log({
    kind: 'wired',
    version: PKG_VERSION,
    clusterScale,
    projectScope,
    enforceReadInsideWorkspace,
    verifier: { kind: verifier.kind, enabled: verifier.enabled },
    ledgerRoot: defaultLedger.dir,
    baseLedgerRoot: baseRoot,
    skills: { state: skills.state, count: skills.count, dir: skills.dir, ...(skills.error ? { error: skills.error } : {}) },
    tools: [
      'findings.record', 'findings.status', 'findings.aggregate', 'findings.challenge',
      'findings.route', 'findings.verify', 'findings.gate-skip', 'findings.unknown', 'findings.resolve',
      'findings.ingest', 'findings.mark-verified', 'findings.spans', 'alignment.record',
    ],
  });
  info('research-harness wired: clusterScale=' + clusterScale + ' scope=' + projectScope + ' ledger=' + defaultLedger.dir + ' verifier=' + verifier.kind);
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
