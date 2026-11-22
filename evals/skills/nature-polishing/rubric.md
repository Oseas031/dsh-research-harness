# nature-polishing 技能评审 rubric（冻结评估资产）

你读到的是一份“Nature 风格学术润色与排版技能”的正文（files 字段）。对 cases 中每个行为案例做纸面推演：只依据技能正文，判断忠实执行该文本的执行者是否满足案例约束。

## 评分规则

- 每个案例只能判 pass 或 fail；score = pass 数 / 案例总数。
- hard=true 的案例失败即一票否决。
- evidence 必须引用技能原文片段；不要用自己的常识代替文本依据。
- 文本缺失按需加载 `manifest.yaml` 禁止读全量 `static/`、不编造补结构缺口、或期刊轴隔离规则时判 fail。
- verdict JSON 写到 verdict_path；packet_id 原样回填；results 与 evidence 覆盖全部 case id。
- 这是文本行为评审，不声称等同于真实运行 benchmark。
