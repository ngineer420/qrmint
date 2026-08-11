/* qrmint.net — QR code reader.
 *
 * Two inputs, one decoder: a still image (drop / pick / paste) and a live
 * camera feed. Both end up as a raw RGBA buffer handed to the vendored jsQR
 * (see jsqr.js). Nothing is uploaded — there is no server to upload to.
 *
 * The pure payload parsers at the top have no DOM dependency and are exported
 * for node-based tests; everything below the export guard is browser wiring.
 */
(() => {
  "use strict";

  /* ======================================================================
     Payload parsing (pure)

     A decoded QR is just a string. What makes the result useful is knowing
     that "WIFI:T:WPA;S:..." is a network and "BEGIN:VCARD" is a person, and
     pulling the fields out of each. These are the inverse of the payload
     builders in app.js.
     ====================================================================== */

  // Splits on *unescaped* occurrences of `sep`, leaving escape sequences
  // intact for a single unescape pass later. The WIFI: and MECARD: formats
  // both escape \ ; , : and " with a backslash. Unescaping here as well as in
  // splitKeyValue would eat one level too many: a password of `a\;b` would
  // come back as `a;b`.
  function splitEscaped(text, sep) {
    const out = [];
    let cur = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        cur += ch + text[++i];
      } else if (ch === sep) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  // Splits "KEY:value" at the first *unescaped* colon.
  function splitKeyValue(token) {
    for (let i = 0; i < token.length; i++) {
      if (token[i] === "\\") { i++; continue; }
      if (token[i] === ":") {
        return [token.slice(0, i), unescapeBackslashes(token.slice(i + 1))];
      }
    }
    return [unescapeBackslashes(token), ""];
  }

  function unescapeBackslashes(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) out += s[++i];
      else out += s[i];
    }
    return out;
  }

  const WIFI_AUTH_LABELS = {
    WPA: "WPA / WPA2 / WPA3",
    WPA2: "WPA / WPA2 / WPA3",
    WPA3: "WPA3",
    WEP: "WEP",
    nopass: "Open (no password)",
    "": "Open (no password)",
  };

  // "WIFI:T:WPA;S:My Net;P:secret;H:true;;" -> { ssid, password, auth, hidden }
  function parseWifiPayload(text) {
    if (!/^WIFI:/i.test(text)) return null;
    const body = text.slice(5);
    const out = { ssid: "", password: "", auth: "", hidden: false };
    splitEscaped(body, ";").forEach((token) => {
      if (!token) return;
      const [rawKey, value] = splitKeyValue(token);
      const key = rawKey.trim().toUpperCase();
      if (key === "S") out.ssid = value;
      else if (key === "P") out.password = value;
      else if (key === "T") out.auth = value;
      else if (key === "H") out.hidden = /^(true|1|yes)$/i.test(value);
    });
    return out;
  }

  // Unfolds RFC 6350 continuation lines and unescapes \n \, \; \\.
  function unfoldVCard(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    lines.forEach((line) => {
      if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
      else out.push(line);
    });
    return out;
  }

  function unescapeVCardValue(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== "\\" || i + 1 >= s.length) { out += s[i]; continue; }
      const next = s[++i];
      if (next === "n" || next === "N") out += "\n";
      else out += next;
    }
    return out;
  }

  const VCARD_LABELS = {
    FN: "Name",
    ORG: "Organization",
    TITLE: "Job title",
    TEL: "Phone",
    EMAIL: "Email",
    URL: "Website",
    ADR: "Address",
    NOTE: "Note",
    BDAY: "Birthday",
  };

  // Returns [{label, value}] for the properties worth showing, in a stable order.
  function parseVCard(text) {
    const fields = [];
    let name = "";
    const structured = {};
    unfoldVCard(text).forEach((line) => {
      const colon = line.indexOf(":");
      if (colon < 0) return;
      const nameAndParams = line.slice(0, colon);
      const value = unescapeVCardValue(line.slice(colon + 1)).trim();
      const prop = nameAndParams.split(";")[0].trim().toUpperCase();
      if (!value || prop === "BEGIN" || prop === "END" || prop === "VERSION") return;
      if (prop === "N") {
        // N is Family;Given;Middle;Prefix;Suffix
        const parts = value.split(";").map((p) => p.trim());
        structured.n = [parts[3], parts[1], parts[2], parts[0], parts[4]].filter(Boolean).join(" ");
        return;
      }
      if (prop === "FN") { name = value; return; }
      if (prop === "ADR") {
        // ADR is PO;Ext;Street;Locality;Region;Postcode;Country
        const joined = value.split(";").map((p) => p.trim()).filter(Boolean).join(", ");
        if (joined) fields.push({ label: "Address", value: joined });
        return;
      }
      const label = VCARD_LABELS[prop];
      if (label) fields.push({ label, value: value.replace(/\n/g, ", ") });
    });
    const displayName = name || structured.n;
    if (displayName) fields.unshift({ label: "Name", value: displayName });
    return fields;
  }

  // "MECARD:N:Doe,John;TEL:555;;" — the older NTT DoCoMo contact format.
  function parseMeCard(text) {
    const fields = [];
    const labels = { N: "Name", TEL: "Phone", EMAIL: "Email", URL: "Website", ADR: "Address", ORG: "Organization", NOTE: "Note" };
    splitEscaped(text.slice(7), ";").forEach((token) => {
      if (!token) return;
      const [rawKey, value] = splitKeyValue(token);
      const key = rawKey.trim().toUpperCase();
      if (!value || !labels[key]) return;
      const shown = key === "N" ? value.split(",").reverse().map((p) => p.trim()).filter(Boolean).join(" ") : value;
      fields.push({ label: labels[key], value: shown });
    });
    return fields;
  }

  function parseQueryFields(query, labels) {
    const fields = [];
    if (!query) return fields;
    query.split("&").forEach((pair) => {
      if (!pair) return;
      const eq = pair.indexOf("=");
      const key = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      if (!value) return;
      fields.push({ label: labels[key.toLowerCase()] || key, value: value });
    });
    return fields;
  }

  /**
   * Classify and unpack a decoded QR payload.
   * @returns {{kind, label, fields: Array<{label, value}>, link: string|null,
   *            sensitive: boolean, raw: string}}
   */
  function parseDecodedPayload(raw) {
    const text = raw == null ? "" : String(raw);
    const trimmed = text.trim();

    if (/^WIFI:/i.test(trimmed)) {
      const wifi = parseWifiPayload(trimmed);
      const fields = [{ label: "Network (SSID)", value: wifi.ssid }];
      if (wifi.password) fields.push({ label: "Password", value: wifi.password, secret: true });
      fields.push({ label: "Security", value: WIFI_AUTH_LABELS[wifi.auth] || wifi.auth });
      if (wifi.hidden) fields.push({ label: "Hidden network", value: "Yes" });
      return { kind: "wifi", label: "Wi-Fi network", fields, link: null, sensitive: !!wifi.password, raw: text };
    }

    if (/^BEGIN:VCARD/i.test(trimmed)) {
      return { kind: "vcard", label: "Contact card", fields: parseVCard(trimmed), link: null, sensitive: true, raw: text };
    }

    if (/^MECARD:/i.test(trimmed)) {
      return { kind: "vcard", label: "Contact card (MECARD)", fields: parseMeCard(trimmed), link: null, sensitive: true, raw: text };
    }

    if (/^BEGIN:VEVENT/i.test(trimmed) || /^BEGIN:VCALENDAR/i.test(trimmed)) {
      const fields = [];
      const labels = { SUMMARY: "Event", LOCATION: "Location", DTSTART: "Starts", DTEND: "Ends", DESCRIPTION: "Description" };
      unfoldVCard(trimmed).forEach((line) => {
        const colon = line.indexOf(":");
        if (colon < 0) return;
        const prop = line.slice(0, colon).split(";")[0].trim().toUpperCase();
        const value = unescapeVCardValue(line.slice(colon + 1)).trim();
        if (labels[prop] && value) fields.push({ label: labels[prop], value });
      });
      return { kind: "event", label: "Calendar event", fields, link: null, sensitive: false, raw: text };
    }

    if (/^mailto:/i.test(trimmed)) {
      const rest = trimmed.slice(7);
      const q = rest.indexOf("?");
      const fields = [{ label: "To", value: decodeURIComponent(q < 0 ? rest : rest.slice(0, q)) }];
      if (q >= 0) fields.push(...parseQueryFields(rest.slice(q + 1), { subject: "Subject", body: "Message", cc: "Cc", bcc: "Bcc" }));
      return { kind: "email", label: "Email address", fields, link: trimmed, sensitive: false, raw: text };
    }

    if (/^tel:/i.test(trimmed)) {
      return { kind: "tel", label: "Phone number", fields: [{ label: "Number", value: trimmed.slice(4) }], link: trimmed, sensitive: false, raw: text };
    }

    if (/^smsto:/i.test(trimmed) || /^sms:/i.test(trimmed)) {
      const isSmsto = /^smsto:/i.test(trimmed);
      const rest = trimmed.slice(isSmsto ? 6 : 4);
      const parts = isSmsto ? rest.split(":") : rest.split("?body=");
      const fields = [{ label: "Number", value: parts[0] }];
      if (parts[1]) fields.push({ label: "Message", value: isSmsto ? parts.slice(1).join(":") : decodeURIComponent(parts[1]) });
      return { kind: "sms", label: "SMS message", fields, link: null, sensitive: false, raw: text };
    }

    if (/^geo:/i.test(trimmed)) {
      const coords = trimmed.slice(4).split(";")[0].split(",");
      const fields = [{ label: "Latitude", value: coords[0] || "" }, { label: "Longitude", value: coords[1] || "" }];
      if (coords[2]) fields.push({ label: "Altitude", value: coords[2] });
      return { kind: "geo", label: "Geographic location", fields, link: trimmed, sensitive: false, raw: text };
    }

    // otpauth:// carries a two-factor seed. Anyone who scans it owns the
    // second factor forever, so it gets the loudest warning we have.
    if (/^otpauth:\/\//i.test(trimmed)) {
      let fields = [];
      try {
        const u = new URL(trimmed);
        fields.push({ label: "Account", value: decodeURIComponent(u.pathname.replace(/^\//, "")) });
        u.searchParams.forEach((value, key) => {
          fields.push({ label: key === "secret" ? "Secret" : key, value, secret: key === "secret" });
        });
      } catch (e) {
        fields = [{ label: "Payload", value: trimmed, secret: true }];
      }
      return { kind: "otp", label: "Two-factor authentication seed", fields, link: null, sensitive: true, raw: text };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const fields = [{ label: "URL", value: trimmed }];
      try {
        const u = new URL(trimmed);
        fields.push({ label: "Host", value: u.host });
      } catch (e) { /* keep the raw URL only */ }
      return { kind: "url", label: "Website link", fields, link: trimmed, sensitive: false, raw: text };
    }

    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    if (scheme) {
      return {
        kind: "uri",
        label: scheme[1].toLowerCase() + ": link",
        fields: [{ label: "Payload", value: trimmed }],
        link: null,
        sensitive: false,
        raw: text,
      };
    }

    return { kind: "text", label: "Plain text", fields: [{ label: "Text", value: text }], link: null, sensitive: false, raw: text };
  }

  /* ============================================================
     Export the pure parsers for Node-based tests.
     ============================================================ */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      splitEscaped,
      unescapeBackslashes,
      parseWifiPayload,
      parseVCard,
      parseMeCard,
      parseDecodedPayload,
    };
  }

  /* ======================================================================
     Browser wiring
     ====================================================================== */
  if (typeof document === "undefined") return;

  const root = document.getElementById("decode-tool");
  if (!root) return;

  const dropZone = document.getElementById("decode-drop");
  const fileInput = document.getElementById("decode-file");
  const pickBtn = document.getElementById("decode-pick");
  const idleEl = document.getElementById("decode-idle");
  const cameraBtn = document.getElementById("decode-camera-btn");
  const cameraStopBtn = document.getElementById("decode-camera-stop");
  const video = document.getElementById("decode-video");
  const videoWrap = document.getElementById("decode-video-wrap");
  const statusEl = document.getElementById("decode-status");
  const resultEl = document.getElementById("decode-result");
  const previewImg = document.getElementById("decode-preview");
  const canvas = document.createElement("canvas");

  /* jsQR is 250 KB of decoder that most visitors never need, so it is fetched
     on first use rather than blocking first paint. Still same-origin, still no
     bundler — just a <script> appended when the tool is actually used. */
  let decoderPromise = null;
  function ensureDecoder() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/assets/js/jsqr.js";
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error("decoder-missing")));
      s.onerror = () => { decoderPromise = null; reject(new Error("decoder-failed")); };
      document.head.appendChild(s);
    });
    return decoderPromise;
  }

  function setStatus(message, tone) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.hidden = !message;
    statusEl.className = "decode-status" + (tone ? " is-" + tone : "");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  let lastRaw = "";

  function renderResult(text) {
    lastRaw = text;
    const parsed = parseDecodedPayload(text);
    const rows = parsed.fields
      .filter((f) => f.value !== "" && f.value != null)
      .map(
        (f) =>
          '<div class="decode-row"><div class="decode-row-label">' +
          escapeHtml(f.label) +
          '</div><div class="decode-row-value' +
          (f.secret ? " is-secret" : "") +
          '">' +
          escapeHtml(f.value) +
          "</div></div>"
      )
      .join("");

    let html =
      '<div class="decode-kind"><span class="decode-badge">' +
      escapeHtml(parsed.label) +
      "</span></div>" +
      '<div class="decode-fields">' +
      rows +
      "</div>";

    if (parsed.sensitive) {
      html +=
        '<p class="decode-caution">This code carries a secret. It was decoded here in your browser and never sent anywhere — but treat what is above the way you would treat the password itself.</p>';
    }

    if (parsed.link) {
      html +=
        '<p class="decode-open"><a href="' +
        escapeHtml(parsed.link) +
        '" target="_blank" rel="noopener noreferrer nofollow">Open this link in a new tab ↗</a> <span class="field-hint">Check the address above before you do — a QR code can point anywhere.</span></p>';
    }

    html +=
      '<div class="decode-raw-wrap"><div class="decode-row-label">Raw payload</div>' +
      '<div class="payload-preview">' +
      escapeHtml(text) +
      "</div></div>" +
      '<div class="qr-actions decode-actions"><div class="copy-flash-wrap">' +
      '<button type="button" class="primary" id="decode-copy">Copy decoded text</button>' +
      '<span class="copy-flash" id="decode-copy-flash">Copied!</span></div>' +
      '<button type="button" class="icon-btn" id="decode-reset">Scan another</button></div>';

    resultEl.innerHTML = html;
    resultEl.hidden = false;
    if (idleEl) idleEl.hidden = true;

    const copyBtn = document.getElementById("decode-copy");
    const copyFlash = document.getElementById("decode-copy-flash");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(lastRaw);
        } catch (e) {
          const ta = document.createElement("textarea");
          ta.value = lastRaw;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        if (copyFlash) {
          copyFlash.classList.add("show");
          setTimeout(() => copyFlash.classList.remove("show"), 1100);
        }
      });
    }
    const resetBtn = document.getElementById("decode-reset");
    if (resetBtn) resetBtn.addEventListener("click", reset);
  }

  function reset() {
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    if (idleEl) idleEl.hidden = false;
    if (previewImg) { previewImg.hidden = true; previewImg.removeAttribute("src"); }
    setStatus("", null);
    if (fileInput) fileInput.value = "";
  }

  // Draws the source at `scale` and runs the decoder over the pixels.
  function scanSource(source, width, height, scale, jsQR, inversion) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: inversion || "attemptBoth" });
  }

  // Phone photos are far bigger than the decoder needs, and a code that
  // misses at full resolution often lands at a smaller one, so try a ladder.
  const SCALE_LADDER = [1, 0.6, 0.35];
  const MAX_EDGE = 1600;

  function decodeStill(source, width, height, jsQR) {
    const cap = Math.min(1, MAX_EDGE / Math.max(width, height));
    for (const step of SCALE_LADDER) {
      const result = scanSource(source, width, height, cap * step, jsQR);
      if (result && result.data) return result;
    }
    return null;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setStatus("That is not an image file. Drop a PNG, JPG, GIF, WebP or SVG containing a QR code.", "error");
      return;
    }
    reset();
    setStatus("Reading the image…", null);
    let jsQR;
    try {
      jsQR = await ensureDecoder();
    } catch (e) {
      setStatus("The decoder could not be loaded. Check your connection and reload the page.", "error");
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (previewImg) {
        previewImg.src = url;
        previewImg.hidden = false;
      }
      const result = decodeStill(img, img.naturalWidth, img.naturalHeight, jsQR);
      if (result && result.data) {
        setStatus("Decoded.", "ok");
        renderResult(result.data);
      } else {
        setStatus(
          "No QR code found in that image. Try a sharper or more tightly cropped picture — the whole code, including its quiet border, needs to be visible.",
          "error"
        );
      }
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus("That image could not be opened.", "error");
    };
    img.src = url;
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => handleFile(fileInput.files && fileInput.files[0]));
  }
  if (pickBtn && fileInput) pickBtn.addEventListener("click", () => fileInput.click());

  if (dropZone) {
    ["dragenter", "dragover"].forEach((evt) =>
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropZone.classList.add("is-dragging");
      })
    );
    ["dragleave", "dragend", "drop"].forEach((evt) =>
      dropZone.addEventListener(evt, () => dropZone.classList.remove("is-dragging"))
    );
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(file);
    });
  }

  // Paste a screenshot straight in — the fastest path for a code on screen.
  // On the homepage the reader is one tab among several, so a paste aimed at
  // another tool must not be hijacked into a decode.
  const ownPanel = root.closest(".tab-panel");
  document.addEventListener("paste", (e) => {
    if (ownPanel && ownPanel.hidden) return;
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const imageItem = items.find((it) => it.type && it.type.indexOf("image/") === 0);
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (file) {
      e.preventDefault();
      handleFile(file);
    }
  });

  /* ------------------------------ camera -------------------------------- */

  let stream = null;
  let rafId = 0;

  function stopCamera() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    if (videoWrap) videoWrap.hidden = true;
    if (cameraStopBtn) cameraStopBtn.hidden = true;
    if (cameraBtn) cameraBtn.hidden = false;
  }

  function cameraErrorMessage(err) {
    const name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      return "Camera access was blocked. Allow the camera for this site in your browser's address bar, or use the image upload above instead.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      return "No camera was found on this device. You can still decode a saved photo or screenshot with the upload above.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "The camera is already in use by another app. Close it and try again, or upload an image instead.";
    }
    return "The camera could not be started on this device. Uploading an image works the same way.";
  }

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function startCamera() {
    if (!cameraSupported()) {
      setStatus(
        "This browser will not open a camera here — that usually means the page is not on a secure (https) connection. The image upload above works either way.",
        "error"
      );
      return;
    }
    let jsQR;
    try {
      jsQR = await ensureDecoder();
    } catch (e) {
      setStatus("The decoder could not be loaded. Check your connection and reload the page.", "error");
      return;
    }
    setStatus("Asking for camera permission…", null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      setStatus(cameraErrorMessage(err), "error");
      stopCamera();
      return;
    }

    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    try {
      await video.play();
    } catch (e) {
      // Autoplay refusals are recoverable: the frame loop below still reads
      // from the element once the user interacts with it.
    }
    videoWrap.hidden = false;
    cameraBtn.hidden = true;
    cameraStopBtn.hidden = false;
    setStatus("Point the camera at a QR code.", null);

    const tick = () => {
      if (!stream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
        const result = scanSource(video, video.videoWidth, video.videoHeight, 1, jsQR, "dontInvert");
        if (result && result.data) {
          setStatus("Decoded.", "ok");
          renderResult(result.data);
          stopCamera();
          return;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  if (cameraBtn) {
    if (!cameraSupported()) {
      cameraBtn.disabled = true;
      cameraBtn.title = "Camera capture needs a secure (https) connection";
    }
    cameraBtn.addEventListener("click", startCamera);
  }
  if (cameraStopBtn) cameraStopBtn.addEventListener("click", stopCamera);

  // Never leave the camera light on behind a hidden tab or a switched tool.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });
  window.addEventListener("pagehide", stopCamera);
  window.qrmintStopCamera = stopCamera;
})();
