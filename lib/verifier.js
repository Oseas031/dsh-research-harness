import { spawn, spawnSync } from 'node:child_process';
import { gateEntry, verifyFileProvenance } from './evidence-gate.js';

const SHELL_META_RE = /[;&|`$><\r\n]/;
const SENSITIVE_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i;
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'LANG', 'LC_ALL', 'HOME', 'SHELL', 'TERM', 'TZ',
];
const OUTPUT_LIMIT = 1024 * 1024;
const SYNC_DEFAULT_MS = 10000;
const SYNC_MAX_MS = 15000;
const ASYNC_DEFAULT_MS = 30000;
const ASYNC_MAX_MS = 120000;
const GRACE_MS = 2000;

function splitSafeArgs(cmdText) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < cmdText.length; i++) {
    const ch = cmdText[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken || cur.length > 0) { tokens.push(cur); cur = ''; hasToken = false; }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (quote) throw new Error('VERIFIER_BAD_COMMAND: 命令字符串存在未闭合引号');
  if (hasToken || cur.length > 0) tokens.push(cur);
  return tokens;
}

/**
 * 解析并校验命令配置：拒绝 shell 注入元字符，产出安全的 { bin, args, syncTimeoutMs, asyncTimeoutMs, cwd, env }。
 */
export function parseCommandSpec(cfg = {}) {
  const raw = typeof cfg === 'string' || Array.isArray(cfg) ? { command: cfg } : (cfg || {});
  const extraArgs = Array.isArray(raw.args) ? raw.args.map(String) : null;
  let bin = null;
  let args = [];

  if (Array.isArray(raw.command)) {
    if (raw.command.length === 0) return { bin: null, args: [], empty: true };
    bin = String(raw.command[0] ?? '').trim();
    if (!bin) throw new Error('VERIFIER_BAD_COMMAND: 命令数组首项不能为空');
    args = raw.command.slice(1).map(String);
    if (extraArgs) args.push(...extraArgs);
  } else if (typeof raw.command === 'string') {
    const trimmed = raw.command.trim();
    if (!trimmed) return { bin: null, args: [], empty: true };
    if (extraArgs) {
      if (SHELL_META_RE.test(trimmed)) throw new Error('VERIFIER_UNSAFE_COMMAND: 可执行路径禁止包含 shell 元字符');
      bin = trimmed;
      args = extraArgs;
    } else {
      if (SHELL_META_RE.test(trimmed)) {
        throw new Error('VERIFIER_UNSAFE_COMMAND: 禁止在命令字符串中使用 shell 元字符（请改用 argv 数组形式传参）');
      }
      const tokens = splitSafeArgs(trimmed);
      if (tokens.length === 0) return { bin: null, args: [], empty: true };
      bin = tokens[0];
      args = tokens.slice(1);
    }
  } else if (raw.command === undefined || raw.command === null) {
    return { bin: null, args: [], empty: true };
  } else {
    throw new Error('VERIFIER_BAD_COMMAND: command 必须是字符串或 argv 字符串数组');
  }

  const reqTimeout = Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : null;
  return {
    bin,
    args,
    empty: false,
    syncTimeoutMs: reqTimeout ? Math.min(reqTimeout, SYNC_MAX_MS) : SYNC_DEFAULT_MS,
    asyncTimeoutMs: reqTimeout ? Math.min(reqTimeout, ASYNC_MAX_MS) : ASYNC_DEFAULT_MS,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : undefined,
    env: raw.env && typeof raw.env === 'object' ? raw.env : undefined,
  };
}

export function buildSafeEnv(extraEnv) {
  const env = {};
  for (const key of ENV_ALLOW) {
    if (process.env[key] !== undefined && !SENSITIVE_ENV_RE.test(key)) env[key] = process.env[key];
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

function buildVerifierEnv(ledger, extraEnv) {
  return buildSafeEnv({
    ...(ledger?.dir ? { RESEARCH_LEDGER_DIR: String(ledger.dir) } : {}),
    ...(ledger?.file ? { RESEARCH_LEDGER_FILE: String(ledger.file) } : {}),
    ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
  });
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  } catch { /* 进程可能已退出 */ }
}

/** 安全异步执行已校验的命令规格，支持树级超时查杀与输出截断。 */
export function runAsyncCommand(spec, { env, cwd, timeoutMs } = {}) {
  const effectiveTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, ASYNC_MAX_MS)
    : (spec.asyncTimeoutMs ?? ASYNC_DEFAULT_MS);
  const runCwd = cwd ?? spec.cwd;
  const runEnv = env ?? buildSafeEnv(spec.env);
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    let timer;
    let grace;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolvePromise({ ...payload, timedOut, stdout, stderr });
    };
    try {
      child = spawn(spec.bin, spec.args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runEnv,
        ...(runCwd ? { cwd: runCwd } : {}),
      });
    } catch (error) {
      return finish({ error });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, effectiveTimeout);
    grace = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, signal: 'SIGKILL' });
    }, effectiveTimeout + GRACE_MS);
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

function interpretCommandResult(spec, { code, signal, timedOut, stdout, stderr, error }) {
  const label = 'command: ' + [spec.bin, ...spec.args].join(' ');
  if (error) {
    return { pass: false, checks: [label], failed: ['spawn error: ' + String(error.message ?? error).slice(0, 200)], timedOut: false, exitCode: null };
  }
  if (timedOut) {
    return { pass: false, checks: [label], failed: ['command timed out after ' + (signal ?? 'timeout')], timedOut: true, exitCode: code ?? null };
  }
  if (code !== 0) {
    const errText = String(stderr || stdout || '').trim().slice(0, 200);
    return { pass: false, checks: [label], failed: ['exit=' + String(code) + (errText ? ' ' + errText : '')], timedOut: false, exitCode: code };
  }
  const outTrim = String(stdout ?? '').trim();
  if (outTrim.startsWith('{') && outTrim.endsWith('}')) {
    try {
      const parsed = JSON.parse(outTrim);
      if (parsed && typeof parsed.pass === 'boolean') {
        return {
          pass: parsed.pass,
          checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [label],
          failed: parsed.pass ? [] : (Array.isArray(parsed.failed) ? parsed.failed.map(String) : ['command JSON reported pass=false']),
          timedOut: false,
          exitCode: 0,
        };
      }
    } catch { /* 非结构化 JSON 输出按退出码 0 判定通过 */ }
  }
  return { pass: true, checks: [label], failed: [], timedOut: false, exitCode: 0 };
}

/**
 * 可插拔校验器。
 * kind='evidence'（默认）：对台账里 observed/inferred 条目复跑证据门（provenance 必须在场且合法）。
 * kind='command'：以 shell: false + argv 数组 + env 白名单跑外部校验脚本，支持同步 verify()（短限顶）与异步 verifyAsync()（进程树回收）。
 */
export function createVerifier(cfg = {}) {
  const kind = cfg.kind ?? 'evidence';
  const enabled = cfg.enabled !== false;
  if (kind === 'command') {
    const spec = parseCommandSpec(cfg);
    return {
      kind,
      enabled,
      spec,
      verify(ledger) {
        if (spec.empty) return { pass: true, checks: ['verifier command 未配置，跳过'], failed: [] };
        const env = buildVerifierEnv(ledger, spec.env);
        const r = spawnSync(spec.bin, spec.args, {
          shell: false,
          timeout: spec.syncTimeoutMs,
          maxBuffer: OUTPUT_LIMIT,
          encoding: 'utf8',
          windowsHide: true,
          env,
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
        });
        const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
        return interpretCommandResult(spec, {
          code: r.status,
          signal: r.signal,
          timedOut,
          stdout: r.stdout,
          stderr: r.stderr,
          error: timedOut ? null : r.error,
        });
      },
      async verifyAsync(ledger) {
        if (spec.empty) return { pass: true, checks: ['verifier command 未配置，跳过'], failed: [] };
        const env = buildVerifierEnv(ledger, spec.env);
        const res = await runAsyncCommand(spec, { env, cwd: spec.cwd, timeoutMs: spec.asyncTimeoutMs });
        return interpretCommandResult(spec, res);
      },
    };
  }
  const cfgMaxAgeMs = typeof cfg.maxAgeHours === 'number' && cfg.maxAgeHours > 0 ? cfg.maxAgeHours * 3600 * 1000 : null;
  const checkFileExists = cfg.checkFileExists === true;
  const workspaceRoot = cfg.workspaceRoot ?? '.';
  return {
    kind: 'evidence',
    enabled,
    maxAgeHours: cfgMaxAgeMs ? cfg.maxAgeHours : null,
    checkFileExists,
    verify(ledger, opts = {}) {
      const failed = [];
      const warnings = [];
      let checked = 0;
      let stale = 0;
      const baseDir = opts.workspaceRoot ?? workspaceRoot;
      const verifyFiles = typeof opts.checkFileExists === 'boolean' ? opts.checkFileExists : checkFileExists;
      const restrictToBaseDir = typeof opts.restrictToBaseDir === 'boolean'
        ? opts.restrictToBaseDir
        : (typeof cfg.restrictToBaseDir === 'boolean' ? cfg.restrictToBaseDir : true);
      for (const e of ledger.entries()) {
        if (e.kind === 'finding' && (e.confidence === 'observed' || e.confidence === 'inferred')) {
          checked += 1;
          const d = gateEntry({ claim: e.claim, confidence: e.confidence, provenance: e.provenance });
          if (d) {
            failed.push(e.id + ' ' + d.code);
          } else if (verifyFiles) {
            const fv = verifyFileProvenance(e.provenance, baseDir, { restrictToBaseDir });
            if (!fv.ok) failed.push(e.id + ' ' + fv.code + ': ' + fv.reason);
          }
          // v0.3 时效降档：条目年龄超过 maxAgeHours → 警告并降 confidence（findings.aggregate 按 todo 档计）
          if (cfgMaxAgeMs && e.ts) {
            const age = Date.now() - Date.parse(e.ts);
            if (Number.isFinite(age) && age > cfgMaxAgeMs) {
              stale += 1;
              warnings.push(e.id + ' stale(' + Math.round(age / 3600000) + 'h) → confidence 降 unknown');
            }
          }
        }
      }
      return { pass: failed.length === 0, checks: ['evidence re-gate over ' + checked + ' observed/inferred entries' + (stale ? ', ' + stale + ' stale' : '') + (verifyFiles ? ' (+file check)' : '')], failed, warnings };
    },
    async verifyAsync(ledger, opts = {}) {
      return this.verify(ledger, opts);
    },
  };
}
