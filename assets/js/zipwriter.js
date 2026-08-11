/* qrmint.net — minimal ZIP writer.
 *
 * Writes a valid .zip with STORED (uncompressed) entries only. That is a
 * deliberate trade: PNGs are already deflate-compressed internally, so a
 * second deflate pass would buy a rounding error of space in exchange for
 * pulling in a compression library. Storing them keeps this file to ~120
 * lines with no dependencies, no bundler and no CDN.
 *
 * Layout written (PKZIP APPNOTE 4.3, sections 4.3.7 / 4.3.12 / 4.3.16):
 *   [local header + name + data] * n  ++  [central directory] * n  ++  EOCD
 *
 * Filenames are written as UTF-8 with general-purpose bit 11 set, so
 * non-ASCII names survive the trip into any modern unzip.
 */
(function (global) {
  "use strict";

  // Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320), table built once.
  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  // MS-DOS packed date/time (APPNOTE 4.4.6). Seconds have 2-second resolution.
  function dosDateTime(date) {
    var d = date || new Date();
    var year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /**
   * Build a ZIP archive.
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @param {Date} [date] modification stamp for every entry
   * @returns {Uint8Array} the complete archive
   */
  function buildZip(entries, date) {
    var stamp = dosDateTime(date);
    var prepared = entries.map(function (e) {
      var nameBytes = utf8Bytes(e.name);
      var data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      return { nameBytes: nameBytes, data: data, crc: crc32(data), offset: 0 };
    });

    var localSize = prepared.reduce(function (n, e) {
      return n + 30 + e.nameBytes.length + e.data.length;
    }, 0);
    var centralSize = prepared.reduce(function (n, e) {
      return n + 46 + e.nameBytes.length;
    }, 0);

    var out = new Uint8Array(localSize + centralSize + 22);
    var view = new DataView(out.buffer);
    var p = 0;

    function u16(v) { view.setUint16(p, v, true); p += 2; }
    function u32(v) { view.setUint32(p, v >>> 0, true); p += 4; }
    function bytes(b) { out.set(b, p); p += b.length; }

    prepared.forEach(function (e) {
      e.offset = p;
      u32(0x04034b50);          // local file header signature
      u16(20);                  // version needed to extract (2.0)
      u16(0x0800);              // flags: bit 11 = filename is UTF-8
      u16(0);                   // compression method: 0 = stored
      u16(stamp.time);
      u16(stamp.date);
      u32(e.crc);
      u32(e.data.length);       // compressed size == uncompressed (stored)
      u32(e.data.length);
      u16(e.nameBytes.length);
      u16(0);                   // extra field length
      bytes(e.nameBytes);
      bytes(e.data);
    });

    var centralStart = p;
    prepared.forEach(function (e) {
      u32(0x02014b50);          // central directory header signature
      u16(20);                  // version made by
      u16(20);                  // version needed to extract
      u16(0x0800);
      u16(0);
      u16(stamp.time);
      u16(stamp.date);
      u32(e.crc);
      u32(e.data.length);
      u32(e.data.length);
      u16(e.nameBytes.length);
      u16(0);                   // extra field length
      u16(0);                   // file comment length
      u16(0);                   // disk number start
      u16(0);                   // internal file attributes
      u32(0);                   // external file attributes
      u32(e.offset);            // offset of local header
      bytes(e.nameBytes);
    });

    // Measure the directory before writing the EOCD, or the EOCD's own bytes
    // land inside the size it is supposed to report.
    var centralSizeWritten = p - centralStart;

    u32(0x06054b50);            // end of central directory
    u16(0);                     // this disk number
    u16(0);                     // disk with start of central directory
    u16(prepared.length);
    u16(prepared.length);
    u32(centralSizeWritten);
    u32(centralStart);
    u16(0);                     // .zip file comment length

    return out;
  }

  function zipBlob(entries, date) {
    return new Blob([buildZip(entries, date)], { type: "application/zip" });
  }

  var api = { crc32: crc32, buildZip: buildZip, zipBlob: zipBlob };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.qrmintZip = api;
})(typeof window !== "undefined" ? window : this);
