# 工具契约与守卫（已接线）

守卫纯函数在 `lib/guards.js`，由 `lib/index.js` 的 `apply()` 经 **`ctx.tools.guard()`**（dsh-tools 官方沟槽）挂进预设会话——在 policy 之后、dispatch 之前执行，拒绝返回 `{reason, info}`，拒绝必落 `.research/guard-log.jsonl`。

| 守卫 | 函数 | 拒绝码 | 触发条件 |
|---|---|---|---|
| 二进制读取 | `guardBinaryRead` | `READ_BINARY` / `READ_TOO_LARGE` | 扩展名命中二进制表，或 >20MB |
| 路径越界 | `guardPathEscape` | `WRITE_OUTSIDE_WORKSPACE` / `READ_OUTSIDE_WORKSPACE` | 目标不在 ledgerRoot 工作区内（含 E:/ws vs E:/ws-evil 前缀陷阱） |
| 子代理参数 | `guardAgentParams` | `AGENT_NO_DESCRIPTION` / `AGENT_NO_PROMPT` / `AGENT_PROMPT_TOO_LONG` / `AGENT_FORBIDDEN_TOOLS` | 空描述、空 prompt、>20000 字符、子代理持有 bash/pwsh/write/edit |
| 证据门 | `gateExec` | `EVIDENCE_NO_PROVENANCE` / `EVIDENCE_BAD_PROVENANCE` / `EVIDENCE_BAD_CONFIDENCE` | findings.record 条目缺/坏 provenance，或 confidence 非法 |
| 完成语义 | `completionGate` | `EVIDENCE_BLOCKERS_OPEN` / `EVIDENCE_VERIFY_FAILED` | update_goal complete 时未决 blocker 非空，或校验器复验失败 |
| 档位纪律 | （guard 内联） | `SCALE_SOLO_NO_DELEGATION` | clusterScale=solo 时调用 subagent |

统一入口 `check(tool, args, ctx)` → `null`（放行）或 `{code, reason}`（拒绝）；接线层另有 findings.record / findings.status 两个注册工具（`ctx.tools.register`，带 output schema 与 render）。

## 验收（可判定）

1. `node --test test/` 全绿（纯函数 + mock-ctx 契约测试）。
2. 真预设会话里：`findings.record` 一条无 provenance 条目 → 模型收到拒绝 + `.research/guard-log.jsonl` 多一行 `EVIDENCE_NO_PROVENANCE`；补 provenance 重发 → `ledger.jsonl` 多一行 finding。
3. 台账登记 blocker → `update_goal complete` 被拒（`EVIDENCE_BLOCKERS_OPEN`）且 ledger 落一条 `completion-attempt: inconclusive`；resolve 后 complete 放行。

## DSH 原生兜底层（叠加可用）

1. `@deepseek-ai/dsh-sandbox-policy`：workspace-write 沙箱（bash/fs/terminal 共同消费）。
2. `@deepseek-ai/dsh-fs-observation-policy`：读后写（FS_NOT_OBSERVED / FS_STALE_VERSION）。
3. persona 规则 ①-⑦（上下文层，见 dsh.patch.yml）。
