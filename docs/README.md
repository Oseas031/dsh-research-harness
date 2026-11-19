# dsh-research-harness — 科研工作台

> v0.3：证据契约补齐四缺口——聚合指标（findings.aggregate）、挑战者门（findings.challenge）、成本槽（OTel gen_ai.usage 词表）、复现槽（SLSA 字段）。参考与出处：docs/v03-references.md。

一个 DSH 插件 + 独立预设（「科研 Harness」）：**技能是库存，契约是产品。**

## 证据契约闭环（灵魂）

```
研究发现 ──findings.record──▶ 守卫查 provenance
   │缺                          │在场且合法
   ▼                            ▼
当场拒 + guard-log.jsonl    ledger.jsonl 入账（observed/inferred/unknown）
                                  │
              update_goal complete│
                                  ▼
              未决 blocker 非空 → 拒（EVIDENCE_BLOCKERS_OPEN）
              台账落 completion-attempt: inconclusive → goal 走 inconclusive/blocked
```

## 结构

- `lib/guards.js` — 三守卫纯函数 + check() 统一入口
- `lib/evidence-gate.js` — provenance 校验 + findings.record 门控 + subagent 审计监听
- `lib/ledger.js` — append-only 证据台账（ledger.jsonl），unknown 会计（blocker/非 blocker/参数项）
- `lib/completion.js` — 完成语义：blocker 挡 complete，inconclusive 通道
- `lib/verifier.js` — 可插拔校验器（evidence 复验默认；command=Lean 接口）
- `lib/index.js` — apply() 接线：ctx.tools.guard() + ctx.tools.register() + ctx.on(subagent/end)
- `instructions/RESEARCH.md` — 研究纪律全文（AGENTS.md 指针指向它）
- `skills/` — 9 个科研技能；`test/` — node:test 单测 + mock-ctx 契约测试

## clusterScale（可玩参数）

solo（禁一切派单）/ delegate（默认，主从）/ cluster（放开实验）。集群规模不追 136——上游本地证据只有「medium <10 agents」口径。

## 热循环开发（harness-lab）

改完插件代码不用重启 DSH：`E:/dsh-research-harness/harness-lab` 用真实 cordis boot + 真实 ToolsService/SystemPrompt 装配插件本体（绝对路径挂载，改码即生效）。
- `node protocol.mjs` — 9 项完整验收协议（当前 9/9 绿）
- `node lab.mjs scenarios/smoke.mjs` — 自定义场景 runner（模板在 scenarios/）
预设组合层（persona/工具面/技能根）仍需一次 DSH 重启做一次性确认。

## 状态

- v0.3.1（当前）：可移植性修复——技能不再依赖 dsh.patch.yml 里的绝对路径 customSkillDirs，插件在 apply() 里用 import.meta.url 自定位 skills/ 并通过 ctx.skills.registerProvider() 注册 provider（rank=600 与 BUNDLED_SKILL_RANK 对齐）；ledgerRoot 缺省改为 ~/.dsh/research-harness（ctx.dshHomePath），显式配置优先。测试 40/40，harness-lab 协议 11/11（新增 P4：provider 真挂载验收）。
- v0.3.0：verifier evidence 复验链、clusterScale 可玩参数（delegate/solo）、四工具全量（findings.record/status/aggregate/challenge）。
- v0.2.0：契约层四件 + verifier + 接线 + 测试全量落地。
- 已验收：DSH 真会话重启验收（2026-11-18，wired 留痕 + guard-log 双通道）；harness-lab 热循环（真实 cordis Loader + ToolsService，无 DSH 重启）。
- 安装同步见 CHANGELOG；本 README 即真相源。
