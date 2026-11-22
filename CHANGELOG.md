# Changelog

本文件记录仓库版本变化。版本号本身不表示 npm 发布或远端 CI 状态；二者以各自的实际记录为准。

## [0.8.1]

### Security & Reliability (P0)

- `lib/guards.js`：`guardPathEscape()` 引入 `realpathSync()` 祖先链 解析，拦截经由符号链接/Junction 的工作区逃逸；`guardBinaryRead()` 改用 `trim()` + `extname()` 阻断尾部空格绕过；对齐 DSH 真实 `apply_patch`（`input`）与新增 `str_replace_editor`（`view|create|str_replace|insert`）守卫；`subagent`/`agent` 扩充 `FORBIDDEN_CHILD_TOOLS` 并校验 `cwd` 越界。
- `lib/completion.js`：移除全量 `gate-skip` 覆盖后的提前 `return null`，继续执行 `verifier.verify(ledger, verifyOpts)` 防止绕过 provenance/文件校验，并在通过时写入 `completion-attempt`（`complete` 或 `complete-with-skips`）以联动重置任务 `repairRounds`。
- `lib/evolve.js`：`surfaceViolation()` 对 `IMPLICIT_EXCLUDES` 采用大小写不敏感匹配，阻断 Windows/macOS 大小写绕过；`Evolver.rollback()` 回写前校验 `evaluator_id` 未漂移且每个目标文件均合法属于 `contract.surface`。
- `lib/skill-provider.js`：`provider.get()` 使用 `realpathSync` 强制校验技能文件位于 `skillsDir` 内，拒绝目录逃逸并返回 `undefined`。
- `lib/evidence-gate.js`、`lib/verifier.js` 与 `lib/index.js`：`validateProvenance()` 支持递归校验 `report:<source> | <inner>`（拒绝 `(report 未标 provenance)` 等占位）；`verifyFileProvenance()` 解包 `report:` 前缀、强制校验工作区内边界与 20MB 文件上限；`lib/index.js` 新增 `enforceReadInsideWorkspace` 开关并向 `completionGate` 透传 `verifyOpts: { workspaceRoot }`。

### Fixed (P1)

- `lib/receipts.js`：`receiptOf()` 与 `verifyLedger()` 兼容 Windows CRLF（`\r\n`）换行，防止换行转换引起误报 `drifted`（同时保持尾随空格篡改可检出）。
- `lib/challenge.js`、`lib/repro.js`、`lib/ledger.js`：`validateChallenge()` 接入 `validateProvenance()`；`validateRepro()` 拒绝非字符串 `subject_digest`；`Ledger.record()` 校验 `repro`，`Ledger.addUnknown()` 强校验 `classification` ∈ `['blocker', 'non-blocker', 'parameterizable']`。
- `lib/spans.js`：为 `redactValue()` 与 `summarizeInput()` 补充字符串内联脱敏（`Bearer`、`ghp_/gho_/ghu_/ghs_/github_pat_`、`sk-`、带密码的 URL）。
- `skills/latex-paper-en/scripts/compile.py` 与 `skills/latex-thesis-zh/scripts/compile.py`：新增 `--timeout`（默认 180 秒，超时退出码 `124`）、`stdin=DEVNULL` 及默认 `MIKTEX_AUTOINSTALL=no`。
- `bin/research-harness.mjs`：通过 `readJsonFile()` 剥离 `--acceptance` 与 `alignment save --file` 输入 JSON 的 UTF-8 BOM。

## [0.8.0]

### Added

- `lib/ledger.js` 与 `lib/route.js` 支持按 `task` 持久化 `repairRounds`（新增 `recordRepairFailure`、`resetRepairRounds`、`repairRoundsOf`），`findings.route` 与 CLI `route --repair-failed --task` 跨会话保留失败轮数并在任务完成后自动归零。
- `lib/aggregate.js` 支持 `maxAgeHours` 时效自动降档：超期 `observed`/`inferred` finding 降为 `todo`（`# TODO stale`、`confidence: 'unknown'`、`stale: true`），`counts` 增 `stale` 计数。
- `lib/evidence-gate.js` 与 `lib/verifier.js` 新增 `verifyFileProvenance()`，在 `verifier.checkFileExists = true` 时校验 `file:line` 引用文件存在且行号不越界。
- 新增 `lib/spans.js`：通过 `guardFn` 放行前 `SpanRecorder.start()` 与 `ctx.on('tools/result')` `end()` 自动收集工具耗时与错误，敏感参数字段脱敏 `[REDACTED]` 并截断至 160 字符，落盘 `spans.jsonl`。
- 新增 `lib/alignment.js`：6 层结构化预期对齐卡校验、`Markdown` 无损持久化和 `syncAlignmentToLedger()`。
- 新增插件工具 `findings.ingest`、`findings.mark-verified`、`findings.spans`、`alignment.record`（总计 13 个注册工具）；CLI 新增 `spans`、`alignment save|read`、`evolve eval`、`evolve rollback`。
- `lib/evolve.js` 新增 `rollback({ gen, toParent, reason, ledger })`（与重放事件流的 `champion()`）以及隔离异步评审执行器 `runEvaluator()`；复用 `lib/verifier.js` 的 `buildSafeEnv` 与 `runAsyncCommand`。
- 新增 `test/v080.test.mjs` 与 `harness-lab/protocol.mjs` `P10` 契约验收。

### Changed

- `lib/ingest.js` 抽取 `ingestMarkdown()` 供 `ingestReport()` 与 `findings.ingest` 工具共用。
- `lib/verifier.js` 导出共享 `buildSafeEnv()`、`killTree()`、`runAsyncCommand()`，消除异步子进程管控逻辑重复。

## [0.7.0]

### Added

- `lib/ledger.js` 新增跨进程排他写入锁 `withLock()`（`wx` 原子建锁 + 僵尸锁自动回收），保证并发写账时 `seq` 单调不冲突、台账与 SHA-256 收据严格对齐。
- `lib/index.js` 新增 `resolveWorkspaceRoot()`、`workspaceSlug()` 与 `resolveLedgerDir()`：默认按会话工作区路径隔离台账（`~/.dsh/research-harness/projects/<slug-hash>/` + `workspace.json`），支持 `projectScope: 'global'` 与显式 `ledgerRoot` 覆盖。
- `lib/guards.js` 新增 `extractPatchPaths()`，支持检查 DSH `apply_patch`（`patchText`）中所有增/改/删/重命名目标路径。
- `lib/verifier.js` 新增 `parseCommandSpec()` 与异步 `verifyAsync()`；CLI 新增 `verify-cmd` 子命令。
- 新增 `test/v070.test.mjs`，覆盖四大 P0 生产级加固及 CI 中全 10 个 `SKILL.md <= 8192` 字符红线门禁。

### Changed

- `lib/verifier.js` 移除 `shell: true`：拒绝含 shell 注入元字符（`VERIFIER_UNSAFE_COMMAND`），强制 `shell: false`、argv 数组传参、宿主敏感环境变量隔离，以及同步/异步分档超时上限与进程树回收。
- `skills/validate-data/SKILL.md` 修复未闭合代码围栏并将冗余模板下沉至 `references/`，正文压回 `7073` 字符（低于 8192 上限，完整保留全部进化评估规则）。

### Fixed

- 修复 `lib/index.js` 原将 `ledgerRoot` 误当作 `workspaceRoot` 传入路径守卫、以及未优先读取 DSH 真实 `exec.arguments` 的问题；`lib/guards.js` 修复相对路径按 `process.cwd()` 而非 `workspaceRoot` 解析的问题、补齐驼峰 `filePath` 识别及 `read` 磁盘真实大小 `statSync` 检测。

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
