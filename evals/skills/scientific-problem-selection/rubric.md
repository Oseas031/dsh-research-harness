# scientific-problem-selection 技能评审 rubric（冻结评估资产）

你读到的是一份“科研选题与研究路线决策技能”的正文（files 字段）。对 cases 中每个行为案例做纸面推演：只依据技能正文，判断忠实执行该文本的执行者是否满足案例约束。

## 评分规则

- 每个案例只能判 pass 或 fail；score = pass 数 / 案例总数。
- hard=true 的案例失败即一票否决。
- evidence 必须引用技能原文片段；不要用自己的常识代替文本依据。
- 文本未提供对应路径（Pitch 四问与 Skills 1–4、Troubleshoot 始终给 workarounds 与 Skills 5/4/6/7、Parameter Paradox 固定单一有意义约束）时判 fail。
- verdict JSON 写到 verdict_path；packet_id 原样回填；results 与 evidence 覆盖全部 case id。
- 这是文本行为评审，不声称等同于真实运行 benchmark。
