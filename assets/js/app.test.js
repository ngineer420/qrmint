// Pure-helper tests for qrmint. Run with: node assets/js/app.test.js
// No framework/deps — uses Node's built-in test runner + assert.
//
// The last block is the one that matters most: it generates a QR code with
// the same encoder the site ships, rasterises it, and decodes it with the
// same decoder the site ships. A green run there means the round trip works,
// not merely that the two libraries load.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWifiPayload, buildVCardPayload, normalizeUrl,
  fitContain, logoGeometry, eccWithLogo, scanVerdict, isLightOnDark,
  renderQrToCanvas, buildQrSvg, LOGO_MIN_PCT, LOGO_MAX_PCT,
} = require("./app.js");
const { parseDecodedPayload, parseWifiPayload, parseVCard, parseMeCard, splitEscaped } = require("./decode.js");
const { detectDelimiter, parseCsv, sanitizeFilename, uniqueNames, buildBatchItems } = require("./batch.js");
const { crc32, buildZip } = require("./zipwriter.js");

/* ------------------------------ decoding ------------------------------- */

test("splitEscaped splits on unescaped separators only, without unescaping", () => {
  assert.deepEqual(splitEscaped("a;b;c", ";"), ["a", "b", "c"]);
  // The escaped ";" stays inside the field, escape sequence and all — the
  // single unescape pass happens later, in splitKeyValue.
  assert.deepEqual(splitEscaped("a\\;b;c", ";"), ["a\\;b", "c"]);
  // An escaped backslash must not shield the separator that follows it.
  assert.deepEqual(splitEscaped("a\\\\;b", ";"), ["a\\\\", "b"]);
});

test("parseWifiPayload reads a plain network", () => {
  const wifi = parseWifiPayload("WIFI:T:WPA;S:My Net;P:secret123;;");
  assert.equal(wifi.ssid, "My Net");
  assert.equal(wifi.password, "secret123");
  assert.equal(wifi.auth, "WPA");
  assert.equal(wifi.hidden, false);
});

test("parseWifiPayload survives the characters the builder escapes", () => {
  // Round-trip against app.js's builder rather than a hand-written string.
  const original = { ssid: 'Cafe; "Mint", Ltd:', password: "p@ss\\;word", enc: "WPA", hidden: true };
  const payload = buildWifiPayload(original);
  const parsed = parseWifiPayload(payload);
  assert.equal(parsed.ssid, original.ssid);
  assert.equal(parsed.password, original.password);
  assert.equal(parsed.hidden, true);
});

test("parseVCard round-trips app.js's builder", () => {
  const payload = buildVCardPayload({
    firstName: "Jane",
    lastName: "Doe",
    phone: "+1 555 0100",
    email: "jane@example.com",
    org: "Mint; Co",
    title: "Engineer",
    url: "example.com",
    address: "123 Main St, Springfield",
  });
  const fields = parseVCard(payload);
  const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.Name, "Jane Doe");
  assert.equal(byLabel.Phone, "+1 555 0100");
  assert.equal(byLabel.Email, "jane@example.com");
  assert.equal(byLabel.Organization, "Mint; Co");
  assert.equal(byLabel.Website, "https://example.com");
  assert.equal(byLabel.Address, "123 Main St, Springfield");
});

test("parseVCard unfolds continuation lines", () => {
  const folded = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane\r\n  Doe\r\nEND:VCARD";
  const fields = parseVCard(folded);
  assert.equal(fields[0].value, "Jane Doe");
});

test("parseMeCard reverses the comma-separated name", () => {
  const fields = parseMeCard("MECARD:N:Doe,John;TEL:5550100;;");
  assert.deepEqual(fields[0], { label: "Name", value: "John Doe" });
  assert.deepEqual(fields[1], { label: "Phone", value: "5550100" });
});

test("parseDecodedPayload classifies each payload kind", () => {
  assert.equal(parseDecodedPayload("https://qrmint.net/x").kind, "url");
  assert.equal(parseDecodedPayload("WIFI:T:WPA;S:n;P:p;;").kind, "wifi");
  assert.equal(parseDecodedPayload("BEGIN:VCARD\nFN:A\nEND:VCARD").kind, "vcard");
  assert.equal(parseDecodedPayload("MECARD:N:A;;").kind, "vcard");
  assert.equal(parseDecodedPayload("mailto:a@b.com?subject=Hi").kind, "email");
  assert.equal(parseDecodedPayload("tel:+15550100").kind, "tel");
  assert.equal(parseDecodedPayload("SMSTO:5550100:hello").kind, "sms");
  assert.equal(parseDecodedPayload("geo:37.786,-122.399").kind, "geo");
  assert.equal(parseDecodedPayload("BEGIN:VEVENT\nSUMMARY:Launch\nEND:VEVENT").kind, "event");
  assert.equal(parseDecodedPayload("otpauth://totp/Acme:jane?secret=JBSW").kind, "otp");
  assert.equal(parseDecodedPayload("spotify:track:abc").kind, "uri");
  assert.equal(parseDecodedPayload("just some words").kind, "text");
});

test("parseDecodedPayload flags the payloads that carry a secret", () => {
  assert.equal(parseDecodedPayload("WIFI:T:WPA;S:n;P:p;;").sensitive, true);
  assert.equal(parseDecodedPayload("WIFI:T:nopass;S:open;;").sensitive, false);
  assert.equal(parseDecodedPayload("otpauth://totp/A:b?secret=JBSW").sensitive, true);
  assert.equal(parseDecodedPayload("https://qrmint.net/").sensitive, false);
});

test("parseDecodedPayload only offers a link for schemes worth opening", () => {
  assert.equal(parseDecodedPayload("https://qrmint.net/").link, "https://qrmint.net/");
  assert.equal(parseDecodedPayload("WIFI:T:WPA;S:n;P:p;;").link, null);
  assert.equal(parseDecodedPayload("otpauth://totp/A:b?secret=X").link, null);
  assert.equal(parseDecodedPayload("javascript:alert(1)").link, null);
});

test("parseDecodedPayload pulls query fields out of a mailto:", () => {
  const parsed = parseDecodedPayload("mailto:a@b.com?subject=Hello%20there&body=Hi");
  const byLabel = Object.fromEntries(parsed.fields.map((f) => [f.label, f.value]));
  assert.equal(byLabel.To, "a@b.com");
  assert.equal(byLabel.Subject, "Hello there");
  assert.equal(byLabel.Message, "Hi");
});

/* -------------------------------- CSV ---------------------------------- */

test("parseCsv handles quotes, embedded delimiters and newlines", () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n"multi\nline",z\n', ",");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x,1", 'he said "hi"'],
    ["multi\nline", "z"],
  ]);
});

test("parseCsv treats CRLF as one row break", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d\r\n", ","), [["a", "b"], ["c", "d"]]);
});

test("detectDelimiter prefers the delimiter with a consistent column count", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3\n"), ",");
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");
  assert.equal(detectDelimiter("a|b\n1|2\n"), "|");
  // A comma inside prose must not beat the real semicolon delimiter.
  assert.equal(detectDelimiter("name;url\nAcme, Inc;https://a.test\nBeta, Ltd;https://b.test\n"), ";");
});

test("sanitizeFilename transliterates and strips", () => {
  assert.equal(sanitizeFilename("Table 1", "x"), "Table-1");
  assert.equal(sanitizeFilename("café ✓", "x"), "cafe");
  assert.equal(sanitizeFilename("../../etc/passwd", "x"), "etc-passwd");
  assert.equal(sanitizeFilename("", "qr-001"), "qr-001");
  assert.equal(sanitizeFilename("   ", "qr-001"), "qr-001");
});

test("uniqueNames disambiguates repeats case-insensitively", () => {
  assert.deepEqual(uniqueNames(["a", "a", "A", "b"], ".png"), ["a.png", "a-2.png", "A-3.png", "b.png"]);
});

test("buildBatchItems maps rows to payloads and filenames", () => {
  const rows = parseCsv("name,url\nTable 1,https://a.test\n,https://skipme.test\nTable 2,\nTable 3,https://c.test\n", ",");
  const built = buildBatchItems(rows, { hasHeader: true, dataIndex: 1, nameIndex: 0 });
  assert.equal(built.skipped, 1); // the row with an empty url
  assert.deepEqual(built.items.map((i) => i.name), ["Table-1", "qr-002", "Table-3"]);
  assert.deepEqual(built.items.map((i) => i.payload), ["https://a.test", "https://skipme.test", "https://c.test"]);
});

test("buildBatchItems numbers files when no name column is chosen", () => {
  const rows = parseCsv("https://a.test\nhttps://b.test\n", ",");
  const built = buildBatchItems(rows, { hasHeader: false, dataIndex: 0, nameIndex: -1 });
  assert.deepEqual(built.items.map((i) => i.name), ["qr-001", "qr-002"]);
});

/* ----------------------------- logo geometry ---------------------------- */

test("fitContain letterboxes a non-square logo inside the box", () => {
  assert.deepEqual(fitContain(10, 200, 100), { width: 10, height: 5 });
  assert.deepEqual(fitContain(10, 100, 200), { width: 5, height: 10 });
  assert.deepEqual(fitContain(10, 50, 50), { width: 10, height: 10 });
  // A sizeless SVG reports 0×0; treat it as square rather than dividing by zero.
  assert.deepEqual(fitContain(10, 0, 0), { width: 10, height: 10 });
});

test("logoGeometry centres the logo on the whole symbol, quiet zone included", () => {
  const g = logoGeometry({ qrSize: 25, margin: 4, sizePct: 20, padPct: 0, plate: "none", imageWidth: 1, imageHeight: 1 });
  assert.equal(g.dim, 33);
  assert.equal(g.box, 5); // 20% of 25 modules
  assert.equal(g.logo.width, 5);
  assert.equal(g.logo.height, 5);
  // Centre of the logo == centre of the full symbol.
  assert.equal(g.logo.x + g.logo.width / 2, 16.5);
  assert.equal(g.logo.y + g.logo.height / 2, 16.5);
});

test("logoGeometry sizes the logo as a share of the symbol, not the quiet zone", () => {
  const tight = logoGeometry({ qrSize: 25, margin: 2, sizePct: 20, imageWidth: 1, imageHeight: 1 });
  const wide = logoGeometry({ qrSize: 25, margin: 6, sizePct: 20, imageWidth: 1, imageHeight: 1 });
  assert.equal(tight.logo.width, wide.logo.width);
});

test("logoGeometry grows the plate by the padding and turns a circle into one radius", () => {
  const bare = logoGeometry({ qrSize: 100, margin: 4, sizePct: 20, padPct: 0, plate: "rounded", imageWidth: 1, imageHeight: 1 });
  assert.equal(bare.plate.width, 20);

  const padded = logoGeometry({ qrSize: 100, margin: 4, sizePct: 20, padPct: 0.1, plate: "rounded", imageWidth: 1, imageHeight: 1 });
  assert.equal(padded.plate.width, 24); // 20 + 2×(0.1 × 20)
  assert.equal(padded.plate.x + padded.plate.width / 2, 54);

  // A wide logo's circle plate must cover the long side, not the short one.
  const circle = logoGeometry({ qrSize: 100, margin: 4, sizePct: 20, padPct: 0, plate: "circle", imageWidth: 200, imageHeight: 100 });
  assert.equal(circle.logo.width, 20);
  assert.equal(circle.logo.height, 10);
  assert.equal(circle.plate.width, 20);
  assert.equal(circle.plate.height, 20);
  assert.equal(circle.plate.radius, 10); // half the side == a circle
});

test("logoGeometry reports the share of the symbol that is covered", () => {
  const g = logoGeometry({ qrSize: 100, margin: 4, sizePct: 20, padPct: 0, plate: "none", imageWidth: 1, imageHeight: 1 });
  assert.equal(Math.round(g.coverage * 1000) / 1000, 0.04); // 20% of a side is 4% of the area
});

test("logoGeometry draws an over-large logo as asked instead of quietly shrinking it", () => {
  // Clamping to the slider's range here would hide the problem from scan
  // verification, which is the one thing meant to catch it.
  const g = logoGeometry({ qrSize: 100, margin: 4, sizePct: 50, imageWidth: 1, imageHeight: 1 });
  assert.equal(g.logo.width, 50);
});

test("eccWithLogo forces H with a logo and returns the pick without one", () => {
  assert.equal(eccWithLogo("L", true), "H");
  assert.equal(eccWithLogo("M", true), "H");
  assert.equal(eccWithLogo("H", true), "H");
  assert.equal(eccWithLogo("L", false), "L");
  assert.equal(eccWithLogo("Q", false), "Q");
  assert.equal(eccWithLogo("nonsense", false), "M");
});

/* ------------------------- PNG / SVG export parity ---------------------- */

// A canvas 2D context that records what was drawn instead of drawing it, so the
// PNG path's geometry can be compared with the SVG path's without a canvas
// implementation. Both renderers are handed the same logo; if their numbers
// ever drift apart, the exports stop matching and this test says so.
function recordingCanvas() {
  const calls = [];
  const ctx = {
    fillStyle: "",
    fillRect: (x, y, width, height) => calls.push({ op: "fillRect", x, y, width, height, fill: ctx.fillStyle }),
    drawImage: (img, x, y, width, height) => calls.push({ op: "drawImage", x, y, width, height }),
    roundRect: (x, y, width, height, r) => calls.push({ op: "roundRect", x, y, width, height, r, fill: ctx.fillStyle }),
    beginPath() {},
    fill() {},
  };
  return { width: 0, height: 0, getContext: () => ctx, calls };
}

const LOGO = {
  image: { fake: true },
  href: "data:image/png;base64,iVBORw0KGgo=",
  imageWidth: 200,
  imageHeight: 100,
  sizePct: 20,
  padPct: 0.1,
  plate: "rounded",
};

// Only the plate and the logo carry an x/y in the SVG — the background rect is
// written without one — so this reads back whichever of the two is asked for.
function svgNumbers(svg, tag) {
  const m = svg.match(new RegExp("<" + tag + ' x="([-\\d.]+)" y="([-\\d.]+)" width="([-\\d.]+)" height="([-\\d.]+)"'));
  assert.ok(m, "expected a positioned <" + tag + "> in the SVG");
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

test("the PNG and the SVG place the logo and its plate identically", () => {
  const qr = qrcodegen.QrCode.encodeText("https://qrmint.net/", qrcodegen.QrCode.Ecc.HIGH);
  const margin = 4;
  const canvas = recordingCanvas();
  const px = renderQrToCanvas(qr, canvas, { targetPx: 512, margin, fg: "#0b2119", bg: "#ffffff", logo: LOGO });
  const scale = px / (qr.size + margin * 2);

  const drawn = canvas.calls.find((c) => c.op === "drawImage");
  const plate = canvas.calls.find((c) => c.op === "roundRect");
  const svg = buildQrSvg(qr, { margin, fg: "#0b2119", bg: "#ffffff", logo: LOGO });
  const svgLogo = svgNumbers(svg, "image");
  const svgPlate = svgNumbers(svg, "rect");

  // The canvas works in pixels and the SVG in modules; one integer scale apart.
  ["x", "y", "width", "height"].forEach((k) => {
    assert.ok(Math.abs(drawn[k] / scale - svgLogo[k]) < 1e-9, "logo " + k + " differs: " + drawn[k] / scale + " vs " + svgLogo[k]);
    assert.ok(Math.abs(plate[k] / scale - svgPlate[k]) < 1e-9, "plate " + k + " differs");
  });
  assert.ok(svg.includes('rx="' + plate.r / scale + '"'), "plate corner radius differs");
  assert.ok(svg.includes(LOGO.href), "the SVG embeds the logo as a data: URI");
  // The aspect ratio survives in both: a 2:1 logo stays 2:1.
  assert.ok(Math.abs(svgLogo.width / svgLogo.height - 2) < 1e-3);
});

test("the plate is knocked out in the background color in both exports", () => {
  const qr = qrcodegen.QrCode.encodeText("hello", qrcodegen.QrCode.Ecc.HIGH);
  const canvas = recordingCanvas();
  renderQrToCanvas(qr, canvas, { targetPx: 300, margin: 4, fg: "#123456", bg: "#fedcba", logo: LOGO });
  assert.equal(canvas.calls.find((c) => c.op === "roundRect").fill, "#fedcba");
  const g = logoGeometry({ qrSize: qr.size, margin: 4, sizePct: LOGO.sizePct, padPct: LOGO.padPct, plate: LOGO.plate, imageWidth: LOGO.imageWidth, imageHeight: LOGO.imageHeight });
  assert.ok(buildQrSvg(qr, { margin: 4, fg: "#123456", bg: "#fedcba", logo: LOGO })
    .includes('ry="' + g.plate.radius + '" fill="#fedcba"'));
});

test("a code with no logo renders exactly as it did before the feature", () => {
  const qr = qrcodegen.QrCode.encodeText("https://qrmint.net/", qrcodegen.QrCode.Ecc.MEDIUM);
  const svg = buildQrSvg(qr, { margin: 4, fg: "#0b2119", bg: "#ffffff" });
  assert.ok(!svg.includes("<image"));
  const canvas = recordingCanvas();
  renderQrToCanvas(qr, canvas, { targetPx: 512, margin: 4, fg: "#0b2119", bg: "#ffffff" });
  assert.equal(canvas.calls.filter((c) => c.op === "drawImage").length, 0);
});

/* ---------------------------- verdict wording --------------------------- */

test("scanVerdict passes a code that reads back as itself", () => {
  const v = scanVerdict({ decoded: "https://qrmint.net/", expected: "https://qrmint.net/", ecl: "H" });
  assert.equal(v.state, "ok");
  assert.equal(v.label, "Scan-verified");
});

test("scanVerdict refuses to call an inverted-only code verified", () => {
  const v = scanVerdict({ decoded: "x", expected: "x", inverted: true, ecl: "H" });
  assert.equal(v.state, "warn");
  assert.match(v.detail, /Swap your colors/);
});

test("scanVerdict names the logo as the fix when a logo is present", () => {
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: true, logoPct: 25, plate: "rounded", ecl: "H", contrast: 18 });
  assert.equal(v.state, "fail");
  assert.equal(v.label, "Won't scan");
  assert.match(v.detail, /shrink the logo from 25% to about 19%/);
  assert.match(v.detail, /backing plate/);
  // ECC is already as high as it goes, so telling them to raise it is noise.
  assert.doesNotMatch(v.detail, /error correction/);
});

test("scanVerdict never suggests shrinking below the smallest size the UI offers", () => {
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: true, logoPct: 12, ecl: "H", contrast: 18 });
  assert.match(v.detail, new RegExp("to about " + LOGO_MIN_PCT + "%"));
});

test("scanVerdict names error correction and contrast when those are the problem", () => {
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: false, ecl: "L", contrast: 1.6 });
  assert.match(v.detail, /raise error correction to H/);
  assert.match(v.detail, /only 1\.6:1 apart/);
  assert.doesNotMatch(v.detail, /logo/);
});

test("scanVerdict blames colors before the logo when the colors cannot work", () => {
  // Two colors a shade apart break any code, logo or no logo. Naming the logo
  // first would send someone off shrinking a logo that was never the problem.
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: true, logoPct: 18, ecl: "H", contrast: 1.2 });
  assert.ok(v.detail.indexOf("contrast") < v.detail.indexOf("logo"), v.detail);
});

test("scanVerdict tells a light-on-dark code to swap its colors", () => {
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: true, logoPct: 18, ecl: "H", contrast: 12, lightOnDark: true });
  assert.match(v.detail, /swap your colors/);
  assert.ok(v.detail.indexOf("swap your colors") < v.detail.indexOf("shrink the logo"), v.detail);
});

test("isLightOnDark spots modules lighter than their background", () => {
  assert.equal(isLightOnDark("#ffffff", "#0b2119"), true);
  assert.equal(isLightOnDark("#0b2119", "#ffffff"), false);
});

test("scanVerdict still says something useful when nothing obvious is wrong", () => {
  const v = scanVerdict({ decoded: null, expected: "x", hasLogo: false, ecl: "H", contrast: 21 });
  assert.match(v.detail, /widen the margin/);
});

test("scanVerdict flags a code that reads back as the wrong data", () => {
  const v = scanVerdict({ decoded: "something else", expected: "x", ecl: "H" });
  assert.equal(v.state, "fail");
  assert.equal(v.label, "Wrong data");
});

/* -------------------------------- ZIP ---------------------------------- */

test("crc32 matches the standard check value", () => {
  // The CRC-32 of "123456789" is 0xCBF43926 by definition of the algorithm.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildZip emits a structurally valid archive", () => {
  const zip = buildZip([
    { name: "a.txt", data: new TextEncoder().encode("hello") },
    { name: "b.txt", data: new TextEncoder().encode("world!") },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "starts with a local file header");

  // Find the end-of-central-directory record and check it describes reality.
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "ends with an EOCD record");
  assert.equal(view.getUint16(eocd + 10, true), 2, "two entries");
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd, "central directory ends exactly where the EOCD begins");
  assert.equal(view.getUint32(cdOffset, true), 0x02014b50, "central directory header signature");
});

/* --------------------- generate → decode round trip --------------------- */

// qrcodegen.js declares a top-level `var qrcodegen` for the browser, so it
// needs evaluating rather than requiring.
const qrcodegen = new Function(
  fs.readFileSync(path.join(__dirname, "qrcodegen.js"), "utf8") + "\n;return qrcodegen;"
)();
const jsQR = require("./jsqr.js");

// The browser hands jsQR an ImageData from a canvas; here we build the same
// RGBA buffer by hand so the test needs no canvas implementation.
function rasterize(qr, scale, margin) {
  const dim = (qr.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.getModule(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + margin) * scale + dy) * dim + (x + margin) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function roundTrip(text, ecc) {
  const qr = qrcodegen.QrCode.encodeText(text, ecc || qrcodegen.QrCode.Ecc.MEDIUM);
  const img = rasterize(qr, 4, 4);
  const result = jsQR(img.data, img.width, img.height);
  return result && result.data;
}

// Paints the logo layer onto an existing raster exactly where logoGeometry says
// it goes: the plate knocked out in the background color, the logo itself a
// solid block. A solid block is the worst case a real logo can be, which is the
// case worth testing — anything softer damages fewer modules.
function paintLogo(img, geometry, scale) {
  function box(rect, value) {
    const x0 = Math.round(rect.x * scale);
    const y0 = Math.round(rect.y * scale);
    const x1 = Math.round((rect.x + rect.width) * scale);
    const y1 = Math.round((rect.y + rect.height) * scale);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const p = (y * img.width + x) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = value;
      }
    }
  }
  if (geometry.plate) box(geometry.plate, 255);
  box(geometry.logo, 0);
  return img;
}

// generate → rasterise → paint the logo → decode, all through the same helpers
// the browser uses to place it.
function roundTripWithLogo(text, { sizePct, padPct = 0.1, plate = "rounded", margin = 4, scale = 6 }) {
  const ecl = eccWithLogo("M", true);
  const ecc = { L: qrcodegen.QrCode.Ecc.LOW, M: qrcodegen.QrCode.Ecc.MEDIUM, Q: qrcodegen.QrCode.Ecc.QUARTILE, H: qrcodegen.QrCode.Ecc.HIGH }[ecl];
  const qr = qrcodegen.QrCode.encodeText(text, ecc);
  const geometry = logoGeometry({ qrSize: qr.size, margin, sizePct, padPct, plate, imageWidth: 1, imageHeight: 1 });
  const img = paintLogo(rasterize(qr, scale, margin), geometry, scale);
  const result = jsQR(img.data, img.width, img.height);
  return { decoded: result && result.data, ecl, coverage: geometry.coverage };
}

test("a generated URL code decodes back to the same URL", () => {
  const url = normalizeUrl("qrmint.net/scan-qr-code/");
  assert.equal(roundTrip(url), "https://qrmint.net/scan-qr-code/");
});

test("a generated Wi-Fi code decodes back into the same credentials", () => {
  const payload = buildWifiPayload({ ssid: "Cafe Mint", password: "flat;white", enc: "WPA", hidden: true });
  const decoded = roundTrip(payload);
  assert.equal(decoded, payload);
  const parsed = parseWifiPayload(decoded);
  assert.equal(parsed.ssid, "Cafe Mint");
  assert.equal(parsed.password, "flat;white");
  assert.equal(parsed.hidden, true);
});

test("a generated vCard decodes back into the same contact", () => {
  const payload = buildVCardPayload({ firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "5550100" });
  const decoded = roundTrip(payload);
  assert.equal(decoded, payload);
  const byLabel = Object.fromEntries(parseVCard(decoded).map((f) => [f.label, f.value]));
  assert.equal(byLabel.Name, "Jane Doe");
  assert.equal(byLabel.Email, "jane@example.com");
});

test("non-ASCII text survives the round trip", () => {
  assert.equal(roundTrip("héllo — 日本語 ✓"), "héllo — 日本語 ✓");
});

test("every error-correction level round-trips", () => {
  const { LOW, MEDIUM, QUARTILE, HIGH } = qrcodegen.QrCode.Ecc;
  [LOW, MEDIUM, QUARTILE, HIGH].forEach((ecc) => {
    assert.equal(roundTrip("https://qrmint.net/", ecc), "https://qrmint.net/");
  });
});

test("a code still decodes with a logo over the middle of it", () => {
  const url = "https://qrmint.net/wifi-qr-code/";
  for (let pct = LOGO_MIN_PCT; pct <= LOGO_MAX_PCT; pct++) {
    const { decoded, ecl } = roundTripWithLogo(url, { sizePct: pct });
    assert.equal(ecl, "H", "a logo must force H");
    assert.equal(decoded, url, "a " + pct + "% logo should still scan at H");
    assert.equal(scanVerdict({ decoded, expected: url, hasLogo: true, logoPct: pct, ecl }).state, "ok");
  }
});

test("the whole size range survives every payload kind, plate or no plate", () => {
  const payloads = [
    normalizeUrl("qrmint.net"),
    buildWifiPayload({ ssid: "Cafe Mint", password: "flat;white", enc: "WPA" }),
    buildVCardPayload({ firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "5550100" }),
  ];
  payloads.forEach((payload) => {
    ["none", "rounded", "circle"].forEach((plate) => {
      const { decoded } = roundTripWithLogo(payload, { sizePct: LOGO_MAX_PCT, plate, padPct: 0.16 });
      assert.equal(decoded, payload, "failed with a " + plate + " plate");
    });
  });
});

test("a deliberately over-large logo fails the scan check and is told to shrink", () => {
  const url = "https://qrmint.net/wifi-qr-code/";
  const { decoded, ecl } = roundTripWithLogo(url, { sizePct: 50 });
  assert.equal(decoded, null, "a logo over half the symbol must not quietly pass");
  const verdict = scanVerdict({ decoded, expected: url, hasLogo: true, logoPct: 50, plate: "rounded", ecl });
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.label, "Won't scan");
  assert.match(verdict.detail, /shrink the logo from 50% to about 44%/);
});
