// Moodle Course Archiver - popup.

const CATEGORIES = [
  { id: 'files', label: 'Files' },
  { id: 'videos', label: 'Videos & audio' },
  { id: 'forum', label: 'Announcements' },
  { id: 'submissions', label: 'My submissions' },
  { id: 'pages', label: 'Pages' },
  { id: 'links', label: 'Web links' }
];

const ICONS = {
  pdf: '📕', doc: '📘', docx: '📘', odt: '📘', rtf: '📘', txt: '📄', md: '📄',
  ppt: '📙', pptx: '📙', odp: '📙', key: '📙',
  xls: '📗', xlsx: '📗', ods: '📗', csv: '📗',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', gz: '🗜️', tar: '🗜️',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
  mp4: '🎬', mkv: '🎬', mov: '🎬', avi: '🎬', webm: '🎬', webex: '🎬', mp3: '🎵', wav: '🎵', m4a: '🎵',
  ipynb: '📓', py: '🐍', r: '📊', m: '📊', java: '☕', c: '💾', cpp: '💾', h: '💾', js: '💾', sh: '💾', sql: '💾'
};

const DEFAULT_PREFS = {
  popupTheme: 'light',
  // Web links (sites, YouTube…) are opt-in: they aren't files a student can study offline.
  categoryFilter: { files: true, videos: true, forum: true, submissions: true, pages: true, links: false },
  numberSections: true,
  labelFolders: true,
  fileNames: 'title',
  showDuplicates: false,
  zipClouds: true
};

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const filesDiv = $('files');
  const downloadBtn = $('download');
  const rescanBtn = $('rescan');
  const courseInput = $('course-name');
  const scanStatus = $('scan-status');
  const progressBar = $('progress');
  const chipsDiv = $('chips');
  const dlStatus = $('dl-status');

  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_PREFS).concat(['courseFolders']));
  const prefs = { ...DEFAULT_PREFS, ...stored, categoryFilter: { ...DEFAULT_PREFS.categoryFilter, ...(stored.categoryFilter || {}) } };
  const courseFolders = stored.courseFolders || {};

  // --- theme ---------------------------------------------------------------
  const applyTheme = t => document.documentElement.classList.toggle('dark', t === 'dark');
  applyTheme(prefs.popupTheme);
  $('theme-toggle').checked = prefs.popupTheme === 'dark';
  $('theme-toggle').addEventListener('change', e => {
    prefs.popupTheme = e.target.checked ? 'dark' : 'light';
    applyTheme(prefs.popupTheme);
    chrome.storage.local.set({ popupTheme: prefs.popupTheme });
  });

  // --- naming options ------------------------------------------------------
  $('opt-number').checked = prefs.numberSections;
  $('opt-labels').checked = prefs.labelFolders;
  $('opt-names').value = prefs.fileNames;
  $('opt-dupes').checked = prefs.showDuplicates;
  $('opt-zip').checked = prefs.zipClouds;
  const savePref = (key, value) => { prefs[key] = value; chrome.storage.local.set({ [key]: value }); render(); };
  $('opt-number').addEventListener('change', e => savePref('numberSections', e.target.checked));
  $('opt-labels').addEventListener('change', e => savePref('labelFolders', e.target.checked));
  $('opt-dupes').addEventListener('change', e => savePref('showDuplicates', e.target.checked));
  $('opt-zip').addEventListener('change', e => savePref('zipClouds', e.target.checked));
  $('opt-names').addEventListener('change', e => savePref('fileNames', e.target.value));

  // --- talk to the page ----------------------------------------------------
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let info = null;
  let scan = null;
  const selected = new Set();
  const collapsed = new Set();

  function setEmpty(html) {
    filesDiv.innerHTML = `<div class="empty">${html}</div>`;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Download';
  }

  async function connect() {
    if (!tab || !/^https?:/.test(tab.url || '')) return null;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
      return await chrome.tabs.sendMessage(tab.id, { type: 'mca-info' });
    } catch (e) {
      console.warn('Could not reach the page', e);
      return null;
    }
  }

  info = await connect();
  if (!info || !info.isMoodle) {
    scanStatus.textContent = 'Open a Moodle course page to use the archiver.';
    rescanBtn.disabled = true;
    setEmpty('This page is not a Moodle site (or you are not logged in).');
    return;
  }
  if (!info.isCourse) {
    scanStatus.textContent = 'Open one of your courses to archive it.';
    rescanBtn.disabled = true;
    setEmpty('This Moodle page does not belong to a course.');
    return;
  }

  const scanKey = `scan:${info.key}`;
  const progressKey = `progress:${info.key}`;

  // The folder defaults to the course's name on Moodle. A name typed by the
  // user is remembered per course; clearing the field goes back to the default.
  let defaultCourseFolder = '';
  function setDefaultCourseFolder(name) {
    if (!name) return;
    defaultCourseFolder = mcaSafeFolder(name, 'Course');
    courseInput.placeholder = defaultCourseFolder;
    if (!courseFolders[info.key]) courseInput.value = defaultCourseFolder;
  }
  courseInput.value = courseFolders[info.key] || '';
  chrome.tabs.sendMessage(tab.id, { type: 'mca-course-name' })
    .then(r => { setDefaultCourseFolder(r && r.name); render(); })
    .catch(() => {});

  courseInput.addEventListener('input', () => {
    const value = courseInput.value.trim();
    if (!value || value === defaultCourseFolder) delete courseFolders[info.key];
    else courseFolders[info.key] = courseInput.value;
    chrome.storage.local.set({ courseFolders });
    render();
  });
  courseInput.addEventListener('blur', () => {
    if (!courseInput.value.trim()) courseInput.value = defaultCourseFolder;
  });

  function startScan() {
    rescanBtn.disabled = true;
    scanStatus.classList.remove('error');
    scanStatus.textContent = 'Starting scan…';
    progressBar.hidden = false;
    chrome.tabs.sendMessage(tab.id, { type: 'mca-scan' }).catch(() => {
      scanStatus.textContent = 'Could not start the scan. Reload the page and try again.';
    });
  }
  rescanBtn.addEventListener('click', startScan);

  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function showProgress(p) {
    if (!p || !p.running) {
      progressBar.hidden = true;
      rescanBtn.disabled = false;
      if (p && p.error) {
        scanStatus.classList.add('error');
        scanStatus.textContent = `Scan failed: ${p.error}`;
      }
      return;
    }
    rescanBtn.disabled = true;
    progressBar.hidden = false;
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 5;
    progressBar.firstElementChild.style.width = pct + '%';
    scanStatus.classList.remove('error');
    scanStatus.textContent = `${p.phase}… ${p.done}/${p.total} pages · ${p.found} items found`;
  }

  function setScan(s) {
    scan = s;
    selected.clear();
    if (scan) {
      scan.sections.forEach(sec => sec.items.forEach(it => selected.add(it.id)));
      if (!defaultCourseFolder) setDefaultCourseFolder(scan.courseName);
      const items = scan.sections.flatMap(sec => sec.items);
      const dupes = items.filter(it => it.duplicateOf).length;
      scanStatus.textContent = `Scanned ${timeAgo(scan.scannedAt)} · ${items.length - dupes} items` +
        (dupes ? ` · ${dupes} duplicate${dupes === 1 ? '' : 's'} hidden` : '');
    }
    render();
  }

  // --- rendering -----------------------------------------------------------

  const isShown = item => !item.duplicateOf || prefs.showDuplicates;
  const visible = item => isShown(item) && prefs.categoryFilter[item.category || 'files'] !== false;

  function iconFor(item) {
    if (item.kind === 'link') return '🔗';
    if (item.kind === 'page') return '📰';
    if (item.kind === 'stream') return '▶️';
    const ext = (item.ext || mcaExtOf(item.origName) || '').replace('.', '');
    return ICONS[ext] || '📄';
  }

  function renderChips() {
    chipsDiv.innerHTML = '';
    if (!scan) return;
    const counts = {};
    scan.sections.forEach(sec => sec.items.filter(isShown).forEach(it => { const c = it.category || 'files'; counts[c] = (counts[c] || 0) + 1; }));
    for (const cat of CATEGORIES) {
      if (!counts[cat.id]) continue;
      const chip = document.createElement('label');
      chip.className = 'chip' + (prefs.categoryFilter[cat.id] !== false ? ' on' : '');
      chip.innerHTML = `<input type="checkbox"> ${cat.label} <span class="n">${counts[cat.id]}</span>`;
      chip.querySelector('input').checked = prefs.categoryFilter[cat.id] !== false;
      chip.querySelector('input').addEventListener('change', e => {
        prefs.categoryFilter[cat.id] = e.target.checked;
        chrome.storage.local.set({ categoryFilter: prefs.categoryFilter });
        render();
      });
      chipsDiv.appendChild(chip);
    }
  }

  function currentOpts() {
    return {
      courseFolder: courseInput.value.trim() || defaultCourseFolder,
      numberSections: prefs.numberSections,
      labelFolders: prefs.labelFolders,
      originalNames: prefs.fileNames === 'original',
      zipClouds: prefs.zipClouds
    };
  }

  function render() {
    renderChips();
    if (!scan) return;

    const opts = currentOpts();
    const all = [];
    scan.sections.forEach(section => section.items.forEach(item => { if (visible(item)) all.push({ section, item }); }));
    // Compute final paths for every visible item so the list shows exactly what will be saved.
    const jobs = mcaBuildJobs(scan, all, opts);
    const pathOf = new Map(jobs.flatMap(j => (j.kind === 'zip' ? j.items.map(i => [i.itemId, i.filename]) : [[j.itemId, j.filename]])));

    const scrollTop = filesDiv.scrollTop;
    filesDiv.innerHTML = '';
    if (all.length === 0) {
      setEmpty(scan.sections.some(s => s.items.length) ? 'Nothing to show with the current filters. Turn a category on above.' : 'No files found in this course.');
      return;
    }

    for (const section of scan.sections) {
      const items = section.items.filter(visible);
      if (items.length === 0) continue;
      const secKey = `${section.number}`;

      const wrap = document.createElement('div');
      wrap.className = 'section' + (collapsed.has(secKey) ? ' collapsed' : '');

      const head = document.createElement('div');
      head.className = 'section-head';
      const secCb = document.createElement('input');
      secCb.type = 'checkbox';
      const nSel = items.filter(it => selected.has(it.id)).length;
      secCb.checked = nSel === items.length;
      secCb.indeterminate = nSel > 0 && nSel < items.length;
      secCb.addEventListener('click', e => e.stopPropagation());
      secCb.addEventListener('change', () => {
        items.forEach(it => secCb.checked ? selected.add(it.id) : selected.delete(it.id));
        render();
      });
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '▾';
      const title = document.createElement('span');
      title.textContent = section.title;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${nSel}/${items.length}`;
      head.append(chev, secCb, title, count);
      head.addEventListener('click', () => {
        collapsed.has(secKey) ? collapsed.delete(secKey) : collapsed.add(secKey);
        wrap.classList.toggle('collapsed');
      });

      const list = document.createElement('div');
      list.className = 'section-items';
      for (const item of items) {
        const full = pathOf.get(item.id) || '';
        const parts = full.split('/');
        const fileName = parts.pop();
        const where = parts.slice(2).join(' / '); // below Course/Section

        const row = document.createElement('label');
        row.className = 'file';
        row.title = `${full}\n\nSource: ${item.webUrl || item.url}`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(item.id);
        cb.addEventListener('change', () => {
          cb.checked ? selected.add(item.id) : selected.delete(item.id);
          render();
        });
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = iconFor(item);
        const names = document.createElement('div');
        names.className = 'names';
        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = fileName;
        names.appendChild(nameEl);
        const meta = [where];
        if (item.copies?.length) meta.push(`also posted in ${item.copies.length === 1 ? item.copies[0] : `${item.copies.length} other places`}`);
        if (item.duplicateOf) meta.push('duplicate copy');
        if (meta.some(Boolean)) {
          const whereEl = document.createElement('div');
          whereEl.className = 'where';
          whereEl.textContent = meta.filter(Boolean).join(' · ');
          names.appendChild(whereEl);
        }
        if (item.copies?.length) row.title += `\n\nSame file also in:\n${item.copies.join('\n')}`;
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatSize(item.size);
        row.append(cb, icon, names, size);
        list.appendChild(row);
      }

      wrap.append(head, list);
      filesDiv.appendChild(wrap);
    }

    filesDiv.scrollTop = scrollTop;
    const chosen = all.filter(({ item }) => selected.has(item.id));
    const bytes = chosen.reduce((sum, { item }) => sum + (item.size || 0), 0);
    downloadBtn.disabled = chosen.length === 0;
    downloadBtn.textContent = chosen.length ? `Download ${chosen.length}${bytes ? ` · ${formatSize(bytes)}` : ''}` : 'Download';
  }

  $('select-all').addEventListener('click', () => {
    scan?.sections.forEach(sec => sec.items.filter(visible).forEach(it => selected.add(it.id)));
    render();
  });
  $('select-none').addEventListener('click', () => {
    scan?.sections.forEach(sec => sec.items.filter(visible).forEach(it => selected.delete(it.id)));
    render();
  });

  downloadBtn.addEventListener('click', async () => {
    if (!scan) return;
    const chosen = [];
    scan.sections.forEach(section => section.items.forEach(item => {
      if (visible(item) && selected.has(item.id)) chosen.push({ section, item });
    }));
    if (chosen.length === 0) return;
    const opts = currentOpts();
    const all = mcaBuildJobs(scan, chosen, opts);
    // Online videos can't be fetched by Chrome itself: they go into a yt-dlp script.
    const streams = all.filter(j => j.kind === 'stream');
    const jobs = all.filter(j => j.kind !== 'stream');
    if (streams.length) {
      const platform = /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix';
      const script = mcaBuildVideoScript(streams, opts.courseFolder || scan.courseName, platform);
      jobs.push({ kind: 'text', filename: script.filename, text: script.text });
    }
    downloadBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'download-jobs', jobs });
    scriptNote = streams.length
      ? `${streams.length} online video(s) go into "${jobs[jobs.length - 1].filename.split('/').pop()}" in the course folder. ` +
        'Run it to download them (it needs yt-dlp; Chrome may ask you to "Keep" the script first).'
      : '';
    dlStatus.textContent = `Starting ${jobs.length} downloads… ${scriptNote}`;
  });

  let scriptNote = '';

  // --- download status -----------------------------------------------------

  function showDownloadStatus(s) {
    if (!s) { dlStatus.textContent = ''; return; }
    const done = s.completed + s.failed.length;
    let text = s.packing
      ? `Packing ${s.packing.name}… ${s.packing.done}/${s.packing.total} files (${s.completed}/${s.total} saved)`
      : s.running || done < s.total
      ? `Downloading… ${s.completed}/${s.total} saved`
      : `Finished: ${s.completed}/${s.total} saved`;
    if (s.failed.length) text += `, ${s.failed.length} failed`;
    if (s.held > 0) text += `. ${s.held} waiting for you to click "Keep" in Chrome's downloads (Ctrl+J)`;
    dlStatus.innerHTML = '';
    dlStatus.append(text);
    if (scriptNote) {
      const note = document.createElement('div');
      note.textContent = scriptNote;
      dlStatus.appendChild(note);
    }
    if (s.failed.length) {
      const det = document.createElement('details');
      det.innerHTML = '<summary>Show failed downloads</summary>';
      const ul = document.createElement('ul');
      s.failed.slice(0, 50).forEach(f => {
        const li = document.createElement('li');
        li.textContent = `${f.filename} (${f.error})`;
        ul.appendChild(li);
      });
      det.appendChild(ul);
      dlStatus.appendChild(det);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[progressKey]) showProgress(changes[progressKey].newValue);
    if (changes[scanKey]) setScan(changes[scanKey].newValue);
    if (changes.downloadStatus) showDownloadStatus(changes.downloadStatus.newValue);
  });

  // --- initial state -------------------------------------------------------
  const initial = await chrome.storage.local.get([scanKey, progressKey, 'downloadStatus']);
  showDownloadStatus(initial.downloadStatus);
  if (initial[scanKey]) setScan(initial[scanKey]);
  if (info.scanning) {
    showProgress(initial[progressKey] || { running: true, phase: 'Scanning', done: 0, total: 0, found: 0 });
  } else if (!initial[scanKey]) {
    setEmpty('Scanning course… you can close this popup, the scan keeps running.');
    startScan();
  }
});
