/* qrmint.net — printable QR code label sheets.
 *
 * The back half of the bulk tool. /bulk-qr-codes/ ends in a ZIP of loose PNGs
 * that somebody then has to hand-place in Word; this lays them out on a real
 * sheet, captions them, and hands the job to the browser's own print dialog.
 * "Save as PDF" is therefore free and no PDF library is needed.
 *
 * Everything physical is in millimetres. The sheet element is sized in mm, the
 * cells are positioned in mm, and an injected `@page { size: <w>mm <h>mm;
 * margin: 0 }` rule tells the printer the same numbers — the trick borrowed
 * from paperprintouts, which solves this exact problem for printable paper.
 * The one thing no page can control is the print dialog's own scaling, which
 * is why the calibration rule at the foot of every sheet is not optional.
 *
 * Reuse, not reimplementation:
 *   qrcodegen.js          the encoder
 *   window.qrmintRender   buildQrSvg for the printed code, renderQrToCanvas
 *                         for the copy the verifier decodes
 *   window.qrmintCsv      the RFC-4180 reader and delimiter guess from batch.js
 *   window.qrmintEnsureDecoder / qrmintDecodeCanvas   the scan-verify pass
 */
(() => {
  "use strict";

  if (typeof document === "undefined") return;
  const root = document.getElementById("labels-tool");
  if (!root) return;

  const QrCode = window.qrcodegen && window.qrcodegen.QrCode;
  const Ecc = QrCode && QrCode.Ecc;
  if (!QrCode) return;

  const render = window.qrmintRender || {};
  const buildQrSvg = render.buildQrSvg;
  const drawQr = render.renderQrToCanvas;
  if (!buildQrSvg || !drawQr) return;

  const csv = window.qrmintCsv || {};

  /* ======================================================================
     Paper and layout tables
     ====================================================================== */

  // Real sheet sizes in millimetres, not the CSS keywords: `size: Letter`
  // leaves the exact figure to the user agent, and this page's whole promise
  // is that the numbers are the numbers.
  const PAPERS = {
    a4: { label: "A4", w: 210, h: 297 },
    letter: { label: "US Letter", w: 215.9, h: 279.4 },
  };

  // Height reserved at the foot of every sheet for the calibration rule.
  const CAL_BAND = 16;

  /* Layout presets. Four, fixed. There is deliberately no custom rows/columns
     builder: it is the piece nobody uses and the one that makes print CSS
     fragile, and every hour spent on it is an hour not spent on the alignment
     that decides whether a run of 30 lands on the die-cut stock.

     Two kinds of geometry live here. The die-cut preset carries the label
     stock's own published offsets and must not be re-centred. Everything else
     is centred inside a stated margin, because a sheet you cut by hand only
     has to be square with itself. */
  const PRESETS = {
    "table-tents": {
      label: "Table tents — 2 per page, folded",
      blurb: "Two folded tents per sheet. Each one prints the code twice, the top half upside down, so it reads from both sides of the table once folded.",
      fold: true,
      cut: true,
      captionPos: "below",
      cellsPerPage: 2,
      grid: { cols: 1, rows: 2, margin: 12 },
      codeMm: 46,
      captionMm: 5.5,
    },
    "place-cards": {
      label: "Place cards — 6 per page, folded",
      blurb: "Six folded cards per sheet, name first and the code underneath — for a wedding table, a conference desk or a shelf label.",
      fold: true,
      cut: true,
      captionPos: "below",
      cellsPerPage: 6,
      grid: { cols: 2, rows: 3, margin: 12 },
      codeMm: 26,
      captionMm: 4.5,
    },
    "address-labels": {
      label: "Address labels — Avery 5160 / L7160",
      blurb: "Laid out on the published geometry of Avery 5160 on Letter (30 up) and Avery L7160 on A4 (21 up). This is the preset where the calibration rule matters most: a few percent of scaling walks the grid off the die-cut stock by the bottom row.",
      fold: false,
      cut: false,
      captionPos: "right",
      // Die-cut stock: these offsets are the label maker's, not ours.
      diecut: {
        letter: { stock: "Avery 5160", cols: 3, rows: 10, cellW: 66.675, cellH: 25.4, left: 4.7625, top: 12.7, gapX: 3.175, gapY: 0 },
        a4: { stock: "Avery L7160", cols: 3, rows: 7, cellW: 63.5, cellH: 38.1, left: 7.2, top: 15.1, gapX: 2.5, gapY: 0 },
      },
      captionMm: 3.4,
    },
    "sticker-grid": {
      label: "Sticker grid — 30 per page, cut marks",
      blurb: "Thirty codes on a plain sheet with corner cut marks, for asset stickers, ticket stubs and anything you will cut with a guillotine rather than peel.",
      fold: false,
      cut: true,
      captionPos: "below",
      cellsPerPage: 30,
      grid: { cols: 5, rows: 6, margin: 12 },
      codeMm: 27,
      captionMm: 3.4,
    },
  };

  /* ======================================================================
     Geometry
     ====================================================================== */

  /**
   * Work out where every cell on a sheet sits, in millimetres from the page's
   * top-left corner. Die-cut presets use the stock's published offsets
   * untouched; everything else is centred inside the preset's margin, above
   * the band the calibration rule occupies.
   */
  function layoutFor(presetId, paperId) {
    const preset = PRESETS[presetId];
    const paper = PAPERS[paperId];

    if (preset.diecut) {
      const d = preset.diecut[paperId];
      return {
        cols: d.cols, rows: d.rows, cellW: d.cellW, cellH: d.cellH,
        left: d.left, top: d.top, gapX: d.gapX, gapY: d.gapY,
        perPage: d.cols * d.rows, stock: d.stock,
        codeMm: Math.max(12, d.cellH - 4),
      };
    }

    const g = preset.grid;
    const usableW = paper.w - g.margin * 2;
    const usableH = paper.h - g.margin - CAL_BAND;
    const cellW = usableW / g.cols;
    const cellH = usableH / g.rows;
    return {
      cols: g.cols, rows: g.rows, cellW, cellH,
      left: g.margin, top: g.margin, gapX: 0, gapY: 0,
      perPage: g.cols * g.rows, stock: null,
      // A folded cell only has half its height for the visible face.
      codeMm: Math.min(preset.codeMm,
        (preset.fold ? cellH / 2 : cellH) - preset.captionMm - 8,
        cellW - 8),
    };
  }

  /* ======================================================================
     Captions
     ====================================================================== */

  /**
   * Pull the SSID out of a Wi-Fi payload. The format escapes \ ; , : and "
   * with a backslash, so a naive split on ";" cuts an SSID containing one in
   * half.
   */
  function wifiSsid(payload) {
    const src = String(payload || "");
    if (!/^WIFI:/i.test(src)) return "";
    let i = 5;
    let key = "";
    let value = "";
    let inValue = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") { (inValue ? (value += src[i + 1] || "") : (key += src[i + 1] || "")); i += 2; continue; }
      if (ch === ":" && !inValue) { inValue = true; i++; continue; }
      if (ch === ";") {
        if (key.toUpperCase() === "S" && value) return value;
        key = ""; value = ""; inValue = false; i++; continue;
      }
      if (inValue) value += ch; else key += ch;
      i++;
    }
    return key.toUpperCase() === "S" ? value : "";
  }

  /**
   * One resolution order, everywhere: the CSV's label column, then the free
   * text field, then the SSID if the payload is a Wi-Fi one. Anything else
   * gets no caption rather than a guess — a printed sheet of thirty labels
   * captioned with a truncated URL is worse than thirty uncaptioned ones.
   */
  function captionFor(item, freeText) {
    if (item.label) return item.label;
    if (freeText) return freeText;
    return wifiSsid(item.payload);
  }

  /* ======================================================================
     DOM
     ====================================================================== */

  const el = (id) => document.getElementById(id);

  const sourceRadios = Array.prototype.slice.call(root.querySelectorAll('input[name="lbl-source"]'));
  const onePanel = el("lbl-one-panel");
  const csvPanel = el("lbl-csv-panel");
  const payloadInput = el("lbl-payload");
  const countInput = el("lbl-count");
  const csvInput = el("lbl-csv");
  const csvFile = el("lbl-csv-file");
  const csvDrop = el("lbl-csv-drop");
  const csvSample = el("lbl-csv-sample");
  const delimSelect = el("lbl-delimiter");
  const headerToggle = el("lbl-header");
  const dataSelect = el("lbl-data-col");
  const labelSelect = el("lbl-label-col");
  const presetSelect = el("lbl-preset");
  const paperSelect = el("lbl-paper");
  const captionInput = el("lbl-caption");
  const eclSelect = el("lbl-ecl");
  const summaryEl = el("lbl-summary");
  const blurbEl = el("lbl-preset-blurb");
  const verdictEl = el("lbl-verify");
  const sheetsEl = el("print-sheets");
  const printBtn = el("lbl-print");
  const pageRule = el("lbl-page-rule");

  const SAMPLE_CSV =
    "label,data\n" +
    "Table 1,https://qrmint.net/menu?t=1\n" +
    "Table 2,https://qrmint.net/menu?t=2\n" +
    "Table 3,https://qrmint.net/menu?t=3\n" +
    "Guest Wi-Fi,WIFI:T:WPA;S:Cafe Guest;P:flatwhite;;\n";

  const MAX_CODES = 300;

  function source() {
    const picked = sourceRadios.filter((r) => r.checked)[0];
    return picked ? picked.value : "one";
  }

  function eccValue() {
    return { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH }[eclSelect.value] || Ecc.MEDIUM;
  }

  /* --------------------------- gathering the codes ----------------------- */

  let csvRows = [];

  function fillColumnSelects() {
    const rows = csvRows;
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    const headerRow = headerToggle.checked && rows.length ? rows[0] : null;
    [dataSelect, labelSelect].forEach((select, isLabel) => {
      const previous = select.value;
      select.innerHTML = "";
      if (isLabel) {
        const none = document.createElement("option");
        none.value = "-1";
        none.textContent = "No caption column";
        select.appendChild(none);
      }
      for (let i = 0; i < width; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        const name = headerRow && headerRow[i] ? String(headerRow[i]).trim() : "";
        opt.textContent = name ? name + " (column " + (i + 1) + ")" : "Column " + (i + 1);
        select.appendChild(opt);
      }
      if (previous && select.querySelector('option[value="' + previous + '"]')) {
        select.value = previous;
      } else if (!isLabel) {
        // A two-column sheet is nearly always label,data or data,label — take
        // the widest column as the payload rather than always the first.
        select.value = String(bestDataColumn(rows, headerRow ? 1 : 0, width));
      } else if (width > 1) {
        select.value = String(dataSelect.value === "0" ? 1 : 0);
      }
    });
  }

  function bestDataColumn(rows, from, width) {
    let best = 0;
    let bestLen = -1;
    for (let c = 0; c < width; c++) {
      let total = 0;
      let n = 0;
      for (let r = from; r < rows.length && n < 20; r++) {
        if (!rows[r] || rows[r][c] == null) continue;
        total += String(rows[r][c]).length;
        n++;
      }
      const avg = n ? total / n : 0;
      if (avg > bestLen) { bestLen = avg; best = c; }
    }
    return best;
  }

  function itemsFromCsv() {
    if (!csv.parseCsv) return [];
    const dataIndex = parseInt(dataSelect.value, 10) || 0;
    const labelIndex = parseInt(labelSelect.value, 10);
    const rows = headerToggle.checked ? csvRows.slice(1) : csvRows;
    const items = [];
    rows.forEach((row) => {
      const payload = row && row[dataIndex] != null ? String(row[dataIndex]).trim() : "";
      if (!payload) return;
      const label = labelIndex >= 0 && row[labelIndex] != null ? String(row[labelIndex]).trim() : "";
      items.push({ payload, label });
    });
    return items;
  }

  function itemsFromOne() {
    const payload = payloadInput.value.trim();
    if (!payload) return [];
    const n = Math.max(1, Math.min(MAX_CODES, parseInt(countInput.value, 10) || 1));
    const out = [];
    for (let i = 0; i < n; i++) out.push({ payload, label: "" });
    return out;
  }

  function gather() {
    const items = source() === "csv" ? itemsFromCsv() : itemsFromOne();
    const capped = items.length > MAX_CODES;
    return { items: capped ? items.slice(0, MAX_CODES) : items, capped };
  }

  /* --------------------------- drawing a sheet --------------------------- */

  function svgNode(qr) {
    // buildQrSvg opens with an XML declaration, which is meaningless inside an
    // HTML document and refuses to parse as a fragment; the rest is the SVG.
    const markup = buildQrSvg(qr, { margin: 4, fg: "#000000", bg: "#ffffff" })
      .replace(/^<\?xml[^>]*\?>\s*/, "");
    const holder = document.createElement("div");
    holder.innerHTML = markup;
    const svg = holder.querySelector("svg");
    if (svg) svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function faceNode(qrSvg, caption, preset, geo, upsideDown) {
    const face = document.createElement("div");
    face.className = "lbl-face" + (upsideDown ? " is-flipped" : "")
      + (preset.captionPos === "right" ? " is-beside" : "");
    const code = document.createElement("div");
    code.className = "lbl-code";
    code.style.width = geo.codeMm + "mm";
    code.style.height = geo.codeMm + "mm";
    code.appendChild(qrSvg);
    face.appendChild(code);
    if (caption) {
      const cap = document.createElement("p");
      cap.className = "lbl-caption";
      cap.style.fontSize = preset.captionMm + "mm";
      cap.textContent = caption;
      face.appendChild(cap);
    }
    return face;
  }

  const CUT_CORNERS = ["tl", "tr", "bl", "br"];

  function cellNode(item, caption, preset, geo, qr) {
    const cell = document.createElement("div");
    cell.className = "lbl-cell";
    cell.style.width = geo.cellW + "mm";
    cell.style.height = geo.cellH + "mm";

    if (preset.cut) {
      CUT_CORNERS.forEach((corner) => {
        const mark = document.createElement("span");
        mark.className = "lbl-cut lbl-cut-" + corner;
        cell.appendChild(mark);
      });
    }

    if (preset.fold) {
      // The top face is rotated a half turn so the tent reads from both sides
      // once it is folded along the middle.
      cell.appendChild(faceNode(svgNode(qr), caption, preset, geo, true));
      const fold = document.createElement("div");
      fold.className = "lbl-fold";
      cell.appendChild(fold);
    }
    cell.appendChild(faceNode(svgNode(qr), caption, preset, geo, false));
    return cell;
  }

  /* The calibration rule. Drawn as SVG strokes rather than CSS backgrounds on
     purpose: Chrome's print dialog suppresses background graphics by default
     and would silently drop a rule made of gradients, which is the one thing
     on this sheet that must never be silently wrong.

     100 mm with a tick every 10 mm, and a second mark at 101.6 mm — four
     inches — standing 1.6 mm proud of the end. Two units cross-checking each
     other is what makes a mis-scaled print obvious rather than plausible. */
  function calibrationNode(paperId, geo, preset) {
    const wrap = document.createElement("div");
    wrap.className = "lbl-cal";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 110 9");
    svg.setAttribute("width", "110mm");
    svg.setAttribute("height", "9mm");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("shape-rendering", "geometricPrecision");

    const parts = [];
    parts.push('<line x1="0" y1="6" x2="100" y2="6" stroke="#111" stroke-width="0.3"/>');
    for (let mm = 0; mm <= 100; mm += 10) {
      const len = mm % 50 === 0 ? 4.5 : 2.6;
      parts.push('<line x1="' + mm + '" y1="' + (6 - len) + '" x2="' + mm + '" y2="6" stroke="#111" stroke-width="0.3"/>');
    }
    parts.push('<line x1="101.6" y1="1.5" x2="101.6" y2="6" stroke="#111" stroke-width="0.3" stroke-dasharray="0.8 0.6"/>');
    parts.push('<text x="0" y="8.6" font-size="2.4" fill="#111">0</text>');
    parts.push('<text x="50" y="8.6" font-size="2.4" fill="#111" text-anchor="middle">50 mm</text>');
    parts.push('<text x="100" y="8.6" font-size="2.4" fill="#111" text-anchor="end">100 mm</text>');
    // The 4 in mark gets its own line above the rule, or it collides with the
    // 100 mm label it is only 1.6 mm away from.
    parts.push('<text x="102.6" y="2.6" font-size="2.4" fill="#111">4 in</text>');
    svg.innerHTML = parts.join("");
    wrap.appendChild(svg);

    const note = document.createElement("p");
    note.className = "lbl-cal-note";
    const stock = geo.stock ? " on " + geo.stock : "";
    note.textContent =
      "Measure this rule before you print 30. It is exactly 100 mm (3.94 in) end to end, and the dashed mark is 4 in — 1.6 mm past it. "
      + "If it comes out short, your printer scaled the page: set the dialog to 100% or Actual size, never Fit to page. "
      + PAPERS[paperId].label + stock + ".";
    wrap.appendChild(note);
    return wrap;
  }

  function buildSheets(items, presetId, paperId) {
    const preset = PRESETS[presetId];
    const paper = PAPERS[paperId];
    const geo = layoutFor(presetId, paperId);
    const freeText = captionInput.value.trim();
    const ecc = eccValue();

    sheetsEl.innerHTML = "";
    const pages = Math.max(1, Math.ceil(items.length / geo.perPage));
    let tooLong = 0;
    const drawn = [];

    for (let p = 0; p < pages; p++) {
      const frame = document.createElement("div");
      frame.className = "lbl-sheet-frame";

      const sheet = document.createElement("div");
      sheet.className = "lbl-sheet";
      sheet.style.width = paper.w + "mm";
      sheet.style.height = paper.h + "mm";

      for (let i = 0; i < geo.perPage; i++) {
        const item = items[p * geo.perPage + i];
        if (!item) break;
        let qr;
        try {
          qr = QrCode.encodeText(item.payload, ecc);
        } catch (e) {
          tooLong++;
          continue;
        }
        const col = i % geo.cols;
        const row = Math.floor(i / geo.cols);
        const cell = cellNode(item, captionFor(item, freeText), preset, geo, qr);
        cell.style.left = (geo.left + col * (geo.cellW + geo.gapX)) + "mm";
        cell.style.top = (geo.top + row * (geo.cellH + geo.gapY)) + "mm";
        sheet.appendChild(cell);
        drawn.push({ payload: item.payload, qr });
      }

      sheet.appendChild(calibrationNode(paperId, geo, preset));
      frame.appendChild(sheet);
      sheetsEl.appendChild(frame);
    }

    // The printer is told the same numbers the sheet is drawn with. margin: 0
    // because every offset on the page is already measured from the paper edge.
    pageRule.textContent = "@page { size: " + paper.w + "mm " + paper.h + "mm; margin: 0; }";

    scaleSheets();
    return { geo, pages, tooLong, drawn };
  }

  /* On screen a sheet is shown at true proportions but scaled to fit the
     column; in print the transform is dropped and the millimetres are the
     millimetres. The frame carries the scaled box so the page below it does
     not have a 297 mm hole in it. */
  const MM_PX = 96 / 25.4;

  function scaleSheets() {
    const frames = Array.prototype.slice.call(sheetsEl.querySelectorAll(".lbl-sheet-frame"));
    if (!frames.length) return;
    const paper = PAPERS[paperSelect.value] || PAPERS.a4;
    const available = sheetsEl.clientWidth || 640;
    const scale = Math.min(1, available / (paper.w * MM_PX));
    frames.forEach((frame) => {
      frame.style.width = paper.w * MM_PX * scale + "px";
      frame.style.height = paper.h * MM_PX * scale + "px";
      const sheet = frame.firstElementChild;
      if (sheet) sheet.style.transform = "scale(" + scale + ")";
    });
  }

  /* --------------------------- scan verification ------------------------- */

  /* The same pass the batch tool runs, kept for the same reason: nothing
     unscannable should be printed thirty times. Only the distinct payloads are
     checked, because a sheet of one code repeated is one question.

     The print-specific half is the module size. A code is not a picture that
     can be shrunk freely — below roughly 0.4 mm per module, ordinary laser
     toner spread and a phone camera stop agreeing about where the edges are,
     and the sheet fails on paper while reading back perfectly on screen. */
  let verifyToken = 0;

  function setVerdict(state, label, detail) {
    verdictEl.hidden = false;
    verdictEl.className = "scan-verdict is-" + state;
    verdictEl.textContent = "";
    const badge = document.createElement("span");
    badge.className = "verdict-badge";
    badge.textContent = label;
    const text = document.createElement("span");
    text.className = "verdict-detail";
    text.textContent = detail;
    verdictEl.append(badge, text);
  }

  function moduleMm(qr, codeMm) {
    return codeMm / (qr.size + 8); // margin is fixed at 4 modules a side
  }

  async function verify(drawn, geo) {
    const token = ++verifyToken;
    if (!drawn.length) { verdictEl.hidden = true; return; }

    const seen = new Set();
    const unique = drawn.filter((d) => {
      if (seen.has(d.payload)) return false;
      seen.add(d.payload);
      return true;
    });

    const smallest = drawn.reduce(
      (min, d) => Math.min(min, moduleMm(d.qr, geo.codeMm)), Infinity);
    const sizeNote = " Smallest printed module: " + smallest.toFixed(2) + " mm.";

    setVerdict("checking", "Checking…", "Reading each distinct code back.");

    let jsQR;
    try {
      jsQR = await window.qrmintEnsureDecoder();
    } catch (err) {
      if (token === verifyToken) {
        setVerdict("warn", "Not verified", "The reader could not be loaded, so these codes were not scanned back." + sizeNote);
      }
      return;
    }
    if (token !== verifyToken) return;

    const canvas = document.createElement("canvas");
    let failures = 0;
    let inverted = 0;
    for (let i = 0; i < unique.length; i++) {
      drawQr(unique[i].qr, canvas, { targetPx: 320, margin: 4, fg: "#000000", bg: "#ffffff" });
      const read = window.qrmintDecodeCanvas(jsQR, canvas);
      if (token !== verifyToken) return;
      if (read.data !== unique[i].payload) failures++;
      else if (read.inverted) inverted++;
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep the tab live
    }
    if (token !== verifyToken) return;

    const noun = unique.length === 1 ? "code" : "codes";
    if (failures) {
      setVerdict("fail", failures + " won't scan",
        failures + " of these " + unique.length + " " + noun + " did not read back. Shorten the data, or raise the error-correction level." + sizeNote);
      return;
    }
    if (smallest < 0.4) {
      setVerdict("warn", "Too small to print",
        "All " + unique.length + " " + noun + " read back on screen, but at " + smallest.toFixed(2)
        + " mm per module this will be at the edge of what a home laser and a phone camera agree on. Use a preset with a larger code, or shorten the data so the code needs fewer modules.");
      return;
    }
    if (inverted) {
      setVerdict("warn", "Inverted only",
        "These read back only when a scanner flips the colours. Printed sheets are black on white here, so this usually means the data itself is the problem." + sizeNote);
      return;
    }
    setVerdict("ok", "Scan-verified",
      unique.length + " distinct " + noun + " read back correctly with the same reader the scan tool uses." + sizeNote);
  }

  /* ------------------------------- rendering ----------------------------- */

  function rerender() {
    const presetId = presetSelect.value;
    const paperId = paperSelect.value;
    const preset = PRESETS[presetId];
    blurbEl.textContent = preset.blurb;

    const { items, capped } = gather();
    printBtn.disabled = items.length === 0;

    if (!items.length) {
      sheetsEl.innerHTML = "";
      verdictEl.hidden = true;
      summaryEl.textContent = source() === "csv"
        ? "Paste or drop a CSV and the sheet shows up here."
        : "Type what the code should hold and the sheet shows up here.";
      return;
    }

    const { geo, pages, tooLong, drawn } = buildSheets(items, presetId, paperId);

    const parts = [];
    parts.push(items.length + (items.length === 1 ? " code" : " codes")
      + " across " + pages + (pages === 1 ? " sheet" : " sheets"));
    parts.push(geo.perPage + " per page");
    parts.push(geo.cellW.toFixed(1) + " × " + geo.cellH.toFixed(1) + " mm per cell");
    if (geo.stock) parts.push(geo.stock);
    if (capped) parts.push("capped at " + MAX_CODES + " — split the file to do more");
    if (tooLong) parts.push(tooLong + " row(s) hold more data than a QR code can carry");
    summaryEl.textContent = parts.join(" · ");

    verify(drawn, geo);
  }

  const schedule = debounce(rerender, 180);

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /* --------------------------------- CSV --------------------------------- */

  function parseCsvInput() {
    const text = csvInput.value;
    if (!text.trim() || !csv.parseCsv) {
      csvRows = [];
      fillColumnSelects();
      return;
    }
    const delim = delimSelect.value === "auto"
      ? csv.detectDelimiter(text)
      : { comma: ",", semicolon: ";", tab: "\t", pipe: "|" }[delimSelect.value];
    csvRows = csv.parseCsv(text, delim);
    fillColumnSelects();
  }

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      csvInput.value = String(reader.result || "");
      parseCsvInput();
      rerender();
    };
    reader.readAsText(file);
  }

  /* -------------------------------- wiring ------------------------------- */

  function syncSource() {
    const mode = source();
    onePanel.hidden = mode !== "one";
    csvPanel.hidden = mode !== "csv";
    rerender();
  }

  sourceRadios.forEach((r) => r.addEventListener("change", syncSource));
  [presetSelect, paperSelect, eclSelect, headerToggle, dataSelect, labelSelect, delimSelect]
    .forEach((element) => element.addEventListener("change", () => {
      if (element === delimSelect || element === headerToggle) parseCsvInput();
      if (element === presetSelect) {
        // Each preset has its own natural run length, so the count follows it
        // until the visitor overrides it.
        const perPage = PRESETS[presetSelect.value].diecut
          ? PRESETS[presetSelect.value].diecut[paperSelect.value].cols * PRESETS[presetSelect.value].diecut[paperSelect.value].rows
          : PRESETS[presetSelect.value].cellsPerPage;
        countInput.value = String(perPage);
      }
      rerender();
    }));

  [payloadInput, captionInput].forEach((element) =>
    element.addEventListener("input", schedule));
  countInput.addEventListener("input", schedule);
  csvInput.addEventListener("input", debounce(() => { parseCsvInput(); rerender(); }, 200));

  if (csvSample) {
    csvSample.addEventListener("click", () => {
      csvInput.value = SAMPLE_CSV;
      headerToggle.checked = true;
      parseCsvInput();
      rerender();
    });
  }
  if (csvFile) csvFile.addEventListener("change", () => readFile(csvFile.files[0]));
  if (csvDrop) {
    csvDrop.addEventListener("click", () => csvFile && csvFile.click());
    ["dragenter", "dragover"].forEach((type) =>
      csvDrop.addEventListener(type, (e) => { e.preventDefault(); csvDrop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((type) =>
      csvDrop.addEventListener(type, () => csvDrop.classList.remove("is-over")));
    csvDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  printBtn.addEventListener("click", () => window.print());
  window.addEventListener("resize", debounce(scaleSheets, 120));

  syncSource();
})();
