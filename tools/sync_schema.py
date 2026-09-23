#!/usr/bin/env python3
"""Write the structured-data and Open Graph block into every page.

Stdlib only. The block is derived from what the page already says — its
`<title>`, its meta description, its canonical URL, its `<h1>` and its visible
FAQ markup — so the schema cannot claim something the page does not.

    python3 tools/sync_schema.py          # write every marked region
    python3 tools/sync_schema.py --check  # exit 1 if any file is stale

Each page carries one managed region, just before `</head>`:

    <!-- schema:start --> ... <!-- schema:end -->

On the first run the region does not exist and this script inserts it. Every
later run rewrites it in place, so there is no one-shot mode to get wrong. A
page with no `</head>` is left alone.

What the region carries:

  BreadcrumbList  on every page except the site root. Two items for a
                  top-level page, three where a real section hub exists
                  (/articles/). Both members of a twin pair get the same
                  trail, pointing at the directory URL, because that is what
                  both canonicalize to.
  Article         on each of the four guides under /articles/. `headline` is
                  the page's own <h1>. `datePublished` comes from
                  ARTICLE_DATES below, which holds the date each file was
                  first committed.
  CollectionPage  on /articles/ itself. The hub is an index of the guides, not
                  a guide, so it must not claim to be an Article. It reuses
                  the `faq-item` class for its four teaser cards, which are
                  links to other pages and not answers, so it gets no FAQPage
                  either.
  FAQPage         on a page that has visible FAQ markup and does not already
                  carry the schema. /qr-code-labels/ wrote its own by hand, so
                  this only fills the rest in.
  og:*            the tags a page is missing. A tag already in the head is
                  left where it is and is not repeated here.

Run this after `tools/sync_nav.py` and before `tools/build_sw.py`, because the
worker hashes the pages as they are on disk.
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://qrmint.net"
DOMAIN = "qrmint.net"
SKIP_DIRS = {".git", ".worktrees", "node_modules", "tools", "assets"}

BEGIN = "<!-- schema:start -->"
END = "<!-- schema:end -->"

# Section hubs that really exist, as path prefix -> breadcrumb name. A page
# under one of these gets a three-item trail. Anything else gets two.
SECTIONS = {"/articles/": "Guides"}

# The date each guide was first committed, from
# `git log --diff-filter=A --format=%ad --date=short -- PATH | tail -1`.
# Typed here rather than read from git, so the output does not depend on the
# checkout having history. The guides carry no visible date, so this is the
# only honest source for `datePublished`.
ARTICLE_DATES = {
    "/articles/how-qr-codes-work.html": "2026-07-18",
    "/articles/how-to-share-wifi-with-a-qr-code.html": "2026-07-18",
    "/articles/qr-code-design-tips-that-still-scan.html": "2026-07-18",
    "/articles/qr-code-error-correction-levels-explained.html": "2026-07-18",
}

# Pages that index other pages. These get CollectionPage, never Article.
COLLECTIONS = {"/articles/index.html"}

OG_TAGS = ("og:type", "og:site_name", "og:title", "og:description", "og:url")


# --------------------------------------------------------------------------
# reading the page
# --------------------------------------------------------------------------

def strip_region(src):
    """The page without its managed region, which is what everything reads."""
    start = src.find(BEGIN)
    if start == -1:
        return src
    end = src.find(END, start)
    if end == -1:
        return src
    line_start = src.rfind("\n", 0, start) + 1
    return src[:line_start] + src[end + len(END) + 1:]


def text_of(fragment):
    """Visible text of an HTML fragment, whitespace collapsed."""
    plain = re.sub(r"(?s)<[^>]+>", "", fragment)
    return html.unescape(re.sub(r"\s+", " ", plain)).strip()


def page_url(path):
    """The URL the server sends this file for. Both twins give one answer."""
    rel = "/" + path.relative_to(ROOT).as_posix()
    if rel.endswith("/index.html"):
        rel = rel[: -len("index.html")]
    elif rel.endswith(".html") and not rel.startswith("/articles/"):
        # Tool pages are served at a clean path; the flat file is the alias.
        # The guides are the exception: they are served at their own .html,
        # which is what their canonical says.
        rel = rel[: -len(".html")] + "/"
    return rel


def canonical_of(src, path):
    match = re.search(r'<link rel="canonical" href="([^"]+)"', src)
    if match:
        return match.group(1)
    return SITE + page_url(path)


def title_of(src):
    match = re.search(r"(?s)<title>(.*?)</title>", src)
    return text_of(match.group(1)) if match else ""


def description_of(src):
    match = re.search(r'<meta name="description" content="([^"]*)"', src)
    return html.unescape(match.group(1)) if match else ""


def h1_of(src):
    match = re.search(r"(?s)<h1[^>]*>(.*?)</h1>", src)
    return text_of(match.group(1)) if match else ""


def faq_items(src):
    """Question and answer pairs from the page's own FAQ section.

    Only the `.faq-item` blocks that sit under a Questions heading count. The
    same class carries the guide teaser cards on the homepage and on
    /articles/, and those are links to other pages, not answers to anything.
    """
    heading = re.search(r"(?i)<h2[^>]*>\s*(questions|faq|frequently asked[^<]*)\s*</h2>", src)
    if not heading:
        return []
    rest = src[heading.end():]
    nxt = re.search(r"<h2[^>]*>", rest)
    block = rest[: nxt.start()] if nxt else rest
    out = []
    for item in re.findall(r'(?s)<div class="faq-item">(.*?)</div>', block):
        q = re.search(r"(?s)<h3[^>]*>(.*?)</h3>", item)
        a = re.search(r"(?s)<p[^>]*>(.*?)</p>", item)
        if not q or not a:
            continue
        question, answer = text_of(q.group(1)), text_of(a.group(1))
        if question and answer:
            out.append((question, answer))
    return out


# --------------------------------------------------------------------------
# writing the region
# --------------------------------------------------------------------------

def ld(obj):
    return ('<script type="application/ld+json">%s</script>'
            % json.dumps(obj, separators=(",", ":"), ensure_ascii=True))


def breadcrumb(url, name):
    items = [{"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"}]
    path = url[len(SITE):] if url.startswith(SITE) else url
    for prefix, label in SECTIONS.items():
        if path.startswith(prefix) and path != prefix:
            items.append({"@type": "ListItem", "position": 2, "name": label,
                          "item": SITE + prefix})
    items.append({"@type": "ListItem", "position": len(items) + 1,
                  "name": name, "item": url})
    return ld({"@context": "https://schema.org", "@type": "BreadcrumbList",
               "itemListElement": items})


def article(url, headline, description, date):
    return ld({"@context": "https://schema.org", "@type": "Article",
               "headline": headline, "description": description,
               "datePublished": date, "url": url,
               "publisher": {"@type": "Organization", "name": DOMAIN},
               "author": {"@type": "Organization", "name": DOMAIN}})


def collection(url, name, description):
    return ld({"@context": "https://schema.org", "@type": "CollectionPage",
               "name": name, "description": description, "url": url,
               "publisher": {"@type": "Organization", "name": DOMAIN}})


def faqpage(items):
    return ld({"@context": "https://schema.org", "@type": "FAQPage",
               "mainEntity": [{"@type": "Question", "name": q,
                               "acceptedAnswer": {"@type": "Answer", "text": a}}
                              for q, a in items]})


def region_for(path, bare):
    """The lines of the managed region for one page, or [] for none."""
    url = canonical_of(bare, path)
    is_root = url.rstrip("/") == SITE
    name = h1_of(bare) or title_of(bare)
    description = description_of(bare)
    rel = "/" + path.relative_to(ROOT).as_posix()
    lines = []

    missing = [t for t in OG_TAGS if ('property="%s"' % t) not in bare]
    values = {
        "og:type": "article" if rel in ARTICLE_DATES else "website",
        "og:site_name": DOMAIN,
        "og:title": title_of(bare),
        "og:description": description,
        "og:url": url,
    }
    for tag in missing:
        if values[tag]:
            lines.append('<meta property="%s" content="%s">'
                         % (tag, html.escape(values[tag], quote=True)))

    if not is_root:
        lines.append(breadcrumb(url, name))

    if rel in ARTICLE_DATES:
        lines.append(article(url, name, description, ARTICLE_DATES[rel]))
    elif rel in COLLECTIONS:
        lines.append(collection(url, name, description))

    if '"FAQPage"' not in bare:
        items = faq_items(bare)
        if items:
            lines.append(faqpage(items))

    return lines


def rendered(path, bare):
    lines = region_for(path, bare)
    if not lines:
        return bare
    block = "\n".join([BEGIN] + lines + [END]) + "\n"
    head = bare.find("</head>")
    if head == -1:
        return bare
    line_start = bare.rfind("\n", 0, head) + 1
    return bare[:line_start] + block + bare[line_start:]


def html_files():
    for path in sorted(ROOT.rglob("*.html")):
        rel = path.relative_to(ROOT)
        if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
            continue
        yield path


def main():
    ap = argparse.ArgumentParser(description="Write the schema region.")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if any page's region is stale")
    args = ap.parse_args()

    stale, written = [], []
    for path in html_files():
        src = path.read_text(encoding="utf-8")
        updated = rendered(path, strip_region(src))
        if updated == src:
            continue
        if args.check:
            stale.append(path.relative_to(ROOT).as_posix())
        else:
            path.write_text(updated, encoding="utf-8")
            written.append(path.relative_to(ROOT).as_posix())

    if args.check:
        if stale:
            print("schema region is stale in %d file(s):" % len(stale))
            for name in stale[:20]:
                print("  " + name)
            print("run: python3 tools/sync_schema.py")
            return 1
        print("schema region is current in every file")
        return 0
    print("updated %d file(s)" % len(written))
    for name in written:
        print("  " + name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
