/**
 * Minimal ZIP writer (store method, no compression).
 *
 * An .xlsx file is a ZIP of XML parts. Writing this by hand — about 120 lines —
 * is what lets the Excel exporter work with NO build step and NO third-party
 * library, which was a hard requirement for this project.
 *
 * Store (method 0) is used deliberately: it needs no DEFLATE implementation,
 * and the XML in a lead export is small enough that the size difference does
 * not matter.
 */

/* CRC-32, table-driven. Built once on first use. */
let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* Little-endian writers */
function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/** MS-DOS date/time, as required by the ZIP local header. */
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function createZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // ---- local file header ----
    const local = [
      ...u32(0x04034b50),      // signature
      ...u16(20),              // version needed
      ...u16(0x0800),          // flags: bit 11 = UTF-8 filenames
      ...u16(0),               // method 0 = store
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ];
    localParts.push(Uint8Array.from(local), nameBytes, dataBytes);

    // ---- central directory entry ----
    const central = [
      ...u32(0x02014b50),
      ...u16(20), ...u16(20),
      ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ];
    centralParts.push(Uint8Array.from(central), nameBytes);

    offset += local.length + nameBytes.length + dataBytes.length;
    count += 1;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(count), ...u16(count),
    ...u32(centralSize), ...u32(offset),
    ...u16(0),
  ]);

  const all = [...localParts, ...centralParts, end];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of all) { out.set(part, cursor); cursor += part.length; }
  return out;
}

/** Base64 for a byte array, chunked so a large export cannot blow the stack. */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
