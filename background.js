// Moodle Course Archiver - background service worker.
//
// - Downloads the jobs prepared by the popup (files, web-link shortcuts and
//   saved Moodle pages) into the Downloads folder, paced so Moodle isn't flooded.
// - Fixes file extensions after the server answers (Google Drive, unknown links).
// - Probes external links for the scanner to tell files from web pages
//   (the service worker isn't bound by CORS thanks to host permissions).

const START_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 15000;

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
  // A "file" that arrives as a web page is a login/permission/error page, not material.
  if (job.kind === 'file' && /^text\/html/i.test(item.mime || '') && !/\.html?$/i.test(job.filename)) {
    suggest();
    job.rejected = true;
    chrome.downloads.cancel(item.id);
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
    if (job.blobUrl) releaseZipUrl(job.blobUrl);
    saveStatus();
  } else if (delta.state?.current === 'interrupted') {
    const error = job.rejected ? 'got a web page instead of the file (no access?)' : (delta.error?.current || 'interrupted');
    status.failed.push({ filename: job.filename, url: job.url, error });
    if (job.held) status.held--;
    pathById.delete(delta.id);
    if (job.blobUrl) releaseZipUrl(job.blobUrl);
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

// Shares (SharePoint) whose files need the guest cookie set by opening the link.
const primedShares = new Set();

async function startDownload(job) {
  let url = job.url;
  if (job.kind === 'link') url = htmlDataUrl(linkHtml(job.url, job.title));
  else if (job.kind === 'page') url = htmlDataUrl(job.html || '');
  else if (job.kind === 'text') url = 'data:application/octet-stream;charset=utf-8,' + encodeURIComponent(job.text || '');

  if (job.prime && !primedShares.has(job.prime)) {
    primedShares.add(job.prime);
    try { await fetch(job.prime, { credentials: 'include' }); } catch (e) { /* download will report it */ }
  }

  const entry = { kind: job.kind, filename: job.filename, needsExt: !!job.needsExt, serverName: !!job.serverName, url: job.url, blobUrl: job.blobUrl };
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
    if (job.blobUrl) releaseZipUrl(job.blobUrl);
  }
  saveStatus();
}

async function primeShare(url) {
  if (!url || primedShares.has(url)) return;
  primedShares.add(url);
  try { await fetch(url, { credentials: 'include' }); } catch (e) { /* the download will report it */ }
}

// --- cloud folders packed into one zip ---------------------------------------
//
// The zip is built in an offscreen document (service workers can't make blob
// URLs); it reports progress and hands back blob URLs, which are downloaded
// like any other file and released once saved.

const zipWaiters = new Map();   // build id -> resolve
let openZipUrls = 0;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Pack the files picked from a cloud folder into one zip file'
  });
}

async function closeOffscreenIfIdle() {
  if (openZipUrls > 0 || zipWaiters.size > 0) return;
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

async function startZip(job) {
  if (job.directUrl) return startDownload({ kind: 'file', url: job.directUrl, filename: job.filename });
  for (const prime of new Set(job.entries.map(e => e.prime).filter(Boolean))) await primeShare(prime);
  await ensureOffscreen();
  const buildId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  status.packing = { name: basename(job.filename), done: 0, total: job.entries.length };
  saveStatus(true);
  const result = await new Promise(resolve => {
    zipWaiters.set(buildId, resolve);
    chrome.runtime.sendMessage({ type: 'mca-zip-build', jobId: buildId, entries: job.entries }).catch(() => {});
  });
  zipWaiters.delete(buildId);
  status.packing = null;
  for (const f of result.failed) {
    status.failed.push({ filename: `${job.filename} › ${f.path}`, url: f.url, error: f.error });
  }
  if (!result.parts.length) {
    status.failed.push({ filename: job.filename, url: '', error: 'none of the files could be fetched' });
    saveStatus(true);
    await closeOffscreenIfIdle();
    return;
  }
  status.total += result.parts.length - 1;
  for (let i = 0; i < result.parts.length; i++) {
    const filename = result.parts.length === 1 ? job.filename : job.filename.replace(/(\.zip)?$/i, ` (part ${i + 1}).zip`);
    openZipUrls++;
    await startDownload({ kind: 'zip', url: result.parts[i].url, filename, blobUrl: result.parts[i].url });
  }
}

async function releaseZipUrl(url) {
  chrome.runtime.sendMessage({ type: 'mca-zip-release', url }).catch(() => {});
  openZipUrls = Math.max(0, openZipUrls - 1);
  await closeOffscreenIfIdle();
}

async function runDownloads(jobs) {
  primedShares.clear();
  status = { total: jobs.length, started: 0, completed: 0, failed: [], startedAt: Date.now(), running: true };
  saveStatus(true);
  for (const job of jobs) {
    if (job.kind === 'zip') await startZip(job);
    else await startDownload(job);
    await new Promise(r => setTimeout(r, START_INTERVAL_MS));
  }
  status.running = false;
  saveStatus(true);
}

// Google's download endpoints refuse requests that carry an Origin header,
// which every extension request has. Drop it for the extension's own
// (tab-less) requests to Google, so Drive files can be fetched into zips.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      requestDomains: ['drive.usercontent.google.com', 'drive.google.com', 'docs.google.com', 'googleusercontent.com'],
      tabIds: [-1],
      resourceTypes: ['xmlhttprequest', 'other']
    }
  }]
}).catch(e => console.warn('Could not set the Google download rule', e));

// --- Nextcloud / ownCloud public shares --------------------------------------

const NC_MAX_FILES = 500;
const NC_MAX_DEPTH = 5;

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Lists a public share through its WebDAV endpoint (the same one the share's
// web page uses). Files are then fetched from …/public.php/dav/files/<token>/<path>.
async function listNextcloudShare(base, token) {
  const root = `${base}/public.php/dav/files/${token}`;
  const enc = parts => parts.map(encodeURIComponent).join('/');
  const files = [];
  const walk = async (rel, depth) => {
    if (depth > NC_MAX_DEPTH || files.length >= NC_MAX_FILES) return true;
    const resp = await fetch(`${root}/${enc(rel)}${rel.length ? '/' : ''}`, {
      method: 'PROPFIND',
      credentials: 'omit',
      headers: { Depth: '1', 'X-Requested-With': 'XMLHttpRequest', Authorization: 'Basic ' + btoa(`${token}:`) }
    });
    if (resp.status !== 207) return false;
    const xml = await resp.text();
    const responses = xml.split(/<d:response>/).slice(2); // the first one is the folder itself
    for (const r of responses) {
      const href = xmlUnescape((r.match(/<d:href>([^<]+)<\/d:href>/) || [])[1] || '');
      const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() || '');
      if (!name) continue;
      if (/<d:collection\s*\/>/.test(r)) {
        await walk([...rel, name], depth + 1);
      } else if (files.length < NC_MAX_FILES) {
        const size = Number((r.match(/<d:getcontentlength>(\d+)</) || [])[1]) || null;
        files.push({ name, size, rel, url: `${root}/${enc([...rel, name])}` });
      }
    }
    return true;
  };
  try {
    return (await walk([], 0)) ? { files } : null;
  } catch (e) {
    return null;
  }
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

// Size of the whole file from a ranged (Content-Range) or plain response.
function totalSize(resp) {
  const range = resp.headers.get('content-range');
  const m = range && range.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = resp.headers.get('content-length');
  return resp.status === 200 && len ? Number(len) : null;
}

async function probe(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    // Ask for one byte: enough to learn the type, name and total size.
    const resp = await fetch(url, { method: 'GET', signal: ac.signal, credentials: 'include', redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    const result = {
      ok: resp.ok,
      finalUrl: resp.url,
      contentType: resp.headers.get('content-type') || '',
      filename: filenameFromDisposition(resp.headers.get('content-disposition')),
      size: totalSize(resp)
    };
    ac.abort(); // only the headers are needed
    return result;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reads (the start of) a text response: web pages to inspect, Drive folder
// listings, oEmbed/GitHub JSON. Large or binary responses are cut off.
async function fetchText(url, maxBytes = 1500000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal, credentials: 'include', redirect: 'follow' });
    const contentType = resp.headers.get('content-type') || '';
    const result = { ok: resp.ok, status: resp.status, finalUrl: resp.url, contentType, text: '' };
    if (!/text|json|xml|javascript/i.test(contentType)) { ac.abort(); return result; }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch (e) {
      // Timed out mid-body (some servers trickle): use what has arrived.
      if (total === 0) return null;
    }
    ac.abort();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    result.text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(total, maxBytes)));
    return result;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- SharePoint / OneDrive for Business shared folders ---------------------
//
// Opening an "anyone with the link" share sets a guest cookie and redirects to
// the folder (…/onedrive.aspx?id=/personal/<user>/Documents/<path>). With that
// cookie the SharePoint REST API lists the folder and download.aspx serves files.

const SP_MAX_FILES = 500;
const SP_MAX_DEPTH = 4;

async function listSharePointFolder(shareUrl) {
  try {
    const resp = await fetch(shareUrl, { credentials: 'include', redirect: 'follow' });
    if (!resp.ok) return null;
    const html = await resp.text();
    const folder = new URL(resp.url).searchParams.get('id');
    const web = (html.match(/"webAbsoluteUrl":"([^"]+)"/) || [])[1]?.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
    if (!folder || !web) return null;

    const files = [];
    const walk = async (path, rel, depth) => {
      if (depth > SP_MAX_DEPTH || files.length >= SP_MAX_FILES) return;
      const api = `${web}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(path.replace(/'/g, "''"))}')` +
        '?$expand=Files,Folders&$select=Name,Files/Name,Files/Length,Files/ServerRelativeUrl,Folders/Name,Folders/ServerRelativeUrl';
      const r = await fetch(api, { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } });
      if (!r.ok) return;
      const data = await r.json();
      for (const f of data.Files || []) {
        if (files.length >= SP_MAX_FILES) break;
        files.push({
          name: f.Name,
          size: Number(f.Length) || null,
          rel,
          url: `${web}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(f.ServerRelativeUrl)}`
        });
      }
      for (const sub of data.Folders || []) {
        if (sub.Name === 'Forms') continue; // SharePoint system folder
        await walk(sub.ServerRelativeUrl, [...rel, sub.Name], depth + 1);
      }
    };
    await walk(folder, [], 0);
    return { name: decodeURIComponent(folder.split('/').pop() || 'Shared folder'), files };
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'mca-zip-progress') {
    if (status?.packing) { status.packing.done = msg.done; saveStatus(); }
    return false;
  }
  if (msg?.type === 'mca-zip-ready') {
    zipWaiters.get(msg.jobId)?.(msg);
    return false;
  }
  if (msg?.type === 'mca-nextcloud') {
    listNextcloudShare(msg.base, msg.token).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'mca-sharepoint') {
    listSharePointFolder(msg.url).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'mca-fetch-text') {
    fetchText(msg.url, msg.maxBytes).then(sendResponse);
    return true; // async response
  }
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
