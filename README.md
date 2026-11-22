# dsh-research-harness

面向 DSH 的科研工作台：把证据守卫、追加式台账、完成门禁、最短路径路由和 10 个科研技能装进独立「科研 Harness」预设。**技能是库存，证据契约是产品。**

当前仓库版本：**v0.8.0**。版本变化见 [CHANGELOG](CHANGELOG.md)，机制与文件契约见 [docs/README](docs/README.md)。

## v0.8.0 能做什么

- **工程闭环增强（P1）**：
  - 按任务持久化的修复预算：`Ledger` 新增 `repair-attempt` 事件按 `task` 持久化失败修复轮数（`recordRepairFailure` / `resetRepairRounds` / `repairRoundsOf`），`findings.route`（及 `route --repair-failed --task`）跨会话不归零也不串任务。
  - 证据时效与文件 provenance 复核：`aggregate` 支持 `maxAgeHours` 自动将超期条目降档为 `# TODO stale`（`counts.stale`）；`evidence` 校验器支持 `checkFileExists` 检验引用文件真实存在且行号不越界。
  - 回合可观测性：`SpanRecorder` 监听守卫放行与 `tools/result`，写入脱敏 `spans.jsonl`；插件新增 `findings.spans`（CLI：`research-harness spans`）输出工具耗时排行与最近调用。
  - 6 层结构化预期对齐卡：新增 `alignment.record` 工具与 CLI `alignment save|read`，将 6 层预期、探测裁决（`adopt|reject|reframe`）与未知项持久化到 `.research/alignment/<slug>.md` 并同步至台账。
  - 工具面与进化闭环补全：新增 `findings.ingest` 与 `findings.mark-verified`，注册工具数扩充至 13 个；`Evolver` 新增 `rollback()` 与隔离异步双盲评审执行器 `runEvaluator()`（CLI：`evolve eval` / `evolve rollback`）。
- **工作区守卫解耦（v0.7.0 P0）**：基于 DSH 真实 `exec.arguments` 与 `WorkingDirectoryService` 校验 `write`/`edit`/`apply_patch` 越界，不再把 `ledgerRoot` 误当作工作区；`read` 自动检测磁盘文件大小并拦截 >20MB 文本与二进制文件。
- **多项目分账与并发锁**：默认按工作区自动隔离台账（`~/.dsh/research-harness/projects/<slug-hash>/`），写入经跨进程 `wx` 排他锁保障 `seq` 单调且收据严格对齐。
- **安全异步命令校验器**：`verifier(command)` 强制 `shell: false`、argv 数组传参、环境变量白名单、拒绝 shell 元字符与 `verifyAsync()` 进程树超时回收；CLI 新增 `verify-cmd`。
- **证据入账**：研究发现必须带 `provenance` 与 `confidence`（`observed` / `inferred` / `unknown`），支持 `task` 标签和 `verifiedBy`（`agent-reported` / `lead-verified`）验证状态；并提供 `findings.unknown` 与 `findings.resolve` 对齐 CLI 的完整 unknown/challenge 工具链。
- **完成门禁**：未决 blocker 阻止直接 `complete`；软门禁跳过必须留下原因、风险与补偿动作。
- **最短路径路由**：`route` 与插件工具 `findings.route` 统一支持 `acceptance` 充分性规格，给出 `record-findings`、`resolve-blockers`、`continue-recording`、`run-acceptance` 或 `BLOCKED`，并同步落 `route-check` 检查点。
- **证据收据**：机制写入台账时同步写 SHA-256 收据；`verify` 可发现改行、删行和缺失收据。
- **报告入账与复验**：把报告中的 `findings` 代码块结构化导入，区分 `agent-reported` 与 `lead-verified`。
- **全技能评估与进化闭环**：为全部 10 个内置科研技能配备冻结行为评估矩阵（`evals/skills/`）及 `SKILL.md <= 8192` 字符红线，支持随机 A/B 配对评审、keep/revert 与回滚保护。
- **端到端产物流水线**：内置 `harness-lab/scenarios/pipeline-e2e.mjs`（`npm run test:e2e`），在真实 `cordis` 上下文串通 实验 CSV → `sci-figure` 300dpi 出图 → `latex-paper-en` PDF 编译 → `findings.*` 证据闭环。
- **任务级验收计数**：`acceptance.task` 将 `minFindings` 与 `minObservedRatio` 的统计限定到当前 `REQ-xxxx` / `TASK-xxxx`，便于共享台账。

## 环境与实测边界

- **Node.js >= 22**，并使用支持该插件包与 bundle patch 的 DSH。
- 当前项目实测范围是 **Windows + DSH**；macOS、Linux、其他 DSH 版本以及其他安装布局需要在对应环境重新验收。
- `harness-lab` 用真实 cordis boot、ToolsService 和 SystemPrompt 验证插件契约层，但它不是完整的 DSH UI 端到端测试。
- persona、工具面、技能根等预设组合层在真实 DSH 中变更后，需要完全退出并重启 DSH 再验收。

## 安装

### npm

把 v0.8.0 安装进 DSH 的 `web` profile（使用其他 profile 时替换名称）：

```bash
dsh plugin --profile web add dsh-research-harness@0.8.0
```

只需要独立 CLI 时，也可以全局安装：

```bash
npm install -g dsh-research-harness@0.8.0
```

### GitHub

```bash
dsh plugin --profile web add github:Oseas031/dsh-research-harness#v0.8.0
```

也可以从源码安装 CLI：

```bash
git clone https://github.com/Oseas031/dsh-research-harness.git
cd dsh-research-harness
npm install
npm link
```

`dsh plugin add` 会把包安装进指定 profile，并处理包声明的 `dsh.bundle` patch。**安装、更新或修改预设组合后，完全退出并重启 DSH**，再选择「科研 Harness」。只使用独立 CLI 时不需要重启 DSH。

重启后检查 `findings.record`、`findings.status`、`findings.aggregate`、`findings.challenge`、`findings.route`、`findings.verify`、`findings.gate-skip`、`findings.unknown`、`findings.resolve`、`findings.ingest`、`findings.mark-verified`、`findings.spans`、`alignment.record` 共 13 个工具是否可用，并确认技能 provider 已注册 10 个技能。未全局安装 CLI 时，可在仓库根目录把下文中的 `research-harness` 换成 `node bin/research-harness.mjs`。

## CLI Quickstart

以下命令在**源码仓库根目录**执行，示例台账为当前目录下的 `.research`：

```bash
# 初始化台账
research-harness init --ledger .research

# 记录一条带来源的发现
research-harness record --claim "README 提供 v0.5.0 使用说明" --provenance "README.md:1" --confidence observed --task REQ-0005 --verified-by agent-reported --ledger .research

# 查看统计、未决 blocker 和 route-check 数
research-harness status --ledger .research

# 重算每行 SHA-256 并核对机制收据
research-harness verify --ledger .research

# 根据当前台账决定下一步，并写入 route-check
research-harness route --scale delegate --ledger .research
```

可用 `--acceptance acceptance.json` 给 `route` 传入验收充分性规格，例如：

```json
{
  "minFindings": 1,
  "minObservedRatio": 1,
  "requiredRouteChecks": 1,
  "task": "REQ-0005"
}
```

### 技能进化 Quickstart

先在源码仓库根目录创建实验并计算父本哈希。`--root .` 明确把实验写入当前仓库，而不是全局安装目录：

```bash
research-harness evolve init --name EXP --surface "skills/validate-data/**" --root .
research-harness evolve hash --file skills/validate-data/SKILL.md --root .
```

按 [v0.5.0 进化契约](docs/v05-evolution.md) 准备 `proposal.json`、生成配对 packet 并填写 verdict 后，再执行：

```bash
research-harness evolve apply --name EXP --candidate proposal.json --root .
research-harness evolve select --name EXP --root . --ledger .research
research-harness evolve verify --name EXP --root .
research-harness evolve log --name EXP --root .
research-harness evolve champion --name EXP --root .
```

`apply` 前后及 `select` 前会复核冻结的 `evaluator_id`；发生漂移时拒绝或回滚。候选是完整文件替换，机制不会 import 或执行候选代码。

## 默认数据位置

| 使用方式 | 默认位置 | 覆盖方式 |
|---|---|---|
| DSH 插件 | `~/.dsh/research-harness/`（Windows 通常为 `%USERPROFILE%/.dsh/research-harness/`） | 插件配置 `ledgerRoot`；无法取得 DSH home 时回退到 `./.research` |
| 独立 CLI | 当前工作目录的 `./.research` | `--ledger DIR`，其次 `RESEARCH_LEDGER` 环境变量 |
| 技能进化 | `<root>/.evolve/<name>/` | `--root DIR`；缺省为 CLI 所在包根目录 |

主要产物：

- `ledger.jsonl`：追加式证据、unknown、route-check、完成尝试和 champion 事件。
- `ledger-receipts.jsonl`：与机制写入行对应的 SHA-256 收据。
- `guard-log.jsonl`：守卫拒绝与接线自检留痕。
- `.evolve/<name>/`：`contract.json`、`archive.jsonl`、`archive-receipts.jsonl`、`gens/`、`packets/`、`verdicts/` 和 `backups/`。

收据用于发现台账漂移，**不证明研究结论为真**。旧台账中没有收据的行会计为 `unverified`，不会仅因此被误判为漂移。

## 内置 10 个技能

| 技能 | 用途 |
|---|---|
| `expectation-alignment` | 研究开工前的六层预期对齐、探针与未知项治理 |
| `humanizer-paper` | 中英文学术稿件保真润色与 AI 痕迹检查 |
| `latex-paper-en` | 英文 LaTeX 论文编译、结构、引用、逻辑与格式修复 |
| `latex-thesis-zh` | 中文 LaTeX 学位论文编译、规范、结构与一致性检查 |
| `literature-search-arxiv` | arXiv 检索及 PDF、HTML、LaTeX 源码获取 |
| `nature-polishing` | 学术论文保真润色、翻译、精简与 LaTeX 布局修正 |
| `qu-ai-wei` | 简体中文保真改写与自然化表达 |
| `sci-figure` | 代码生成、可复现、可迭代的科研图件 |
| `scientific-problem-selection` | 科研选题、风险评估与研究路线决策 |
| `validate-data` | 分享前复核分析方法、计算、偏差与结论 |

技能说明以各自 `skills/<name>/SKILL.md` 为准。

## 限制

- v0.5.0 的进化评审是对「技能文本能否引导目标行为」的**配对文本行为评审**，不是运行时 benchmark，也不证明统计意义上的能力增益。
- 进化对象是技能文本；`evals/**`、机制代码、台账与进化谱系等受保护路径不属于可修改 surface。
- 自动长跑、operator 算法库、容器化运行、novelty、多父本合并和 viewer 不在当前版本范围内。
- 本地单测或 harness-lab 结果只代表对应环境，不等同于 npm 发布状态或远端 CI 状态。

## 文档与开发

- [当前机制与文件契约](docs/README.md)
- [v0.5.0 技能进化契约](docs/v05-evolution.md)
- [版本记录](CHANGELOG.md)
- 测试：`npm test`
- harness-lab 真实协议：`npm run test:protocol`（需要本机 DSH 安装）
- 端到端科研流水线：`npm run test:e2e`（需要本机 DSH 安装、Python matplotlib 与 LaTeX 编译器）

## License

[MIT](LICENSE) © 2026 YG
