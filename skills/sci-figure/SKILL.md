---
name: sci-figure
description: "Sci-figure bundles: code-generated, publication-grade scientific figures (科研绘图, journal-style plots) the user will iterate on, with versions and annotations. Read before creating or revising one; every render goes through render.py. Not for one-off charts (deliver a PNG) or AI-image art."
---

# Scientific figures (.figure bundles)

For **publication-grade, code-generated figures** — plots the user will iterate on, annotate, and need to reproduce — the platform provides *figure bundles*: versioned figure packages rendered from code, opened on the user's side as a review board (figure + annotations + version timeline + code/environment tabs). Use one when the user asks for a scientific figure / 科研绘图 / journal-style plot, or clearly wants a figure refined over rounds. Do **not** use it for quick one-off exploratory charts (just deliver a PNG) or AI-image-model art; figure bundles are always produced by code (matplotlib, ggplot2, …), never by image models — that is what makes versions and environment snapshots meaningful.

## Bundle layout

One figure = one directory under `<workdir>/.research/figures/`, with a manifest named after it:

```
<workdir>/.research/figures/effect-by-group/
  effect-by-group.figure   ← manifest (the file you deliver; opens the review board)
  code/                    ← your working area: plotting script + data + anything the code needs
  versions/                ← rendered versions, MANAGED BY THE RENDER SCRIPT — never write here
```

When creating `<workdir>/.research/` for the first time, also write `<workdir>/.research/.gitignore` containing a single line `*` — the directory ignores itself, so version archives never pollute the user's git history (do not touch the user's own .gitignore).

The manifest is strict JSON. You create it once with empty `history`/`annotations`; the render script maintains `history`/`output`, the user adds `annotations` from the review board:

```json
{
  "version": 1,
  "title": "Treatment effect by group",
  "language": "en",
  "style": "nature",
  "entry": "code/plot.py",
  "history": [],
  "annotations": []
}
```

- `language`: all text on the figure (axis labels, legend, title) follows it. For CJK, apply the chart font setup from your system prompt.
- `style`: a preset (below) or the user's own wording. `entry`: the script to run, relative to the bundle (`.py` / `.r` / `.sh` / `.jl`).

## Rendering — always through the render script

Your entry script must save the figure to the path in the **`FIGURE_OUT`** env var (PNG; extra artifacts saved next to `$FIGURE_OUT` — e.g. SVG/PDF when the user wants vector output — are archived with the version). Then render:

```bash
python <skill-dir>/render.py <bundle>/<slug>.figure \
    [--note "one-line summary of what changed"] \
    [--resolve a1,a2]          # annotation ids this render addresses
```

On success the script runs the entry (cwd = the entry's directory), archives `versions/vN/` (figure + code snapshot + `env.json` environment snapshot + manifest snapshot) and appends the history row. **The script is the only legitimate writer of figures and versions**:

- Never run the plotting code directly to produce the final figure, never save figures into the bundle by hand, and never edit `history`/`output` in the manifest yourself.
- `versions/` is an append-only archive — never modify, overwrite, or delete anything under it, and never run recursive cleanup (`rm -rf`, `git clean`) anywhere that could reach a bundle.
- One render per meaningful change — iterate on the code first, render when the round is done; don't burn a version on every micro-edit.
- A non-zero exit means no version was created; stderr says why (entry crashed, figure not written, manifest invalid). Fix and rerun.

If the host is missing a plotting package (e.g. matplotlib on the user's own machine), install it first; cloud hosts have the scientific Python stack pre-baked.

## Delivering

Deliver the **manifest** with the standard delivery tool (`present` tool / host file delivery, see *Delivering files* in your system prompt) — path = the `.figure` manifest. Everything else in a bundle is internal — if the user asks for the raw PNG/SVG as a file, copy it out of the bundle under a descriptive name and deliver that copy. Deliver the manifest once, after the first successful render; later renders update the user's open review board live, so **do not re-send the manifest after revisions** — just say in chat what changed.

## Revising from annotations

When asked to revise (typically "handle the open annotations in …"):

1. Read the manifest. Each open annotation has `rect` `[x, y, w, h]` in 0–1 coordinates relative to the figure (origin top-left) and the user's comment — together they tell you *where* and *what*.
2. You cannot view the rendered PNG (binary reads are blocked). Locate the issue from the annotation coordinates plus your own plotting code; if you need to inspect the rendered result, have the entry also save an SVG next to `$FIGURE_OUT` and read that — SVG is text.
3. Edit the code, then render with `--resolve` listing the annotations you addressed. `--resolve` marks them resolved in the manifest — never edit annotation entries by hand; annotations belong to the user (you may edit the other metadata fields: `title`, `language`, `style`, `entry`).

## Style presets

- `nature` — sans-serif, minimal: no top/right spines, colorblind-safe palette (e.g. Okabe–Ito), ≥300 dpi, single-column width ≈ 89 mm.
- `science` — like `nature`, slightly denser; smaller markers, thin (0.5 pt) lines.
- `ieee` — serif (Times-compatible), grayscale-safe line styles, column width ≈ 3.5 in.
- `academic` — clean general-purpose default: sans-serif, no chartjunk, ≥300 dpi.

The preset fixes the mechanics (fonts, spines, dpi, widths); the design sense is yours, and the bar is a figure that could ship in the journal itself: declutter ruthlessly (light or no gridlines, no redundant ink), direct-label lines and bars instead of a legend where feasible, size text for the final column width (axis labels ~7–8 pt at single-column, never postage-stamp small), keep one visual hierarchy — data ink dominant, annotations quiet, panel labels (a, b, c) consistent. Composed multi-panel figures share one font scale and one palette.

Whatever the preset, follow the annotations and the user's explicit wording over the preset when they conflict.
