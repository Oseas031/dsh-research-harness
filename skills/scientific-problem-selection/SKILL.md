---
name: scientific-problem-selection
description: "Helps scientists choose and steer research problems: pitch and refine a new project idea, evaluate project risks, troubleshoot a stuck project, plan research strategy or navigate decision trees. Typical requests: \"I have an idea for a project\", \"I'm stuck on my research\", \"help me evaluate this project\", \"what should I work on\"."
---

# Scientific Problem Selection Skills

A conversational framework for systematic scientific problem selection based on Fischbach & Walsh's "Problem choice and decision trees in science and engineering" (Cell, 2024).

## Getting Started

Present users with three entry points:

**1) Pitch an idea for a new project** — to work it up together

**2) Share a problem in a current project** — to troubleshoot together

**3) Ask a strategic question** — to navigate the decision tree together

This conversational entry meets scientists where they are and establishes a collaborative tone.

---

## Option 1: Pitch an Idea

### Initial Prompt
Ask: **"Tell me the short version of your idea (1-2 sentences)."**

### Response Approach
After the user shares their idea, return a quick summary (no more than one paragraph) demonstrating understanding. Note the general area of research and rephrase the idea in a way that highlights its kernel—showing alignment and readiness to dive into details.

### Follow-up Prompt
Then ask for more detail: "Now give me a bit more detail. You might include, however briefly or even say where you are unsure:
1. What exactly you want to do
2. How you currently plan to do it
3. If it works, why will it be a big deal
4. What you think are the major risks"

### Workflow
From there, guide the user through the early stages of problem selection and evaluation:
- **Skill 1: Intuition Pumps** - Refine and strengthen the idea
- **Skill 2: Risk Assessment** - Identify and manage project risks
- **Skill 3: Optimization Function** - Define success metrics
- **Skill 4: Parameter Strategy** - Determine what to fix vs. keep flexible

See `references/01-intuition-pumps.md`, `references/02-risk-assessment.md`, `references/03-optimization-function.md`, and `references/04-parameter-strategy.md` for detailed guidance.

---

## Option 2: Troubleshoot a Problem

### Initial Prompt
Ask: **"Tell me a short version of your problem (1-2 sentences or whatever is easy)."**

### Response Approach
After the user shares their problem, return a quick summary (no more than one paragraph) demonstrating understanding. Note the context of the project where the problem occurred and rephrase the problem—highlighting its core essence—so the user knows the situation is understood. Also raise additional questions that seem important to discuss.

### Follow-up Prompt
Then ask: "Now give me a bit more detail. You might include, however briefly:
1. The overall goal of your project (if we have not talked about it before)
2. What exactly went wrong
3. Your current ideas for fixing it"

### Workflow
From there, guide the user through troubleshooting and decision tree navigation:
- **Skill 5: Decision Tree Navigation** - Plan decision points and navigate between execution and strategic thinking
- **Skill 4: Parameter Strategy** - Fix one parameter at a time, let others float
- **Skill 6: Adversity Response** - Frame problems as opportunities for growth
- **Skill 7: Problem Inversion** - Strategies for navigating around obstacles

Always include workarounds that might be useful whether or not the problem can be fixed easily.

See `references/05-decision-tree.md`, `references/06-adversity-planning.md`, `references/07-problem-inversion.md`, and `references/04-parameter-strategy.md` for detailed guidance.

---

## Option 3: Ask a Strategic Question

### Initial Prompt
Ask: **"Tell me the short version of your question (1-2 sentences)."**

### Response Approach
After the user shares their question, return a quick summary (no more than one paragraph) demonstrating understanding. Note the broader context and rephrase the question—highlighting its crux—to confirm alignment with their thinking.

### Follow-up Prompt
Then ask: "Now give me a bit more detail. You might include, however briefly:
1. The setting (i.e., is this about a current or future project)
2. A bit more detail about what you're thinking"

### Workflow
From there, draw on the specific modules from the problem choice framework most appropriate to the question:
- **Skills 1-4** for future project planning (ideation, risk, optimization, parameters)
- **Skills 5-7** for current project navigation (decision trees, adversity, inversion)
- **Skill 8** for communication and synthesis
- **Skill 9** for comprehensive workflow orchestration

See the complete reference materials in the `references/` folder.

---

## Core Framework Concepts

### The Central Insight
**Problem Choice >> Execution Quality**

Even brilliant execution of a mediocre problem yields incremental impact. Good execution of an important problem yields substantial impact.

### The Time Paradox
Scientists typically spend:
- **Days** choosing a problem
- **Years** solving it

This imbalance limits impact. These skills help invest more time choosing wisely.

### Evaluation Axes
**For Evaluating Ideas:**
- **X-axis:** Likelihood of success
- **Y-axis:** Impact if successful

Skills help move ideas rightward (more feasible) and upward (more impactful).

### The Risk Paradox
- Don't avoid risk—befriend it
- No risk = incremental work
- But: Multiple miracles = avoid or refine
- **Balance:** Understood, quantified, manageable risk

### The Parameter Paradox
- Too many fixed = brittleness
- Too few fixed = paralysis
- **Sweet spot:** Fix ONE meaningful constraint

### The Adversity Principle
- Crises are inevitable (don't be surprised)
- Crises are opportune (don't waste them)
- **Strategy:** Fix problem AND upgrade project simultaneously

---

## The 9 Skills Overview

| Skill | Purpose | Output | Time |
|-------|---------|--------|------|
| 1. Intuition Pumps | Generate high-quality research ideas | Problem Ideation Document | ~1 week |
| 2. Risk Assessment | Identify and manage project risks | Risk Assessment Matrix | 3-5 days |
| 3. Optimization Function | Define success metrics | Impact Assessment Document | 2-3 days |
| 4. Parameter Strategy | Decide what to fix vs. keep flexible | Parameter Strategy Document | 2-3 days |
| 5. Decision Tree Navigation | Plan decision points and altitude dance | Decision Tree Map | 2 days |
| 6. Adversity Response | Prepare for crises as opportunities | Adversity Playbook | 2 days |
| 7. Problem Inversion | Navigate around obstacles | Problem Inversion Analysis | 1 day |
| 8. Integration & Synthesis | Synthesize into coherent plan | Project Communication Package | 3-5 days |
| 9. Meta-Framework | Orchestrate complete workflow | Complete Project Package | 1-6 weeks |

---

## Key Design Principles

1. **Conversational Entry** - Meet users where they are with three clear starting points
2. **Thoughtful Interaction** - Ask clarifying questions; low confidence prompts additional input
3. **Literature Integration** - Use PubMed searches at strategic points for validation
4. **Concrete Outputs** - Every skill produces tangible 1-2 page documents
5. **Building Specificity** - Progressive detail emerges through targeted questions
6. **Flexibility** - Skills work independently, sequentially, or iteratively
7. **Scientific Rigor** - Claims about generality and feasibility should be evidence-based

---


## 详细内容（按需读取）

以下章节已移到 references，需要时再打开：

- [references/scientific-problem-selection-details-1.md](references/scientific-problem-selection-details-1.md)
