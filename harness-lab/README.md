# harness-lab — 科研工作台插件的真实协议验收环境

**改完插件代码直接跑，不用重启 DSH。** 每次运行使用真实生产装配路径：

- 真实 cordis Context + Loader（`boot()`，与 DSH profile 同一启动函数）
- 真实 `@deepseek-ai/dsh-tools` ToolsService（官方 guard 链 / definitions / checkGuards）
- 真实 `@deepseek-ai/dsh-system-prompt` SystemPrompt
- 插件入口和仓库根目录从 `import.meta.url` 推导，移动检出目录后无需改码

裸包名经 `bareModuleBaseUrl` 指向 DSH 安装内的 `node_modules`，无需在仓库安装这些生产依赖。

## 环境与运行

需要 Node.js 22 或更高版本，以及一份本机 DSH 安装。运行时会自动探测常见安装位置；也可用环境变量显式指定：

| 变量 | 含义 |
| --- | --- |
| `DSH_BOOT_PATH` | `@deepseek-ai/dsh-app-boot/lib/index.js` 的路径或 file URL；单独设置时会自动推导 `bareModuleBaseUrl` |
| `DSH_BARE_MODULE_BASE_URL` | DSH 安装内 `node_modules` 的路径或 file URL；单独设置时会自动推导 boot 入口 |
| `HARNESS_LAB_LEDGER_DIR` | 可选台账输出目录；默认是随仓库位置推导的 `harness-lab/.research` |
| `DSH_INSTALL_DIR` | 可选 DSH 安装根目录，用于非标准安装位置探测 |

在仓库根目录运行：

```bash
# 完整真实协议（当前 32 项）
npm run test:protocol

# 通用场景；默认每次清空台账
node harness-lab/lab.mjs harness-lab/scenarios/smoke.mjs

# 保留既有台账供检查
node harness-lab/lab.mjs harness-lab/scenarios/smoke.mjs --keep
```

`profile/cordis.yml` 是带占位符的模板。每次运行会在操作系统临时目录生成真实 profile，写入当前仓库的插件入口与台账目录，并在退出时清理。CI 不运行该协议：它需要本机 DSH 生产模块，CI 只执行离线单测与发布包检查。

## 结构

- `runtime.mjs` — 仓库路径推导、DSH 环境变量/本机探测、临时 profile 生命周期
- `profile/cordis.yml` — system-prompt + tools + skill + 插件的可移植模板
- `protocol.mjs` — 32 项真实协议；P8 进化 fixture 也在系统临时目录创建并清理
- `lab.mjs` — 通用场景 runner（boot → definitions → scenario → verdict）
- `scenarios/` — 场景库
- `.research/` — 台账/守卫日志产物（`guard-log.jsonl`、`ledger.jsonl`）

## 验证边界

lab 验证的是**插件契约层**（guard 链、工具注册、台账、完成语义、技能进化），这部分迭代无需重启。预设组合层（persona、工具面、技能根 via `dsh.patch.yml`）仍需在 DSH UI 里确认。
