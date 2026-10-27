// Moodle Course Archiver - zip builder (offscreen document).
//
// Packs the files picked from one cloud folder (Google Drive, SharePoint,
// Nextcloud) into a single .zip. Files are fetched one by one and kept as
// Blobs (Chrome keeps large blobs on disk, not in memory); the zip is stored
// uncompressed, so building it only means computing CRC-32s and writing the
// headers around the file data. The background worker downloads the result.

const MAX_PART_BYTES = 3.5 * 1024 * 1024 * 1024; // plain zip offsets stop at 4 GB: split before that
const PROGRESS_EVERY_MS = 5000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

async function crc32(blob, onChunk) {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    onChunk(value.length);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function localHeader(name, crc, size, when) {
  const h = new DataView(new ArrayBuffer(30));
  h.setUint32(0, 0x04034b50, true);
  h.setUint16(4, 20, true);       // version needed
  h.setUint16(6, 0x0800, true);   // UTF-8 file names
  h.setUint16(8, 0, true);        // stored, no compression
  h.setUint16(10, when.time, true);
  h.setUint16(12, when.date, true);
  h.setUint32(14, crc, true);
  h.setUint32(18, size, true);
  h.setUint32(22, size, true);
  h.setUint16(26, name.length, true);
  h.setUint16(28, 0, true);
  return [h.buffer, name];
}

function centralHeader(name, crc, size, offset, when) {
  const h = new DataView(new ArrayBuffer(46));
  h.setUint32(0, 0x02014b50, true);
  h.setUint16(4, 20, true);       // made by
  h.setUint16(6, 20, true);       // needed
  h.setUint16(8, 0x0800, true);
  h.setUint16(10, 0, true);
  h.setUint16(12, when.time, true);
  h.setUint16(14, when.date, true);
  h.setUint32(16, crc, true);
  h.setUint32(20, size, true);
  h.setUint32(24, size, true);
  h.setUint16(28, name.length, true);
  h.setUint32(42, offset, true);  // the rest (extra, comment, disk, attributes) stays 0
  return [h.buffer, name];
}

function endOfCentralDirectory(count, size, offset) {
  const h = new DataView(new ArrayBuffer(22));
  h.setUint32(0, 0x06054b50, true);
  h.setUint16(8, count, true);
  h.setUint16(10, count, true);
  h.setUint32(12, size, true);
  h.setUint32(16, offset, true);
  return h.buffer;
}

function finishPart(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const local = localHeader(e.name, e.crc, e.blob.size, e.when);
    central.push(...centralHeader(e.name, e.crc, e.blob.size, offset, e.when));
    parts.push(...local, e.blob);
    offset += 30 + e.name.length + e.blob.size;
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const zip = new Blob([...parts, ...central, endOfCentralDirectory(entries.length, centralSize, offset)], { type: 'application/zip' });
  return { url: URL.createObjectURL(zip), size: zip.size };
}

async function buildZip({ jobId, entries }) {
  const encoder = new TextEncoder();
  const usedNames = new Set();
  const failed = [];
  const finished = [];
  let current = [];
  let currentBytes = 0;
  let done = 0;
  let lastProgress = 0;

  const progress = (force) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = now;
    chrome.runtime.sendMessage({ type: 'mca-zip-progress', jobId, done, total: entries.length }).catch(() => {});
  };

  for (const entry of entries) {
    try {
      const resp = await fetch(entry.url, { credentials: 'include' });
      const type = resp.headers.get('content-type') || '';
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (/^text\/html/i.test(type) && !/\.html?$/i.test(entry.path)) throw new Error('got a web page instead of the file (no access?)');
      const blob = await resp.blob();

      // Unique path inside the zip (case-insensitive, like Windows/macOS).
      let path = entry.path;
      for (let n = 2; usedNames.has(path.toLowerCase()); n++) path = entry.path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
      usedNames.add(path.toLowerCase());

      const crc = await crc32(blob, () => progress(false));
      const name = encoder.encode(path);
      if (current.length && currentBytes + blob.size > MAX_PART_BYTES) {
        finished.push(finishPart(current));
        current = [];
        currentBytes = 0;
      }
      current.push({ name, blob, crc, when: dosDateTime() });
      currentBytes += blob.size + name.length + 76;
    } catch (e) {
      failed.push({ path: entry.path, url: entry.url, error: String(e && e.message || e) });
    }
    done++;
    progress(true);
  }
  if (current.length) finished.push(finishPart(current));
  chrome.runtime.sendMessage({ type: 'mca-zip-ready', jobId, parts: finished, failed }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'mca-zip-build') buildZip(msg);
  else if (msg?.type === 'mca-zip-release' && msg.url) URL.revokeObjectURL(msg.url);
});
