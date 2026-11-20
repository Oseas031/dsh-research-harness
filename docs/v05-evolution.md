# v0.5.0 技能进化闭环（REQ-0004）

## 边界

进化对象是技能文本，不是机制代码。操作者通过 JSON 提案提交完整文件替换；机制不 import、不执行候选代码。默认 surface 为单个技能目录，以下路径始终排除，include 写成 ** 也不能覆盖：

- evals/**：冻结评估资产
- .research/**：研究台账
- lib/**、bin/**、test/**、harness-lab/**：插件机制与协议
- .evolve/**：进化谱系
- instructions/**、docs/**、package.json、dsh.patch.yml

## 文件契约

提案：

{ "id": "candidate-id", "rationale": "证据驱动的修改理由", "mutations": [{ "file": "skills/validate-data/SKILL.md", "new_content": "完整新文件", "expected_parent_sha256": "父本 SHA-256" }] }

每代生成两份 packet。A/B 标签随机分配，packet 不暴露 control/treatment 身份。评审只按 packet 内 rubric 和 cases 写 verdict：

{ "packet_id": "gen1-A", "results": { "case-id": "pass" }, "evidence": { "case-id": "技能原文" } }

选择规则：treatment 必须没有 hard failure；总分高于 control 时 keep。若平分，仅当 treatment 修复了 control 的 hard failure 才 keep，否则恢复父本字节。

## CLI

在插件根目录执行：

node bin/research-harness.mjs evolve init --name EXP --surface "skills/validate-data/**"
node bin/research-harness.mjs evolve hash --file skills/validate-data/SKILL.md
node bin/research-harness.mjs evolve apply --name EXP --candidate proposal.json
node bin/research-harness.mjs evolve select --name EXP --ledger /path/to/.research
node bin/research-harness.mjs evolve log --name EXP
node bin/research-harness.mjs evolve verify --name EXP
node bin/research-harness.mjs evolve champion --name EXP

跨仓库 fixture 可附加 --root DIR。

## 冻结与谱系

init 将 evals/**、lib/**、bin/**、test/**、harness-lab/** 的排序文件内容哈希钉为 evaluator_id。apply 前后及 select 前重验；漂移候选会拒绝或回滚。

实验目录为 .evolve/<name>/：contract.json、archive.jsonl、archive-receipts.jsonl、gens/、packets/、verdicts/、backups/。archive 每行都有 SHA-256 收据。select keep 时可同步向主 Ledger 写 evolve-champion。

## 验收口径

本 PoC 的评审是“技能文本能否引导目标行为”的配对纸面评审，不是运行时 benchmark，也不证明统计意义上的能力增益。自动长跑、operator 算法库、容器、novelty、多父本合并与 viewer 均不在本版本范围。
