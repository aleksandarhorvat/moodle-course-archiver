// Moodle Course Archiver - folder & file naming.
//
// Turns scanned items into safe relative download paths:
//   <Course>/<NN - Section>/<subsection>/<label group>/<activity folders…>/<file>
// Every segment is made safe for Windows, macOS and Linux, and duplicate
// paths get " (2)", " (3)"… so nothing overwrites anything else.

const MCA_MAX_SEGMENT = 80;
const MCA_MAX_FILENAME = 120;
const MCA_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function mcaExtOf(name) {
  const m = (name || '').match(/(\.[a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

function mcaTruncate(s, max) {
  return s.length > max ? s.slice(0, max).trim() : s;
}

// One path segment (folder or file base name).
function mcaSafeSegment(raw, fallback = '_') {
  let s = String(raw || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s*:\s+/g, ' - ')    // "Course: Topic" -> "Course - Topic"
    .replace(/[/\\]/g, '-')        // "2025/26" -> "2025-26"
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')     // no hidden / dot-leading names
    .replace(/[.\s]+$/, '');    // Windows strips trailing dots and spaces
  if (!s) s = fallback;
  if (MCA_RESERVED.test(s)) s = '_' + s;
  return s;
}

function mcaSafeFolder(raw, fallback) {
  return mcaSafeSegment(mcaTruncate(String(raw || ''), MCA_MAX_SEGMENT), fallback);
}

function mcaSafeFilename(raw, fallback = 'file') {
  const name = String(raw || '').trim();
  const ext = mcaExtOf(name);
  let base = ext ? name.slice(0, -ext.length) : name;
  base = mcaSafeSegment(mcaTruncate(base, MCA_MAX_FILENAME - ext.length), fallback);
  return base + ext;
}

function mcaPad(n, width) {
  return String(n).padStart(width, '0');
}

function mcaSectionFolder(section, opts, width) {
  const title = mcaSafeFolder(section.title, `Section ${section.number}`);
  return opts.numberSections ? `${mcaPad(section.number, width)} - ${title}` : title;
}

// The file name (without folders) for an item.
function mcaItemFilename(item, opts) {
  if (item.kind === 'link') return { name: mcaSafeFilename(`${item.title}.html`, 'link'), needsExt: false };
  if (item.kind === 'page') return { name: mcaSafeFilename(`${item.title}.html`, 'page'), needsExt: false };

  const ext = item.ext || mcaExtOf(item.origName);
  let name;
  if (item.useTitle && item.title && !(opts.originalNames && item.origName)) {
    // Activity title, plus the real extension if the title doesn't already end with it.
    name = item.title;
    if (ext && mcaExtOf(name) !== ext) name += ext;
  } else {
    name = item.origName || item.title || 'file';
  }
  const safe = mcaSafeFilename(name, 'file');
  const needsExt = !!item.needsExt && !mcaExtOf(safe);
  // No meaningful title (e.g. a bare Google Drive link): keep the server's file name.
  return { name: safe, needsExt, serverName: needsExt && !!item.serverName };
}

// Builds download jobs for the selected items.
function mcaBuildJobs(scan, selectedItems, opts) {
  const courseFolder = mcaSafeFolder(opts.courseFolder || scan.courseName, 'Course');
  const maxNumber = Math.max(0, ...scan.sections.map(s => s.number));
  const width = Math.max(2, String(maxNumber).length);
  const used = new Map(); // lower-case path -> count
  const jobs = [];

  for (const { section, item } of selectedItems) {
    const folders = [courseFolder, mcaSectionFolder(section, opts, width)];
    for (const p of item.pre || []) folders.push(mcaSafeFolder(p, 'Subsection'));
    if (opts.labelFolders && item.group) folders.push(mcaSafeFolder(item.group, 'Group'));
    for (const p of item.inner || []) folders.push(mcaSafeFolder(p, 'Folder'));

    const { name, needsExt, serverName } = mcaItemFilename(item, opts);
    const dir = folders.join('/');
    let filename = `${dir}/${name}`;

    // Make paths unique (case-insensitive, as on Windows/macOS).
    const key = filename.toLowerCase();
    if (used.has(key)) {
      const ext = mcaExtOf(name);
      const base = ext ? name.slice(0, -ext.length) : name;
      let n = used.get(key) + 1;
      let candidate;
      do {
        candidate = `${dir}/${base} (${n})${ext}`;
        n++;
      } while (used.has(candidate.toLowerCase()));
      used.set(key, n - 1);
      used.set(candidate.toLowerCase(), 1);
      filename = candidate;
    } else {
      used.set(key, 1);
    }

    jobs.push({ kind: item.kind, url: item.url, title: item.title, html: item.html, filename, needsExt, serverName, itemId: item.id });
  }
  return jobs;
}
