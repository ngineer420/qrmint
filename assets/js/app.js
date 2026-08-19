(() => {
  "use strict";

  /* ======================================================================
     qrmint.net — payload builders (pure, DOM-independent)
     ====================================================================== */

  function normalizeUrl(input) {
    const t = (input || "").trim();
    if (!t) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t; // already has a scheme
    return "https://" + t;
  }

  // Escapes backslash, semicolon, comma, double-quote and colon per the
  // conventional WIFI: QR payload format (used by Android/iOS/ZXing).
  function escapeWifiField(s) {
    return (s || "").replace(/([\\;,":])/g, "\\$1");
  }

  function buildWifiPayload({ ssid, password, enc, hidden }) {
    const cleanSsid = (ssid || "").trim();
    if (!cleanSsid) return "";
    const T = enc === "nopass" ? "nopass" : enc === "WEP" ? "WEP" : "WPA";
    let out = "WIFI:T:" + T + ";S:" + escapeWifiField(cleanSsid) + ";";
    if (T !== "nopass" && password) out += "P:" + escapeWifiField(password) + ";";
    if (hidden) out += "H:true;";
    out += ";";
    return out;
  }

  // Escapes backslash, comma, semicolon and newline per RFC 6350 (vCard 3/4).
  function escapeVCardField(s) {
    return (s || "").replace(/([\\,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
  }

  function buildVCardPayload(f) {
    const firstName = (f.firstName || "").trim();
    const lastName = (f.lastName || "").trim();
    const org = (f.org || "").trim();
    if (!firstName && !lastName && !org) return "";
    const lines = ["BEGIN:VCARD", "VERSION:3.0"];
    lines.push("N:" + escapeVCardField(lastName) + ";" + escapeVCardField(firstName) + ";;;");
    const fn = [firstName, lastName].filter(Boolean).join(" ") || org;
    lines.push("FN:" + escapeVCardField(fn));
    if (org) lines.push("ORG:" + escapeVCardField(org));
    if (f.title && f.title.trim()) lines.push("TITLE:" + escapeVCardField(f.title.trim()));
    if (f.phone && f.phone.trim()) lines.push("TEL;TYPE=CELL:" + escapeVCardField(f.phone.trim()));
    if (f.email && f.email.trim()) lines.push("EMAIL:" + escapeVCardField(f.email.trim()));
    if (f.url && f.url.trim()) lines.push("URL:" + escapeVCardField(normalizeUrl(f.url)));
    if (f.address && f.address.trim()) lines.push("ADR;TYPE=WORK:;;" + escapeVCardField(f.address.trim()) + ";;;;");
    lines.push("END:VCARD");
    return lines.join("\r\n");
  }

  /* --------------------- phone, email, SMS, chat, geo --------------------- */

  // A single leading "+" and the digits. Spaces, dashes, dots and brackets are
  // formatting for humans; a tel: or SMSTO: payload wants the bare number, and
  // a scanner that has to guess where the number ends is a scanner that dials
  // the wrong one.
  function normalizePhone(input) {
    const t = (input || "").trim();
    if (!t) return "";
    const plus = t.charAt(0) === "+";
    const digits = t.replace(/\D/g, "");
    if (!digits) return "";
    return (plus ? "+" : "") + digits;
  }

  function buildPhonePayload(f) {
    const n = normalizePhone(f && f.number);
    return n ? "tel:" + n : "";
  }

  function buildEmailPayload(f) {
    const o = f || {};
    // Whitespace inside an address is the one character that reliably ends a
    // scanner's URI detection early, so it goes before anything else does.
    const addr = (o.to || "").trim().replace(/\s+/g, "");
    if (!addr) return "";
    const params = [];
    const subject = (o.subject || "").trim();
    const body = (o.body || "").trim();
    // encodeURIComponent, not encodeURI: a "&" or "=" inside a subject line
    // has to survive as data rather than start a second parameter. It also
    // encodes a space as %20 rather than "+", which every mail client decodes
    // the same way — "+" is a form-encoding convention some do not undo.
    if (subject) params.push("subject=" + encodeURIComponent(subject));
    if (body) params.push("body=" + encodeURIComponent(body));
    return "mailto:" + addr + (params.length ? "?" + params.join("&") : "");
  }

  function buildSmsPayload(f) {
    const o = f || {};
    const n = normalizePhone(o.number);
    if (!n) return "";
    const message = (o.message || "").trim();
    // SMSTO:number:message — the ZXing convention, which is what QR scanners
    // and Android's camera read. The message is not escaped because everything
    // after the second colon is the message, colons included.
    return message ? "SMSTO:" + n + ":" + message : "SMSTO:" + n;
  }

  function buildWhatsAppPayload(f) {
    const o = f || {};
    // wa.me takes the full international number in digits only: no "+", no
    // separators. A leading "00" is the international dialling prefix people
    // type instead of "+", so it goes. A single leading zero is left alone on
    // purpose: it means the number was typed in national format and is missing
    // its country code entirely, and quietly deleting the zero would turn a
    // number that fails loudly into one that reaches a stranger. The form hint
    // asks for the country code instead.
    const digits = (o.number || "").replace(/\D/g, "").replace(/^00/, "");
    if (!digits) return "";
    const message = (o.message || "").trim();
    return "https://wa.me/" + digits + (message ? "?text=" + encodeURIComponent(message) : "");
  }

  // Six decimals is about 11 cm — past the point any consumer GPS can tell the
  // difference, and short enough to keep the code sparse. Trailing zeros go so
  // that "51.50" and "51.5" produce the same payload.
  function formatCoordinate(n) {
    return String(Number(n.toFixed(6)));
  }

  function buildGeoPayload(f) {
    const o = f || {};
    const rawLat = String(o.lat == null ? "" : o.lat).trim();
    const rawLng = String(o.lng == null ? "" : o.lng).trim();
    if (!rawLat || !rawLng) return "";
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!isFinite(lat) || !isFinite(lng)) return "";
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";
    const pair = formatCoordinate(lat) + "," + formatCoordinate(lng);
    // iOS Camera does nothing with a geo: URI — Apple Maps never registered
    // the scheme — so a maps URL is the honest cross-platform default and
    // geo: is the opt-in for an Android-only audience.
    if (o.mapsUrl === false) return "geo:" + pair;
    return "https://www.google.com/maps/search/?api=1&query=" + pair;
  }

  /* ------------------------- centre logo geometry ------------------------- */

  // The size range the UI offers. Below 10% a logo is unreadable; above 25%
  // it starts eating into the redundancy that keeps the code scannable.
  const LOGO_MIN_PCT = 10;
  const LOGO_MAX_PCT = 25;

  function clamp(n, lo, hi) {
    const v = typeof n === "number" && isFinite(n) ? n : Number(n);
    if (!isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  // 4dp is far below one device pixel at any export size we offer, and rounding
  // both renderers identically is what keeps the PNG and the SVG in step.
  function round4(n) {
    return Math.round(n * 1e4) / 1e4;
  }

  // The largest width×height with the source's aspect ratio that fits inside a
  // square box. A logo is almost never square; both renderers must letterbox it
  // the same way or the exports drift apart.
  function fitContain(box, srcW, srcH) {
    const w = srcW > 0 ? srcW : 1;
    const h = srcH > 0 ? srcH : 1;
    const k = Math.min(box / w, box / h);
    return { width: w * k, height: h * k };
  }

  /**
   * Where the logo — and its optional knockout plate — sit, expressed in QR
   * *module* units. That is the unit the SVG viewBox already uses, and the one
   * the canvas gets by multiplying by its integer module scale, so a single
   * geometry drives both renderers and they cannot disagree.
   *
   * @param {{qrSize:number, margin:number, sizePct:number, padPct:number,
   *          plate:("none"|"rounded"|"circle"), imageWidth:number, imageHeight:number}} opts
   */
  function logoGeometry(opts) {
    const o = opts || {};
    const qrSize = o.qrSize;
    const margin = o.margin || 0;
    const dim = qrSize + margin * 2;
    // The slider offers 10–25%. The clamp here is deliberately wider: an
    // over-large logo must still be drawn exactly as asked so scan
    // verification can catch it, rather than being quietly resized to safety.
    const pct = clamp(o.sizePct, 4, 60);
    const box = qrSize * (pct / 100);
    const fit = fitContain(box, o.imageWidth, o.imageHeight);
    const center = dim / 2;
    const logo = {
      x: round4(center - fit.width / 2),
      y: round4(center - fit.height / 2),
      width: round4(fit.width),
      height: round4(fit.height),
    };

    const shape = o.plate === "circle" || o.plate === "rounded" ? o.plate : "none";
    const pad = box * clamp(o.padPct, 0, 0.5);
    let plate = null;
    if (shape !== "none") {
      let pw = fit.width + pad * 2;
      let ph = fit.height + pad * 2;
      if (shape === "circle") pw = ph = Math.max(pw, ph);
      plate = {
        x: round4(center - pw / 2),
        y: round4(center - ph / 2),
        width: round4(pw),
        height: round4(ph),
        // A radius of half the side turns the rounded rect into a circle, so
        // one code path draws both plate shapes in canvas and in SVG.
        radius: round4(shape === "circle" ? pw / 2 : Math.min(pw, ph) * 0.22),
      };
    }

    const covered = plate ? plate.width * plate.height : logo.width * logo.height;
    return { dim, box: round4(box), logo, plate, coverage: covered / (qrSize * qrSize) };
  }

  // A logo blanks out modules, so the only sane level is the one with modules
  // to spare. Anything the visitor picked is remembered and handed back the
  // moment the logo goes away.
  function eccWithLogo(selected, hasLogo) {
    if (hasLogo) return "H";
    return ["L", "M", "Q", "H"].indexOf(selected) >= 0 ? selected : "M";
  }

  /* ---------------------------- rendering -------------------------------- */

  function traceRoundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, rad);
      return;
    }
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  // Draws the given qrcodegen.QrCode onto a canvas. Returns the final pixel
  // dimension actually used (an integer multiple of the module count).
  function renderQrToCanvas(qr, canvas, { targetPx, margin, fg, bg, logo }) {
    const dim = qr.size + margin * 2;
    const scale = Math.max(1, Math.round(targetPx / dim));
    const px = dim * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = fg;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) ctx.fillRect((margin + x) * scale, (margin + y) * scale, scale, scale);
      }
    }

    if (logo && logo.image) {
      const g = logoGeometry({
        qrSize: qr.size, margin,
        sizePct: logo.sizePct, padPct: logo.padPct, plate: logo.plate,
        imageWidth: logo.imageWidth, imageHeight: logo.imageHeight,
      });
      if (g.plate) {
        ctx.fillStyle = logo.plateColor || bg;
        traceRoundRect(ctx, g.plate.x * scale, g.plate.y * scale, g.plate.width * scale, g.plate.height * scale, g.plate.radius * scale);
        ctx.fill();
      }
      ctx.drawImage(logo.image, g.logo.x * scale, g.logo.y * scale, g.logo.width * scale, g.logo.height * scale);
    }
    return px;
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Builds a compact, crisp vector SVG string for the given QR code. The logo
  // rides along as a data: URI, so the file stays a single self-contained
  // asset with no external reference to resolve.
  function buildQrSvg(qr, { margin, fg, bg, logo }) {
    const dim = qr.size + margin * 2;
    let path = "";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) path += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }

    let overlay = "";
    if (logo && logo.href) {
      const g = logoGeometry({
        qrSize: qr.size, margin,
        sizePct: logo.sizePct, padPct: logo.padPct, plate: logo.plate,
        imageWidth: logo.imageWidth, imageHeight: logo.imageHeight,
      });
      if (g.plate) {
        overlay +=
          `<rect x="${g.plate.x}" y="${g.plate.y}" width="${g.plate.width}" height="${g.plate.height}" ` +
          `rx="${g.plate.radius}" ry="${g.plate.radius}" fill="${escapeXml(logo.plateColor || bg)}"/>\n`;
      }
      overlay +=
        `<image x="${g.logo.x}" y="${g.logo.y}" width="${g.logo.width}" height="${g.logo.height}" ` +
        `preserveAspectRatio="xMidYMid meet" href="${escapeXml(logo.href)}"/>\n`;
    }

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">\n` +
      `<rect width="${dim}" height="${dim}" fill="${bg}"/>\n` +
      `<path d="${path}" fill="${fg}"/>\n` +
      overlay +
      `</svg>\n`
    );
  }

  // Relative luminance of a "#rrggbb" color, WCAG-style.
  function luminance(hex) {
    const n = parseInt(String(hex).replace("#", ""), 16);
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // True when the modules are lighter than the background. Scanners are allowed
  // to try both polarities and many phone cameras simply don't.
  function isLightOnDark(fg, bg) {
    return luminance(fg) > luminance(bg);
  }

  // Rough WCAG-style contrast ratio between two "#rrggbb" colors.
  function contrastRatio(hex1, hex2) {
    const lum = luminance;
    const l1 = lum(hex1), l2 = lum(hex2);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }

  /* -------------------------- scan verification --------------------------- */

  function joinFixes(list) {
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(", ") + ", or " + list[list.length - 1];
  }

  /**
   * Turns one decode attempt into the verdict the generator shows. Pure, so the
   * copy that matters most — what to change when a code will not scan — is
   * testable without a canvas or a decoder.
   *
   * @param {{decoded:?string, expected:string, inverted:boolean, hasLogo:boolean,
   *          logoPct:number, plate:string, ecl:string, contrast:number}} input
   * @returns {{state:("ok"|"warn"|"fail"), label:string, detail:string}}
   */
  function scanVerdict(input) {
    const i = input || {};
    const expected = i.expected == null ? "" : i.expected;

    if (i.decoded && i.decoded === expected) {
      if (i.inverted) {
        return {
          state: "warn",
          label: "Inverted only",
          detail:
            "This reads only when a scanner tries the colors the other way round, and plenty of phone cameras will not. " +
            "Swap your colors so the modules are darker than the background.",
        };
      }
      return {
        state: "ok",
        label: "Scan-verified",
        detail: "Decoded back to exactly what you typed, in this tab, with the same reader the scan tool uses.",
      };
    }

    if (i.decoded) {
      return {
        state: "fail",
        label: "Wrong data",
        detail: "This scans, but it reads back as something other than your payload. Change a setting to re-mint it.",
      };
    }

    // Ordered by what is most likely to be the actual cause: colors that can
    // never work come first, then the logo, then anything left. Naming the logo
    // first when the two colors are a shade apart sends people the wrong way.
    const fixes = [];
    const pct = Number(i.logoPct) || 0;
    const contrast = typeof i.contrast === "number" ? i.contrast : null;
    const contrastFix = contrast === null ? null :
      "increase the contrast — your two colors are only " + contrast.toFixed(1) + ":1 apart";
    const hopeless = contrast !== null && contrast < 2.5;

    if (hopeless) fixes.push(contrastFix);
    if (i.lightOnDark) {
      fixes.push("swap your colors so the modules are darker than the background — plenty of phone cameras refuse a light-on-dark code");
    }
    if (i.hasLogo && pct > 0) {
      const target = Math.max(LOGO_MIN_PCT, Math.round(pct) - 6);
      fixes.push(
        "shrink the logo from " + Math.round(pct) + "% to about " + target + "%" +
        (i.plate && i.plate !== "none" ? " (or drop its backing plate)" : "")
      );
    }
    if (i.ecl !== "H") fixes.push("raise error correction to H (~30%)");
    if (!hopeless && contrast !== null && contrast < 4) fixes.push(contrastFix);
    if (!fixes.length) fixes.push("widen the margin, or shorten the payload so each module is chunkier");

    return {
      state: "fail",
      label: "Won't scan",
      detail: "This code did not read back. Fix it: " + joinFixes(fixes) + ".",
    };
  }

  /* ============================================================
     Export pure functions for Node-based sanity checks.
     In the browser this block is skipped and the IIFE below runs.
     ============================================================ */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalizeUrl,
      escapeWifiField,
      buildWifiPayload,
      escapeVCardField,
      buildVCardPayload,
      normalizePhone,
      buildPhonePayload,
      buildEmailPayload,
      buildSmsPayload,
      buildWhatsAppPayload,
      formatCoordinate,
      buildGeoPayload,
      renderQrToCanvas,
      buildQrSvg,
      contrastRatio,
      isLightOnDark,
      fitContain,
      logoGeometry,
      eccWithLogo,
      scanVerdict,
      LOGO_MIN_PCT,
      LOGO_MAX_PCT,
    };
  }

  /* ======================================================================
     Browser wiring — everything below touches the DOM.
     ====================================================================== */
  if (typeof document === "undefined") return;

  const QrCode = window.qrcodegen && window.qrcodegen.QrCode;
  const Ecc = QrCode && QrCode.Ecc;
  const ECC_BY_KEY = Ecc ? { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH } : {};

  // Shared with batch.js so the CSV tool draws through exactly the same
  // renderers — one logo geometry, one PNG path, one SVG path, site-wide.
  window.qrmintRender = {
    renderQrToCanvas, buildQrSvg, logoGeometry, eccWithLogo, scanVerdict,
    contrastRatio, isLightOnDark, LOGO_MIN_PCT, LOGO_MAX_PCT,
  };
  // Defined further down; published here so batch.js can build its own logo
  // panel from the same factory rather than growing a second copy of it.
  window.qrmintCreateLogoPanel = (ids, onChange) => createLogoPanel(ids, onChange);
  window.qrmintCreateEccLock = (select, noteEl) => createEccLock(select, noteEl);

  /* jsQR is 258 KB of decoder that a generator page never needs until the
     visitor asks for a verdict, so it is injected on first verify rather than
     shipped with the page. Same origin, no bundler — just a <script> appended
     the first time something actually needs to read a code back. Shared with
     decode.js so the scan tool and the verifier never pull it twice. */
  let decoderPromise = null;
  function ensureDecoder() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/assets/js/jsqr.js";
      // Both failure paths clear the cached promise. Holding on to a rejected
      // one would leave verification broken for the rest of the visit.
      s.onload = () => {
        if (window.jsQR) { resolve(window.jsQR); return; }
        decoderPromise = null;
        reject(new Error("decoder-missing"));
      };
      s.onerror = () => { decoderPromise = null; reject(new Error("decoder-failed")); };
      document.head.appendChild(s);
    });
    return decoderPromise;
  }
  window.qrmintEnsureDecoder = ensureDecoder;

  /**
   * Reads a canvas back through jsQR. Tries the honest orientation first: a
   * code that only decodes inverted is a code half the phones in the room will
   * refuse, and the caller wants to be told that rather than given a pass.
   */
  function decodeCanvas(jsQR, canvas) {
    let image;
    try {
      image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return { blocked: true };
    }
    // jsQR throws rather than returning null on some codes it cannot extract —
    // a badly damaged one, for instance, which is exactly the case that matters
    // here. A throw and a null mean the same thing to us: it did not read back.
    function attempt(mode) {
      try {
        return jsQR(image.data, image.width, image.height, { inversionAttempts: mode });
      } catch (err) {
        return null;
      }
    }
    const straight = attempt("dontInvert");
    if (straight) return { data: straight.data, inverted: false };
    // Falling through to "attemptBoth" rather than "onlyInvert": the vendored
    // jsQR throws on that mode. Anything that reads only on the second pass read
    // only after the scanner flipped the colors, which is the fact we report.
    const flipped = attempt("attemptBoth");
    if (flipped) return { data: flipped.data, inverted: true };
    return { data: null, inverted: false };
  }
  window.qrmintDecodeCanvas = decodeCanvas;

  function flash(el) {
    if (!el) return;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 1100);
  }

  async function copyText(text, flashEl) {
    try {
      await navigator.clipboard.writeText(text);
      flash(flashEl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      flash(flashEl);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ------------------------------ logo panel ------------------------------ */

  const LOGO_TYPES = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml|avif)$/i;
  const LOGO_MAX_BYTES = 4 * 1024 * 1024;

  /**
   * Wires one "Center logo" panel. The file never leaves the tab: FileReader
   * turns it into a data: URI, which is what the canvas draws and what the SVG
   * export embeds — the same bytes in both, so the two exports match.
   *
   * @param {object} ids   element ids for this panel's controls
   * @param {function} onChange  called whenever the logo or its options change
   * @returns {{get: function(): ?object, isActive: function(): boolean}}
   */
  function createLogoPanel(ids, onChange) {
    const fileInput = document.getElementById(ids.file);
    const pickBtn = document.getElementById(ids.pick);
    if (!fileInput || !pickBtn) return { get: () => null, isActive: () => false };

    const clearBtn = document.getElementById(ids.clear);
    const nameEl = document.getElementById(ids.name);
    const thumb = document.getElementById(ids.thumb);
    const optionsEl = document.getElementById(ids.options);
    const sizeInput = document.getElementById(ids.size);
    const sizeOut = document.getElementById(ids.sizeOut);
    const plateSel = document.getElementById(ids.plate);
    const padSel = document.getElementById(ids.pad);
    const errEl = document.getElementById(ids.error);
    const idleText = nameEl ? nameEl.textContent : "";

    let logo = null;

    function setError(message) {
      if (!errEl) return;
      errEl.textContent = message || "";
      errEl.hidden = !message;
    }

    function syncUi() {
      if (optionsEl) optionsEl.hidden = !logo;
      if (clearBtn) clearBtn.hidden = !logo;
      if (nameEl) nameEl.textContent = logo ? logo.name : idleText;
      if (thumb) {
        thumb.hidden = !logo;
        if (logo) thumb.src = logo.href;
        else thumb.removeAttribute("src");
      }
      if (sizeOut && sizeInput) sizeOut.textContent = sizeInput.value + "%";
    }

    function get() {
      if (!logo) return null;
      return {
        image: logo.image,
        href: logo.href,
        imageWidth: logo.width,
        imageHeight: logo.height,
        sizePct: sizeInput ? parseFloat(sizeInput.value) || LOGO_MIN_PCT : 18,
        padPct: padSel ? parseFloat(padSel.value) || 0 : 0.08,
        plate: plateSel ? plateSel.value : "rounded",
      };
    }

    function load(file) {
      if (!file) return;
      if (!LOGO_TYPES.test(file.type || "")) {
        setError("Pick a PNG, JPG, WebP, GIF or SVG image.");
        return;
      }
      if (file.size > LOGO_MAX_BYTES) {
        setError("That file is over 4 MB. A smaller logo keeps your SVG export light — it gets embedded in it.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const href = String(reader.result || "");
        const img = new Image();
        img.onload = () => {
          logo = {
            image: img,
            href,
            // An SVG with no intrinsic size reports 0; treat it as square and
            // let the box decide, rather than dividing by zero later.
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
            name: file.name,
          };
          if (!logo.width || !logo.height) { logo.width = 1; logo.height = 1; }
          setError("");
          syncUi();
          onChange();
        };
        img.onerror = () => setError("That image could not be read — try re-saving it as a PNG.");
        img.src = href;
      };
      reader.onerror = () => setError("That file could not be read.");
      reader.readAsDataURL(file);
    }

    pickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      load(fileInput.files && fileInput.files[0]);
      fileInput.value = ""; // so re-picking the same file fires change again
    });
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        logo = null;
        setError("");
        syncUi();
        onChange();
      });
    }
    [sizeInput, plateSel, padSel].forEach((el) => {
      if (!el) return;
      el.addEventListener("input", () => { syncUi(); onChange(); });
      el.addEventListener("change", () => { syncUi(); onChange(); });
    });

    syncUi();
    return { get, isActive: () => !!logo };
  }

  /**
   * Keeps an error-correction <select> pinned to H while a logo is in place,
   * shows the note that says why, and hands the visitor's own pick back the
   * moment the logo goes.
   */
  function createEccLock(select, noteEl) {
    let saved = null;
    return function apply(hasLogo) {
      if (!select) return;
      if (hasLogo) {
        if (saved === null) saved = select.value;
        select.value = "H";
        select.disabled = true;
      } else {
        if (saved !== null) { select.value = saved; saved = null; }
        select.disabled = false;
      }
      if (noteEl) noteEl.hidden = !hasLogo;
    };
  }

  /* ---------------------------- theme toggle ---------------------------- */

  (function initTheme() {
    const stored = localStorage.getItem("qrmint-theme");
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const current =
        document.documentElement.getAttribute("data-theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("qrmint-theme", next);
    });
  })();

  /* ------------------------------- panels -------------------------------- */

  let currentMode = "url";

  // Figure out which mode(s) this page has. A dedicated page (e.g.
  // wifi-qr-code.html) only ever has one #panel-* in the DOM, so detect the
  // mode from the panel itself. The homepage mounts all of them and gets the
  // instant switching below.
  const panelIdToMode = {
    "panel-url": "url", "panel-wifi": "wifi", "panel-vcard": "vcard", "panel-text": "text",
    "panel-email": "email", "panel-sms": "sms", "panel-whatsapp": "whatsapp",
    "panel-geo": "geo", "panel-phone": "phone",
  };
  const presentModePanels = Object.keys(panelIdToMode).filter((id) => document.getElementById(id));
  if (presentModePanels.length === 1) currentMode = panelIdToMode[presentModePanels[0]];

  // The reader and the CSV batch tool are whole tools rather than another
  // payload type, so they replace the generator's two-column stage instead of
  // feeding it.
  const GENERATOR_MODES = {
    url: true, wifi: true, vcard: true, text: true,
    email: true, sms: true, whatsapp: true, geo: true, phone: true,
  };

  /* ---- homepage instant tool switch ----
     The toolbar's links are real navigation on every page. The homepage is the
     one page that mounts every panel, so there a plain left-click swaps the
     panel in place and pushes the tool's clean URL instead. Both the rail and
     the sheet are wired, so the two routes to a tool behave identically.

     This is no longer a tablist. The roving tabindex that came with that
     pattern shipped five of the six links with tabindex="-1", i.e. out of tab
     order entirely, and announced site navigation as tabs. */
  (function initToolPanels() {
    const PANEL_FOR = {
      "/": "panel-url",
      "/wifi-qr-code": "panel-wifi",
      "/vcard-qr-code": "panel-vcard",
      "/email-qr-code": "panel-email",
      "/sms-qr-code": "panel-sms",
      "/whatsapp-qr-code": "panel-whatsapp",
      "/location-qr-code": "panel-geo",
      "/phone-number-qr-code": "panel-phone",
      "/scan-qr-code": "panel-decode",
      "/bulk-qr-codes": "panel-batch",
    };
    const MODE_FOR_PANEL = {
      "panel-url": "url", "panel-wifi": "wifi", "panel-vcard": "vcard",
      "panel-text": "text", "panel-email": "email", "panel-sms": "sms",
      "panel-whatsapp": "whatsapp", "panel-geo": "geo", "panel-phone": "phone",
      "panel-decode": "decode", "panel-batch": "batch",
    };
    const ALL_PANELS = Object.keys(MODE_FOR_PANEL);
    const panels = {};
    ALL_PANELS.forEach((id) => (panels[id] = document.getElementById(id)));
    // A dedicated tool page mounts one panel: its toolbar links are plain
    // navigation and there is nothing here to do.
    if (!ALL_PANELS.every((id) => panels[id])) return;

    const bar = document.querySelector(".toolbar");
    if (!bar) return;
    const grid = document.getElementById("generator-grid");
    const payloadSwitch = document.getElementById("payload-switch");
    const links = Array.from(bar.querySelectorAll(".tb-rail a[href], .tb-sheet a[href]"));

    function cleanPath(pathname) {
      const p = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "");
      return p || "/";
    }
    function panelForPath(pathname) {
      return PANEL_FOR[cleanPath(pathname)] || null;
    }

    function activate(href, { push = false, payload = null } = {}) {
      // "/" mounts two payload types; which one is showing is remembered so a
      // return trip from Wi-Fi does not silently drop back to Link.
      const id = payload || panelForPath(href) || "panel-url";
      ALL_PANELS.forEach((pid) => {
        const on = pid === id;
        panels[pid].hidden = !on;
        panels[pid].classList.toggle("active", on);
      });
      currentMode = MODE_FOR_PANEL[id];
      const isGenerator = !!GENERATOR_MODES[currentMode];
      if (grid) grid.hidden = !isGenerator;

      // The URL moved, so the marked chip has to move with it.
      const here = cleanPath(href);
      links.forEach((a) => {
        if (cleanPath(a.getAttribute("href")) === here) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });

      // The payload switch belongs to the "/" destination only.
      if (payloadSwitch) {
        payloadSwitch.hidden = !(currentMode === "url" || currentMode === "text");
        payloadSwitch.querySelectorAll("button").forEach((b) => {
          b.setAttribute("aria-pressed", String(b.dataset.payload === currentMode));
        });
      }
      // Leaving the reader must switch the camera light off, not just hide it.
      if (currentMode !== "decode" && typeof window.qrmintStopCamera === "function") window.qrmintStopCamera();
      if (push) history.pushState({ panel: id }, "", href);
      if (isGenerator) scheduleUpdate();
    }

    bar.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]");
      if (!link || !bar.contains(link) || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = link.getAttribute("href");
      if (!panelForPath(href)) return; // the guides hub is real navigation
      e.preventDefault();
      activate(href, { push: true });
      const menu = bar.querySelector("details.tb-menu");
      if (menu) menu.open = false;
    });

    if (payloadSwitch) {
      payloadSwitch.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-payload]");
        if (!btn) return;
        // Same URL either way: this is a parameter of the tool, not a different
        // destination, so it replaces the history entry instead of pushing one.
        const id = btn.dataset.payload === "text" ? "panel-text" : "panel-url";
        activate("/", { payload: id });
        history.replaceState({ panel: id }, "", location.pathname + location.search);
      });
    }

    window.addEventListener("popstate", (e) => {
      const id = e.state && e.state.panel;
      activate(location.pathname, { payload: id === "panel-text" ? id : null });
    });

    activate(location.pathname);
    history.replaceState({ panel: panelForPath(location.pathname) || "panel-url" },
      "", location.pathname + location.search);
  })();

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ------------------------------ generator ------------------------------- */

  (function generator() {
    const canvas = document.getElementById("qr-canvas");
    if (!canvas || !QrCode) return;

    const badge = document.getElementById("mint-badge");
    const stage = document.getElementById("qr-stage");
    const pngBtn = document.getElementById("qr-download-png");
    const svgBtn = document.getElementById("qr-download-svg");
    const copyBtn = document.getElementById("qr-copy-payload");
    const copyFlash = document.getElementById("qr-copy-flash");
    const preview = document.getElementById("qr-payload-preview");
    const metaEl = document.getElementById("qr-meta");
    const warnEl = document.getElementById("qr-warning");
    const emptyEl = document.getElementById("qr-empty");
    const verifyEl = document.getElementById("qr-verify");

    const optSize = document.getElementById("opt-size");
    const optEcl = document.getElementById("opt-ecl");
    const optMargin = document.getElementById("opt-margin");
    const optFg = document.getElementById("opt-fg");
    const optBg = document.getElementById("opt-bg");
    const applyEccLock = createEccLock(optEcl, document.getElementById("opt-ecl-note"));

    // URL panel
    const urlInput = document.getElementById("url-input");

    // WiFi panel
    const wifiSsid = document.getElementById("wifi-ssid");
    const wifiPassword = document.getElementById("wifi-password");
    const wifiEnc = document.getElementById("wifi-enc");
    const wifiHidden = document.getElementById("wifi-hidden");
    const wifiTogglePw = document.getElementById("wifi-toggle-pw");

    // vCard panel
    const vcFirst = document.getElementById("vc-first");
    const vcLast = document.getElementById("vc-last");
    const vcPhone = document.getElementById("vc-phone");
    const vcEmail = document.getElementById("vc-email");
    const vcOrg = document.getElementById("vc-org");
    const vcTitle = document.getElementById("vc-title");
    const vcUrl = document.getElementById("vc-url");
    const vcAddress = document.getElementById("vc-address");

    // Text panel
    const textInput = document.getElementById("text-input");

    // Email panel
    const emTo = document.getElementById("em-to");
    const emSubject = document.getElementById("em-subject");
    const emBody = document.getElementById("em-body");

    // SMS panel
    const smsNumber = document.getElementById("sms-number");
    const smsMessage = document.getElementById("sms-message");

    // WhatsApp panel
    const waNumber = document.getElementById("wa-number");
    const waMessage = document.getElementById("wa-message");

    // Location panel
    const geoLat = document.getElementById("geo-lat");
    const geoLng = document.getElementById("geo-lng");
    const geoFormat = document.getElementById("geo-format");

    // Phone panel
    const telNumber = document.getElementById("tel-number");

    if (wifiTogglePw) {
      wifiTogglePw.addEventListener("click", () => {
        const show = wifiPassword.type === "password";
        wifiPassword.type = show ? "text" : "password";
        wifiTogglePw.textContent = show ? "Hide" : "Show";
      });
    }

    let lastSvg = "";
    let lastPayload = "";

    const logoPanel = createLogoPanel(
      {
        file: "logo-file", pick: "logo-pick", clear: "logo-clear", name: "logo-name",
        thumb: "logo-thumb", options: "logo-options", size: "logo-size",
        sizeOut: "logo-size-out", plate: "logo-plate", pad: "logo-pad", error: "logo-error",
      },
      () => scheduleUpdateInner()
    );

    function currentPayload() {
      if (currentMode === "wifi") {
        return buildWifiPayload({
          ssid: wifiSsid && wifiSsid.value,
          password: wifiPassword && wifiPassword.value,
          enc: wifiEnc ? wifiEnc.value : "WPA",
          hidden: !!(wifiHidden && wifiHidden.checked),
        });
      }
      if (currentMode === "vcard") {
        return buildVCardPayload({
          firstName: vcFirst && vcFirst.value,
          lastName: vcLast && vcLast.value,
          phone: vcPhone && vcPhone.value,
          email: vcEmail && vcEmail.value,
          org: vcOrg && vcOrg.value,
          title: vcTitle && vcTitle.value,
          url: vcUrl && vcUrl.value,
          address: vcAddress && vcAddress.value,
        });
      }
      if (currentMode === "text") {
        return (textInput && textInput.value) || "";
      }
      if (currentMode === "email") {
        return buildEmailPayload({
          to: emTo && emTo.value,
          subject: emSubject && emSubject.value,
          body: emBody && emBody.value,
        });
      }
      if (currentMode === "sms") {
        return buildSmsPayload({
          number: smsNumber && smsNumber.value,
          message: smsMessage && smsMessage.value,
        });
      }
      if (currentMode === "whatsapp") {
        return buildWhatsAppPayload({
          number: waNumber && waNumber.value,
          message: waMessage && waMessage.value,
        });
      }
      if (currentMode === "geo") {
        return buildGeoPayload({
          lat: geoLat && geoLat.value,
          lng: geoLng && geoLng.value,
          mapsUrl: geoFormat ? geoFormat.value !== "geo" : true,
        });
      }
      if (currentMode === "phone") {
        return buildPhonePayload({ number: telNumber && telNumber.value });
      }
      // url (default)
      return normalizeUrl(urlInput && urlInput.value);
    }

    function setEmpty(message) {
      const ctx = canvas.getContext("2d");
      const s = canvas.width || 220;
      ctx.clearRect(0, 0, s, s);
      if (badge) badge.classList.remove("show");
      if (pngBtn) pngBtn.disabled = true;
      if (svgBtn) svgBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
      if (preview) preview.textContent = "";
      if (metaEl) metaEl.textContent = "";
      if (warnEl) warnEl.hidden = true;
      if (emptyEl) {
        emptyEl.textContent = message;
        emptyEl.hidden = false;
      }
      cancelVerify();
      lastSvg = "";
      lastPayload = "";
    }

    function render() {
      const payload = currentPayload().trim();
      const logo = logoPanel.get();
      applyEccLock(!!logo);
      if (!payload) {
        setEmpty(emptyMessageFor(currentMode));
        return;
      }

      const fg = (optFg && optFg.value) || "#0b2119";
      const bg = (optBg && optBg.value) || "#ffffff";
      const margin = optMargin ? parseInt(optMargin.value, 10) || 4 : 4;
      const targetPx = optSize ? parseInt(optSize.value, 10) || 512 : 512;
      // A logo blanks out modules, so H is not a suggestion here — it is the
      // level that makes the logo survivable, and the note by the control says so.
      const ecl = eccWithLogo(optEcl ? optEcl.value : "M", !!logo);

      let qr;
      try {
        qr = QrCode.encodeText(payload, ECC_BY_KEY[ecl] || Ecc.MEDIUM);
      } catch (err) {
        setEmpty("That's too much data for a scannable QR code — try a shorter message or a lower error-correction level.");
        return;
      }

      if (emptyEl) emptyEl.hidden = true;
      const px = renderQrToCanvas(qr, canvas, { targetPx, margin, fg, bg, logo });
      canvas.style.width = "220px";
      canvas.style.height = "220px";
      lastSvg = buildQrSvg(qr, { margin, fg, bg, logo });
      lastPayload = payload;

      if (pngBtn) pngBtn.disabled = false;
      if (svgBtn) svgBtn.disabled = false;
      if (copyBtn) copyBtn.disabled = false;
      if (preview) preview.textContent = payload;

      const eclNames = { 1: "L", 0: "M", 3: "Q", 2: "H" };
      if (metaEl) {
        metaEl.textContent =
          `v${qr.version} · ${qr.size}×${qr.size} modules · EC ${eclNames[qr.errorCorrectionLevel.formatBits]} · ${px}×${px}px`;
      }

      const ratio = contrastRatio(fg, bg);
      if (warnEl) {
        warnEl.hidden = ratio >= 4;
        if (ratio < 4) warnEl.textContent = "Low contrast between your colors may stop this code from scanning reliably.";
      }

      scheduleVerify({ qr, margin, fg, bg, logo, payload, ecl, contrast: ratio, lightOnDark: isLightOnDark(fg, bg) });
    }

    /* ------------------------- scan verification ------------------------- */

    // Verification re-draws the code at a modest size instead of reading the
    // export-sized canvas: same geometry, same logo, same colors, a fraction of
    // the pixels — so the check stays a few milliseconds and the tab stays live.
    const VERIFY_PX = 480;
    let verifyToken = 0;

    function setVerdict(state, label, detail) {
      if (!verifyEl) return;
      verifyEl.hidden = false;
      verifyEl.className = "scan-verdict is-" + state;
      verifyEl.textContent = "";
      const badgeEl = document.createElement("span");
      badgeEl.className = "verdict-badge";
      badgeEl.textContent = label;
      const detailEl = document.createElement("span");
      detailEl.className = "verdict-detail";
      detailEl.textContent = detail;
      verifyEl.append(badgeEl, detailEl);
    }

    function cancelVerify() {
      verifyToken++;
      if (verifyEl) verifyEl.hidden = true;
    }

    function runVerify(ctx) {
      if (!verifyEl) return;
      const token = ++verifyToken;
      setVerdict("checking", "Checking…", "Reading the code back to make sure it still scans.");
      ensureDecoder().catch(() => {
        // Only a failed *load* belongs here. Anything the decode itself throws is
        // a verdict, not an outage, and must not be dressed up as one.
        if (token === verifyToken) setVerdict("warn", "Not verified", "The reader could not be loaded, so this code was not scanned back.");
        return null;
      }).then((jsQR) => {
        if (!jsQR) return;
        if (token !== verifyToken) return; // a newer render already superseded this
        const off = document.createElement("canvas");
        renderQrToCanvas(ctx.qr, off, {
          targetPx: VERIFY_PX, margin: ctx.margin, fg: ctx.fg, bg: ctx.bg, logo: ctx.logo,
        });
        const read = decodeCanvas(jsQR, off);
        if (token !== verifyToken) return;
        if (read.blocked) {
          setVerdict("warn", "Not verified", "That logo file blocks the browser from reading the canvas back. Re-save it as a PNG to get a verdict.");
          return;
        }
        const verdict = scanVerdict({
          decoded: read.data,
          expected: ctx.payload,
          inverted: read.inverted,
          hasLogo: !!ctx.logo,
          logoPct: ctx.logo && ctx.logo.sizePct,
          plate: ctx.logo && ctx.logo.plate,
          ecl: ctx.ecl,
          contrast: ctx.contrast,
          lightOnDark: ctx.lightOnDark,
        });
        setVerdict(verdict.state, verdict.label, verdict.detail);
      }).catch(() => {
        // Belt and braces: never leave the badge stuck on "Checking…".
        if (token === verifyToken) setVerdict("warn", "Not verified", "Something went wrong reading this code back, so it has not been checked.");
      });
    }

    const scheduleVerify = debounce(runVerify, 260);

    function emptyMessageFor(mode) {
      if (mode === "wifi") return "Enter a network name to mint your Wi-Fi QR code.";
      if (mode === "vcard") return "Enter at least a name or organization to mint your contact card.";
      if (mode === "text") return "Type something to mint a QR code.";
      if (mode === "email") return "Enter an email address to mint your code.";
      if (mode === "sms") return "Enter a phone number to mint your SMS code.";
      if (mode === "whatsapp") return "Enter a number with its country code to mint your WhatsApp code.";
      if (mode === "geo") return "Enter a latitude and longitude to mint your location code.";
      if (mode === "phone") return "Enter a phone number to mint your call code.";
      return "Enter a link to mint your QR code.";
    }

    const scheduleUpdateInner = debounce(render, 120);
    window.scheduleUpdate = scheduleUpdateInner;

    [
      urlInput, wifiSsid, wifiPassword, wifiEnc, wifiHidden,
      vcFirst, vcLast, vcPhone, vcEmail, vcOrg, vcTitle, vcUrl, vcAddress,
      textInput, emTo, emSubject, emBody, smsNumber, smsMessage,
      waNumber, waMessage, geoLat, geoLng, geoFormat, telNumber,
      optSize, optEcl, optMargin, optFg, optBg,
    ].forEach((el) => {
      if (!el) return;
      const evt = el.tagName === "SELECT" || el.type === "checkbox" || el.type === "color" ? "input" : "input";
      el.addEventListener(evt, scheduleUpdateInner);
      el.addEventListener("change", scheduleUpdateInner);
    });

    function mint(download) {
      if (!lastPayload) return;
      if (stage) {
        stage.classList.remove("stamp-press");
        void stage.offsetWidth; // restart animation
        stage.classList.add("stamp-press");
      }
      if (badge) badge.classList.add("show");
      download();
    }

    if (pngBtn) {
      pngBtn.addEventListener("click", () => {
        mint(() => {
          // A logo the browser refuses to let us read back taints the canvas;
          // say so instead of failing silently on the download click.
          try {
            canvas.toBlob((blob) => blob && triggerDownload(blob, "qrmint-qr-code.png"));
          } catch (err) {
            setVerdict("warn", "PNG blocked", "The browser won't export a PNG with that logo file in it. Re-save the logo as a PNG, or download the SVG instead.");
          }
        });
      });
    }
    if (svgBtn) {
      svgBtn.addEventListener("click", () => {
        mint(() => {
          const blob = new Blob([lastSvg], { type: "image/svg+xml" });
          triggerDownload(blob, "qrmint-qr-code.svg");
        });
      });
    }
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        if (lastPayload) copyText(lastPayload, copyFlash);
      });
    }

    render();
  })();
})();
