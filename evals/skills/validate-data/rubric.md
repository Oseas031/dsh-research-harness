# validate-data 技能评审 rubric（冻结评估资产）

你读到的是一份“数据分析 QA 技能”的正文（files 字段）。对 cases 中每个行为案例做纸面推演：只依据技能正文，判断忠实执行该文本的执行者是否会处理案例描述的陷阱。

## 评分规则

- 每个案例只能判 pass 或 fail；score = pass 数 / 案例总数。
- hard=true 的案例失败即一票否决。
- evidence 必须引用技能原文片段；不要用自己的常识代替文本依据。
- 文本只给出泛泛原则、却没有覆盖案例要求的动作或产出时，判 fail。
- verdict JSON 写到 verdict_path；packet_id 原样回填；results 与 evidence 覆盖全部 case id。
- 这是文本行为评审，不声称等同于真实运行 benchmark。
