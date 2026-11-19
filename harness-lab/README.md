# harness-lab — 科研工作台插件的模拟验收环境

**改完插件代码直接跑，不用重启 DSH。** 每次运行用真实的生产装配路径：

- 真实 cordis Context + Loader（boot()，与 DSH profile 同一启动函数）
- 真实 @deepseek-ai/dsh-tools ToolsService（官方 guard 链 / definitions / checkGuards）
- 真实 @deepseek-ai/dsh-system-prompt SystemPrompt
- 插件本体从 E:/dsh-research-harness/lib/index.js 按绝对路径挂载（改码即生效，下一次进程 import 拿新的）

裸包名经 bareModuleBaseUrl 指向 DSH 安装的 node_modules（官方内嵌者通道），无需 pnpm install。

## 用法

```bash
# 完整验收协议（9 项：挂载/注册/拒/入账/留痕/blocker/resolve）
node protocol.mjs

# 自定义场景（模板见 scenarios/smoke.mjs）
node lab.mjs scenarios/smoke.mjs          # 每次清空 .research
node lab.mjs scenarios/smoke.mjs --keep   # 保留 .research 产物供检查
```

node 路径：C:\Users\ASUS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

## 结构

- profile/cordis.yml — 三条目最小组合：system-prompt + tools + 插件（绝对路径 + config）
- protocol.mjs — 完整验收协议（当前 9/9 绿）
- lab.mjs — 通用场景 runner（boot → defs → scenario → verdict）
- scenarios/ — 场景库
- .research/ — 台账/守卫日志产物（guard-log.jsonl、ledger.jsonl）

## 边界（诚实声明）

lab 验证的是**插件契约层**（guard 链、工具注册、台账、完成语义）——这部分迭代从此零重启。
预设组合层（persona 七条、工具面、技能根 via dsh.patch.yml）仍需一次 DSH 重启在 UI 里确认；
但那是一次性验收，不是迭代成本。
