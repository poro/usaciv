"""Markdown summary of a data refresh, for the pull request body and the job summary.

usage: python .github/scripts/refresh_summary.py <check-report.txt> [base-ref]

Compares web/data against base-ref (default HEAD): which files changed and by how much, which sources have a new
vintage (from sources.json), and the check report's totals plus every WARN and FAIL line.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "web" / "data"


def git_show(ref: str, path: str) -> bytes | None:
    r = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=ROOT, capture_output=True)
    return r.stdout if r.returncode == 0 else None


def vintages(raw: bytes | None) -> dict[str, str]:
    if not raw:
        return {}
    try:
        return {s["id"]: str(s.get("vintage") or "") for s in json.loads(raw) if isinstance(s, dict) and "id" in s}
    except (ValueError, TypeError):
        return {}


def kb(n: int) -> str:
    return f"{n / 1024:,.0f} kB"


def main(argv: list[str]) -> str:
    report = Path(argv[1]).read_text() if len(argv) > 1 and Path(argv[1]).exists() else ""
    base = argv[2] if len(argv) > 2 else "HEAD"
    out = ["## Monthly data refresh", ""]

    rows = []
    for f in sorted(DATA.glob("*.json")):
        old = git_show(base, f"web/data/{f.name}")
        new = f.read_bytes()
        if old == new:
            continue
        delta = len(new) - len(old or b"")
        rows.append(f"| `{f.name}` | {'new' if old is None else kb(len(old))} | {kb(len(new))} | {delta:+,} bytes |")
    if rows:
        out += ["### Changed files", "", "| File | Before | After | Change |", "|---|---|---|---|", *rows, ""]
    else:
        out += ["No file in `web/data` changed.", ""]

    before = vintages(git_show(base, "web/data/sources.json"))
    after = vintages((DATA / "sources.json").read_bytes() if (DATA / "sources.json").exists() else None)
    changed = [(k, before.get(k, "(new)"), v) for k, v in after.items() if before.get(k) != v]
    if changed:
        out += ["### New source vintages", "", "| Source | Before | After |", "|---|---|---|"]
        out += [f"| `{k}` | {b} | {a} |" for k, b, a in changed]
        out.append("")

    lines = report.splitlines()
    total = next((ln for ln in reversed(lines) if ln.startswith("check:")), None)
    flagged = [ln.strip() for ln in lines if ln.strip().startswith(("WARN", "FAIL"))]
    out += ["### Data check", "", f"`{total}`" if total else "(no check report)", ""]
    if flagged:
        out += ["```", *flagged, "```", ""]
    out += [
        "Before merging: open the site locally (`uv run python -m pipeline serve`) and skim the map, a City View, "
        "and each game mode. Merge to publish the new numbers.",
    ]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    sys.stdout.write(main(sys.argv))
