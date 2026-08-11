/* qrmint.net — batch QR codes from a CSV.
 *
 * Paste or drop a CSV, pick the column that holds the data and (optionally)
 * the column that names each file, and download the lot as a ZIP. The CSV is
 * parsed here, the codes are drawn here, and the ZIP is assembled here (see
 * zipwriter.js) — the file never leaves the tab.
 *
 * Pure parsing lives above the export guard so node can test it.
 */
(() => {
  "use strict";

  const MAX_ROWS = 500;

  /* ======================================================================
     CSV parsing (pure)
     ====================================================================== */

  const DELIMITERS = [",", ";", "\t", "|"];

  /**
   * Guess the delimiter by asking which candidate yields the most consistent
   * column count across the first few lines. Counting raw occurrences alone
   * gets fooled by prose containing commas; consistency does not.
   */
  function detectDelimiter(text) {
    const sample = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 20);
    if (!sample.length) return ",";
    let best = ",";
    let bestScore = -1;
    DELIMITERS.forEach((delim) => {
      const counts = sample.map((line) => parseCsv(line, delim)[0].length);
      const first = counts[0];
      if (first < 2) return;
      const consistent = counts.filter((c) => c === first).length / counts.length;
      const score = consistent * 100 + Math.min(first, 20);
      if (score > bestScore) {
        bestScore = score;
        best = delim;
      }
    });
    return best;
  }

  /**
   * RFC 4180 CSV reader: double quotes wrap fields, "" is a literal quote,
   * and CR/LF inside quotes is data rather than a row break.
   * @returns {string[][]} rows of raw cell strings
   */
  function parseCsv(text, delimiter) {
    const delim = delimiter || ",";
    const src = String(text == null ? "" : text);
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delim) { row.push(field); field = ""; continue; }
      if (ch === "\r") {
        if (src[i + 1] === "\n") i++;
        row.push(field); field = ""; rows.push(row); row = [];
        continue;
      }
      if (ch === "\n") {
        row.push(field); field = ""; rows.push(row); row = [];
        continue;
      }
      field += ch;
    }
    row.push(field);
    rows.push(row);

    // Drop a trailing blank line left by a file that ends with a newline.
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    return rows;
  }

  /**
   * Reduce a cell to something every filesystem and unzip will accept.
   * Deliberately ASCII-only: the ZIP is written with the UTF-8 name flag set,
   * but some long-lived unzip builds still mangle non-ASCII names, and a
   * mangled filename is a worse outcome than a transliterated one.
   */
  function sanitizeFilename(value, fallback) {
    const cleaned = String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // drop the accents NFKD just split off
      .replace(/[^A-Za-z0-9._ -]+/g, "-")
      .replace(/[\s_]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60);
    return cleaned || fallback;
  }

  /** Appends -2, -3 … to repeated names so no ZIP entry overwrites another. */
  function uniqueNames(names, extension) {
    const seen = Object.create(null);
    return names.map((name) => {
      const key = name.toLowerCase();
      const n = (seen[key] = (seen[key] || 0) + 1);
      return (n === 1 ? name : name + "-" + n) + extension;
    });
  }

  /**
   * Turn parsed CSV rows into the list of codes to mint.
   * @param {string[][]} rows
   * @param {{hasHeader: boolean, dataIndex: number, nameIndex: number}} opts
   *        nameIndex of -1 means "number the files"
   * @returns {{items: Array<{payload: string, name: string}>, skipped: number}}
   */
  function buildBatchItems(rows, opts) {
    const o = opts || {};
    const dataIndex = o.dataIndex || 0;
    const nameIndex = typeof o.nameIndex === "number" ? o.nameIndex : -1;
    const body = o.hasHeader ? rows.slice(1) : rows;
    const items = [];
    let skipped = 0;
    body.forEach((row, i) => {
      const payload = (row[dataIndex] == null ? "" : String(row[dataIndex])).trim();
      if (!payload) { skipped++; return; }
      const fallback = "qr-" + String(items.length + 1).padStart(3, "0");
      const rawName = nameIndex >= 0 ? row[nameIndex] : "";
      items.push({ payload, name: sanitizeFilename(rawName, fallback), row: i });
    });
    return { items, skipped };
  }

  /* ============================================================
     Export the pure helpers for Node-based tests.
     ============================================================ */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { detectDelimiter, parseCsv, sanitizeFilename, uniqueNames, buildBatchItems, MAX_ROWS };
  }

  /* ======================================================================
     Browser wiring
     ====================================================================== */
  if (typeof document === "undefined") return;

  const root = document.getElementById("batch-tool");
  if (!root) return;

  const QrCode = window.qrcodegen && window.qrcodegen.QrCode;
  const Ecc = QrCode && QrCode.Ecc;
  if (!QrCode) return;

  const textarea = document.getElementById("batch-csv");
  const fileInput = document.getElementById("batch-file");
  const dropZone = document.getElementById("batch-drop");
  const delimSelect = document.getElementById("batch-delimiter");
  const headerToggle = document.getElementById("batch-header");
  const dataSelect = document.getElementById("batch-data-col");
  const nameSelect = document.getElementById("batch-name-col");
  const formatSelect = document.getElementById("batch-format");
  const summaryEl = document.getElementById("batch-summary");
  const previewEl = document.getElementById("batch-preview");
  const downloadBtn = document.getElementById("batch-download");
  const progressEl = document.getElementById("batch-progress");
  const sampleBtn = document.getElementById("batch-sample");

  const boptSize = document.getElementById("bopt-size");
  const boptEcl = document.getElementById("bopt-ecl");
  const boptMargin = document.getElementById("bopt-margin");
  const boptFg = document.getElementById("bopt-fg");
  const boptBg = document.getElementById("bopt-bg");

  const SAMPLE_CSV =
    "name,url\n" +
    "Table 1,https://qrmint.net/menu\n" +
    "Table 2,https://qrmint.net/menu?table=2\n" +
    "Front door,WIFI:T:WPA;S:Cafe Guest;P:flatwhite;;\n" +
    "Ticket 001,https://example.com/ticket/001\n";

  const IDLE_SUMMARY = "Paste or drop a CSV and the codes show up here.";
  let state = { rows: [], items: [] };

  function eccValue() {
    const v = boptEcl ? boptEcl.value : "M";
    return { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH }[v] || Ecc.MEDIUM;
  }

  function currentOptions() {
    return {
      targetPx: boptSize ? parseInt(boptSize.value, 10) || 512 : 512,
      margin: boptMargin ? parseInt(boptMargin.value, 10) || 4 : 4,
      fg: (boptFg && boptFg.value) || "#0b2119",
      bg: (boptBg && boptBg.value) || "#ffffff",
    };
  }

  function drawQr(qr, canvas, opts) {
    const dim = qr.size + opts.margin * 2;
    const scale = Math.max(1, Math.round(opts.targetPx / dim));
    const px = dim * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.fg;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) ctx.fillRect((opts.margin + x) * scale, (opts.margin + y) * scale, scale, scale);
      }
    }
    return px;
  }

  function qrSvg(qr, opts) {
    const dim = qr.size + opts.margin * 2;
    let path = "";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) path += "M" + (x + opts.margin) + "," + (y + opts.margin) + "h1v1h-1z";
      }
    }
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      dim + " " + dim + '" shape-rendering="crispEdges">\n<rect width="' + dim + '" height="' + dim +
      '" fill="' + opts.bg + '"/>\n<path d="' + path + '" fill="' + opts.fg + '"/>\n</svg>\n'
    );
  }

  function columnLabel(index, headerRow, hasHeader) {
    const name = hasHeader && headerRow && headerRow[index] ? String(headerRow[index]).trim() : "";
    return name ? name + " (column " + (index + 1) + ")" : "Column " + (index + 1);
  }

  function fillColumnSelects() {
    const rows = state.rows;
    if (!rows.length) {
      dataSelect.innerHTML = "";
      nameSelect.innerHTML = '<option value="-1">Number them (qr-001, qr-002…)</option>';
      return;
    }
    const hasHeader = headerToggle.checked;
    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    const previousData = dataSelect.value;
    const previousName = nameSelect.value;

    let dataHtml = "";
    let nameHtml = '<option value="-1">Number them (qr-001, qr-002…)</option>';
    for (let i = 0; i < columnCount; i++) {
      const label = columnLabel(i, rows[0], hasHeader);
      dataHtml += '<option value="' + i + '">' + label.replace(/</g, "&lt;") + "</option>";
      nameHtml += '<option value="' + i + '">' + label.replace(/</g, "&lt;") + "</option>";
    }
    dataSelect.innerHTML = dataHtml;
    nameSelect.innerHTML = nameHtml;

    // Keep the user's choice across re-parses; otherwise guess the column
    // that looks most like payload data (longest average cell).
    if (previousData && parseInt(previousData, 10) < columnCount) dataSelect.value = previousData;
    else dataSelect.value = String(guessDataColumn(rows, hasHeader, columnCount));
    if (previousName && parseInt(previousName, 10) < columnCount) nameSelect.value = previousName;
  }

  function guessDataColumn(rows, hasHeader, columnCount) {
    const body = hasHeader ? rows.slice(1) : rows;
    if (!body.length) return 0;
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < columnCount; i++) {
      let score = 0;
      body.slice(0, 25).forEach((r) => {
        const cell = (r[i] || "").trim();
        if (!cell) return;
        score += /^(https?:\/\/|WIFI:|BEGIN:VCARD|mailto:|tel:)/i.test(cell) ? 40 : Math.min(cell.length, 30) / 3;
      });
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function parseAndRender() {
    const text = textarea.value;
    if (!text.trim()) {
      state = { rows: [], items: [] };
      fillColumnSelects();
      summaryEl.textContent = IDLE_SUMMARY;
      previewEl.innerHTML = "";
      downloadBtn.disabled = true;
      return;
    }
    const delim = delimSelect.value === "auto" ? detectDelimiter(text) : { comma: ",", semicolon: ";", tab: "\t", pipe: "|" }[delimSelect.value];
    state.rows = parseCsv(text, delim);
    fillColumnSelects();
    renderPreview(delim);
  }

  function delimiterName(delim) {
    return { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" }[delim] || delim;
  }

  function renderPreview(delim) {
    const built = buildBatchItems(state.rows, {
      hasHeader: headerToggle.checked,
      dataIndex: parseInt(dataSelect.value, 10) || 0,
      nameIndex: parseInt(nameSelect.value, 10),
    });
    let items = built.items;
    let capped = false;
    if (items.length > MAX_ROWS) {
      items = items.slice(0, MAX_ROWS);
      capped = true;
    }
    const ext = formatSelect.value === "svg" ? ".svg" : ".png";
    const names = uniqueNames(items.map((i) => i.name), ext);
    items.forEach((item, i) => (item.filename = names[i]));
    state.items = items;

    const parts = [];
    parts.push(items.length + (items.length === 1 ? " code" : " codes") + " ready");
    if (delimSelect.value === "auto") parts.push("delimiter detected: " + delimiterName(delim));
    if (built.skipped) parts.push(built.skipped + " empty " + (built.skipped === 1 ? "row" : "rows") + " skipped");
    if (capped) parts.push("capped at " + MAX_ROWS + " — split the file to do more");
    summaryEl.textContent = parts.join(" · ");

    downloadBtn.disabled = items.length === 0;

    const opts = currentOptions();
    previewEl.innerHTML = "";
    let tooLong = 0;
    items.slice(0, 12).forEach((item) => {
      const cell = document.createElement("figure");
      cell.className = "batch-cell";
      const canvas = document.createElement("canvas");
      try {
        drawQr(QrCode.encodeText(item.payload, eccValue()), canvas, { ...opts, targetPx: 240 });
      } catch (e) {
        tooLong++;
        cell.classList.add("is-error");
      }
      cell.appendChild(canvas);
      const caption = document.createElement("figcaption");
      caption.textContent = item.filename;
      cell.appendChild(caption);
      previewEl.appendChild(cell);
    });
    if (items.length > 12) {
      const more = document.createElement("p");
      more.className = "field-hint batch-more";
      more.textContent = "Showing the first 12 of " + items.length + ". The ZIP contains all of them.";
      previewEl.appendChild(more);
    }
    if (tooLong) {
      const warn = document.createElement("p");
      warn.className = "qr-warning";
      warn.textContent = tooLong + " row(s) hold more data than a QR code can carry — shorten them or drop the error-correction level.";
      previewEl.appendChild(warn);
    }
  }

  function canvasToBytes(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(blob);
      }, "image/png");
    });
  }

  async function downloadZip() {
    if (!state.items.length) return;
    const opts = currentOptions();
    const wantSvg = formatSelect.value === "svg";
    downloadBtn.disabled = true;
    progressEl.hidden = false;

    const entries = [];
    const failures = [];
    const canvas = document.createElement("canvas");

    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      progressEl.textContent = "Minting " + (i + 1) + " of " + state.items.length + "…";
      let qr;
      try {
        qr = QrCode.encodeText(item.payload, eccValue());
      } catch (e) {
        failures.push(item.filename);
        continue;
      }
      if (wantSvg) {
        entries.push({ name: item.filename, data: new TextEncoder().encode(qrSvg(qr, opts)) });
      } else {
        drawQr(qr, canvas, opts);
        const bytes = await canvasToBytes(canvas);
        if (bytes) entries.push({ name: item.filename, data: bytes });
        else failures.push(item.filename);
      }
      // Yield every so often so the tab stays responsive on a big file.
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }

    if (!entries.length) {
      progressEl.textContent = "Nothing could be minted from that file.";
      downloadBtn.disabled = false;
      return;
    }

    progressEl.textContent = "Packing the ZIP…";
    const blob = window.qrmintZip.zipBlob(entries);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qrmint-codes.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    progressEl.textContent =
      entries.length + " code" + (entries.length === 1 ? "" : "s") + " packed" +
      (failures.length ? " · " + failures.length + " skipped (too much data)" : "") + ".";
    downloadBtn.disabled = false;
  }

  function readCsvFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      textarea.value = String(reader.result || "");
      parseAndRender();
    };
    reader.readAsText(file);
  }

  textarea.addEventListener("input", parseAndRender);
  [delimSelect, headerToggle, dataSelect, nameSelect, formatSelect, boptSize, boptEcl, boptMargin, boptFg, boptBg].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      if (el === delimSelect || el === headerToggle) parseAndRender();
      else if (state.rows.length) renderPreview(detectDelimiter(textarea.value));
    });
  });

  const pickBtn = document.getElementById("batch-pick");
  if (pickBtn && fileInput) pickBtn.addEventListener("click", () => fileInput.click());
  if (fileInput) fileInput.addEventListener("change", () => readCsvFile(fileInput.files && fileInput.files[0]));
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
      readCsvFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  if (sampleBtn) {
    sampleBtn.addEventListener("click", () => {
      textarea.value = SAMPLE_CSV;
      parseAndRender();
    });
  }

  if (downloadBtn) downloadBtn.addEventListener("click", downloadZip);
})();
