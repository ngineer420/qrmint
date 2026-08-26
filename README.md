# qrmint.net

A free, browser-only QR code generator and reader. The site is static HTML on
GitHub Pages. Every page loads `assets/js/nav.js`, which is the shared script.

## Checks before a deploy

1. Run `python3 tools/sync_nav.py --check`. The toolbar must be current in every page.
2. Run `python3 tools/build_sw.py --check`. The service worker must be current.
3. Run `node assets/js/app.test.js`. All tests must pass.

## Offline

`sw.js` is a service worker. On the first visit it precaches every page in
`sitemap.xml` and every same-origin CSS and JS file that those pages load. After
that, each page loads from the cache first, with no network.

`tools/build_sw.py` writes `sw.js`. It reads the page list from `sitemap.xml`
and scans each page for `<link rel="stylesheet">` and `<script src>` tags. Do
not edit `sw.js` by hand.

The cache name is `qrmint-` plus a 12-character hash of every precached file.
Any change to a page or an asset gives a new hash, and the browser then
installs a new cache and deletes the old one. Run this command after every
change and before every deploy:

    python3 tools/build_sw.py

`python3 tools/build_sw.py --check` exits with code 1 when `sw.js` is stale.

The worker handles same-origin GET requests only. It never intercepts and
never caches the AdSense script or any other third-party request.
