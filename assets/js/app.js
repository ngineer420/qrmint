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

  /* ---------------------------- rendering -------------------------------- */

  // Draws the given qrcodegen.QrCode onto a canvas. Returns the final pixel
  // dimension actually used (an integer multiple of the module count).
  function renderQrToCanvas(qr, canvas, { targetPx, margin, fg, bg }) {
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
    return px;
  }

  // Builds a compact, crisp vector SVG string for the given QR code.
  function buildQrSvg(qr, { margin, fg, bg }) {
    const dim = qr.size + margin * 2;
    let path = "";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) path += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">\n` +
      `<rect width="${dim}" height="${dim}" fill="${bg}"/>\n` +
      `<path d="${path}" fill="${fg}"/>\n` +
      `</svg>\n`
    );
  }

  // Rough WCAG-style contrast ratio between two "#rrggbb" colors.
  function contrastRatio(hex1, hex2) {
    function lum(hex) {
      const n = parseInt(hex.replace("#", ""), 16);
      const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }
    const l1 = lum(hex1), l2 = lum(hex2);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
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
      renderQrToCanvas,
      buildQrSvg,
      contrastRatio,
    };
  }

  /* ======================================================================
     Browser wiring — everything below touches the DOM.
     ====================================================================== */
  if (typeof document === "undefined") return;

  const QrCode = window.qrcodegen && window.qrcodegen.QrCode;
  const Ecc = QrCode && QrCode.Ecc;

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

  /* ------------------------------- tabs ---------------------------------- */

  let currentMode = "url";

  // Figure out which mode(s) this page has. A dedicated page (e.g.
  // wifi-qr-code.html) only ever has one #panel-* in the DOM, regardless of
  // whether its tabbar links carry ids — so detect the mode from the panel
  // itself, not from the tabbar. The homepage has all four panels and gets
  // full tabbed switching.
  const modeOf = {
    "tab-url": "url", "tab-wifi": "wifi", "tab-vcard": "vcard", "tab-text": "text",
    "tab-decode": "decode", "tab-batch": "batch",
  };
  const panelIdToMode = { "panel-url": "url", "panel-wifi": "wifi", "panel-vcard": "vcard", "panel-text": "text" };
  const presentModePanels = Object.keys(panelIdToMode).filter((id) => document.getElementById(id));
  if (presentModePanels.length === 1) currentMode = panelIdToMode[presentModePanels[0]];

  // The reader and the CSV batch tool are whole tools rather than another
  // payload type, so they replace the generator's two-column stage instead of
  // feeding it.
  const GENERATOR_MODES = { url: true, wifi: true, vcard: true, text: true };

  (function initTabs() {
    const tabIds = ["tab-url", "tab-wifi", "tab-vcard", "tab-text", "tab-decode", "tab-batch"];
    const tabs = tabIds.map((id) => document.getElementById(id)).filter(Boolean);
    const panels = {};
    tabs.forEach((t) => {
      const p = document.getElementById(t.getAttribute("aria-controls"));
      if (p) panels[t.id] = p;
    });

    const isHomepage = tabs.length > 0 && tabs.every((t) => panels[t.id]);
    if (!isHomepage) return;

    function select(tab, { focus = false, push = false } = {}) {
      tabs.forEach((t) => {
        const active = t === tab;
        t.setAttribute("aria-selected", String(active));
        t.tabIndex = active ? 0 : -1;
        t.classList.toggle("is-active", active);
        if (active) t.setAttribute("aria-current", "page");
        else t.removeAttribute("aria-current");
        panels[t.id].hidden = !active;
        panels[t.id].classList.toggle("active", active);
      });
      currentMode = modeOf[tab.id];
      const isGenerator = !!GENERATOR_MODES[currentMode];
      const grid = document.getElementById("generator-grid");
      if (grid) grid.hidden = !isGenerator;
      // Leaving the reader must switch the camera light off, not just hide it.
      if (currentMode !== "decode" && typeof window.qrmintStopCamera === "function") window.qrmintStopCamera();
      if (push) history.pushState({ tool: tab.id }, "", tab.getAttribute("href"));
      if (focus) tab.focus();
      if (isGenerator) scheduleUpdate();
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(tab, { push: true });
      });
      tab.addEventListener("keydown", (e) => {
        let target;
        if (e.key === "ArrowRight") target = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") target = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") target = tabs[0];
        else if (e.key === "End") target = tabs[tabs.length - 1];
        if (!target) return;
        e.preventDefault();
        select(target, { focus: true, push: true });
      });
    });

    window.addEventListener("popstate", (e) => {
      const id = (e.state && e.state.tool) || "tab-url";
      select(document.getElementById(id) || tabs[0], { focus: false, push: false });
    });

    const current = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
    history.replaceState({ tool: current.id }, "", location.pathname + location.search);
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

    const optSize = document.getElementById("opt-size");
    const optEcl = document.getElementById("opt-ecl");
    const optMargin = document.getElementById("opt-margin");
    const optFg = document.getElementById("opt-fg");
    const optBg = document.getElementById("opt-bg");

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

    if (wifiTogglePw) {
      wifiTogglePw.addEventListener("click", () => {
        const show = wifiPassword.type === "password";
        wifiPassword.type = show ? "text" : "password";
        wifiTogglePw.textContent = show ? "Hide" : "Show";
      });
    }

    let lastSvg = "";
    let lastPayload = "";

    function eccFromSelect() {
      const v = optEcl ? optEcl.value : "M";
      return { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH }[v] || Ecc.MEDIUM;
    }

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
      lastSvg = "";
      lastPayload = "";
    }

    function render() {
      const payload = currentPayload().trim();
      if (!payload) {
        setEmpty(emptyMessageFor(currentMode));
        return;
      }

      const fg = (optFg && optFg.value) || "#0b2119";
      const bg = (optBg && optBg.value) || "#ffffff";
      const margin = optMargin ? parseInt(optMargin.value, 10) || 4 : 4;
      const targetPx = optSize ? parseInt(optSize.value, 10) || 512 : 512;

      let qr;
      try {
        qr = QrCode.encodeText(payload, eccFromSelect());
      } catch (err) {
        setEmpty("That's too much data for a scannable QR code — try a shorter message or a lower error-correction level.");
        return;
      }

      if (emptyEl) emptyEl.hidden = true;
      const px = renderQrToCanvas(qr, canvas, { targetPx, margin, fg, bg });
      canvas.style.width = "220px";
      canvas.style.height = "220px";
      lastSvg = buildQrSvg(qr, { margin, fg, bg });
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

      if (warnEl) {
        const ratio = contrastRatio(fg, bg);
        warnEl.hidden = ratio >= 4;
        if (ratio < 4) warnEl.textContent = "Low contrast between your colors may stop this code from scanning reliably.";
      }
    }

    function emptyMessageFor(mode) {
      if (mode === "wifi") return "Enter a network name to mint your Wi-Fi QR code.";
      if (mode === "vcard") return "Enter at least a name or organization to mint your contact card.";
      if (mode === "text") return "Type something to mint a QR code.";
      return "Enter a link to mint your QR code.";
    }

    const scheduleUpdateInner = debounce(render, 120);
    window.scheduleUpdate = scheduleUpdateInner;

    [
      urlInput, wifiSsid, wifiPassword, wifiEnc, wifiHidden,
      vcFirst, vcLast, vcPhone, vcEmail, vcOrg, vcTitle, vcUrl, vcAddress,
      textInput, optSize, optEcl, optMargin, optFg, optBg,
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
        mint(() => canvas.toBlob((blob) => blob && triggerDownload(blob, "qrmint-qr-code.png")));
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
