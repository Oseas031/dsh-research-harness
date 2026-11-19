# v0.3 优雅方案参考（避免重复造轮子）

两线：lead 亲验（U 节）+ 子代理调研（OSS 仓库面 / 轻量标准面）。

## 缺口→现成方案映射（lead 已锁定）
| 缺口 | 现成方案 | 出处 | 采纳方式 |
|---|---|---|---|
| ① 聚合指标 | mle-bench：Any Medal % + 3 seeds + mean±SEM | openai/mle-bench README | findings.aggregate() 输出 mean±SEM 式报告 |
| ① 输出文法 | TAP v13：ok/not ok/1..N/Bail out | testanything.org | 聚合报告机器可读行格式 |
| ③ 成本槽 | OTel GenAI usage 词表 | semantic-conventions-genai repo | ledger cost 槽字段名对齐 gen_ai.*（可对接将来 otel 管道） |
| ④ 复现场景 | CORE-Bench 双向任务 | siegelz/core-bench (MIT) | harness-lab 加 Results-to-Code 场景 |
| ② 证据分级 | paper-qa 检索置信 | Future-House/paper-qa (Apache-2.0) | 待子代理回收细化 |

## ev-ref-standards 回收（全官方页原文证实）

| 缺口 | 标准方案 | 字段/文法 | 判定 |
|---|---|---|---|
| ① 聚合输出文法 | TAP v13 | ok\|not ok N Desc # Directive；1..N；TODO/SKIP 降档 | 直接采纳（verdict 枚举 ok/not_ok/todo/skip/bail_out；todo=UNVERIFIED 档） |
| ① 聚合计数 | JUnit XML (junitxml 事实标准) | tests/failures/errors/skipped；rate=1−(f+e)/tests | 直接采纳 |
| ③ 成本槽 | OTel GenAI registry | gen_ai.usage.{input,output,cache_read,cache_write,reasoning.output}_tokens；**官方无 cost 属性**——自留派生 cost_usd/currency | 直接采纳字段名；不引 OTel SDK |
| ④ 复现槽 | SLSA v1.0 predicate | repro:{external_parameters,subject_digest(sha256),build_type,started_on,finished_on,invocation_id} | 直接采纳字段名；不用 level 体系 |
| ② challenger 关系 | CiTO 谓词 |cito:disagreesWith / refutes / usesDataFrom / providesDataFor / citesAsAuthority | 直接采纳谓词 URI 作关系标签 |
| — | PROV-JSON | entity/activity/agent 三元 | 过重不碰（仅借三元命名分类 ledger 条目） |
| — | sigstore bundle | tlogEntries.integratedTime | 过重不碰（freshness 用条目 updated_at） |

## ev-ref-oss 回收（README/LICENSE/源码三重验证）

| 缺口 | 仓库 | 机制 | 许可 |
|---|---|---|---|
| ① 检索置信分级 | Future-House/paper-qa | Gather Evidence：Rank top-k chunks → scored summary → LLM re-score 选最相关 | Apache-2.0 ✓ |
| ① 机器判定 | openai/mle-bench | grade.py 缺列/越界→InvalidSubmissionError；3 seeds + Any Medal % mean±SEM；grading deterministic | MIT ✓ |
| ① 数值容差 | siegelz/core-bench | t 分布 95% 预测区间 t.ppf(0.975,n-1)×std×√(1+1/n)；列表精确比较——免 LLM-judge | MIT ✓ |
| ① 集合型指标 | CherYou/AutoResearchBench | judge→{"is_match":bool,"reason":…}；compute_iou_recall→IoU/recall/precision | Apache-2.0 ✓ |
| ② 挑战者门 | SakanaAI/AI-Scientist | perform_review(num_reflections=5, num_reviews_ensemble=5)→{Overall,Decision,Weaknesses} | 自研 Responsible AI License——**只借机制不抄代码** |
| ③ 成本档 | SakanaAI/AI-Scientist | $15/paper (Claude Sonnet 3.5) 基准 | 同上 |
| ③ 模型分级 | SamuelSchmidgall/AgentLaboratory | 关键实验用大模型、迭代任务用小模型 | MIT ✓ |
| ④ 复现链路 | du-nlp-lab/MLR-Copilot | idea→implementation(retrieved prototype code)→execution 迭代 | **无 LICENSE——只借思想** |

## v0.3 实施定案（四件套合并后的最终映射）

1. **findings.aggregate()**（缺口①）：JUnit 计数（tests/failures/errors/skipped, rate=1−(f+e)/tests）+ TAP 行文法输出 + core-bench t 区间容差（数值型）+ ARB IoU（集合型）+ mle-bench 多 seed mean±SEM；无效条目→InvalidSubmissionError 同型（计 skipped 不计 fail）。
2. **challenger 门**（缺口②）：AI-Scientist perform_review 式 ensemble(5) 审稿 + CiTO 谓词（disagreesWith/refutes）标注反证关系 + verdict 枚举 ok/not_ok/todo(=UNVERIFIED)/skip/bail_out。
3. **成本槽**（缺口③）：ledger 条目 tokens 字段对齐 OTel registry（gen_ai.usage.{input,output,cache_read,cache_write,reasoning.output}_tokens）+ 派生 cost_usd/currency + AgentLab 模型分级建议写进文档。
4. **Results-to-Code 场景**（缺口④）：MLR-Copilot 链路思想 + SLSA 字段（repro:{external_parameters,subject_digest,build_type,started_on,invocation_id}）；CORE-Bench 官方仓仅正向复现——反向场景自建（HAL 扩展待验，不阻塞）。

**许可红线**：Apache-2.0/MIT 仓库可自由借字段名、机制与判定协议；AI-Scientist（自研 Responsible AI）与 MLR-Copilot（无 LICENSE）仅机制参考，一行代码不搬。
