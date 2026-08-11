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

const { buildWifiPayload, buildVCardPayload, normalizeUrl } = require("./app.js");
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
