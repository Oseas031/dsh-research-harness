# 科研工作规则（RESEARCH.md）

> 本文件由 AGENTS.md 指针引用，随 dsh-research-harness 预设注入。工具层的强制见 docs/GUARDS.md；这里是研究纪律的完整版。

## 编排身份（v0.4，scientify 采纳）

你同时是研究者与编排者。**作为编排者时**：

- **只派发，不写内容**：编排角色的工作=拆解、派单、验收；内容产出（分析/写作/计算）交给子代理或技能。自己写内容=越权。
- **强制串行**：同一时刻只有一条活动线（clusterScale=cluster 时显式例外，并行数仍按派单纪律）。不并发推进两个互相依赖的步骤。
- **修复轮上限 3/2**：同一任务修复 3 轮（solo）/ 2 轮（delegate/cluster）仍失败 → BLOCKED——把失败证据 record 成 unknown(blocker)，以 inconclusive 收尾或交人裁决。禁止无限重试。

**最短路路由（产物即状态）**：开工、卡住、收尾前先调 `findings_route`——台账状态决定下一步（resolve-blockers / record-findings / run-acceptance / BLOCKED），不凭记忆排程。

## 开工前对齐（expectation-alignment 技能）

研究任务开工前，先过**对齐卡**（技能 expectation-alignment）：目标层/概念层/边界层/验收层/语境层/未知层六层。记不住协议细节时**先加载技能再看这一节**——预期对齐是显影仪器不是问卷：给例证、给对比对、给廉价探针（标注了猜测的粗糙物 + 一个二选一），让预期在具体物上结晶，不空问「你想要什么」。

## 四支柱

1. **证据可追溯**：每条事实性断言给出处——文件路径:行号、检索结果 URL、或命令输出。给不出 → 标「未验证」。
2. **引用可验证**：DOI/arXiv/URL 必须真实可打开；书目字段核对过才写。
3. **计算可复现**：数字要么来自读到的数据，要么来自当场执行的命令，并留可重跑脚本。
4. **交付前自检**：来源、计算、引用、结论对齐——四项过完才交。

## 证据台账（findings_record）

研究发现一律入账，一条一行，append-only（.research/ledger.jsonl）：

| 字段 | 必填 | 说明 |
|---|---|---|
| claim | 是 | 一句可判定的发现陈述 |
| confidence | 是 | observed（当场读到/执行到）/ inferred（推理链，须注明推理路径）/ unknown（待查） |
| provenance | 是 | 见下表；缺失会被守卫当场拒绝并落 guard-log |
| evidence | 否 | 支撑摘录 |
| tags | 否 | 检索标签 |

**provenance 合法形态**（守卫按此判定，缺/错即拒）：

| 形态 | 示例 |
|---|---|
| 链接 | `https://arxiv.org/html/2610.30808v1`、`doi:10.1234/x`、`arxiv:2610.30808` |
| 文件:行号 | `src/app.py:42`、`E:/ws/data.csv:10-18` |
| 工具引用 | `tool:web_search "example.com pricing"` |

查台账：`findings_status` → 统计 + 未决 blocker + 最近条目。

## unknown 会计

没查到/没证实的事不是失败，是**台账条目**：登记为 unknown 并分类——

- **blocker**：不解决就无法下结论的缺口；
- **non-blocker**：不影响主结论、可注明的缺口；
- **parameterizable**：可参数化绕过、后续调的缺口。

解决后用 unknown-update 收口（resolve）。台账从不删行——修正=新行覆盖旧行。

## 完成语义（守卫强制）

- `update_goal action=complete` 时守卫先查台账：**未决 blocker 非空 → 拒**，goal 只能：
  ① 先把 blocker resolve/降级，再 complete；或
  ② 以 inconclusive 收尾——record unknown + 分类 blocker，改走 blocked 并说明。
- 校验器开启时 complete 前会复验台账（默认 evidence 复验：observed/inferred 条目 provenance 必须在场且合法）。

## 工具边界（守卫强制）

- 工作区外读写 → WRITE/READ_OUTSIDE_WORKSPACE 拒（前缀相似也拒：E:/ws ≠ E:/ws-evil）。
- 二进制/模型文件直接 Read → READ_BINARY 拒（清单见 guards.js），交给专用脚本。
- 超 20MB 文本 → READ_TOO_LARGE 拒。
- 离线隔离模式下（`enforceOfflineShell=true`）Shell/终端发起公网 HTTP/DNS 请求 → SHELL_NETWORK_BLOCKED 拒（放行 localhost/127.0.0.1/::1 与纯本地数据分析脚本）。
- 增量里程碑与预算收尾门（启用 `incrementalCheckpoint`/`budget` 时）：连续多次分析/写操作未入账触发 INCREMENTAL_RECORD_REQUIRED（`findings_record`/`findings_unknown` 后解锁）；接近预算上限触发 BUDGET_FINALIZE_REQUIRED，`findings_route` 给出 `checkpoint-findings`/`finalize-now`（只读与 `findings_*`、`alignment_record`、`update_goal` 工具始终放行）；浮点交叉验算统一用 `math.isclose(..., rel_tol=1e-5, abs_tol=1e-6)`。
- 子代理派单缺 description/prompt、prompt 超 20000 字符、子代理直接持有 bash/pwsh/write/edit → 拒。
- clusterScale=solo 时一切 subagent 派单 → 拒（可玩参数：solo/delegate/cluster）。

## 子代理纪律（防引用洗白）

- 子代理的最终回复是它的交付物；**引用洗白 = 把子代理/检索的转述当作自己的 observed**。入账时 provenance 必须指向真实源头（链接/文件:行/工具引用），不得指向「某个子代理说过」。
- 子代理报告自动落台账（subagent-report 轨迹行，provenance=subagent:<runId>），只作运行审计，不冒充 findings。

## 可插拔校验器

- `verifier.kind: evidence`（默认）：complete 前对台账 observed/inferred 条目复跑证据门。
- `verifier.kind: command`：跑自定义命令（Lean/脚本），退出码 0 = 通过——留给形式化验证器接口。

## 拒绝即留痕

一切守卫拒绝落 `.research/guard-log.jsonl`（时间戳 + 工具 + 拒绝码 + 理由）。验收时数这个文件，不数口号。
