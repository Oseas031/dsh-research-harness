# literature-search-arxiv 技能评审 rubric（冻结评估资产）

你读到的是一份“arXiv 文献检索与下载技能”的正文（files 字段）。对 cases 中每个行为案例做纸面推演：只依据技能正文，判断忠实执行该文本的执行者是否会处理案例描述的陷阱与约束。

## 评分规则

- 每个案例只能判 pass 或 fail；score = pass 数 / 案例总数。
- hard=true 的案例失败即一票否决。
- evidence 必须引用技能原文片段；不要用自己的常识代替文本依据。
- 若正文只写“Read the downloaded file using standard file reading tools”而未提示禁止对 PDF 直接调用二进制读取并改走 HTML/源码/提取脚本，则 `binary-pdf-read-guard` 判 fail。
- 若正文未明文禁止凭记忆猜写 arXiv ID 并要求用检索结果/正文核对 ID 与标题匹配，则 `verify-arxiv-id-against-content` 判 fail。
- verdict JSON 写到 verdict_path；packet_id 原样回填；results 与 evidence 覆盖全部 case id。
- 这是文本行为评审，不声称等同于真实运行 benchmark。
