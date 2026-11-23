import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply as applyPlugin } from '../lib/index.js';
import { check, guardShellNetwork } from '../lib/guards.js';
import { validateProvenance, verifyFileProvenance } from '../lib/evidence-gate.js';
import { Ledger } from '../lib/ledger.js';
import { route } from '../lib/route.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = (prefix = 'rh-v090-') => mkdtempSync(join(tmpdir(), prefix));

function makeMockCtx() {
  const guards = [];
  const tools = [];
  const ctx = {
    logger: { info() {}, error() {} },
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
      register(def) {
        tools.push(def);
        return () => {};
      },
    },
    on() {
      return () => {};
    },
  };
  const checkGuards = (exec) => {
    for (const fn of guards) {
      const r = fn(exec);
      if (r) return r;
    }
    return undefined;
  };
  return { ctx, tools, checkGuards };
}

test('v0.9.0 guardShellNetwork: 拦截公网客户端调用，放行回环与本地数据分析', () => {
  const blockedCmds = [
    ['pwsh', 'Invoke-RestMethod https://api.openalex.org/works/W1'],
    ['pwsh', 'Invoke-WebRequest -Uri https://example.org/data.csv -OutFile out.csv'],
    ['pwsh', 'irm https://api.github.com/repos/a/b'],
    ['pwsh', 'iwr https://example.org'],
    ['pwsh', '$wc = New-Object System.Net.WebClient; $wc.DownloadString("https://example.com")'],
    ['pwsh', 'Resolve-DnsName example.org'],
    ['bash', 'curl -s https://api.openalex.org/works'],
    ['bash', 'curl.exe -s https://example.org/test'],
    ['bash', 'wget https://example.org/file.txt'],
    ['bash', 'nslookup example.org'],
    ['pwsh', 'python -B -c "import requests; requests.get(\'https://api.openalex.org\')"'],
    ['bash', 'python3 -B -c "import urllib.request; urllib.request.urlopen(\'https://example.org\')"'],
    ['bash', 'python3 -B -c "import httpx; httpx.get(\'https://example.org\')"'],
    ['terminal_send', 'node -e "fetch(\'https://api.example.com/v1\')"'],
  ];
  for (const [tool, command] of blockedCmds) {
    const res = check(tool, { command }, { enforceOfflineShell: true });
    assert.equal(res?.code, 'SHELL_NETWORK_BLOCKED', `应拦截 ${tool}: ${command}`);
    assert.equal(guardShellNetwork({ command, tool })?.code, 'SHELL_NETWORK_BLOCKED');
  }

  // 默认关闭 enforceOfflineShell 时保持向后兼容（不阻断）
  assert.equal(
    check('pwsh', { command: 'Invoke-RestMethod https://api.openalex.org/works/W1' }, {}),
    null,
  );

  // 回环请求与纯本地数据分析（含打印 DOI URL）一律放行
  const allowedCmds = [
    ['pwsh', 'Invoke-RestMethod http://127.0.0.1:8080/health'],
    ['bash', 'curl -s http://localhost:3000/api/status'],
    ['bash', 'curl -s http://[::1]:8000/metrics'],
    ['pwsh', 'python -B scripts/analyze.py'],
    ['pwsh', 'python -B -c "print(\'doi_url=https://doi.org/10.1007/s10530-024-03270-0\')"'],
    ['pwsh', 'python -B -c "import pandas as pd; df = pd.read_csv(\'data/raw.csv\'); print(df[df[\'url\'].str.contains(\'https://doi.org\')])"'],
  ];
  for (const [tool, command] of allowedCmds) {
    assert.equal(
      check(tool, { command }, { enforceOfflineShell: true }),
      null,
      `不应误杀 ${tool}: ${command}`,
    );
  }
});

test('v0.9.0 route(): 预算感知输出 checkpoint-findings / finalize-now，不破坏旧优先序', (t) => {
  const dir = tmp('rh-route-budget-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir).ensure();

  // 未达阈值保持原状
  assert.equal(
    route(ledger, { budget: { maxToolCalls: 10, usedToolCalls: 6, warnRatio: 0.7 } }).action,
    'record-findings',
  );

  // 达阈值但 findings=0 → checkpoint-findings
  const cp = route(ledger, { budget: { maxToolCalls: 10, usedToolCalls: 7, warnRatio: 0.7 } });
  assert.equal(cp.action, 'checkpoint-findings');
  assert.equal(cp.detail.findings, 0);
  assert.equal(cp.detail.budget.ratio, 0.7);

  // 仅按耗时触发同样生效
  const cpTime = route(ledger, { budget: { maxDurationMs: 10000, elapsedMs: 7500, warnRatio: 0.7 } });
  assert.equal(cpTime.action, 'checkpoint-findings');

  // 有未决 blocker 时，resolve-blockers 仍优先于预算分流
  const unk = ledger.addUnknown({ what: '缺口待查', classification: 'blocker' });
  assert.equal(
    route(ledger, { budget: { maxToolCalls: 10, usedToolCalls: 9, warnRatio: 0.7 } }).action,
    'resolve-blockers',
  );

  // 修复轮达上限时，BLOCKED 仍最高优先
  assert.equal(
    route(ledger, {
      clusterScale: 'delegate',
      repairRounds: 2,
      budget: { maxToolCalls: 10, usedToolCalls: 9, warnRatio: 0.7 },
    }).action,
    'BLOCKED',
  );

  // 解决 blocker 并入账 finding 后，达阈值 → finalize-now
  ledger.resolve(unk.id, '已核实');
  ledger.record({ claim: '主检验显著 p=0.001', confidence: 'observed', provenance: 'results/out.txt:1' });
  const fin = route(ledger, { budget: { maxToolCalls: 10, usedToolCalls: 8, warnRatio: 0.7 } });
  assert.equal(fin.action, 'finalize-now');
  assert.equal(fin.detail.findings, 1);

  // 预算未超阈值 + 传空 opts 时维持 run-acceptance
  assert.equal(route(ledger).action, 'run-acceptance');
  assert.equal(
    route(ledger, { budget: { maxToolCalls: 10, usedToolCalls: 5, warnRatio: 0.7 } }).action,
    'run-acceptance',
  );
});

test('v0.9.0 apply(): 增量入账门、预算硬收尾门、不死锁放行与 findings_route 自动感知', async (t) => {
  const ws = tmp('rh-v090-apply-');
  const ledgerDir = join(ws, '.research');
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, 'data.csv'), 'a,b\n1,2\n', 'utf8');

  const { ctx, tools, checkGuards } = makeMockCtx();
  applyPlugin(ctx, {
    ledgerRoot: ledgerDir,
    workspaceRoot: ws,
    enforceReadInsideWorkspace: true,
    enforceOfflineShell: true,
    incrementalCheckpoint: { enabled: true, maxAnalysisCalls: 2 },
    budget: { maxToolCalls: 7, maxDurationMs: 60000, warnRatio: 0.5, hardFinalizeRatio: 0.8 },
  });
  const byName = Object.fromEntries(tools.map(d => [d.name, d]));

  // wired 日志应含 v0.9.0 配置摘要
  const guardLines = () => readFileSync(join(ledgerDir, 'guard-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const wired = guardLines().find(x => x.kind === 'wired');
  assert.equal(wired.enforceOfflineShell, true);
  assert.deepEqual(wired.incrementalCheckpoint, { maxAnalysisCalls: 2, onlyAfterResults: false });
  assert.equal(wired.budget.maxToolCalls, 7);

  // 1. 离线联网拦截（且拒绝不累计 totalToolCalls / analysisCallsSinceRecord）
  const netDeny = checkGuards({
    name: 'pwsh',
    cwd: ws,
    arguments: { command: 'Invoke-RestMethod https://api.openalex.org/works/W1' },
  });
  assert.equal(netDeny?.info?.code, 'SHELL_NETWORK_BLOCKED');

  // 2. 连续 2 次分析放行，第 3 次触发 INCREMENTAL_RECORD_REQUIRED
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B a.py' } }), undefined);
  assert.equal(checkGuards({ name: 'write', cwd: ws, arguments: { filePath: join(ws, 'out.txt') } }), undefined);
  const incDeny = checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B b.py' } });
  assert.equal(incDeny?.info?.code, 'INCREMENTAL_RECORD_REQUIRED');

  // 触发增量门禁期间，只读与台账/对齐/目标工具始终放行（防死锁）
  assert.equal(checkGuards({ name: 'read', cwd: ws, arguments: { filePath: join(ws, 'data.csv') } }), undefined);
  assert.equal(checkGuards({ name: 'str_replace_editor', cwd: ws, arguments: { command: 'view', path: join(ws, 'data.csv') } }), undefined);
  assert.equal(checkGuards({ name: 'findings_status', cwd: ws, arguments: {} }), undefined);
  assert.equal(checkGuards({ name: 'findings_route', cwd: ws, arguments: {} }), undefined);

  // findings_route 在已达 warnRatio 时返回 checkpoint-findings（此时 findings 仍为 0）
  const routeMid = await byName.findings_route.execute({}, { name: 'findings_route', cwd: ws });
  assert.equal(routeMid.action, 'checkpoint-findings');

  // 调用合法 findings_record 后，立即解锁分析工具
  const recArgs = { entries: [{ claim: '阶段均值 1.5', confidence: 'observed', provenance: 'data.csv:1' }] };
  assert.equal(checkGuards({ name: 'findings_record', cwd: ws, arguments: recArgs }), undefined);
  await byName.findings_record.execute(recArgs, { name: 'findings_record', cwd: ws });

  // totalToolCalls 已到 6/7 ≈ 0.857 >= 0.8（hardFinalizeRatio）→ 触发 BUDGET_FINALIZE_REQUIRED
  const budgetDenyPwsh = checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B c.py' } });
  assert.equal(budgetDenyPwsh?.info?.code, 'BUDGET_FINALIZE_REQUIRED');
  const budgetDenyWrite = checkGuards({ name: 'write', cwd: ws, arguments: { filePath: join(ws, 'extra.txt') } });
  assert.equal(budgetDenyWrite?.info?.code, 'BUDGET_FINALIZE_REQUIRED');

  // findings_route 应自动输出 finalize-now
  const routeFin = await byName.findings_route.execute({}, { name: 'findings_route', cwd: ws });
  assert.equal(routeFin.action, 'finalize-now');

  // 预算硬收尾期间 findings_verify / read / update_goal complete 全部放行
  assert.equal(checkGuards({ name: 'findings_verify', cwd: ws, arguments: {} }), undefined);
  const verOut = await byName.findings_verify.execute({}, { name: 'findings_verify', cwd: ws });
  assert.equal(verOut.ok, true);
  assert.equal(checkGuards({ name: 'update_goal', cwd: ws, arguments: { action: 'complete' } }), undefined);
});

test('v0.9.0 incrementalCheckpoint 解锁：findings_unknown 与高上限单独解锁', async (t) => {
  const ws = tmp('rh-v090-unlock-');
  const ledgerDir = join(ws, '.research');
  t.after(() => rmSync(ws, { recursive: true, force: true }));

  const { ctx, tools, checkGuards } = makeMockCtx();
  applyPlugin(ctx, {
    ledgerRoot: ledgerDir,
    workspaceRoot: ws,
    incrementalCheckpoint: { enabled: true, maxAnalysisCalls: 1 },
  });
  const byName = Object.fromEntries(tools.map(d => [d.name, d]));

  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B step1.py' } }), undefined);
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B step2.py' } })?.info?.code, 'INCREMENTAL_RECORD_REQUIRED');

  const unkArgs = { what: '关键分组字段待核', classification: 'non-blocker' };
  assert.equal(checkGuards({ name: 'findings_unknown', cwd: ws, arguments: unkArgs }), undefined);
  await byName.findings_unknown.execute(unkArgs, { name: 'findings_unknown', cwd: ws });

  // 解锁后再允许执行 1 次分析
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B step2.py' } }), undefined);
});

test('v0.9.0 budget 按 maxDurationMs 时间门槛触发 BUDGET_FINALIZE_REQUIRED', async (t) => {
  const ws = tmp('rh-v090-time-');
  const ledgerDir = join(ws, '.research');
  t.after(() => rmSync(ws, { recursive: true, force: true }));

  const { ctx, checkGuards } = makeMockCtx();
  applyPlugin(ctx, {
    ledgerRoot: ledgerDir,
    workspaceRoot: ws,
    budget: { maxDurationMs: 25, warnRatio: 0.4, hardFinalizeRatio: 0.8 },
  });

  await new Promise(r => setTimeout(r, 35));
  const deny = checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B slow.py' } });
  assert.equal(deny?.info?.code, 'BUDGET_FINALIZE_REQUIRED');
  assert.equal(deny?.info?.findings, 0);
  // read/findings_record 依然放行
  assert.equal(
    checkGuards({
      name: 'findings_record',
      cwd: ws,
      arguments: { entries: [{ claim: '超时前落账', confidence: 'observed', provenance: 'tool:pwsh' }] },
    }),
    undefined,
  );
});

test('v0.9.0 技能、预设与文档规则对齐（validate-data <= 8192）', () => {
  const vd = readFileSync(join(ROOT, 'skills', 'validate-data', 'SKILL.md'), 'utf8');
  assert.ok(vd.length <= 8192, `validate-data/SKILL.md 超出 8192 上限: ${vd.length}`);
  const fenceCount = (vd.match(/^```/gm) || []).length;
  assert.equal(fenceCount % 2, 0);
  assert.ok(vd.includes('math.isclose'));
  assert.ok(vd.includes('rel_tol=1e-5'));
  assert.ok(vd.includes('Checkpoint primary results'));

  const patchYml = readFileSync(join(ROOT, 'dsh.patch.yml'), 'utf8');
  assert.ok(patchYml.includes('math.isclose'));
  assert.ok(patchYml.includes('findings_verify'));

  const researchMd = readFileSync(join(ROOT, 'instructions', 'RESEARCH.md'), 'utf8');
  assert.ok(researchMd.includes('SHELL_NETWORK_BLOCKED'));
  assert.ok(researchMd.includes('INCREMENTAL_RECORD_REQUIRED'));
  assert.ok(researchMd.includes('BUDGET_FINALIZE_REQUIRED'));
  assert.ok(existsSync(join(ROOT, 'test', 'v090.test.mjs')));
});

test('v0.9.0 validateProvenance 与 verifyFileProvenance: 兼容多行逗号语法与区间', (t) => {
  const ws = tmp('rh-v090-prov-');
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, 'results'), { recursive: true });
  writeFileSync(join(ws, 'results', 'out.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n', 'utf8');

  assert.equal(validateProvenance('results/out.txt:5,7'), null);
  assert.equal(validateProvenance('results/out.txt:1,3-4'), null);
  assert.equal(validateProvenance('file:results/out.txt:2-4,6'), null);

  const ok1 = verifyFileProvenance('results/out.txt:5,7', ws);
  assert.equal(ok1.ok, true);
  assert.equal(ok1.start, 5);
  assert.equal(ok1.end, 7);

  const ok2 = verifyFileProvenance('results/out.txt:1,3-4', ws);
  assert.equal(ok2.ok, true);
  assert.equal(ok2.start, 1);
  assert.equal(ok2.end, 4);

  const badOob = verifyFileProvenance('results/out.txt:1,99', ws);
  assert.equal(badOob.ok, false);
  assert.equal(badOob.code, 'EVIDENCE_LINE_OUT_OF_RANGE');

  const badOrder = verifyFileProvenance('results/out.txt:5-3', ws);
  assert.equal(badOrder.ok, false);
  assert.equal(badOrder.code, 'EVIDENCE_BAD_LINES');
});

test('v0.9.0 onlyAfterResults 与 BUDGET_FINALIZE_REQUIRED hasVerified 精细状态', async (t) => {
  const ws = tmp('rh-v090-oar-');
  const ledgerDir = join(ws, '.research');
  t.after(() => rmSync(ws, { recursive: true, force: true }));

  const { ctx, tools, checkGuards } = makeMockCtx();
  applyPlugin(ctx, {
    ledgerRoot: ledgerDir,
    workspaceRoot: ws,
    incrementalCheckpoint: { enabled: true, maxAnalysisCalls: 2, onlyAfterResults: true },
    budget: { maxToolCalls: 6, warnRatio: 0.5, hardFinalizeRatio: 0.65 },
  });
  const byName = Object.fromEntries(tools.map(d => [d.name, d]));

  // results/ 尚未有文件，连续 3 次分析不应触发 INCREMENTAL_RECORD_REQUIRED（onlyAfterResults=true）
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p1.py' } }), undefined);
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p2.py' } }), undefined);
  assert.equal(checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p3.py' } }), undefined);

  // 一旦 results/ 产生文件，下一次分析（totalCalls=3/6 < 0.65 且 analysisCalls=3>=2）立刻触发 INCREMENTAL_RECORD_REQUIRED
  mkdirSync(join(ws, 'results'), { recursive: true });
  writeFileSync(join(ws, 'results', 'out.txt'), 'done\n', 'utf8');
  assert.equal(
    checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p4.py' } })?.info?.code,
    'INCREMENTAL_RECORD_REQUIRED',
  );

  // 入账 1 条 finding（使用逗号行号 provenance）后，calls=4/6=0.667 >= 0.65 → 触发 BUDGET_FINALIZE_REQUIRED（未 verify 态）
  const recArgs = { entries: [{ claim: '主输出完成', confidence: 'observed', provenance: 'results/out.txt:1,1' }] };
  assert.equal(checkGuards({ name: 'findings_record', cwd: ws, arguments: recArgs }), undefined);
  await byName.findings_record.execute(recArgs, { name: 'findings_record', cwd: ws });

  const b1 = checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p5.py' } });
  assert.equal(b1?.info?.code, 'BUDGET_FINALIZE_REQUIRED');
  assert.equal(b1?.info?.hasVerified, false);
  assert.ok(b1.reason.includes('立即调用 findings_verify') || b1.reason.includes('立刻调用 findings_verify'));

  // 执行 findings_verify 后再触发 BUDGET_FINALIZE_REQUIRED → 提示“已完成 findings_verify，禁止再调用任何工具”
  await byName.findings_verify.execute({}, { name: 'findings_verify', cwd: ws });
  const b2 = checkGuards({ name: 'pwsh', cwd: ws, arguments: { command: 'python -B p5.py' } });
  assert.equal(b2?.info?.code, 'BUDGET_FINALIZE_REQUIRED');
  assert.equal(b2?.info?.hasVerified, true);
  assert.ok(b2.reason.includes('已完成 findings_verify'));
  assert.ok(b2.reason.includes('禁止再调用任何工具'));
});
