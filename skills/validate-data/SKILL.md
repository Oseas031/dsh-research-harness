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

Input may be a report/conversation, file (markdown, notebook, spreadsheet), SQL queries and results, charts with underlying data, or a methodology summary.

## Workflow

### 1. Review Methodology and Assumptions

Examine:
- **Question framing**: Is the analysis answering the right question or open to misinterpretation?
- **Data selection**: Are the right tables/datasets and time ranges used?
- **Population definition**: Is the analysis population correctly defined without unintended exclusions?
- **Metric definitions**: Are metrics clearly and consistently defined and aligned with stakeholder expectations?
- **Baseline and comparison**: Are time periods, cohort sizes, and contexts comparable?

### 2. Run the Pre-Delivery QA Checklist

Work through the checklist below — data quality, calculation, reasonableness, and presentation checks.

### 3. Check for Common Analytical Pitfalls

Review against the pitfall catalog in `references/validate-data-details-1.md` (join explosion, survivorship bias, incomplete period comparison, denominator shifting, average of averages, timezone mismatches, selection bias).

### 4. Verify Calculations and Aggregations

Spot-check:
- Recalculate key numbers independently
- Verify subtotals sum to totals and percentages sum to ~100% where expected
- Confirm YoY/MoM comparisons use valid base periods and consistent filters across metrics

Apply the result sanity-checking techniques in `references/validate-data-details-1.md` (magnitude checks, cross-validation, red-flag detection).

### 5. Assess Visualizations

If charts are included:
- Check zero baselines (bar charts), consistent scales across panels, and accurate titles
- Flag truncated axes, inconsistent intervals, or distorting 3D effects

### 6. Evaluate Narrative and Conclusions

Check whether conclusions follow from the data, alternative explanations are noted, uncertainty is stated appropriately, and confidence matches evidence strength.

### 7. Suggest Improvements

Provide concrete improvements: additional checks, required caveats, better visualizations, or missing context.

### 8. Generate Confidence Assessment

Rate the analysis on a 3-level scale:

- **Ready to share**: Methodologically sound, calculations verified, caveats noted; no blocking issues.
- **Share with noted caveats**: Largely sound, with specific limitations or assumptions that must be communicated alongside the deliverable.
- **Needs revision**: Specific errors, methodological flaws, or missing analyses must be fixed before sharing (list in priority order).

## Output Format

```
## Validation Report

### Overall Assessment: [Ready to share | Share with caveats | Needs revision]
### Methodology Review
[Approach, data selection, population & definitions]
### Issues Found
1. [Severity: High/Medium/Low] [Issue description and impact]
### Calculation Spot-Checks
- [Metric]: [Verified / Discrepancy found]
### Visualization Review
[Chart or visual presentation issues]
### Suggested Improvements & Required Caveats
- [Actionable fix or caveat required for stakeholders]
```

---

## Pre-Delivery QA Checklist

### Data Quality Checks
- [ ] **Source verification**: Confirmed tables/data sources match the question.
- [ ] **Freshness & completeness**: "As of" date noted; no unexpected time-series or segment gaps.
- [ ] **Null handling**: Checked null rates and documented exclusion/imputation/flagging.
- [ ] **Deduplication & filters**: No double-counting from joins; WHERE filters free of unintended exclusions.

### Calculation Checks
- [ ] **Aggregation logic**: `GROUP BY` includes all non-aggregated columns at the right grain.
- [ ] **Denominator correctness**: Rates/percentages use the intended, consistent, non-zero denominator (clarify full population vs. subset).
- [ ] **Date alignment**: Equal comparison window lengths; partial periods excluded or flagged.
- [ ] **Join & metric consistency**: Appropriate `INNER` vs `LEFT` joins; metric definitions match stakeholder terms; subtotal gaps explained.

### Reasonableness Checks
- [ ] **Magnitude & continuity**: Plausible ranges (non-negative revenue, 0-100% rates) and smooth trends without unexplained jumps.
- [ ] **Cross-reference & edge cases**: Numbers reconcile with dashboards/finance records; checked empty segments and boundary cases.

### Presentation Checks
- [ ] **Chart & number integrity**: Bar charts start at zero; labeled axes; consistent scales, precision, and formatting.
- [ ] **Transparency & reproducibility**: Explicit caveats, date ranges, and documentation sufficient for independent re-execution.

## Examples

```
/validate-data Review this quarterly revenue analysis before I send it to the exec team: [analysis]
/validate-data Check my churn analysis -- comparing Q4 churn rates to Q3 with a shorter Q4 window
/validate-data Here is a SQL query and its conversion funnel results. Does the logic look right? [query + results]
```

## 详细内容（按需读取）

常见分析陷阱清单、合理性核对表、可复现文档与代码注释模板移至 references，需要时再打开：

- [references/validate-data-details-1.md](references/validate-data-details-1.md)

---

## Artifact Consistency, Sampling, and Traceability

Apply these checks before delivery:

- **Reconcile mixed sources before comparing.** Never silently mix different artifacts or runs within one comparison table. Label mixed-source cells or rows and complete reconciliation first; across artifacts, verify A/B labels, group mappings, and seed conventions, recording any alignment or relabeling.
- **Expose sampling risk.** Mark single-sample results and non-reproducible seeds as risks. Fix and record seeds, repeat sampling, and report the interval with explicit lower and upper bounds (or label a bound-only result as such). If recalculation cannot be performed, mark the result `unverified`.
- **Make every finding traceable.** For each finding, cite the source file and line, artifact and run, and exact source cell(s) (table row/column or spreadsheet coordinates). Findings missing this evidence chain remain `unverified`.
- **Independently recompute derived arithmetic.** For every derived ratio, percentage, or multiplier, independently recalculate it from the raw numerator and raw denominator, and retain the raw numerator, raw denominator, and resulting ratio/percentage/multiplier in the evidence record. Never merely repeat arithmetic reported by the analysis; if the raw counts are missing, mark the derived value `unverified`.
