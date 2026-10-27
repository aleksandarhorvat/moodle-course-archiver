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
    .replace(/[<>:"/\\|?*]/g, '_')
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
  if (item.kind === 'stream') {
    // Saved by yt-dlp, which picks the real extension; ".mp4" is what the list shows.
    const label = item.title || `${item.provider || 'Online'} ${item.playlist ? 'playlist' : 'video'}`;
    return { name: mcaSafeFilename(`${label}.mp4`, 'video'), needsExt: false };
  }

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
  const zips = new Map(); // cloud folder key -> zip job
  const jobs = [];

  for (const { section, item } of selectedItems) {
    const folders = [courseFolder, mcaSectionFolder(section, opts, width)];
    for (const p of item.pre || []) folders.push(mcaSafeFolder(p, 'Subsection'));
    if (opts.labelFolders && item.group) folders.push(mcaSafeFolder(item.group, 'Group'));
    for (const p of item.inner || []) folders.push(mcaSafeFolder(p, 'Folder'));

    const { name, needsExt, serverName } = mcaItemFilename(item, opts);

    // Files picked from one cloud folder go into a single <folder>.zip placed
    // where the folder would have been; inside it they keep their sub-folders.
    if (opts.zipClouds && item.bundle && item.kind === 'file') {
      const split = folders.length - (item.inner || []).length + item.bundle.at;
      let zip = zips.get(item.bundle.key);
      if (!zip) {
        const zipDir = folders.slice(0, split).join('/');
        let zipName = `${zipDir}/${mcaSafeFilename(`${item.bundle.name}.zip`, 'Cloud folder.zip')}`;
        for (let n = 2; used.has(zipName.toLowerCase()); n++) {
          zipName = `${zipDir}/${mcaSafeFilename(`${item.bundle.name} (${n}).zip`, 'Cloud folder.zip')}`;
        }
        used.set(zipName.toLowerCase(), 1);
        zip = { kind: 'zip', filename: zipName, entries: [], items: [], serverZip: item.bundle.serverZip || null };
        zips.set(item.bundle.key, zip);
        jobs.push(zip);
      }
      const entryPath = [...folders.slice(split + 1), name].join('/');
      zip.entries.push({ url: item.url, path: entryPath, size: item.size ?? null, prime: item.prime, sharePath: item.sharePath });
      zip.items.push({ itemId: item.id, filename: `${zip.filename}/${entryPath}` });
      continue;
    }

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

    jobs.push({
      kind: item.kind, url: item.url, title: item.title, html: item.html, filename, needsExt, serverName,
      prime: item.prime, playlist: !!item.playlist, hasTitle: !!item.title, itemId: item.id
    });
  }

  // Servers that can zip a selection themselves (Nextcloud) stream it straight
  // to disk, which beats building the zip locally. Very long selections would
  // overflow the URL, so those are still packed by the extension.
  for (const zip of zips.values()) {
    if (!zip.serverZip || zip.entries.some(e => !e.sharePath)) continue;
    const url = `${zip.serverZip}?accept=zip&files=${encodeURIComponent(JSON.stringify(zip.entries.map(e => e.sharePath)))}`;
    if (url.length <= 6000) zip.directUrl = url;
  }
  return jobs;
}

// A script that downloads the selected online videos with yt-dlp
// (https://github.com/yt-dlp/yt-dlp) into the same folders as everything else.
// It sits in the course folder and works with paths relative to it.
function mcaBuildVideoScript(streamJobs, courseFolder, platform) {
  const windows = platform === 'windows';
  const prefix = `${mcaSafeFolder(courseFolder, 'Course')}/`;
  // "%" starts a yt-dlp template field (and a variable in cmd), so keep it out of names.
  const clean = s => s.replace(/%/g, '_');
  const tpl = s => (windows ? s.replace(/%/g, '%%') : s);
  const quote = s => (windows ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

  const lines = [];
  for (const job of streamJobs) {
    const rel = job.filename.startsWith(prefix) ? job.filename.slice(prefix.length) : job.filename;
    const dir = clean(rel.split('/').slice(0, -1).join('/')) || '.';
    const base = clean(rel.split('/').pop().replace(/\.mp4$/i, ''));
    const output = job.playlist
      ? `${job.hasTitle ? base : '%(playlist_title)s'}/%(playlist_index)03d - %(title)s.%(ext)s`
      : `${job.hasTitle ? base : '%(title)s'}.%(ext)s`;
    lines.push(`${windows ? '%YTDLP%' : '$YTDLP'} ${job.playlist ? '--yes-playlist' : '--no-playlist'} -S res:1080,ext:mp4:m4a --download-archive .yt-dlp-archive.txt ` +
      `-P ${quote(dir)} -o ${quote(tpl(output))} ${quote(job.url)}`);
  }

  if (windows) {
    const text = [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      'set "YTDLP=yt-dlp"',
      'where yt-dlp >nul 2>nul && goto :run',
      'rem Programs installed after Windows Explorer started are missing from the PATH',
      'rem that double-clicked scripts inherit, so reload PATH from the registry.',
      'for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"`) do set "PATH=%%P;%PATH%"',
      'where yt-dlp >nul 2>nul && goto :run',
      'for /d %%D in ("%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_*") do if exist "%%D\\yt-dlp.exe" set "PATH=%%D;%PATH%"',
      'where yt-dlp >nul 2>nul && goto :run',
      'set "YTDLP=py -m yt_dlp"',
      'py -m yt_dlp --version >nul 2>nul && goto :run',
      'set "YTDLP=python -m yt_dlp"',
      'python -m yt_dlp --version >nul 2>nul && goto :run',
      'echo This script needs yt-dlp. Install it with:  winget install yt-dlp',
      'echo or download it from https://github.com/yt-dlp/yt-dlp/releases',
      'pause',
      'exit /b 1',
      ':run',
      `echo Downloading ${streamJobs.length} video(s). Already downloaded videos are skipped.`,
      ...lines,
      'echo Done.',
      'pause',
      ''
    ].join('\r\n');
    return { filename: `${prefix}Download videos (yt-dlp).cmd`, text };
  }
  const text = [
    '#!/bin/sh',
    '# Run with:  sh "Download videos (yt-dlp).sh"',
    'cd "$(dirname "$0")" || exit 1',
    'YTDLP=yt-dlp',
    'if ! command -v yt-dlp >/dev/null 2>&1; then',
    '  if python3 -m yt_dlp --version >/dev/null 2>&1; then YTDLP="python3 -m yt_dlp"',
    '  else echo "This script needs yt-dlp: https://github.com/yt-dlp/yt-dlp#installation"; exit 1; fi',
    'fi',
    `echo "Downloading ${streamJobs.length} video(s). Already downloaded videos are skipped."`,
    ...lines,
    'echo Done.',
    ''
  ].join('\n');
  return { filename: `${prefix}Download videos (yt-dlp).sh`, text };
}
