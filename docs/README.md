# dsh-research-harness — 当前机制与文件契约

> **当前版本：v0.8.0。本文件是机制、目录与数据契约的真相源。**
> 新用户安装与 Quickstart 见 [根 README](../README.md)；版本变化见 [CHANGELOG](../CHANGELOG.md)。

dsh-research-harness 是一个 DSH 插件加独立「科研 Harness」预设：**技能是库存，证据契约是产品。**

## 证据契约闭环

```text
研究发现 ──findings.record──▶ 守卫检查 provenance
   │缺                           │在场且合法
   ▼                            ▼
当场拒绝并写 guard-log       ledger.jsonl 入账
                              （observed/inferred/unknown）
                                  │
                    update_goal complete
                                  ▼
              未决且未被覆盖的 blocker 非空 → 拒绝
              （EVIDENCE_BLOCKERS_OPEN）
              台账写 completion-attempt: inconclusive
              goal 走 inconclusive/blocked
```

核心规则：

1. finding 必须带来源；`task` 只接受 `REQ-xxxx` / `TASK-xxxx`。
2. unknown 分为 blocker、non-blocker、parameterizable；未决 blocker 与完成语义直接关联。
3. 软门禁例外通过 `findings.gate-skip` 留下 `reason`、`risk`、`compensation`，并用 `covers` 指名覆盖的 blocker。
4. `findings.route` 只根据产物状态给出下一步；`acceptance` 可要求最低发现数、observed 比例和 route-check 数。
5. 机制写入 Ledger 时同步写 SHA-256 收据；`findings.verify` 报告 `drifted` 与 `unverified`。收据证明的是行完整性，不是研究结论的真实性。
6. 子代理报告可经 `ingest` 入账，初始为 `agent-reported`，复核后升级为 `lead-verified`。

## v0.5.0 技能进化

进化对象是**技能文本**，不是机制代码。操作者通过 JSON 提案提交完整文件替换；机制不会 import 或执行候选代码。

闭环为：

```text
init 冻结契约与 evaluator_id
  → hash 记录父本
  → apply 校验 surface/父本并生成随机 A/B packet
  → 评审按冻结 rubric/cases 写 verdict
  → select 重验冻结资产并选择 keep/revert
  → verify/log/champion 检查谱系与当前冠军
```

- `evaluator_id` 冻结 `evals/**`、`lib/**`、`bin/**`、`test/**`、`harness-lab/**` 的排序内容哈希；apply 前后及 select 前复核。
- `evals/**`、`.research/**`、`.evolve/**`、机制代码、`instructions/**`、`docs/**`、`package.json` 和 `dsh.patch.yml` 等路径不属于可修改 surface。
- treatment 只有在无 hard failure 且总分更高时才 keep；平分时，只有修复 control 的 hard failure 才 keep，否则恢复父本字节。
- 每代保存 packet、verdict、gens 与 backups；`archive.jsonl` 每行对应 `archive-receipts.jsonl` 中的 SHA-256 收据。keep 可向主 Ledger 写 `evolve-champion`。

完整的提案、verdict、选择规则和 CLI 示例见 [v0.5.0 技能进化契约](v05-evolution.md)。该评审是**技能文本的配对行为评审**，不是运行时 benchmark，也不证明统计意义上的能力增益。

## route 的验收充分性

`acceptance` 是可传入选项；未提供时保持旧行为。

| 字段 | 语义 |
|---|---|
| `minFindings` | 最少 finding 数 |
| `minObservedRatio` | finding 中 `confidence=observed` 的最低比例 |
| `requiredRouteChecks` | 全台账最少 `route-check` 数 |
| `task` | 将 finding 与 observed 统计限定到指定 REQ/TASK；route-check 仍为全局计数 |

主要动作：`record-findings`（空台账）、`resolve-blockers`（有未覆盖 blocker）、`continue-recording`（充分性不足）、`run-acceptance`（可进入验收）、`BLOCKED`（达到修复轮上限）。

## 目录与模块

- `lib/index.js` — 插件入口，从 `package.json` 动态读取版本号，注册 13 个契约工具（含 `findings.unknown`/`findings.resolve`、`findings.ingest`/`findings.mark-verified`、`findings.spans`、`alignment.record` 与对齐 `acceptance` 的 `findings.route`）、守卫、`tools/result` Span 监听、子代理审计监听与技能 provider。
- `lib/guards.js` — 守卫纯函数与统一 `check()` 入口。
- `lib/evidence-gate.js` — provenance 校验、file:line 存在性/行号核查（`verifyFileProvenance`）、`findings.record` 门控与子代理报告审计。
- `lib/ledger.js` — 追加式台账、unknown 会计、task、按任务持久化 `repair-attempt`、软门禁跳过与统计。
- `lib/receipts.js` — Ledger 行级 SHA-256 收据及漂移核对。
- `lib/completion.js` — blocker 完成门禁与 inconclusive 通道。
- `lib/route.js` — 最短路径路由、验收充分性与按任务持久化修复轮上限。
- `lib/verifier.js` — 可插拔校验器；`evidence` 支持 `maxAgeHours` 时效降档与 `checkFileExists`，`command` 支持安全异步执行。
- `lib/ingest.js` — 报告 `findings` 块解析、入账（`ingestMarkdown`/`ingestReport`）和验证状态升级。
- `lib/spans.js` — 回合级工具调用脱敏 Span 记录器与耗时聚合。
- `lib/alignment.js` — 6 层结构化预期对齐卡校验、`Markdown` 无损持久化和台账同步。
- `lib/evolve.js` — 技能提案、surface 保护、冻结评估器、隔离异步评审（`runEvaluator`）、回滚（`rollback`）与谱系收据。
- `lib/skill-provider.js` — 自定位 `skills/` 并注册 10 个科研技能，不依赖硬编码绝对路径。
- `bin/research-harness.mjs` — 独立 CLI，与插件共用核心实现（支持 `--version` / `-v` / `version`）。
- `instructions/RESEARCH.md` — 研究纪律全文。
- `evals/skills/` — 10 个科研技能的冻结行为案例与 rubric。
- `skills/` — 10 个科研技能；各技能的权威说明位于自己的 `SKILL.md`（无硬编码本机路径，`sci-figure/render.py` 使用 `sys.executable`）。
- `test/` — `node:test` 单测与 mock-ctx 契约测试。
- `harness-lab/` — 真实 cordis/ToolsService/SystemPrompt 契约层与端到端产物流水线验收环境（含 `scenarios/pipeline-e2e.mjs`）。

## 数据与收据位置

| 上下文 | 默认根目录 | 覆盖规则 |
|---|---|---|
| DSH 插件 | `~/.dsh/research-harness/projects/<slug-hash>/`（按工作区自动分账，附 `workspace.json`） | `projectScope: 'global'` 回退 `~/.dsh/research-harness/`；显式 `ledgerRoot` 最高优先 |
| CLI | 当前工作目录的 `./.research` | `--ledger DIR` > `RESEARCH_LEDGER` > 默认值 |
| 进化实验 | `<root>/.evolve/<name>/` | `--root DIR`；缺省为 CLI 所在包根目录 |

Ledger 根目录包含 `ledger.jsonl`、`ledger-receipts.jsonl`、`guard-log.jsonl`、`spans.jsonl` 与跨进程写入锁 `.ledger.lock`（自动回收僵尸锁）；工作区 `.research/alignment/` 保存结构化对齐卡 Markdown。进化目录包含 `contract.json`、`archive.jsonl`、`archive-receipts.jsonl`、`gens/`、`packets/`、`verdicts/`、`backups/`。

## clusterScale

- `solo`：禁止派单，修复轮上限 3。
- `delegate`：默认值，主从编排，修复轮上限 2。
- `cluster`：开放实验性集群编排，修复轮上限 2。

`repairFailed` 会以 `repair-attempt` 事件按 `task` 持久化写入 Ledger（并在 `reset` 或 `completion-attempt` 完成后归零），跨会话重启仍生效。

## 开发与验收

在仓库根目录运行：

```bash
npm test
```

契约层热循环验收：

```bash
cd harness-lab
node protocol.mjs
node lab.mjs scenarios/smoke.mjs
```

`harness-lab` 每次用真实生产装配路径验证插件契约层；修改插件代码后，新进程即可加载新代码。它不等同于完整的 DSH UI 端到端测试，persona、工具面、技能根等预设组合层仍需在真实 DSH 中重启确认。

当前实测边界为 **Windows + DSH**。已有记录包括 2026-11-18 的真实 DSH 会话重启验收（wired 与 guard-log 留痕）以及 harness-lab 契约层验收；其他操作系统、DSH 版本或安装布局需重新验证。本地验收结果不代表 npm 发布或远端 CI 状态。

## 相关文档

- [新手安装、CLI Quickstart、10 技能与 License](../README.md)
- [0.5.0 / 0.4.1 / 0.4.0 版本记录](../CHANGELOG.md)
- [v0.5.0 技能进化契约](v05-evolution.md)
- [v0.3 参考与出处](v03-references.md)
