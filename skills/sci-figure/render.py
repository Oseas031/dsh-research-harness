#!/usr/bin/env python3
"""figure bundle renderer — the ONLY writer of figures, versions/ and manifest history.

Usage:
    python <skill-dir>/render.py <bundle>/<slug>.figure \
        [--note "what changed"] [--resolve a1,a2]

Contract (SKILL.md is the source of truth):
  - Runs the manifest's `entry` script with cwd = the entry's directory and env
    FIGURE_OUT = an absolute PNG path the entry MUST save the figure to.
    Extra artifacts (SVG/PDF) may be written next to $FIGURE_OUT; they are archived too.
  - On success it archives versions/vN/ (figure + code snapshot + env.json + manifest
    snapshot), appends a history row, updates `output`, and marks --resolve annotations
    resolved.
  - versions/ is append-only; this script never overwrites or deletes an archived version.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CODE_SNAPSHOT_EXCLUDES = {"__pycache__", ".venv", "venv", "node_modules", ".cache"}
RUNNERS = {".py": [sys.executable], ".r": ["Rscript"], ".sh": ["bash"], ".jl": ["julia"]}


def fail(code: int, message: str):
    print(f"sci-figure: {message}", file=sys.stderr)
    sys.exit(code)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def capture(cmd: list) -> str:
    """Best-effort command capture for env.json; never fails the render."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return (out.stdout or out.stderr).strip()
    except Exception:
        return ""


def main() -> None:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("manifest", help="path to <slug>.figure")
    parser.add_argument("--note", default="", help="one-line summary of this version")
    parser.add_argument("--resolve", default="", help="comma-separated annotation ids handled by this render")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    if manifest_path.suffix != ".figure":
        fail(2, f"manifest must have the .figure extension: {manifest_path}")
    if not manifest_path.is_file():
        fail(2, f"manifest not found: {manifest_path}")
    bundle = manifest_path.parent
    if manifest_path.stem != bundle.name:
        fail(2, f"manifest name must match its directory: expected {bundle.name}.figure, got {manifest_path.name}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as err:
        fail(2, f"manifest is not valid JSON: {err}")
    if not isinstance(manifest, dict):
        fail(2, "manifest top level must be a JSON object")

    entry = manifest.get("entry")
    if not isinstance(entry, str) or not entry:
        fail(2, 'manifest is missing "entry" (relative path to the plotting script, e.g. "code/plot.py")')
    entry_rel = Path(entry)
    if entry_rel.is_absolute() or ".." in entry_rel.parts:
        fail(2, f'"entry" must be a relative path inside the bundle: {entry}')
    entry_path = bundle / entry_rel
    if not entry_path.is_file():
        fail(2, f"entry script not found: {entry_path}")
    runner = RUNNERS.get(entry_path.suffix.lower())
    if runner is None:
        fail(2, f"unsupported entry type {entry_path.suffix} (supported: {', '.join(sorted(RUNNERS))})")

    # Next version number: existing version dirs are the truth (survives a damaged history array)
    versions_dir = bundle / "versions"
    versions_dir.mkdir(exist_ok=True)
    existing = [int(m.group(1)) for d in versions_dir.iterdir() if (m := re.fullmatch(r"v(\d+)", d.name)) and d.is_dir()]
    number = max(existing, default=0) + 1

    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=bundle))
    figure_out = staging / "figure.png"
    try:
        result = subprocess.run(
            [*runner, str(entry_path)],
            cwd=entry_path.parent,
            env={**os.environ, "FIGURE_OUT": str(figure_out)},
        )
        if result.returncode != 0:
            fail(result.returncode or 1, f"entry exited with {result.returncode}; fix the code and rerun")
        if not figure_out.is_file() or figure_out.stat().st_size == 0:
            fail(3, "entry finished but did not write $FIGURE_OUT — save the figure to that exact path (PNG)")

        # Archive: figure (+ any extra artifacts in staging) + code snapshot + env capture.
        # mkdir is the arbiter: a concurrent render that claimed the same number just moves us to the next slot
        while True:
            vdir = versions_dir / f"v{number}"
            try:
                vdir.mkdir()
                break
            except FileExistsError:
                number += 1
        for item in sorted(staging.iterdir()):
            shutil.move(str(item), vdir / item.name)

        code_root = bundle / entry_rel.parts[0]
        if code_root.is_dir():
            shutil.copytree(code_root, vdir / "code", ignore=shutil.ignore_patterns(*CODE_SNAPSHOT_EXCLUDES))
        else:
            (vdir / "code").mkdir()
            shutil.copy2(entry_path, vdir / "code" / entry_path.name)

        env_info = {
            "createdAt": utc_now(),
            "runner": runner[0],
            "runnerVersion": capture([runner[0], "--version"]),
        }
        if runner[0] == "python3":
            freeze = capture(["python3", "-m", "pip", "freeze"])
            if freeze:
                env_info["packages"] = freeze.splitlines()
        (vdir / "env.json").write_text(json.dumps(env_info, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        # Manifest update: history append + output + annotation resolution, atomic replace.
        # Re-read fresh first: the entry run above can take minutes, and the user may have
        # added annotations (the review board writes the manifest) in the meantime — updating
        # the pre-run copy would clobber them. Fall back to the pre-run copy only if the fresh
        # read is momentarily unreadable (concurrent non-atomic write).
        try:
            fresh = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(fresh, dict):
                manifest = fresh
        except (ValueError, OSError) as err:
            print(f"sci-figure: warning: manifest re-read failed, updating pre-run copy ({err})", file=sys.stderr)

        version_id = f"v{number}"
        figure_rel = f"versions/{version_id}/figure.png"
        row = {"id": version_id, "createdAt": env_info["createdAt"], "figure": figure_rel}
        if args.note:
            row["note"] = args.note
        history = manifest.get("history")
        if not isinstance(history, list):
            history = []
        history.append(row)
        manifest["history"] = history
        manifest["output"] = figure_rel
        resolve_ids = {v.strip() for v in args.resolve.split(",") if v.strip()}
        resolved = []
        if resolve_ids and isinstance(manifest.get("annotations"), list):
            for annotation in manifest["annotations"]:
                if isinstance(annotation, dict) and annotation.get("id") in resolve_ids:
                    annotation["status"] = "resolved"
                    resolved.append(annotation["id"])
        text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
        tmp = manifest_path.with_name(manifest_path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(manifest_path)
        (vdir / "manifest.snapshot.json").write_text(text, encoding="utf-8")

        summary = f"rendered {version_id}: {figure_rel}"
        if resolved:
            summary += f" (resolved annotations: {', '.join(resolved)})"
        print(summary)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()
