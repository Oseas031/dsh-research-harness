# Module: Format Check

**Trigger**: format, chktex, lint, 格式检查

## Commands

```bash
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/check_format.py main.tex
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/check_format.py main.tex --strict
```

## Details

Raw script output: PASS / WARN / FAIL with categorized issues.
Skill-layer response: summarize the actionable findings as LaTeX-friendly review comments.
Ensure the document compiles before checking formats iteratively.
Issue categories are best-effort (English-locale chktex message keywords); a non-English chktex locale falls back to a single "other" category without affecting issue counts or severity.
