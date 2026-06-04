// Moodle Course Archiver - course scanner.
//
// Injected on demand by the popup. Walks the course structure (sections,
// Moodle 5 subsections, text labels) and every activity on it, then follows
// each activity to the real files: resources, folders (with sub-directories),
// URL modules, pages, books, assignments, forum/announcement attachments and
// links embedded in section summaries or descriptions.
//
// Results are written to chrome.storage.local under `scan:<origin>:<courseId>`
// and progress under `progress:<origin>:<courseId>`, so the popup can be
// closed and reopened while a scan is running.

(() => {
  if (window.__mcaInstalled) return;
  window.__mcaInstalled = true;

  const MAX_PARALLEL_FETCHES = 4;
  const MAX_PAGE_DEPTH = 1; // how deep to follow page -> page links

  // Hosts that serve videos/apps rather than downloadable files.
  const LINK_ONLY_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion\.com|zoom\.us|teams\.microsoft\.com|meet\.google\.com|forms\.gle|kahoot\.it|menti\.com)$/i;
  // Extensions trusted to be files without asking the server first.
  const FILE_EXT = new Set(('pdf doc docx odt rtf txt md tex ppt pptx pps ppsx odp key xls xlsx xlsm ods csv tsv ' +
    'zip rar 7z gz tgz tar bz2 xz png jpg jpeg gif bmp svg webp tif tiff eps ps djvu epub mobi ' +
    'mp4 m4v mkv mov avi wmv webm mp3 wav m4a ogg flac ipynb py r rmd m mat java c h cpp hpp cs js ts ' +
    'sh bat sql json xml yaml yml pkl npy npz h5 hdf5 parquet arff data dat sav dta mw nb ggb exe msi dmg iso jar apk').split(' '));

  let scanning = false;

  // ---------------------------------------------------------------------------
  // Page / site info
  // ---------------------------------------------------------------------------

  function cfgField(html, name) {
    const m = html.match(new RegExp('"' + name + '":"((?:[^"\\\\]|\\\\.)*)"'));
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }

  function pageInfo() {
    const html = document.documentElement.innerHTML;
    const wwwroot = (cfgField(html, 'wwwroot') || '').replace(/\/$/, '');
    const sesskey = cfgField(html, 'sesskey');
    let courseId = null;
    const bodyMatch = (document.body?.className || '').match(/\bcourse-(\d+)\b/);
    if (bodyMatch) courseId = Number(bodyMatch[1]);
    if (!courseId) {
      const m = html.match(/"courseId":(\d+)/);
      if (m) courseId = Number(m[1]);
    }
    const isMoodle = !!(wwwroot && sesskey);
    const isCourse = isMoodle && courseId && courseId > 1; // course 1 is the site front page
    const key = isCourse ? `${new URL(wwwroot).origin}:${courseId}` : null;
    return { isMoodle, isCourse, wwwroot, sesskey, courseId, key };
  }

  // ---------------------------------------------------------------------------
  // Fetch helpers (rate-limited, same-origin so the Moodle session is used)
  // ---------------------------------------------------------------------------

  function createLimiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= max || queue.length === 0) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; next(); });
    };
    return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  }

  const limit = createLimiter(MAX_PARALLEL_FETCHES);
  const progress = { phase: 'Reading course structure', done: 0, total: 0, found: 0 };
  let progressKey = null;
  let progressTimer = null;

  function reportProgress(force) {
    if (!progressKey) return;
    if (progressTimer && !force) return;
    const write = () => {
      progressTimer = null;
      chrome.storage.local.set({ [progressKey]: { ...progress, running: scanning, updatedAt: Date.now() } });
    };
    if (force) { clearTimeout(progressTimer); write(); }
    else progressTimer = setTimeout(write, 250);
  }

  function tracked(fn) {
    progress.total++;
    reportProgress();
    return limit(fn).finally(() => { progress.done++; reportProgress(); });
  }

  const parser = new DOMParser();

  function fetchDoc(url) {
    return tracked(async () => {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const html = await resp.text();
      const doc = parser.parseFromString(html, 'text/html');
      // Make relative URLs resolve against the fetched page.
      const base = doc.createElement('base');
      base.href = resp.url;
      doc.head.prepend(base);
      return doc;
    });
  }

  // Fetches only the response headers (the body is aborted unless it is HTML).
  function fetchHead(url) {
    return tracked(async () => {
      const ac = new AbortController();
      const resp = await fetch(url, { credentials: 'include', signal: ac.signal });
      const contentType = resp.headers.get('content-type') || '';
      const disposition = resp.headers.get('content-disposition') || '';
      let doc = null;
      if (/text\/html/i.test(contentType)) {
        doc = parser.parseFromString(await resp.text(), 'text/html');
        const base = doc.createElement('base');
        base.href = resp.url;
        doc.head.prepend(base);
      } else {
        ac.abort();
      }
      return { finalUrl: resp.url, contentType, disposition, doc, ok: resp.ok };
    });
  }

  // ---------------------------------------------------------------------------
  // Naming helpers
  // ---------------------------------------------------------------------------

  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // Moodle double-encodes some attributes (data-activityname="A &amp;amp; B").
  const entityDecoder = document.createElement('textarea');
  function decodeEntities(s) {
    if (!s || !s.includes('&')) return s || '';
    entityDecoder.innerHTML = s;
    return entityDecoder.value;
  }

  // Text of an element without Moodle's screen-reader-only type suffixes.
  function visibleText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.accesshide, .sr-only, .visually-hidden').forEach(n => n.remove());
    return cleanText(clone.textContent);
  }

  function extOf(name) {
    const m = (name || '').match(/(\.[a-z0-9]{1,8})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function decodeSegment(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function filenameFromDisposition(cd) {
    if (!cd) return null;
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
    if (star) return decodeSegment(star[1].trim().replace(/^"|"$/g, ''));
    const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
    if (plain) return decodeSegment((plain[1] || plain[2]).trim());
    return null;
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last ? decodeSegment(last) : null;
    } catch (e) { return null; }
  }

  // Normalised URL used to detect the same file found in several places.
  function dedupeKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      u.searchParams.delete('forcedownload');
      u.searchParams.delete('time');
      return decodeSegment(u.href);
    } catch (e) { return url; }
  }

  function isoDate(datetime) {
    const m = (datetime || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  }

  // ---------------------------------------------------------------------------
  // Moodle web-service call (works for logged-in users with the sesskey)
  // ---------------------------------------------------------------------------

  async function callAjax(info, methodname, args) {
    const resp = await tracked(() => fetch(`${info.wwwroot}/lib/ajax/service.php?sesskey=${info.sesskey}&info=${methodname}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname, args }])
    }).then(r => r.json()));
    const result = resp && resp[0];
    if (!result || result.error) throw new Error(result?.exception?.errorcode || 'ajax error');
    return result.data;
  }

  async function getCourseState(info) {
    try {
      const raw = await callAjax(info, 'core_courseformat_get_state', { courseid: info.courseId });
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.info('[MCA] Course state API not available, using page structure only:', e.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Scanner
  // ---------------------------------------------------------------------------

  async function scanCourse(info) {
    const wwwroot = info.wwwroot;
    const origin = new URL(wwwroot).origin;
    const seen = new Set();
    const visitedPages = new Set();
    let nextId = 1;

    const courseUrl = `${wwwroot}/course/view.php?id=${info.courseId}`;
    const courseDoc = await fetchDoc(courseUrl);
    const state = await getCourseState(info);

    const courseName = cleanText(
      courseDoc.querySelector('.page-header-headings h1, #page-header h1, header h1')?.textContent ||
      (courseDoc.title || '').split('|')[0]
    ) || `Course ${info.courseId}`;

    const stateCms = new Map((state?.cm || []).map(c => [String(c.id), c]));
    const stateSections = new Map((state?.section || []).map(s => [String(s.id), s]));

    // A slot keeps items in page order even though activities resolve in parallel.
    const tasks = [];
    function newSlot(section) {
      const slot = [];
      section.slots.push(slot);
      return slot;
    }

    function makeItem(fields, ctx) {
      return {
        id: nextId++,
        kind: 'file',
        pre: ctx.pre || [],
        group: ctx.group || null,
        inner: ctx.inner || [],
        ...fields
      };
    }

    function add(slot, item) {
      const key = `${item.kind}|${dedupeKey(item.url)}`;
      if (seen.has(key)) return;
      seen.add(key);
      slot.push(item);
      progress.found++;
      reportProgress();
    }

    // --- file targets ------------------------------------------------------

    function addPluginfile(slot, url, ctx, source, extra = {}) {
      const origName = filenameFromUrl(url) || 'file';
      add(slot, makeItem({ source, url, origName, ext: extOf(origName), title: extra.title || origName, useTitle: !!extra.useTitle, category: extra.category || 'files' }, ctx));
    }

    // Folder files keep their sub-directory structure (…/mod_folder/content/<rev>/sub/dir/file).
    function folderRelativePath(url) {
      try {
        const parts = new URL(url).pathname.split('/');
        const idx = parts.indexOf('content');
        if (idx >= 0 && parts[idx - 1] === 'mod_folder') {
          return parts.slice(idx + 2).map(decodeSegment).filter(Boolean);
        }
      } catch (e) { /* ignore */ }
      return [filenameFromUrl(url) || 'file'];
    }

    async function expandFolder(slot, url, name, ctx) {
      let doc;
      try { doc = await fetchDoc(url); } catch (e) { console.warn('[MCA] folder', url, e); return; }
      const main = doc.querySelector('[role="main"], #region-main') || doc.body;
      const links = Array.from(main.querySelectorAll('a[href*="/pluginfile.php/"]'))
        .filter(a => /\/mod_folder\/content\//.test(a.href));
      for (const a of links) {
        const rel = folderRelativePath(a.href);
        const origName = rel.pop();
        add(slot, makeItem({ source: 'folder', url: a.href, origName, ext: extOf(origName), title: origName, category: 'files' },
          { ...ctx, inner: [...(ctx.inner || []), name, ...rel] }));
      }
      // Folder description may also contain links.
      const intro = doc.querySelector('#intro, .activity-description');
      if (intro) await extractFromContent(slot, intro, { ...ctx, inner: [...(ctx.inner || []), name] }, 'description', 0);
    }

    async function resolveResource(slot, url, name, ctx) {
      let head;
      try { head = await fetchHead(url); } catch (e) { console.warn('[MCA] resource', url, e); return; }
      let fileUrl = null;
      let origName = null;
      if (!head.doc) {
        fileUrl = head.finalUrl;
        origName = filenameFromDisposition(head.disposition) || filenameFromUrl(fileUrl);
      } else {
        // Embedded (video player, PDF object, iframe…) or "click to open" page.
        const main = head.doc.querySelector('[role="main"], #region-main') || head.doc.body;
        const candidates = [
          ...Array.from(main.querySelectorAll('a[href]')).map(a => a.href),
          ...Array.from(main.querySelectorAll('source[src], video[src], audio[src], img[src], iframe[src], embed[src]')).map(e => e.src),
          ...Array.from(main.querySelectorAll('object[data]')).map(o => o.data)
        ];
        fileUrl = candidates.find(u => /\/pluginfile\.php\/.*\/mod_resource\/content\//.test(u)) ||
                  candidates.find(u => /\/pluginfile\.php\//.test(u) && !/\/(user\/icon|theme)\//.test(u));
        if (fileUrl) origName = filenameFromUrl(fileUrl);
      }
      if (!fileUrl) {
        console.warn('[MCA] Could not find the file behind resource', url);
        return;
      }
      add(slot, makeItem({ source: 'resource', url: fileUrl, origName, ext: extOf(origName), title: name, useTitle: true, category: 'files' }, ctx));
    }

    async function resolveUrlModule(slot, url, name, ctx) {
      // forceview=1 shows the info page instead of redirecting to another site.
      const viewUrl = new URL(url);
      viewUrl.searchParams.set('forceview', '1');
      let doc;
      try { doc = await fetchDoc(viewUrl.href); } catch (e) { console.warn('[MCA] url module', url, e); return; }
      const main = doc.querySelector('[role="main"], #region-main') || doc.body;
      const target =
        main.querySelector('.urlworkaround a[href]')?.href ||
        main.querySelector('iframe#resourceobject, iframe[src]')?.src ||
        Array.from(main.querySelectorAll('a[href]')).map(a => a.href).find(h => !h.startsWith(wwwroot)) || null;
      if (!target) {
        console.warn('[MCA] Could not read the target of URL module', url);
        return;
      }
      await addTarget(slot, target, name, ctx, 'url', 0, true);
    }

    // Saves a Moodle page (or book) as a standalone HTML file and collects
    // everything it links to.
    async function savePage(slot, url, name, ctx, source, depth) {
      const pageKey = dedupeKey(url);
      if (visitedPages.has(pageKey)) return;
      visitedPages.add(pageKey);

      let fetchUrl = url;
      if (source === 'book') {
        const cmid = new URL(url).searchParams.get('id');
        if (cmid) fetchUrl = `${wwwroot}/mod/book/tool/print/index.php?id=${cmid}`;
      }
      let doc;
      try { doc = await fetchDoc(fetchUrl); } catch (e) { console.warn('[MCA] page', url, e); return; }
      const content =
        (source === 'book' ? doc.querySelector('.book_content, #page-content') : null) ||
        doc.querySelector('[role="main"] .box.generalbox, [role="main"] .generalbox, [role="main"]') ||
        doc.body;

      const pageTitle = name || cleanText(doc.querySelector('h2, h1')?.textContent) || 'page';
      add(slot, makeItem({
        kind: 'page', source, url, title: pageTitle, useTitle: true, category: 'pages',
        html: buildStandaloneHtml(pageTitle, content, url)
      }, ctx));

      if (depth < MAX_PAGE_DEPTH + 1) {
        await extractFromContent(slot, content, { ...ctx, inner: [...(ctx.inner || []), pageTitle] }, source, depth + 1);
      }
    }

    function buildStandaloneHtml(title, contentEl, sourceUrl) {
      const clone = contentEl.cloneNode(true);
      clone.querySelectorAll('script, .activity-header, [data-region="activity-information"], .completion-info').forEach(n => n.remove());
      // Make every link/image absolute so the saved page keeps working.
      clone.querySelectorAll('[href]').forEach(n => { try { n.setAttribute('href', new URL(n.getAttribute('href'), sourceUrl).href); } catch (e) { /* ignore */ } });
      clone.querySelectorAll('[src]').forEach(n => { try { n.setAttribute('src', new URL(n.getAttribute('src'), sourceUrl).href); } catch (e) { /* ignore */ } });
      const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}img{max-width:100%}</style>
</head><body>
<h1>${esc(title)}</h1>
<p style="color:#666;font-size:.9em">Saved from <a href="${esc(sourceUrl)}">${esc(sourceUrl)}</a> on ${new Date().toISOString().slice(0, 10)}</p>
${clone.innerHTML}
</body></html>`;
    }

    async function scanAssignment(slot, url, name, ctx) {
      let doc;
      try { doc = await fetchDoc(url); } catch (e) { console.warn('[MCA] assign', url, e); return; }
      const main = doc.querySelector('[role="main"], #region-main') || doc.body;
      const inner = [...(ctx.inner || []), name];
      for (const a of main.querySelectorAll('a[href*="/pluginfile.php/"]')) {
        const href = a.href;
        if (/\/assignsubmission_file\//.test(href)) {
          addPluginfile(slot, href, { ...ctx, inner: [...inner, 'My submission'] }, 'assign', { category: 'submissions' });
        } else if (/\/assignfeedback_[a-z]+\//.test(href)) {
          addPluginfile(slot, href, { ...ctx, inner: [...inner, 'Feedback'] }, 'assign', { category: 'submissions' });
        } else if (/\/mod_assign\/(introattachment|intro)\//.test(href)) {
          addPluginfile(slot, href, { ...ctx, inner }, 'assign');
        }
      }
      const intro = main.querySelector('.activity-description, #intro');
      if (intro) await extractFromContent(slot, intro, { ...ctx, inner }, 'assign', 0);
    }

    async function scanForum(slot, url, name, ctx) {
      let first;
      try { first = await fetchDoc(url); } catch (e) { console.warn('[MCA] forum', url, e); return; }

      // Discussion list is paginated (…&p=1, &p=2 …).
      let maxPage = 0;
      first.querySelectorAll('.pagination a[href*="p="], nav a[href*="view.php"][href*="p="]').forEach(a => {
        try {
          const p = Number(new URL(a.href).searchParams.get('p'));
          if (Number.isFinite(p) && p > maxPage) maxPage = p;
        } catch (e) { /* ignore */ }
      });
      const pages = [first];
      if (maxPage > 0) {
        const more = await Promise.all(Array.from({ length: maxPage }, (_, i) => {
          const u = new URL(url);
          u.searchParams.set('p', String(i + 1));
          return fetchDoc(u.href).catch(() => null);
        }));
        pages.push(...more.filter(Boolean));
      }

      const discussionIds = [];
      for (const doc of pages) {
        doc.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]').forEach(a => {
          try {
            const d = new URL(a.href).searchParams.get('d');
            if (d && !discussionIds.includes(d)) discussionIds.push(d);
          } catch (e) { /* ignore */ }
        });
      }

      progress.phase = 'Scanning announcements & forums';
      reportProgress();

      // Each discussion gets its own slot so the order stays newest-first.
      const discussionSlots = discussionIds.map(() => []);
      await Promise.all(discussionIds.map(async (d, i) => {
        let doc;
        try { doc = await fetchDoc(`${wwwroot}/mod/forum/discuss.php?d=${d}&mode=1`); } catch (e) { return; }
        const posts = Array.from(doc.querySelectorAll('[data-region="post"]'));
        if (posts.length === 0) return;
        const firstPost = posts[0];
        const subject = cleanText(
          firstPost.querySelector('[data-region-content="forum-post-core-subject"]')?.textContent ||
          doc.querySelector('.discussionname, h3.discussionname')?.textContent
        ) || `Discussion ${d}`;
        const date = isoDate(firstPost.querySelector('time[datetime]')?.getAttribute('datetime'));
        const discCtx = { ...ctx, inner: [...(ctx.inner || []), name, cleanText(`${date} ${subject}`)] };
        for (const post of posts) {
          const own = el => el.closest('[data-region="post"]') === post;
          await extractFromContent(discussionSlots[i], post, discCtx, 'forum', 0, {
            filter: el => own(el) && !el.closest('header, [data-region="post-actions-container"], .author-groups-container'),
            externalWithin: '.post-content-container',
            category: 'forum'
          });
        }
      }));
      discussionSlots.forEach(s => s.forEach(it => slot.push(it)));
    }

    async function scanGenericModule(slot, url, name, ctx) {
      let doc;
      try { doc = await fetchDoc(url); } catch (e) { return; }
      const main = doc.querySelector('[role="main"], #region-main') || doc.body;
      const intros = main.querySelectorAll('.activity-description, #intro, .box.generalbox');
      for (const intro of intros) {
        await extractFromContent(slot, intro, { ...ctx, inner: [...(ctx.inner || []), name] }, 'module', 0);
      }
    }

    // --- external/internal link classification ----------------------------

    function googleExport(u) {
      const host = u.hostname;
      const path = u.pathname;
      let m;
      if (host === 'docs.google.com') {
        if ((m = path.match(/^\/document\/d\/e\/([^/]+)/))) return { url: `https://docs.google.com/document/d/e/${m[1]}/pub?output=pdf`, ext: '.pdf' };
        if ((m = path.match(/^\/document\/d\/([^/]+)/))) return { url: `https://docs.google.com/document/d/${m[1]}/export?format=pdf`, ext: '.pdf' };
        if ((m = path.match(/^\/spreadsheets\/d\/e\/([^/]+)/))) return { url: `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=xlsx`, ext: '.xlsx' };
        if ((m = path.match(/^\/spreadsheets\/d\/([^/]+)/))) return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`, ext: '.xlsx' };
        if ((m = path.match(/^\/presentation\/d\/e\/([^/]+)/))) return { url: `https://docs.google.com/presentation/d/e/${m[1]}/pub?output=pptx`, ext: '.pptx' };
        if ((m = path.match(/^\/presentation\/d\/([^/]+)/))) return { url: `https://docs.google.com/presentation/d/${m[1]}/export/pptx`, ext: '.pptx' };
        if ((m = path.match(/^\/drawings\/d\/([^/]+)/))) return { url: `https://docs.google.com/drawings/d/${m[1]}/export/png`, ext: '.png' };
        return null;
      }
      if (host === 'drive.google.com') {
        if (/^\/drive\/(u\/\d+\/)?folders\//.test(path)) return null; // folders can't be downloaded directly
        const id = (path.match(/\/file\/d\/([^/]+)/) || [])[1] || u.searchParams.get('id');
        if (id) return { url: `https://drive.google.com/uc?export=download&id=${id}`, ext: '' };
        return null;
      }
      if (host === 'colab.research.google.com') {
        if ((m = path.match(/^\/drive\/([^/?#]+)/))) return { url: `https://drive.google.com/uc?export=download&id=${m[1]}`, ext: '.ipynb' };
        if ((m = path.match(/^\/github\/([^/]+)\/([^/]+)\/blob\/(.+)$/))) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, ext: '.ipynb' };
      }
      return null;
    }

    function knownFileUrl(u) {
      // github.com/<user>/<repo>/blob/<branch>/<path.ext> -> raw file
      let m;
      if (u.hostname === 'github.com' && (m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)) && FILE_EXT.has(extOf(m[3]).slice(1))) {
        return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, origName: decodeSegment(m[3].split('/').pop()) };
      }
      if (/(^|\.)dropbox\.com$/.test(u.hostname) && /^\/(s|scl)\//.test(u.pathname)) {
        const d = new URL(u.href);
        d.searchParams.set('dl', '1');
        return { url: d.href, origName: filenameFromUrl(u.href) };
      }
      const name = filenameFromUrl(u.href);
      const ext = extOf(name);
      if (ext && FILE_EXT.has(ext.slice(1))) return { url: u.href, origName: name };
      return null;
    }

    function probeExternal(url) {
      return tracked(() => new Promise(resolve => {
        try {
          chrome.runtime.sendMessage({ type: 'mca-probe', url }, r => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(r || null);
          });
        } catch (e) { resolve(null); }
      }));
    }

    function niceTitle(u) {
      const host = u.hostname.replace(/^www\./, '');
      let m;
      if (/(^|\.)youtube\.com$/.test(host) && u.searchParams.get('v')) return `YouTube ${u.searchParams.get('v')}`;
      if (host === 'youtu.be') return `YouTube ${u.pathname.slice(1)}`;
      if (host === 'docs.google.com' && (m = u.pathname.match(/^\/(document|spreadsheets|presentation|forms|drawings)\/d\/(?:e\/)?([^/]+)/))) {
        const kind = { document: 'Google Doc', spreadsheets: 'Google Sheet', presentation: 'Google Slides', forms: 'Google Form', drawings: 'Google Drawing' }[m[1]];
        return `${kind} ${m[2].slice(0, 10)}`;
      }
      if (host === 'drive.google.com') {
        if ((m = u.pathname.match(/\/folders\/([^/?]+)/))) return `Google Drive folder ${m[1].slice(0, 10)}`;
        return 'Google Drive file';
      }
      return linkTitle('', u.href);
    }

    function linkTitle(text, url) {
      const t = cleanText(text);
      if (t && !/^https?:\/\//i.test(t) && t.length <= 150) return t;
      try {
        const u = new URL(url);
        return cleanText(`${u.hostname}${u.pathname === '/' ? '' : u.pathname}`).replace(/\/$/, '');
      } catch (e) { return url; }
    }

    // Unwraps tracking/redirect links (Google, Facebook, Outlook safe links).
    function unwrapRedirect(u) {
      const host = u.hostname;
      let target = null;
      if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === '/url') target = u.searchParams.get('q') || u.searchParams.get('url');
      else if (/(^|\.)facebook\.com$/.test(host) && u.pathname === '/l.php') target = u.searchParams.get('u');
      else if (/safelinks\.protection\.outlook\.com$/.test(host)) target = u.searchParams.get('url');
      if (target) { try { return new URL(target); } catch (e) { /* keep original */ } }
      return u;
    }

    // Adds whatever `url` points to: a Moodle file/module, a downloadable
    // external file, or a web link (saved as a shortcut).
    async function addTarget(slot, url, title, ctx, source, depth, fromUrlModule, category) {
      let u;
      try { u = new URL(url); } catch (e) { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      if (u.username || u.password) return; // malformed "http://Email:someone@host" links
      // Link text that is just a URL makes a poor file name.
      const autoTitle = !title || title === linkTitle('', url) || /^https?:\/\//i.test(title);
      u = unwrapRedirect(u);
      url = u.href;
      if (autoTitle && !fromUrlModule) title = niceTitle(u);

      if (u.origin === origin) {
        const p = u.pathname;
        if (/\/(webservice\/)?pluginfile\.php\//.test(p)) {
          if (/\/(user\/icon|theme|core_admin)\//.test(p)) return;
          addPluginfile(slot, url, ctx, source, { title, useTitle: fromUrlModule, category });
        } else if (/\/mod\/resource\/view\.php/.test(p)) {
          await resolveResource(slot, url, title, ctx);
        } else if (/\/mod\/folder\/view\.php/.test(p)) {
          await expandFolder(slot, url, title, ctx);
        } else if (/\/mod\/url\/view\.php/.test(p) && !fromUrlModule) {
          await resolveUrlModule(slot, url, title, ctx);
        } else if (/\/mod\/(page|book)\/view\.php/.test(p) && depth <= MAX_PAGE_DEPTH) {
          await savePage(slot, url, title, ctx, p.includes('/book/') ? 'book' : 'page', depth);
        }
        return; // other Moodle links (profiles, navigation…) are not course material
      }

      const display = title || linkTitle('', url);
      if (LINK_ONLY_HOSTS.test(u.hostname)) {
        add(slot, makeItem({ kind: 'link', source, url, title: display, useTitle: true, category: 'links' }, ctx));
        return;
      }

      const g = googleExport(u);
      if (g) {
        add(slot, makeItem({ source, url: g.url, origName: null, ext: g.ext, needsExt: !g.ext, serverName: autoTitle && !g.ext, title: display, useTitle: true, category: category || 'files', webUrl: url }, ctx));
        return;
      }

      const known = knownFileUrl(u);
      if (known) {
        add(slot, makeItem({ source, url: known.url, origName: known.origName, ext: extOf(known.origName), title: fromUrlModule ? display : (known.origName || display), useTitle: true, category: category || 'files', webUrl: url }, ctx));
        return;
      }

      // Unknown: ask the background worker what the server actually returns.
      const probe = await probeExternal(url);
      if (probe && probe.ok && probe.contentType && !/text\/html|application\/xhtml/i.test(probe.contentType)) {
        const origName = probe.filename || filenameFromUrl(probe.finalUrl || url);
        const ext = extOf(origName);
        add(slot, makeItem({ source, url: probe.finalUrl || url, origName, ext, needsExt: !ext, serverName: !ext && autoTitle, title: fromUrlModule ? display : (origName || display), useTitle: true, category: category || 'files', webUrl: url }, ctx));
        return;
      }
      add(slot, makeItem({ kind: 'link', source, url, title: display, useTitle: true, category: 'links' }, ctx));
    }

    // Collects every file, module link and external link inside an HTML fragment.
    async function extractFromContent(slot, root, ctx, source, depth, opts = {}) {
      const filter = opts.filter || (() => true);
      const jobs = [];
      const handled = new Set();
      const consider = (el, url, text, isEmbed) => {
        if (!url || !filter(el)) return;
        if (/^(mailto|javascript|tel|data):/i.test(url)) return;
        let abs;
        try { abs = new URL(url, root.ownerDocument.baseURI).href; } catch (e) { return; }
        if (abs.split('#')[0] === (root.ownerDocument.baseURI || '').split('#')[0]) return;
        const isInternal = abs.startsWith(origin);
        // Embedded media/images: only Moodle-hosted files are worth saving.
        if (isEmbed && !(isInternal && abs.includes('/pluginfile.php/'))) return;
        // External links in forum posts: only from the post body, not chrome around it.
        if (!isInternal && opts.externalWithin && !el.closest(opts.externalWithin)) return;
        const key = dedupeKey(abs);
        if (handled.has(key)) return;
        handled.add(key);
        // Each link resolves into its own sub-slot so document order is kept.
        const sub = [];
        jobs.push({ sub, run: addTarget(sub, abs, linkTitle(text, abs), ctx, source, depth, false, opts.category) });
      };
      root.querySelectorAll('a[href]').forEach(a => consider(a, a.getAttribute('href'), visibleText(a) || a.getAttribute('title'), false));
      root.querySelectorAll('img[src], video[src], audio[src], source[src], embed[src], iframe[src]').forEach(e => consider(e, e.getAttribute('src'), e.getAttribute('alt') || e.getAttribute('title') || '', e.tagName !== 'IFRAME'));
      root.querySelectorAll('object[data]').forEach(o => consider(o, o.getAttribute('data'), '', true));
      await Promise.all(jobs.map(j => j.run.catch(e => console.warn('[MCA] link failed', e))));
      jobs.forEach(j => j.sub.forEach(it => slot.push(it)));
    }

    // --- course structure walk ---------------------------------------------

    const SECTION_SEL = '[data-for="section"], li.section';

    function ownedBy(el, sectionEl) {
      return el.parentElement && el.parentElement.closest(SECTION_SEL) === sectionEl;
    }

    function activityInfo(li) {
      const cmid = li.getAttribute('data-id') || (li.id.match(/module-(\d+)/) || [])[1];
      const modname = (li.className.match(/\bmodtype_([a-z0-9_]+)/) || [])[1] || '';
      const link = li.querySelector('.activityname a[href], .activityinstance a[href], a.aalink[href]');
      const name = cleanText(decodeEntities(
        li.querySelector('[data-activityname]')?.getAttribute('data-activityname') ||
        visibleText(li.querySelector('.instancename')) ||
        stateCms.get(String(cmid))?.name
      ));
      return { cmid: String(cmid || ''), modname, url: link?.href || stateCms.get(String(cmid))?.url || null, name };
    }

    function labelHeader(contentEl) {
      if (!contentEl) return null;
      const heading = contentEl.querySelector('h1, h2, h3, h4, h5, h6');
      const firstStrong = contentEl.querySelector('strong, b');
      const full = visibleText(contentEl);
      let text = null;
      if (full && full.length <= 80) text = full;
      else if (heading && visibleText(heading).length <= 80) text = visibleText(heading);
      else if (firstStrong && full.startsWith(visibleText(firstStrong)) && visibleText(firstStrong).length <= 80) text = visibleText(firstStrong);
      return text ? text.replace(/[:\-–—\s]+$/, '') : null;
    }

    function queueModule(section, act, ctx) {
      if (!act.url && act.modname !== 'label') return;
      const slot = newSlot(section);
      const name = act.name || `Activity ${act.cmid}`;
      switch (act.modname) {
        case 'resource': tasks.push(() => resolveResource(slot, act.url, name, ctx)); break;
        case 'folder': tasks.push(() => expandFolder(slot, act.url, name, ctx)); break;
        case 'url': tasks.push(() => resolveUrlModule(slot, act.url, name, ctx)); break;
        case 'page': tasks.push(() => savePage(slot, act.url, name, ctx, 'page', 0)); break;
        case 'book': tasks.push(() => savePage(slot, act.url, name, ctx, 'book', 0)); break;
        case 'assign': tasks.push(() => scanAssignment(slot, act.url, name, ctx)); break;
        case 'forum': tasks.push(() => scanForum(slot, act.url, name, ctx)); break;
        case 'subsection': break; // handled by the walker
        default: tasks.push(() => scanGenericModule(slot, act.url, name, ctx));
      }
    }

    const processedCms = new Set();

    function walkSection(sectionEl, section, pre) {
      // Section summary (intro text) links.
      const summaries = Array.from(sectionEl.querySelectorAll('.summarytext, .summary, [data-for="sectioninfo"] .no-overflow'))
        .filter(el => ownedBy(el, sectionEl) && !el.closest('li.activity'));
      const summaryEl = summaries[0];
      if (summaryEl) {
        const slot = newSlot(section);
        tasks.push(() => extractFromContent(slot, summaryEl, { pre, group: null, inner: [] }, 'summary', 0));
      }

      let group = null;
      const activities = Array.from(sectionEl.querySelectorAll('li.activity')).filter(li => ownedBy(li, sectionEl));
      for (const li of activities) {
        const act = activityInfo(li);
        if (act.cmid) processedCms.add(act.cmid);

        if (act.modname === 'label') {
          const contentEl = li.querySelector('.activity-altcontent, .contentwithoutlink, .description, .activity-description');
          const header = labelHeader(contentEl);
          const hasLinks = contentEl && contentEl.querySelector('a[href], img[src*="pluginfile"], video, audio, object, iframe');
          if (hasLinks) {
            const slot = newSlot(section);
            const labelCtx = { pre, group: header || group, inner: [] };
            tasks.push(() => extractFromContent(slot, contentEl, labelCtx, 'label', 0));
          }
          if (header) group = header;
          continue;
        }

        if (act.modname === 'subsection') {
          const nested = li.querySelector(SECTION_SEL);
          if (nested) {
            const title = cleanText(decodeEntities(nested.getAttribute('data-sectionname'))) || act.name;
            walkSection(nested, section, [...pre, ...(group ? [group] : []), title]);
          }
          continue;
        }

        const ctx = { pre, group, inner: [] };
        const desc = li.querySelector('.activity-description, .description .no-overflow, .contentafterlink');
        if (desc) {
          const slot = newSlot(section);
          tasks.push(() => extractFromContent(slot, desc, { ...ctx, inner: act.modname === 'resource' || act.modname === 'url' ? [] : [act.name] }, 'description', 0));
        }
        queueModule(section, act, ctx);
      }
    }

    function topLevelSections(doc) {
      return Array.from(doc.querySelectorAll(SECTION_SEL))
        .filter(el => !el.parentElement.closest('li.activity') && (el.hasAttribute('data-number') || /^section-\d+$/.test(el.id)));
    }

    function sectionMeta(el) {
      const number = Number(el.getAttribute('data-number') ?? (el.id.match(/section-(\d+)/) || [])[1] ?? 0);
      const dbId = el.getAttribute('data-id') || null;
      const title = cleanText(decodeEntities(
        el.getAttribute('data-sectionname') ||
        visibleText(el.querySelector('.sectionname')) ||
        stateSections.get(String(dbId))?.title
      )) || (number === 0 ? 'General' : `Section ${number}`);
      return { number, dbId, title };
    }

    const sections = [];
    const sectionByDbId = new Map();
    const domSections = topLevelSections(courseDoc);

    for (const el of domSections) {
      const meta = sectionMeta(el);
      const section = { number: meta.number, title: meta.title, dbId: meta.dbId, slots: [] };
      sections.push(section);
      if (meta.dbId) sectionByDbId.set(String(meta.dbId), section);

      const hasActivities = Array.from(el.querySelectorAll('li.activity')).some(li => ownedBy(li, el));
      const expectsActivities = meta.dbId && (stateSections.get(String(meta.dbId))?.cmlist?.length || 0) > 0;
      const sectionLink = el.querySelector('.sectionname a[href*="section.php"], .sectionname a[href*="section="]')?.href;

      if (!hasActivities && (expectsActivities || (!state && sectionLink))) {
        // "One section per page" layout: the course page only shows a summary.
        const url = sectionLink || (meta.dbId ? `${wwwroot}/course/section.php?id=${meta.dbId}` : `${courseUrl}&section=${meta.number}`);
        const sectionDoc = await fetchDoc(url).catch(() => null);
        const full = sectionDoc && topLevelSections(sectionDoc).find(s => sectionMeta(s).number === meta.number);
        walkSection(full || el, section, []);
      } else {
        walkSection(el, section, []);
      }
    }

    // Anything the course state knows about that the page didn't render.
    if (state) {
      for (const s of state.section || []) {
        if (s.component) continue; // delegated subsection, already walked through its parent
        let section = sectionByDbId.get(String(s.id));
        for (const cmid of s.cmlist || []) {
          if (processedCms.has(String(cmid))) continue;
          const cm = stateCms.get(String(cmid));
          if (!cm || !cm.url || cm.uservisible === false || cm.module === 'subsection') continue;
          if (!section) {
            section = { number: s.number, title: cleanText(decodeEntities(s.title)) || `Section ${s.number}`, dbId: s.id, slots: [] };
            sections.push(section);
            sectionByDbId.set(String(s.id), section);
          }
          processedCms.add(String(cmid));
          queueModule(section, { cmid: String(cmid), modname: cm.module, url: cm.url, name: cleanText(decodeEntities(cm.name)) }, { pre: [], group: null, inner: [] });
        }
      }
      sections.sort((a, b) => a.number - b.number);
    }

    progress.phase = 'Scanning activities';
    reportProgress(true);
    await Promise.all(tasks.map(t => t().catch(e => console.warn('[MCA] task failed', e))));

    return {
      courseId: info.courseId,
      courseName,
      courseUrl,
      wwwroot,
      scannedAt: Date.now(),
      sections: sections
        .map(s => ({ number: s.number, title: s.title, items: s.slots.flat() }))
    };
  }

  async function startScan() {
    const info = pageInfo();
    if (!info.isCourse || scanning) return;
    scanning = true;
    progressKey = `progress:${info.key}`;
    Object.assign(progress, { phase: 'Reading course structure', done: 0, total: 0, found: 0, error: null });
    reportProgress(true);
    try {
      const result = await scanCourse(info);
      await chrome.storage.local.set({ [`scan:${info.key}`]: result });
    } catch (e) {
      console.error('[MCA] Scan failed', e);
      progress.error = String(e && e.message || e);
    } finally {
      scanning = false;
      progress.phase = progress.error ? 'Scan failed' : 'Done';
      reportProgress(true);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'mca-info') {
      sendResponse({ ...pageInfo(), sesskey: undefined, scanning });
    } else if (msg?.type === 'mca-scan') {
      const info = pageInfo();
      sendResponse({ started: info.isCourse && !scanning, scanning: true });
      startScan();
    }
  });
})();
