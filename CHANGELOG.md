# Changelog

本文件记录仓库版本变化。版本号本身不表示 npm 发布或远端 CI 状态；二者以各自的实际记录为准。

## [0.6.0]

### Added

- 插件侧新增 `findings.unknown` 与 `findings.resolve` 工具（支持解决 unknown 与 challenge），对齐 CLI 工具能力面（共 9 个工具）。
- `evals/skills/` 补齐其余 9 个科研技能的冻结行为评估案例与 rubric（达成 10/10 全技能覆盖）。
- 新增 `harness-lab/scenarios/pipeline-e2e.mjs`（`npm run test:e2e`）：验证 实验 CSV → `sci-figure/render.py` 300dpi PNG/SVG → `latex-paper-en/compile.py` PDF → DSH 9 工具闭环的完整产物流水线。
- 新增 `test/v060.test.mjs`，覆盖版本对齐、全工具 schema 规范、10/10 评估资产校验与技能目录零硬编码卫生红线。
- CLI 新增 `--version` / `-v` / `version` 命令。

### Changed

- `lib/index.js` 从 `package.json` 动态读取 `PKG_VERSION` 写入 `wired` 日志（消除硬编码旧版本号滞后）；`findings.record` 支持 `verifiedBy`，`findings.route` 支持 `acceptance` 充分性规格并同步落 `route-check`。
- 清除 `skills/` 目录下所有硬编码本机开发路径（改为 `<skill-dir>/` 与 `check_spec.py` 运行时动态拼接 `_SCRIPTS_DIR`）。
- 升级 `skills/literature-search-arxiv/SKILL.md`（经 `arxiv-v060` 配对进化闭环验证）：明确禁止对 PDF 直接调用二进制读取、优先 HTML/LaTeX 源码或专用提取脚本，并严禁凭记忆猜写 arXiv ID。

### Fixed

- 修复 `skills/sci-figure/render.py` 硬编码 `python3` 在 Windows 环境渲染失败的问题（改用 `sys.executable`），并修正 `skills/sci-figure/SKILL.md` 的反引号嵌套笔误。

## [0.5.0]

### Added

- 新增技能进化闭环：完整文件提案、surface 保护、冻结 `evaluator_id`、随机 A/B 配对评审、keep/revert、父本回滚与谱系记录。
- 新增 `evolve init/hash/apply/select/log/verify/champion` CLI；实验产物包含 `archive.jsonl`、SHA-256 收据、配对 packet、verdict 与 backups。
- 新增 `evals/skills/` 冻结行为案例与 rubric，以及 [v0.5.0 进化契约](docs/v05-evolution.md)。
- 补充新手根 README、当前机制真相源和版本记录。
- 新增 Node 22/24 单测与包内容 CI；发布包显式收录可移植 harness-lab。

### Changed

- `route` 的 `acceptance.task` 支持按当前任务限定 findings/observed 统计；`requiredRouteChecks` 仍按整个台账计数。
- keep 时可将 `evolve-champion` 写入主 Ledger，便于追踪当前 champion。
- harness-lab 改为从 `import.meta.url` 推导仓库根，支持环境变量指定 DSH，不再绑定固定用户目录。

### Fixed

- `npm test` 改用 Node 支持的 `test/*.test.mjs` glob，标准测试入口可直接运行。
- 评估器树哈希在任意深度排除 `.research`、`.evolve` 与 `node_modules`，避免 lab 运行日志造成假漂移。

### Boundaries

- 当前进化验收是技能文本的配对行为评审，不是运行时 benchmark，不据此声称统计意义上的能力提升。

## [0.4.1]

- 新增 `research-harness` CLI，让任意会话或裸 shell 使用与插件相同的 Ledger 实现；`route` 调用会写 `route-check`。
- 新增报告 `findings` 块结构化入账，以及 `agent-reported` → `lead-verified` 的验证升级。
- `route` 新增 `minFindings`、`minObservedRatio`、`requiredRouteChecks` 验收充分性规格；缺省行为保持兼容。
- `expectation-alignment` 增加对齐卡持久化规约与 `adopt/reject/reframe` 探针 verdict。

## [0.4.0]

- 新增台账 SHA-256 收据和 `verify` 漂移检查；旧行以 `unverified` 表示。
- 新增基于台账状态的最短路径路由、修复轮上限和可追溯的软门禁跳过。
- finding 新增 `task` 字段，并校验 `REQ-xxxx` / `TASK-xxxx` 格式。
- 新增第 10 个技能 `expectation-alignment`。
