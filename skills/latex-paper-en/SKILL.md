---
name: latex-paper-en
description: "Existing English LaTeX papers (.tex): compile repair, venue formatting, citation checks, section writing, logic and related work, tables, pseudocode, de-AI polish, claim-forward fixes, 换投. Chinese theses: latex-thesis-zh; prose 中译英: nature-polishing; self-review: nature-reviewer."
metadata:
  category: academic-writing
  tags:
    [
      latex,
      paper,
      english,
      ieee,
      acm,
      springer,
      neurips,
      icml,
      compilation,
      grammar,
      bibliography,
      figures,
      pseudocode,
      algorithmicx,
      algpseudocodex,
    ]
  version: "6.0.0"
  last_updated: "2026-09-13"
argument-hint: "[main.tex] [--section SECTION] [--module MODULE]"
allowed-tools: Read, Glob, Grep, Bash(python3 *)
---

# LaTeX Academic Paper Assistant (English)

Use this skill for targeted work on an existing English LaTeX paper project. Keep the workflow low-friction: identify the right module, run the smallest useful check, and return actionable comments in LaTeX-friendly review format.

## Capability Summary

- Compile/diagnose LaTeX builds; audit formatting, bibliography, grammar, sentences, logic, figures, tables, captions, and pseudocode.
- Diagnose and rewrite-plan literature reviews (synthesis, comparison, gap derivation) and specific sections (paragraph roles, outlines, claim-evidence maps, self-review).
- Improve expression, translate academic prose, optimize titles, reduce AI-writing traces, and review experiment sections without touching citations, labels, or math.

## Triggering

Use when the user has an existing English `.tex` paper project and wants: compile/build fixes; format or venue compliance; bibliography/citation validation; grammar, sentence, logic, or expression review; literature-review restructuring or gap derivation; section drafting/rewrite planning (Abstract through Conclusion); translation; title optimization; figure/table/caption checks; pseudocode review; de-AI editing; or experiment-section analysis.

## Do Not Use

Not for: drafting a paper from scratch; literature research without a paper project; Chinese thesis structure/template work; Typst-first workflows; DOCX/PDF conversion without LaTeX source; multi-perspective review or scoring/gate decisions (use `nature-reviewer`); standalone algorithm design.

## Routing Rules

- Infer the module from the request; ask only when two or more modules are equally plausible. Run 2-3 compatible checks sequentially in this order: `compile` -> `bibliography` -> `format` -> `figures` / `tables` / `caption` / `pseudocode` -> `grammar` / `sentences` / `deai` / `claim-forward` -> `logic` / `literature` / `experiment` / `abstract` -> `section-writing` -> `title` / `expression` / `translation` / `adapt`. Polish coarse-to-fine (logic -> sentences -> lexical); never reverse.
- `logic` for cross-section alignment / funnel / contribution drift (add `--motivation-thread` for whole-paper promise/closure maps); `literature` only for Related Work organization or gap derivation; `experiment` for results/discussion/baseline/ablation concerns even when phrased as "logic"; `section-writing` for drafting/rewrite plans (load its module doc plus exactly one guide from `references/writing/section-writing/`).
- `deai --tier light|medium|heavy` gives graded D1-D5 dimension analysis; omit `--tier` for defaults.
- `claim-forward` for under-claiming (claim after caveat, self-weakening words, hedge stacks, negative close); it reorders and rewords only and never deletes a limitation — strengthen wording only up to the evidence rung in `references/evidence/over-claim-guard.md`.
- On script failure: stop, report the exact command and exit code, and suggest the smallest fallback — do not silently switch modules.
- Full decision notes: `references/modules/routing-rules.md`.

## Required Inputs

- `main.tex` or the paper entrypoint.
- Optional `--section SECTION` when the request is section-specific.
- Optional bibliography path when the request targets references.
- Optional venue/context when the user cares about IEEE, ACM, Springer, NeurIPS, or ICML conventions.
- Optional edit axes for rewrite modules — two orthogonal axes, never a single ladder:
  - `--goal grammar|clarity|concision|coherence` — what the edit is for (default `grammar`).
  - `--strength minimal|moderate|restructure` — how far the edit may go (default `minimal`, the smallest change that solves the task).
  - `--tier light|medium|heavy` is unrelated: it is `deai` detection sensitivity, never an edit-strength control.

If arguments are missing, preserve the inferred module and ask only for the missing file path, section, bibliography path, or venue context. Ask about goal, strength, or author intent only when the answer would change this edit — never as a fixed questionnaire.

## Output Contract

- Return findings in LaTeX diff-comment style whenever possible: `% MODULE (Line N) [Severity] [Priority]: Issue ...`; keep comments surgical and source-aware.
- Report the exact command used and the exit code when a script fails.
- Preserve `\cite{}`, `\ref{}`, `\label{}`, custom macros, and math environments unless the user explicitly asks for source edits.
- Module-specific contracts for `literature` and `section-writing`: see `references/modules/routing-rules.md`.

### Rewrite Contract

Applies only to modules that emit concrete replacement text: `expression`, `grammar`, `sentences`, `translation`. Diagnostic-only modules keep the plain finding format; the full three-way scope split (contract / LLM-layer-only / excluded) is listed in `references/modules/routing-rules.md`.

Append these four fields to every rewrite block:

```latex
% Changed:       <verifiable edit facts, or none>
% Protected:     <protected tokens skipped on this line, or none>
% Meaning-Check: <PRESERVED | NEEDS-LLM>
% Risk-Flags:    <none | not-assessed | lexical-substitution | whitespace-normalized | overstatement | ambiguity | terminology-drift | invented-claim>
```

- `[Script]` layer: `Meaning-Check` is always `NEEDS-LLM`. A rule engine cannot judge meaning, so `[Script]` must never emit `Meaning-Check: PRESERVED`. It may set only the rule-determinable flags `none`, `not-assessed`, `lexical-substitution`, `whitespace-normalized`, and falls back to `not-assessed` when nothing else is determinable.
- `[LLM]` layer: may set `Meaning-Check: PRESERVED` and any flag in the closed set, but `PRESERVED` is a proposal the author must still verify, never a verified fact.
- A rewrite must never raise claim strength. When strength changes, set `Risk-Flags: overstatement`; the judgement criteria live in `references/evidence/over-claim-guard.md`, linked from each polish module doc.
- `deai` emits behavioural instructions, not replacement text; a rewrite the LLM derives from them falls under the `[LLM]` layer.

## Workflow

1. Parse `$ARGUMENTS`, infer the smallest matching module, and keep that inference unless the user redirects.
2. Read only the reference file for that module; run its script with `python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/<script>.py`.
3. For multiple compatible concerns, run in routing order and group output by module.
4. Summarize issues, fixes, and blockers in LaTeX-friendly comments; switch modules for new concerns instead of overloading one run.

## Example Requests

- “Compile my IEEE paper and tell me why `main.tex` still fails after BibTeX.”
- “Rewrite the related work so it reads like a synthesis instead of a paper-by-paper list, but keep all citation anchors intact.”
- “Review the experiments section for overclaiming, missing ablations, and weak baseline comparisons.”

See `examples/` for complete request-to-command walkthroughs.

## 详细内容（按需读取）

以下章节已移到 references，需要时再打开：

- [references/latex-paper-en-details-1.md](references/latex-paper-en-details-1.md)
