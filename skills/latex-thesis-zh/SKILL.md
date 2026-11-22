---
name: latex-thesis-zh
description: 中文 LaTeX 学位论文助手，面向已有 .tex 硕博论文工程：XeLaTeX 编译诊断、GB/T 7714、模板识别、格式与公式断行、双语题注与长表、章节结构、术语一致性、逻辑与文献综述、方法与工程应用章、标题优化、去 AI 味、主张前置、单元润色与漂移核对、盲审版、对照学校规范终检。触发：毕业论文、学位论文、硕博论文。英文论文用 latex-paper-en，审稿总评用 nature-reviewer。
metadata:
  category: academic-writing
  tags:
    [
      latex,
      thesis,
      chinese,
      phd,
      master,
      xelatex,
      gb7714,
      thuthesis,
      pkuthss,
      compilation,
      bibliography,
      structure,
    ]
  version: "6.0.0"
  last_updated: "2026-09-20"
argument-hint: "[main.tex] [--section SECTION] [--module MODULE]"
allowed-tools: Read, Glob, Grep, Bash(python3 *)
---

# LaTeX 中文学位论文助手

处理已有中文 LaTeX 学位论文项目中的定向问题：先判断最小匹配模块，再运行对应脚本，最后以论文审阅友好的格式返回问题和建议。

## Capability Summary

- 编译诊断（XeLaTeX/LuaLaTeX/latexmk）、格式与 GB/T 7714、公式编号与断行、双语题注及图表编译页版式、章节结构、模板识别、术语一致性。
- 审阅逻辑连贯性、文献综述（主题簇->代表文献归因->综合比较）、标题架构、章引言/分章型小结、方法/工程应用章、实验章节、中文句间表达与 AI 痕迹。
- 针对绪论/方法/实验/摘要多组件关系、展示与统计口径、摘要-创新点-结论对齐提供证据保真的主线式改写建议。
- 定稿对照学校规范清单（如燕山大学 2024 版）逐项终检；盲审版个人信息隐匿。
- 全程不破坏引用、标签和数学环境。

## Triggering

用户拥有现有中文 `.tex` 学位论文项目，且请求涉及：编译失败/工具链不确定；格式、国标或学校模板检查；公式编号被挤到下一行、长公式拆行；章节结构或模板识别；术语/缩略语一致性；逻辑连贯、文献综述质量、导语完整性、标题架构、跨章节闭合；绪论漏斗、章引言、本章小结、方法动机/设计/优势、实验讨论分层；标题优化、去 AI 化；定稿对照学校规范逐项终检；盲审版生成。即使只提到单一问题（如“判断是不是 thuthesis”“按 GB/T 7714 看参考文献”）也应触发。

## Do Not Use

- 英文会议/期刊论文（用 `latex-paper-en`）；Typst 项目
- 仅有 DOCX/PDF、没有 LaTeX 源文件；纯文献调研；从零写一篇学位论文
- 多维度审稿、评分或投稿门控检查（用 `nature-reviewer`）

## 路由规则

- 自动推断模块，不默认追问“你想用哪个模块”。多目标请求按固定顺序串行执行：`template` -> `compile` -> `format` -> `structure` / `consistency` -> `bibliography` / `references` -> `logic` / `literature` -> `experiment` / `title` / `expression` / `deai` / `claim-forward` / `polish` / `tables` / `abstract` / `conclusion`。
- 多轮润色按“论证/逻辑 -> 句子结构 -> 词汇/排版”由粗到细，顺序不可颠倒（详见 `references/writing/writing-philosophy-zh.md`）。
- “润色这段/这一节/把第 X 章语言润色一下”走 `polish`；整章或全文先 `--plan`，逐单元改写并 `--verify`。只要求检查或审校时仅诊断。保留原有标题、事实及结论强度，邻域只读；详见 `references/writing/unit-polish-zh.md`。
- 常见歧义速判：交叉引用/编号断档或题注缺失走 `references`（条目本身走 `bibliography`）；表格题注位置和三线表结构走 `tables`；续图、子题注、长表留白、图像有效 ppi 或编译页图表版式走 `format`，并按需读取 caption/table/compile 指南；公式断行走 `format`（`\label`/`\eqref` 问题走 `references`，标题后直入公式走 `logic`）；标题架构串行 `structure` -> `title --headings`；章引言段式（一段还是两段）走 `logic --chapter-intro-style` 并读 thesis-writing-guide 段式选型，章引言/分章型小结/主线闭合走 `logic`；各级段落职责/结构重复走 `logic --paragraph-roles`（读 paragraph-roles-zh）；工程应用/系统实现章按正文走 `logic` 并读取工程章指南，不能凭章号运行 `--per-chapter`；文献主题综合与代表归因走 `literature`；摘要多组件关系走 `abstract`；结果分析深度及展示/统计口径走 `experiment --results-analysis`（论断强度语义复核读 over-claim-guard，AI 痕迹走 `deai`）；结论章内容/展望走 `conclusion`（结论格式——`\cite`/字数/模糊措辞——走 `spec-check`）；规范终检走 `spec-check`；盲审匿名走 `blind-review`；口语化/绝对化词汇/搭配不当/标点混用/冒号或分号堆叠/数值单位写法/单句过长走 `expression`（冒号/分号句间逻辑只由 `[LLM]` 按 academic-style-zh §5.4 判断；段落论证走 `logic`，AI 痕迹与句长均匀度走 `deai`，人称走 `abstract`，论断强度走 over-claim-guard）。完整判据与各模块专用旗标见 `references/modules/routing-rules.md`。
- 主张后置/自我削弱（先说本文不做什么、遗憾的是、仍明显落后于、hedge 堆叠、结论末段负面收尾）走 `claim-forward`：只调顺序与搭配，绝不删除限制或不利对比；加强措辞只抬到 `references/writing/over-claim-guard.md` 证据阶梯已支撑的一级。摘要痛点词归 `abstract`，`不是 X 而是 Y` 壳归 `deai`。
- 项目术语治理、缩写体例和程度词只在显式开关下运行：`check_consistency.py --governance --custom-terms FILE` 读取同一 JSON 的 banned/locked/exempt，不改旧同义组路径；`--abbreviation-style` 与治理开关独立；`check_style_zh.py --degree-wording` 默认关闭。这三项只给 `[Script]`、Info/P3、`Meaning-Check: NEEDS-LLM` 的局部候选，不输出整句替换；不传开关时原输出不变。
- 学院数字、公式、表身和中文题注只在 `--school yanshan-ee-2025` 下运行，入口是 `check_style_zh.py`、`check_format.py`、`check_tables.py` 和 `check_references.py`；默认和 `--school generic` 不新增候选，也不接受单独的 `yanshan`。候选为 `[Script]`、Info/P3、`Meaning-Check: NEEDS-LLM`，只给局部位置，不改写数学。
- 引文位置、重复引用页码、学院著录提示和综述递进密度只在显式开关下运行：`check_references.py --author-cite` 与 `--repeat-cite` 相互独立，也可与 `--school` 组合；`verify_bib.py --college-details` 只能与 `--standard gb7714` 或 `gb7714-2025` 同时使用；`analyze_literature.py --progression-density` 可与 `--section` 组合，且与 `--intro-citations` 互斥。候选为 `[Script]`、Info/P3、`Meaning-Check: NEEDS-LLM`，只给局部位置、键或字段，不输出替换句，不改写引用键。不传这些开关时原输出不变。
- 同章结果表、正文和本章小结的终值只由 `analyze_experiment.py --cross-surface` 核对，可与 `--section` 组合；`--cross-surface-terms FILE` 只能与该开关同时使用，且只替换指标或评价集词表。候选为 `[Script]`、Info/P3、`Meaning-Check: NEEDS-LLM`，只给局部位置，不输出修正数字；不传 `--cross-surface` 时原输出不变，`--results-analysis` 的既有九码保持独立。
- 学院 2025 格式审查清单见 `templates/yanshan-ee-2025.md`，命令用 `--template yanshan-ee-2025`，与研究生院 `yanshan` 并存；111 个状态不是 111 项已合规，`script:third_person` 只给 NEEDS-LLM 词位候选，MODULE 行只打印供人工运行的命令，局部 checker 不能把复合项判为 PASS。
- 方法段出现张量、交换轴或 Concat 时走 `logic`，读 `references/writing/method-description-guide-zh.md` 的方法叙述表达约束。判断只由 `[LLM]` 完成，不新增脚本码。
- 正文用词与架构图标注不一致时，走 `logic` 并按同一指南做方法一致核读。不静默改模型名或受保护术语。
- 弱点被写成优点时走 `claim-forward`，读 `references/writing/claim-forward-zh.md` 的三类处置。不删除不利结果，不把未验证弱点写成设计优点。
- 删去预告后“上述”没有先行词时走 `logic`，读 `references/writing/paragraph-roles-zh.md`。补最短桥接，不把删掉的预告贴回去，也不改写合法的“首先/其次”。
- 摘要引号走 `abstract`，读 `references/writing/abstract-structure.md`。中文引语用成对 U+201C 与 U+201D，英文摘要用英文标点。引语的措辞、数学和引用键保持不变。
- 标题或章节安排句中的公式符号走 `structure`，读 `references/writing/structure-guide.md` 与 `references/writing/introduction-guide-zh.md`。该检查不改正文数学、受保护术语或模型名。
- 脚本失败时，先返回精确命令、退出码和关键报错，再给出最小下一步，不静默切换模块。

## Required Inputs

- 论文入口文件，例如 `main.tex`（多文件工程自动解析 `\input`/`\include`）。
- 可选：`--section SECTION`（英文键与中文章节名均可）、bibliography 路径、学校/模板上下文（`thuthesis`、`pkuthss` 等）。
- 可选的编辑轴（仅改写类模块），两轴正交，不是同一条阶梯：
  - `--goal grammar|clarity|concision|coherence` —— 这次编辑要解决什么（默认 `grammar`）。
  - `--strength minimal|moderate|restructure` —— 允许改到多深（默认 `minimal`，即能解决问题的最小改动）。
  - `--tier light|medium|heavy` 与二者无关：它是 `deai` 的检测灵敏度，绝不用作编辑幅度控制。
- 参数不完整时，保留已推断模块，只追问缺失项，不额外扩展问题。编辑目标、编辑幅度、作者原意只在答案会改变本次编辑时才追问，不得变成固定问卷。

## Output Contract

- 用 LaTeX 友好的审阅格式返回问题：`% MODULE (L##) [Severity] [Priority]: ...`；多文件工程定位为 `源文件:行号`（如 `chapters/chap01.tex:12`）。
- 明确给出执行的命令；脚本失败必须报告退出码和关键 stderr。
- “检查结果”和“建议改写”分开陈述；默认保留 `\cite{}`、`\ref{}`、`\label{}`、数学环境、参考文献键和模板宏命令。
- `literature` 模块默认只给诊断与重写蓝图，用户明确要求才给段落级改写。

### Rewrite Contract

仅适用于产出可直接替换原文的具体文本的模块：`expression`。纯诊断模块保持原有挑错格式；契约适用范围三分法（纳入 / 仅 LLM 层 / 排除）逐项列在 `references/modules/routing-rules.md`。

每个改写块追加以下四个字段（字段名保持英文标识符，说明文本用中文）：

```latex
% Changed:       <脚本可验证的变更事实，或 none>
% Protected:     <本行内被识别并跳过的受保护 token，或 none>
% Meaning-Check: <PRESERVED | NEEDS-LLM>
% Risk-Flags:    <none | not-assessed | lexical-substitution | whitespace-normalized | overstatement | ambiguity | terminology-drift | invented-claim>
```

- `[Script]` 层：`Meaning-Check` 恒为 `NEEDS-LLM`。规则脚本没有语义判定能力，因此 `[Script]` 绝不得输出 `Meaning-Check: PRESERVED`。只允许置规则可确定的标记 `none`、`not-assessed`、`lexical-substitution`、`whitespace-normalized`；无其他可确定标记时兜底置 `not-assessed`。
- `[LLM]` 层：可置 `Meaning-Check: PRESERVED` 与闭集内任一标记，但 `PRESERVED` 是待作者核对的**提案**，不是已验证的事实。
- 改写不得升高措辞强度。强度发生变化时置 `Risk-Flags: overstatement`；判据见 `references/writing/over-claim-guard.md`，各润色模块文档均有指针。
- `deai` 产出的是行为指令而非替换文本；LLM 依其指令产出的改写适用 `[LLM]` 层契约。`claim-forward` 同属仅 LLM 层：脚本只给 `Candidate:` 提案与 `Meaning-Check: NEEDS-LLM`，四字段由 LLM 改写块补齐。
- `polish` 同属仅 `[LLM]` 层：清单与核对脚本不产出替换文本，核对恒为 `Meaning-Check: NEEDS-LLM`；完整单元润色稿由 `[LLM]` 补齐四字段，并附三类修改说明与核对摘要。

## Workflow

1. Parse `$ARGUMENTS`，锁定入口文件并推断模块；缺参数只追问缺失项。
2. 多模块请求按“路由规则”顺序串行执行，分模块回报；template 与 structure 都不明时先 `template`。
3. Read the one reference file tied to that module (see "Read next" column).
4. Run the corresponding script with `python3 <skill-dir>/scripts/<script>.py`.
5. Return findings as `% Module (L##) [Severity] [Priority]: ...`. Report exact command and exit code on failure.

## 跨工具执行

frontmatter 中的 `allowed-tools` 是 Claude 兼容元数据，不是其他平台的强制权限列表。把本技能的读 / 搜索 / 执行 / 委派需求映射到当前会话已有的能力。脚本与语义契约不依赖 `Read`、`Glob`、`Grep`、`Bash` 或 `Task` 这些字面名称。

当前会话若有原生委派，仅在本工具确实生成了独立子代理时使用。若无原生委派，则在同一代理内顺序完成相同检查，并如实说明。不得声称本会话未提供的能力。

根因分析、学术判断、严重度和最终验收由主智能体负责。子智能体沿用当前配置的模型，不按角色另选模型。


## 详细内容（按需读取）

以下章节已移到 references，需要时再打开：

- [references/latex-thesis-zh-details-1.md](references/latex-thesis-zh-details-1.md)
