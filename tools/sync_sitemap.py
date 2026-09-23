#!/usr/bin/env python3
"""Put a `<lastmod>` on every `<url>` in sitemap.xml.

Stdlib only.

    python3 tools/sync_sitemap.py          # write the dates
    python3 tools/sync_sitemap.py --check  # exit 1 if a date is stale

`sitemap.xml` is hand-maintained. This script touches neither the `<loc>` set
nor `<changefreq>` nor `<priority>`. It only adds or refreshes the `<lastmod>`
of each entry, so a new page still goes in by hand.

The date is the day the page last changed, worked out like this:

    dirty or untracked in the working tree -> today
    otherwise                              -> the last commit that touched it
    git cannot answer at all               -> the file mtime

The mtime is never the primary source. A fresh clone gives every file the same
mtime, `git pull` resets them, and a generator run touches every file it writes
whether the content changed or not.

The dirty rule is what stops the sitemap from being permanently one commit
behind itself. This script runs BEFORE the commit, so the plain "last commit"
answer records the PREVIOUS commit's date for a page you just edited. The
moment that commit lands, the page's last commit is the new one, and `--check`
on a clean checkout reports every URL stale with nothing actually changed.
Dating a dirty file today converges instead: the sitemap says today, the commit
lands today, the last-commit date is then today, and `--check` passes.

The one residual: a branch merged on a later day than it was built takes the
merge day for every page it touched, so the committed sitemap lags by one
rebuild. The page really did land that day, so the newer date is not a lie.

Run this after the page generators and before `tools/build_sw.py`, which reads
the `<loc>` list out of this file.
"""

import argparse
import re
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITEMAP = ROOT / "sitemap.xml"
SITE = "https://qrmint.net"


def file_for(url):
    """The file the static server sends for a sitemap URL."""
    path = url[len(SITE):] if url.startswith(SITE) else url
    path = path.split("#")[0].split("?")[0]
    if path in ("", "/"):
        return ROOT / "index.html"
    bare = path.lstrip("/")
    for candidate in (ROOT / bare, ROOT / (bare + ".html"),
                      ROOT / bare / "index.html",
                      ROOT / bare.rstrip("/") / "index.html"):
        if candidate.is_file():
            return candidate
    return None


def git(*args):
    """Run one git command, or return None when git cannot answer.

    A bare `except` would hide a broken call and fall back to the mtime without
    saying so, so only the failure modes of running the subprocess are caught.
    """
    try:
        out = subprocess.run(("git",) + args, cwd=ROOT,
                             capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def dirty_paths():
    """Every path git reports as modified, staged, renamed or untracked.

    One call for the whole repo, not one per file. `--porcelain -z` writes
    `XY <path>` entries separated by NUL. A rename or copy entry is followed by
    a second NUL-terminated field holding the other path, and both ends of the
    pair count as changed.
    """
    out = git("status", "--porcelain", "-z")
    if out is None:
        return None
    fields = [f for f in out.split("\0") if f]
    paths, i = set(), 0
    while i < len(fields):
        entry = fields[i]
        i += 1
        if len(entry) < 4:
            continue
        status, name = entry[:2], entry[3:]
        paths.add((ROOT / name).resolve())
        if status[0] in "RC" and i < len(fields):
            paths.add((ROOT / fields[i]).resolve())
            i += 1
    return paths


def last_changed(path, dirty):
    """The day this page last changed. See the module docstring for the rule."""
    if dirty is not None and path.resolve() in dirty:
        return date.today().isoformat()
    out = git("log", "-1", "--format=%ad", "--date=short", "--", str(path))
    if out is not None:
        stamp = out.strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stamp):
            return stamp
    stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%d")


def rewrite(text):
    missing = []
    dirty = dirty_paths()

    def one(match):
        block = match.group(0)
        loc = re.search(r"<loc>\s*([^<\s]+)\s*</loc>", block)
        if not loc:
            return block
        path = file_for(loc.group(1))
        if path is None:
            missing.append(loc.group(1))
            return block
        tag = "<lastmod>%s</lastmod>" % last_changed(path, dirty)
        if "<lastmod>" in block:
            return re.sub(r"<lastmod>[^<]*</lastmod>", tag, block)
        # Straight after the <loc>, with the same indent that line carries.
        indent = re.search(r"(?m)^([ \t]*)<loc>", block)
        pad = indent.group(1) if indent else "    "
        return re.sub(r"(</loc>)", r"\1\n" + pad + tag, block, count=1)

    return re.sub(r"(?s)<url>.*?</url>", one, text), missing


def main():
    ap = argparse.ArgumentParser(description="Date every sitemap entry.")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if sitemap.xml does not carry current dates")
    args = ap.parse_args()

    text = SITEMAP.read_text(encoding="utf-8")
    updated, missing = rewrite(text)
    if missing:
        raise SystemExit("sitemap URL with no file: %s" % ", ".join(missing))
    count = updated.count("<lastmod>")
    if args.check:
        if updated != text:
            print("sitemap.xml dates are stale: run python3 tools/sync_sitemap.py")
            return 1
        print("sitemap.xml is current (%d dated entries)" % count)
        return 0
    if updated != text:
        SITEMAP.write_text(updated, encoding="utf-8")
    print("wrote sitemap.xml (%d dated entries)" % count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
