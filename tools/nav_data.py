"""qrmint.net navigation data — the single source of truth for the toolbar.

This is the ONLY file that differs between sites. `sync_nav.py` is generic and
copies verbatim. Nothing here is computed at runtime by the browser: sync_nav
renders it into the static HTML of every page.

Tier rule (portfolio spec, ngineer420.github.io#13): a page is tier 1 only if it
answers a *different question*. qrmint has five such pages and no tier-2 family:
every generator is a genuinely different payload, not one generator with an
argument baked in.

The one thing worth writing down: the old tab bar shipped six links for five
destinations, because "Link" and "Text" both pointed at "/". They were never two
places — they are two payload types on the same page. So there is one rail chip
for "/" and the choice between the two lives in the generator's own control
panel, where a parameter belongs.
"""

# Noun used in the menu trigger: "All 5 tools".
NOUN = "tools"

# Tier-1 tools, in rail order.
#   label -> rail chip text, <= 18 chars
#   long  -> anchor text in the sheet
#   group -> sheet grouping key, unused below 9 destinations but already decided
TOOLS = [
    {"href": "/",               "label": "Link",         "long": "Link & Text QR Code",  "group": "make",  "tier": 1},
    {"href": "/wifi-qr-code/",  "label": "Wi‑Fi",   "long": "Wi‑Fi QR Code",   "group": "make",  "tier": 1},
    {"href": "/vcard-qr-code/", "label": "Contact card", "long": "vCard QR Code",        "group": "make",  "tier": 1},
    {"href": "/scan-qr-code/",  "label": "Scan a code",  "long": "QR Code Reader",       "group": "read",  "tier": 1},
    {"href": "/bulk-qr-codes/", "label": "Batch CSV",    "long": "Bulk QR Codes (CSV)",  "group": "read",  "tier": 1},
]

# Sheet groups, in order. Unused at <= 8 destinations (the sheet renders flat,
# because group headings are noise at that size) — kept so the arrangement is
# already decided the day this site gains a ninth tool.
GROUPS = [
    ("make", "Make a code"),
    ("read", "Read & batch"),
]

# One hub link at the bottom of the sheet. The four guides were previously
# reachable only from a card grid on the homepage; the hub gives them a real
# index and every page a route to it.
HUBS = [("/articles/", "All 4 QR code guides")]

# No tier-2 family here.
FOOTER = []

# One-time --migrate: strip the legacy markup and drop the marker pair in the
# one place the spec allows — a direct child of <body>, immediately after
# </header> and above <main>. Ops run in order.
MIGRATE = [
    # The old tab bar. role="tablist" plus role="tab" tabindex="-1" took five of
    # its six links out of tab order and announced navigation as tabs; the spec
    # deletes that markup outright rather than porting it.
    {"op": "strip", "pattern": r'\n  <nav role="tablist" class="tabbar".*?\n  </nav>\n'},
    # The in-body "More QR code types" list, which repeated the same five
    # destinations a second time further down every generator page.
    {"op": "strip", "pattern": r'\n  <nav class="container-narrow" aria-label="Other QR code types".*?\n  </nav>\n'},
    {"op": "insert_after", "region": "nav", "pattern": r"</header>", "indent": ""},
]
