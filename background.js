// Moodle Course Archiver - background service worker.
//
// - Downloads the jobs prepared by the popup (files, web-link shortcuts and
//   saved Moodle pages) into the Downloads folder, paced so Moodle isn't flooded.
// - Fixes file extensions after the server answers (Google Drive, unknown links).
// - Probes external links for the scanner to tell files from web pages
//   (the service worker isn't bound by CORS thanks to host permissions).

const START_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 10000;

// Downloads started by us, waiting for Chrome to ask for their filename.
// Keyed by the requested URL; values are FIFO lists of target paths.
const pendingByUrl = new Map();
const pathById = new Map();

function extOf(name) {
  const m = (name || '').match(/(\.[a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

function basename(p) {
  return (p || '').split(/[\\/]/).pop();
}

// Chrome asks every extension listening here for the name of *every* download,
// so only touch the ones we started.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let job = pathById.get(item.id);
  if (!job) {
    const list = pendingByUrl.get(item.url);
    if (list && list.length) {
      job = list.shift();
      if (list.length === 0) pendingByUrl.delete(item.url);
      pathById.set(item.id, job);
    }
  }
  if (!job) {
    suggest();
    return;
  }
  let filename = job.filename;
  const serverBase = basename(item.filename);
  if (job.serverName && serverBase && extOf(serverBase)) {
    filename = job.filename.replace(/[^/]*$/, serverBase.replace(/[<>:"\\|?*\u0000-\u001f]/g, '_'));
  } else if (job.needsExt) {
    const serverExt = extOf(serverBase);
    if (serverExt && extOf(filename) !== serverExt) filename += serverExt;
  }
  suggest({ filename, conflictAction: 'overwrite' });
});

// --- download status shared with the popup ---------------------------------

let status = null;
let statusTimer = null;

function saveStatus(force) {
  if (!status) return;
  const write = () => {
    statusTimer = null;
    chrome.storage.local.set({ downloadStatus: status });
  };
  if (force) { clearTimeout(statusTimer); write(); }
  else if (!statusTimer) statusTimer = setTimeout(write, 300);
}

chrome.downloads.onChanged.addListener(delta => {
  const job = pathById.get(delta.id);
  if (!job || !status) return;
  // Chrome holds some file types (e.g. scripts) until the user clicks "Keep".
  if (delta.danger && !['safe', 'accepted'].includes(delta.danger.current) && !job.held) {
    job.held = true;
    status.held = (status.held || 0) + 1;
    saveStatus();
  }
  if (delta.state?.current === 'complete') {
    status.completed++;
    if (job.held) status.held--;
    pathById.delete(delta.id);
    saveStatus();
  } else if (delta.state?.current === 'interrupted') {
    status.failed.push({ filename: job.filename, url: job.url, error: delta.error?.current || 'interrupted' });
    if (job.held) status.held--;
    pathById.delete(delta.id);
    saveStatus();
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Web links are saved as tiny HTML files that redirect to the page. Unlike
// .url/.webloc shortcuts they open on every OS and Chrome never flags them.
function linkHtml(url, title) {
  const u = escapeHtml(url);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || url)}</title>` +
    `<meta http-equiv="refresh" content="0; url=${u}"></head>` +
    `<body><p>Opening <a href="${u}">${u}</a>…</p></body></html>`;
}

function htmlDataUrl(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function startDownload(job) {
  let url = job.url;
  if (job.kind === 'link') url = htmlDataUrl(linkHtml(job.url, job.title));
  else if (job.kind === 'page') url = htmlDataUrl(job.html || '');

  const entry = { filename: job.filename, needsExt: !!job.needsExt, serverName: !!job.serverName, url: job.url };
  if (!pendingByUrl.has(url)) pendingByUrl.set(url, []);
  pendingByUrl.get(url).push(entry);

  const options = { url, conflictAction: 'overwrite', saveAs: false };
  // With a known name Chrome uses it directly; otherwise we fix it up in
  // onDeterminingFilename once the server's filename (and extension) is known.
  if (!job.needsExt) options.filename = job.filename;

  try {
    const id = await chrome.downloads.download(options);
    if (id !== undefined) pathById.set(id, entry);
    status.started++;
  } catch (e) {
    const list = pendingByUrl.get(url);
    if (list) {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) pendingByUrl.delete(url);
    }
    status.failed.push({ filename: job.filename, url: job.url, error: String(e && e.message || e) });
  }
  saveStatus();
}

async function runDownloads(jobs) {
  status = { total: jobs.length, started: 0, completed: 0, failed: [], startedAt: Date.now(), running: true };
  saveStatus(true);
  for (const job of jobs) {
    await startDownload(job);
    await new Promise(r => setTimeout(r, START_INTERVAL_MS));
  }
  status.running = false;
  saveStatus(true);
}

// --- probing external links -----------------------------------------------

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  try {
    if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
    if (plain) return decodeURIComponent((plain[1] || plain[2]).trim());
  } catch (e) { /* malformed header */ }
  return null;
}

async function probe(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, credentials: 'omit', redirect: 'follow' });
    const result = {
      ok: resp.ok,
      finalUrl: resp.url,
      contentType: resp.headers.get('content-type') || '',
      filename: filenameFromDisposition(resp.headers.get('content-disposition'))
    };
    ac.abort(); // only the headers are needed
    return result;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'download-jobs') {
    runDownloads(msg.jobs || []);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'mca-probe') {
    probe(msg.url).then(sendResponse);
    return true; // async response
  }
  return false;
});
