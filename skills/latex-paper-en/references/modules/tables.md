# Module: Tables

**Trigger**: table, 表格, 三线表, three-line, booktabs, tabular, data table, generate table, table format

## Commands

```bash
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/check_tables.py main.tex
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/check_tables.py main.tex --fix-suggestions
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/check_tables.py main.tex --json
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/generate_table.py data.csv --style booktabs --bilingual
python3 -B E:/dsh-research-harness/skills/latex-paper-en/scripts/generate_table.py data.json --style booktabs
```

## Details

**check_tables.py**: Scans all `table` / `table*` environments in the document. Checks:
- Three-line rule compliance (toprule / midrule / bottomrule only)
- Vertical line presence in column spec
- Caption position (must precede `\begin{tabular}`)
- Table note format ("Note." or "注：")
- Number precision consistency within columns
- `booktabs` package loaded in preamble
- Direction markers may use Unicode `↑`/`↓`, LaTeX commands such as `\uparrow`/`\downarrow`, or text such as "higher is better". This is a readability recommendation, not a mandatory format.

**generate_table.py**: Converts structured data (CSV or JSON) into publication-ready table code:
1. Markdown preview (stdout)
2. LaTeX `booktabs` code
3. Bilingual caption suggestion (if `--bilingual`)
4. Word conversion tip

Skill-layer response: convert script output into `% TABLES (Line N) [Severity] [Priority]: ...` findings.

See also: [table-guide.md](../formatting/table-guide.md) for the full three-line table specification.
