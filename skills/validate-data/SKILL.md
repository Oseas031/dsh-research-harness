---
name: validate-data
description: "QA a finished analysis before sharing: method, accuracy and bias checks. Use before presenting to stakeholders, to spot-check calculations or aggregation logic, verify SQL results, or judge whether conclusions hold. Raw-file screening: exploratory-data-analysis; test choice: statistical-analysis."
argument-hint: "<analysis to review>"
---

# /validate-data - Validate Analysis Before Sharing

Review an analysis for accuracy, methodology, and potential biases before sharing with stakeholders. Generates a confidence assessment and improvement suggestions.

## Usage

```
/validate-data <analysis to review>
```

The analysis can be:
- A document or report in the conversation
- A file (markdown, notebook, spreadsheet)
- SQL queries and their results
- Charts and their underlying data
- A description of methodology and findings

## Workflow

### 1. Review Methodology and Assumptions

Examine:

- **Question framing**: Is the analysis answering the right question? Could the question be interpreted differently?
- **Data selection**: Are the right tables/datasets being used? Is the time range appropriate?
- **Population definition**: Is the analysis population correctly defined? Are there unintended exclusions?
- **Metric definitions**: Are metrics defined clearly and consistently? Do they match how stakeholders understand them?
- **Baseline and comparison**: Is the comparison fair? Are time periods, cohort sizes, and contexts comparable?

### 2. Run the Pre-Delivery QA Checklist

Work through the checklist below — data quality, calculation, reasonableness, and presentation checks.

### 3. Check for Common Analytical Pitfalls

Systematically review against the detailed pitfall catalog below (join explosion, survivorship bias, incomplete period comparison, denominator shifting, average of averages, timezone mismatches, selection bias).

### 4. Verify Calculations and Aggregations

Where possible, spot-check:

- Recalculate a few key numbers independently
- Verify that subtotals sum to totals
- Check that percentages sum to 100% (or close to it) where expected
- Confirm that YoY/MoM comparisons use the correct base periods
- Validate that filters are applied consistently across all metrics

Apply the result sanity-checking techniques below (magnitude checks, cross-validation, red-flag detection).

### 5. Assess Visualizations

If the analysis includes charts:

- Do axes start at appropriate values (zero for bar charts)?
- Are scales consistent across comparison charts?
- Do chart titles accurately describe what's shown?
- Could the visualization mislead a quick reader?
- Are there truncated axes, inconsistent intervals, or 3D effects that distort perception?

### 6. Evaluate Narrative and Conclusions

Review whether:

- Conclusions are supported by the data shown
- Alternative explanations are acknowledged
- Uncertainty is communicated appropriately
- Recommendations follow logically from findings
- The level of confidence matches the strength of evidence

### 7. Suggest Improvements

Provide specific, actionable suggestions:

- Additional analyses that would strengthen the conclusions
- Caveats or limitations that should be noted
- Better visualizations or framings for key points
- Missing context that stakeholders would want

### 8. Generate Confidence Assessment

Rate the analysis on a 3-level scale:

**Ready to share** -- Analysis is methodologically sound, calculations verified, caveats noted. Minor suggestions for improvement but nothing blocking.

**Share with noted caveats** -- Analysis is largely correct but has specific limitations or assumptions that must be communicated to stakeholders. List the required caveats.

**Needs revision** -- Found specific errors, methodological issues, or missing analyses that should be addressed before sharing. List the required changes with priority order.

## Output Format

```
## Validation Report

### Overall Assessment: [Ready to share | Share with caveats | Needs revision]

### Methodology Review
[Findings about approach, data selection, definitions]

### Issues Found
1. [Severity: High/Medium/Low] [Issue description and impact]
2. ...

### Calculation Spot-Checks
- [Metric]: [Verified / Discrepancy found]
- ...

### Visualization Review
[Any issues with charts or visual presentation]

### Suggested Improvements
1. [Improvement and why it matters]
2. ...

### Required Caveats for Stakeholders
- [Caveat that must be communicated]
- ...
```

---

## Pre-Delivery QA Checklist

Run through this checklist before sharing any analysis with stakeholders.

### Data Quality Checks

- [ ] **Source verification**: Confirmed which tables/data sources were used. Are they the right ones for this question?
- [ ] **Freshness**: Data is current enough for the analysis. Noted the "as of" date.
- [ ] **Completeness**: No unexpected gaps in time series or missing segments.
- [ ] **Null handling**: Checked null rates in key columns. Nulls are handled appropriately (excluded, imputed, or flagged).
- [ ] **Deduplication**: Confirmed no double-counting from bad joins or duplicate source records.
- [ ] **Filter verification**: All WHERE clauses and filters are correct. No unintended exclusions.

### Calculation Checks

- [ ] **Aggregation logic**: GROUP BY includes all non-aggregated columns. Aggregation level matches the analysis grain.
- [ ] **Denominator correctness**: Rate and percentage calculations use the right denominator. Denominators are non-zero.
- [ ] **Date alignment**: Comparisons use the same time period length. Partial periods are excluded or noted.
- [ ] **Join correctness**: JOIN types are appropriate (INNER vs LEFT). Many-to-many joins haven't inflated counts.
- [ ] **Metric definitions**: Metrics match how stakeholders define them. Any deviations are noted.
- [ ] **Subtotals sum**: Parts add up to the whole where expected. If they don't, explain why (e.g., overlap).

### Reasonableness Checks

- [ ] **Magnitude**: Numbers are in a plausible range. Revenue isn't negative. Percentages are between 0-100%.
- [ ] **Trend continuity**: No unexplained jumps or drops in time series.
- [ ] **Cross-reference**: Key numbers match other known sources (dashboards, previous reports, finance data).
- [ ] **Order of magnitude**: Total revenue is in the right ballpark. User counts match known figures.
- [ ] **Edge cases**: What happens at the boundaries? Empty segments, zero-activity periods, new entities.

### Presentation Checks

- [ ] **Chart accuracy**: Bar charts start at zero. Axes are labeled. Scales are consistent across panels.
- [ ] **Number formatting**: Appropriate precision. Consistent currency/percentage formatting. Thousands separators where needed.
- [ ] **Title clarity**: Titles state the insight, not just the metric. Date ranges are specified.
- [ ] **Caveat transparency**: Known limitations and assumptions are stated explicitly.
- [ ] **Reproducibility**: Someone else could recreate this analysis from the documentation provided.

## Documentation Standards for Reproducibility

### Analysis Documentation Template

Every non-trivial analysis should include:

```markdown
## Examples

```
/validate-data Review this quarterly revenue analysis before I send it to the exec team: [analysis]
```

```
/validate-data Check my churn analysis -- I'm comparing Q4 churn rates to Q3 but Q4 has a shorter measurement window
```

```
/validate-data Here's a SQL query and its results for our conversion funnel. Does the logic look right? [query + results]
```


## 详细内容（按需读取）

以下章节已移到 references，需要时再打开：

- [references/validate-data-details-1.md](references/validate-data-details-1.md)

---

## Artifact Consistency, Sampling, and Traceability

Apply these checks before delivery:

- **Reconcile mixed sources before comparing.** Never silently mix different artifacts or runs within one comparison table. Label mixed-source cells or rows and complete reconciliation first; across artifacts, verify A/B labels, group mappings, and seed conventions, recording any alignment or relabeling.
- **Expose sampling risk.** Mark single-sample results and non-reproducible seeds as risks. Fix and record seeds, repeat sampling, and report the interval with explicit lower and upper bounds (or label a bound-only result as such). If recalculation cannot be performed, mark the result `unverified`.
- **Make every finding traceable.** For each finding, cite the source file and line, artifact and run, and exact source cell(s) (table row/column or spreadsheet coordinates). Findings missing this evidence chain remain `unverified`.
- **Independently recompute derived arithmetic.** For every derived ratio, percentage, or multiplier, independently recalculate it from the raw numerator and raw denominator, and retain the raw numerator, raw denominator, and resulting ratio/percentage/multiplier in the evidence record. Never merely repeat arithmetic reported by the analysis; if the raw counts are missing, mark the derived value `unverified`.
