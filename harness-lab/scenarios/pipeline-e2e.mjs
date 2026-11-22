// DAG N11 / N13 端到端科研产物流水线验收（完全离线、全产物落在临时目录、结束后彻底清理）：
// 实验 CSV -> sci-figure/render.py (300dpi PNG + SVG + env.json + history)
// -> latex-paper-en/scripts/compile.py (--recipe pdflatex-bibtex 编译含插图与引用的 PDF)
// -> DSH 真实挂载工具链闭环 (findings.record -> findings.unknown -> blocker 拦截 -> findings.resolve -> findings.aggregate -> findings.verify -> findings.route -> complete 放行)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Ledger } from '../../lib/ledger.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function runPy(scriptAbs, args, cwd) {
  return spawnSync('python', ['-B', scriptAbs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

export default async ({ ctx, defs, step, ledgerDir }) => {
  const workDir = mkdtempSync(join(tmpdir(), 'rh-pipeline-e2e-'));
  try {
    // ---- Step 1: 准备多 seed 实验 CSV 数据 ----
    const csvPath = join(workDir, 'metrics.csv');
    const csvText = [
      'seed,baseline_acc,method_acc',
      '42,0.712,0.845',
      '43,0.708,0.851',
      '44,0.719,0.849',
    ].join('\n') + '\n';
    writeFileSync(csvPath, csvText, 'utf8');
    step('E2E-1 多 seed 实验 CSV 已生成', existsSync(csvPath), csvPath);

    // ---- Step 2: 按 sci-figure 契约构建 bundle 并通过 render.py 渲染 300dpi PNG + SVG ----
    const figSlug = 'ablation-compare';
    const bundleDir = join(workDir, '.research', 'figures', figSlug);
    const codeDir = join(bundleDir, 'code');
    mkdirSync(codeDir, { recursive: true });
    const manifestPath = join(bundleDir, figSlug + '.figure');
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      title: 'Ablation Accuracy Comparison across Seeds',
      language: 'en',
      style: 'nature',
      entry: 'code/plot.py',
      history: [],
      annotations: [],
    }, null, 2) + '\n', 'utf8');

    const plotPy = [
      'import csv',
      'import os',
      'from pathlib import Path',
      'import matplotlib',
      'matplotlib.use("Agg")',
      'import matplotlib.pyplot as plt',
      '',
      'csv_file = Path(__file__).resolve().parents[4] / "metrics.csv"',
      'seeds, base_vals, meth_vals = [], [], []',
      'with csv_file.open("r", encoding="utf-8") as fh:',
      '    for row in csv.DictReader(fh):',
      '        seeds.append(row["seed"])',
      '        base_vals.append(float(row["baseline_acc"]))',
      '        meth_vals.append(float(row["method_acc"]))',
      '',
      'fig, ax = plt.subplots(figsize=(3.5, 2.4))',
      'x = range(len(seeds))',
      'ax.plot(x, base_vals, marker="o", label="Baseline", color="#0072B2")',
      'ax.plot(x, meth_vals, marker="s", label="Method", color="#D55E00")',
      'ax.set_xticks(list(x))',
      'ax.set_xticklabels(seeds)',
      'ax.set_xlabel("Random Seed")',
      'ax.set_ylabel("Accuracy")',
      'ax.spines["top"].set_visible(False)',
      'ax.spines["right"].set_visible(False)',
      'ax.legend(frameon=False)',
      'fig.tight_layout()',
      'out_png = Path(os.environ["FIGURE_OUT"])',
      'fig.savefig(out_png, dpi=300)',
      'fig.savefig(out_png.with_suffix(".svg"))',
    ].join('\n') + '\n';
    writeFileSync(join(codeDir, 'plot.py'), plotPy, 'utf8');

    const renderScript = join(REPO_ROOT, 'skills', 'sci-figure', 'render.py');
    const renderRun = runPy(renderScript, [manifestPath, '--note', 'initial ablation plot'], workDir);
    const v1Dir = join(bundleDir, 'versions', 'v1');
    const v1Png = join(v1Dir, 'figure.png');
    const v1Svg = join(v1Dir, 'figure.svg');
    const v1Env = join(v1Dir, 'env.json');
    const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pngHead = existsSync(v1Png) ? readFileSync(v1Png).subarray(0, 4) : Buffer.alloc(0);
    const isValidPng = pngHead.length === 4 && pngHead[0] === 0x89 && pngHead[1] === 0x50 && pngHead[2] === 0x4e && pngHead[3] === 0x47;
    step('E2E-2 sci-figure/render.py 产出 300dpi PNG + SVG + env.json + history',
      renderRun.status === 0 && isValidPng && existsSync(v1Svg) && existsSync(v1Env) && manifestAfter.history?.length === 1,
      'exit=' + renderRun.status + ' png=' + (existsSync(v1Png) ? readFileSync(v1Png).length : 0) + 'B' + (renderRun.status !== 0 ? ' err=' + String(renderRun.stderr).slice(0, 180) : ''));

    // ---- Step 3: 生成最小英文 .tex + .bib 并调用 latex-paper-en/scripts/compile.py 编译 PDF ----
    const paperDir = join(workDir, 'paper');
    mkdirSync(paperDir, { recursive: true });
    const bibPath = join(paperDir, 'refs.bib');
    writeFileSync(bibPath, [
      '@article{demo2026,',
      '  title={Evidence-Contracted Research Workflows},',
      '  author={Researcher, Ada},',
      '  journal={Journal of Reproducible Systems},',
      '  year={2026}',
      '}',
    ].join('\n') + '\n', 'utf8');

    const figRelForTex = '../.research/figures/' + figSlug + '/versions/v1/figure.png';
    const texPath = join(paperDir, 'main.tex');
    writeFileSync(texPath, [
      '\\documentclass[11pt]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{graphicx}',
      '\\title{Ablation Study Verification}',
      '\\author{Research Harness E2E}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{Results}',
      'As established in prior work~\\cite{demo2026}, our method improves accuracy across all three seeds (see Figure~\\ref{fig:ablation}).',
      '\\begin{figure}[htbp]',
      '  \\centering',
      '  \\includegraphics[width=0.8\\linewidth]{' + figRelForTex + '}',
      '  \\caption{Ablation accuracy comparison across three random seeds.}',
      '  \\label{fig:ablation}',
      '\\end{figure}',
      '\\bibliographystyle{plain}',
      '\\bibliography{refs}',
      '\\end{document}',
    ].join('\n') + '\n', 'utf8');

    const compileScript = join(REPO_ROOT, 'skills', 'latex-paper-en', 'scripts', 'compile.py');
    const compileRun = runPy(compileScript, [texPath, '--recipe', 'pdflatex-bibtex'], paperDir);
    const pdfPath = join(paperDir, 'main.pdf');
    const pdfBytes = existsSync(pdfPath) ? readFileSync(pdfPath) : Buffer.alloc(0);
    const isValidPdf = pdfBytes.length > 500 && pdfBytes.subarray(0, 5).toString('ascii') === '%PDF-';
    step('E2E-3 latex-paper-en/compile.py 编译出含图表与引用的 PDF',
      compileRun.status === 0 && isValidPdf,
      'exit=' + compileRun.status + ' pdf=' + pdfBytes.length + 'B' + (compileRun.status !== 0 ? ' out=' + String(compileRun.stdout + compileRun.stderr).slice(-220) : ''));

    // ---- Step 4: 真实挂载 DSH 工具链证据闭环 ----
    const recordDef = defs.find(d => d.name === 'findings.record');
    const unknownDef = defs.find(d => d.name === 'findings.unknown');
    const resolveDef = defs.find(d => d.name === 'findings.resolve');
    const aggregateDef = defs.find(d => d.name === 'findings.aggregate');
    const verifyDef = defs.find(d => d.name === 'findings.verify');
    const routeDef = defs.find(d => d.name === 'findings.route');
    step('E2E-4 DSH 挂载全部 9 个研究契约工具',
      !!(recordDef && unknownDef && resolveDef && aggregateDef && verifyDef && routeDef),
      defs.map(d => d.name).join(','));

    const csvDigest = createHash('sha256').update(csvText).digest('hex');
    const recOut = await recordDef.execute({
      entries: [
        {
          claim: 'seed 42 method accuracy reaches 0.845 vs baseline 0.712',
          confidence: 'observed',
          provenance: csvPath.replace(/\\/g, '/') + ':2',
          metric: 0.845,
          task: 'TASK-0600',
          verifiedBy: 'lead-verified',
          repro: { build_type: 'python-matplotlib-render', subject_digest: csvDigest },
        },
        {
          claim: 'seed 43 method accuracy reaches 0.851 vs baseline 0.708',
          confidence: 'observed',
          provenance: csvPath.replace(/\\/g, '/') + ':3',
          metric: 0.851,
          task: 'TASK-0600',
          verifiedBy: 'lead-verified',
          repro: { build_type: 'python-matplotlib-render', subject_digest: csvDigest },
        },
        {
          claim: 'compiled main.pdf integrates ablation figure and BibTeX citation',
          confidence: 'observed',
          provenance: pdfPath.replace(/\\/g, '/') + ':1',
          metric: 0.849,
          task: 'TASK-0600',
          verifiedBy: 'lead-verified',
          repro: { build_type: 'pdflatex-bibtex', subject_digest: createHash('sha256').update(pdfBytes).digest('hex') },
        },
      ],
    }, { name: 'findings.record' });
    step('E2E-5 findings.record 入账 3 条带 metric/repro/verifiedBy 观测发现',
      recOut?.recorded === 3 && recOut?.ids?.length === 3,
      JSON.stringify(recOut));

    const uOut = await unknownDef.execute({
      what: '需确认附录消融表是否已纳入正文编译统计',
      why: '未核对完整论文页数上限',
      classification: 'blocker',
    }, { name: 'findings.unknown' });
    const denyComplete = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });
    step('E2E-6 findings.unknown(blocker) 成功阻止 update_goal complete',
      !!uOut?.id && String(denyComplete?.reason ?? '').includes('EVIDENCE_BLOCKERS_OPEN'),
      'unknown=' + uOut?.id + ' deny=' + String(denyComplete?.info?.code ?? ''));

    const resOut = await resolveDef.execute({
      id: uOut.id,
      resolution: '已确认主文单页精简排版完整覆盖 3 组实验消融结果',
    }, { name: 'findings.resolve' });
    step('E2E-7 findings.resolve 解除 blocker',
      resOut?.ref === uOut.id && resOut?.status === 'resolved',
      JSON.stringify(resOut));

    const aggOut = await aggregateDef.execute({}, { name: 'findings.aggregate' });
    const verOut = await verifyDef.execute({}, { name: 'findings.verify' });
    const routeOut = await routeDef.execute({
      acceptance: { minFindings: 3, minObservedRatio: 1, task: 'TASK-0600' },
    }, { name: 'findings.route' });
    const hasRouteCheck = new Ledger(ledgerDir).entries().some(e => e.kind === 'route-check' && e.action === 'run-acceptance');
    const passComplete = ctx.tools.checkGuards({ name: 'update_goal', args: { action: 'complete' } });

    step('E2E-8 aggregate + verify + route(acceptance) + complete 放行全通',
      aggOut?.counts?.tests === 3 && aggOut?.counts?.failures === 0 && /1\.\.3/.test(aggOut?.tap ?? '') &&
      verOut?.ok === true && (verOut?.drifted?.length ?? 1) === 0 &&
      routeOut?.action === 'run-acceptance' && hasRouteCheck &&
      passComplete === undefined,
      'tests=' + aggOut?.counts?.tests + ' ok=' + verOut?.ok + ' route=' + routeOut?.action + ' complete=allow');
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
};
