# 科研工作规则（RESEARCH.md）

> 本文件由 AGENTS.md 指针引用，随 dsh-research-harness 预设注入。工具层的强制见 docs/GUARDS.md；这里是研究纪律的完整版。

## 四支柱

1. **证据可追溯**：每条事实性断言给出处——文件路径:行号、检索结果 URL、或命令输出。给不出 → 标「未验证」。
2. **引用可验证**：DOI/arXiv/URL 必须真实可打开；书目字段核对过才写。
3. **计算可复现**：数字要么来自读到的数据，要么来自当场执行的命令，并留可重跑脚本。
4. **交付前自检**：来源、计算、引用、结论对齐——四项过完才交。

## 证据台账（findings.record）

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

查台账：`findings.status` → 统计 + 未决 blocker + 最近条目。

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
