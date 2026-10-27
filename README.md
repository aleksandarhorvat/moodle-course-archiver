# Moodle Course Archiver

A Chrome extension that saves everything from a Moodle course for offline study, in a tidy folder structure that mirrors the course.

## What it finds

The scanner reads the course structure and then follows every activity to the real files behind it:

| Where the material is | What gets saved |
|---|---|
| **File** resources | The actual file with its real extension (PDF, PPTX, ODP, IPYNB, ZIP, SH, MP4…), including videos embedded in a player page |
| **Folder** modules | Every file, keeping the folder's own sub-directories (e.g. `Vežbe 2/data/input.txt`) |
| **Announcements & forums** | Attachments, inline files and linked files (including lecture recordings on Google Drive) from every post in every discussion, across all pages |
| **Assignments** | Instruction files, plus your own submission and feedback files |
| **URL** modules | Downloadable targets: Google Docs/Sheets/Slides (exported as PDF/XLSX/PPTX), Google Drive files of any size (videos too), Colab notebooks (`.ipynb`), GitHub files, Dropbox, direct file links |
| **Pages & books** | The content saved as a standalone `.html` file, plus everything it links to |
| Section summaries, text labels, activity descriptions | Any files or links inside them |

### Web links that lead to material

Many professors share material through other sites. The scanner follows those links and downloads what they offer:

| Link | What you get |
|---|---|
| YouTube, Vimeo, TED, Loom, Dailymotion… videos and playlists | Real video titles, saved by a generated **yt-dlp script** (see below) |
| Google Drive folders | Every file inside, keeping sub-folders (packed into one zip, see below) |
| Google Drive files, Docs/Sheets/Slides, Colab notebooks | The file (Docs exported as PDF/XLSX/PPTX, Colab as `.ipynb`) |
| SharePoint / OneDrive for Business shared folders | Every file inside (e.g. lecture recordings), with sizes (packed into one zip) |
| Nextcloud / ownCloud shares | A shared file as is; a shared folder file by file (packed into one zip). If the folder can't be listed, the server's zip of the whole folder |
| Binder links | The course's GitHub repository as a `.zip` |
| Paper pages (arXiv, OpenReview, PMLR, ACL, publishers…) | The paper's PDF |
| Pages that are just a list of files (lecture lists, file indexes) | Their files, in a folder named after the page |
| Short links (bit.ly, tinyurl…) and tracking redirects | Followed to the real target first |

Pages with their own content stay links: books and documentation sites, blogs, video series pages with descriptions, GitHub "awesome" lists, and conference catalogs with hundreds of papers. The rule: a page counts as a file list when it has at most about 15 words of its own text per file (at least 150 words allowed) and at most 80 files. Only pages linked directly from Moodle are inspected, never pages found on those pages. Hidden and system folders (`.git`, `__pycache__`, …) inside shared folders are skipped.

#### Cloud folders become one zip

Files from a cloud folder (Drive, SharePoint, Nextcloud) are listed one by one, so you can untick what you don't need. Big recordings show their size. On **Download**, the files you picked from each cloud folder are packed into a single **`<folder name>.zip`**, saved where the folder would have been, with the folder's sub-folders inside. Nextcloud builds the zip of your selection itself and streams it straight to disk, so it costs no more time than downloading the files. For Drive and SharePoint, which have no such service, the extension builds the zip locally. It's uncompressed, so the files are byte-for-byte the originals, and it adds about 20–30 seconds per GB, plus a second copy on disk while it's being built. Zips over 3.5 GB are split into `(part 1)`, `(part 2)`, … Turn this off under **Options → Pack each cloud folder into one .zip** to get plain folders instead.

#### Online videos (yt-dlp)

Chrome extensions can't download from YouTube and similar sites, so the archiver writes **`Download videos (yt-dlp).cmd`** (Windows) or **`.sh`** (macOS/Linux) into the course folder. It holds one line per selected video, with the same folder and name the video has in the list. Run it once [yt-dlp](https://github.com/yt-dlp/yt-dlp) is installed:

```bash
winget install yt-dlp
```

Already downloaded videos are skipped when you run it again. Private or removed videos are kept as links.

Every external link is checked with the server before it's listed. If it answers with a web page (a site, a login wall, a "no access" page), it is **never** saved as a file.

### What a student needs, and what is left out

- **Kept:** lecture files, notes, exercises, datasets, homework, exam results, recordings and your own submissions.
- **Dropped automatically:**
  - Live-meeting join links (Webex, Zoom, Teams, Meet). Their *recordings* are kept.
  - Scheduling polls and forms (When2meet, Doodle, Google Forms…), help pages and social-media profiles.
  - Small decorative images pasted into posts (under 15 KB).
- **Off by default:** links to websites and YouTube videos ("Web links" chip). If you turn them on, they're saved as small `.html` files that open the page.

### Duplicate materials

Professors often post the same file several times: re-sending last year's notes, attaching a PDF to an announcement that is also in a section, or re-uploading a dataset in every exercise folder. The scanner finds these by content:

1. The same link found in several places.
2. Files with the exact same byte size, confirmed with a SHA-256 content hash. Very large files are matched by size and type instead.

Only one copy is listed and downloaded. The list shows where else it was posted. The copy that is kept is the one that fits the course structure best: a section's file activity, then a folder, a URL activity, an assignment, a page, text, and finally an announcement. Among announcements, the original post is kept, not later re-posts.

Turn on **Show duplicate copies** in the options if you want a copy in every place, for example a dataset next to each exercise notebook that uses it.

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions/` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and choose the repository folder.

## How to use

1. Open any page of a Moodle course while logged in.
2. Click the extension icon. The first time, it scans the course. You can close the popup while it runs, and the scan keeps going in the tab.
3. Use the category chips (Files, Videos & audio, Announcements, My submissions, Pages, Web links) and the per-section checkboxes to pick what you want. Each file shows its size, and the Download button shows the total.
4. Check or edit the folder name, then click **Download**.

Scan results are cached per course. Click **Rescan** after the professor posts new material.

## How files are organized

```
Downloads/
  Pattern Recognition and Machine Learning/
    00 - Општа секција/
      Announcements/
        2026-05-11 Projekat/
          project.pdf
    01 - Основно о курсу/
      Садржај предмета и начин полагања.html
      Испитна питања.pdf
      Литература/
        Bishop - Pattern Recognition And Machine Learning.pdf
    13 - Domaći zadaci 2026/
      Prvi domaći/
        hw1.pdf
        My submission/
          HM 1.zip
```

- Section folders are numbered so they sort in course order.
- Moodle 5 subsections become nested folders. Short text labels used as headings (like "Vežbe 1") become sub-folders for the activities under them.
- Files from resources are named after the activity title, with the real extension from the server. Files in folders, posts and assignments keep their original names.
- Names are made safe for Windows, macOS and Linux. If two files would get the same name, the second becomes `name (2).ext`.
- Downloading the same course again overwrites the earlier copies instead of creating duplicates.

All of this can be changed under **Options** in the popup: section numbering, label sub-folders, title vs. original file names, and showing duplicate copies.

## Using it with other Moodle sites

The extension detects Moodle automatically and works on any `https://` Moodle site. No configuration is needed. It uses Moodle's course-state service when available (Moodle 4.0+) and falls back to reading the course page, including "one section per page" layouts.

## Troubleshooting

- **Chrome asks where to save every file:** turn off *Settings → Downloads → Ask where to save each file before downloading*.
- **A download failed:** open the popup again and expand *Show failed downloads*. Google Drive files that are private to someone else can't be downloaded. If a server sends a web page instead of the file, the download is cancelled rather than saved as `.html`.
- **The video script asks for yt-dlp:** install it (`winget install yt-dlp` on Windows, `brew install yt-dlp` on macOS), then run the script again. Install ffmpeg too for the best quality. Without it, yt-dlp falls back to a lower-quality single file. On Windows the script also finds a yt-dlp that was installed after you logged in: double-clicked scripts inherit Explorer's old PATH, so the script reloads PATH from the registry and checks winget's install folder and Python's `yt_dlp` module. Videos are saved as MP4, up to 1080p.
- **SharePoint files fail:** open the shared link once in Chrome (it sets a guest cookie), then download again.
- **Chrome holds a file with "Keep / Discard":** some file types (scripts, executables) need your confirmation in Chrome's downloads page (Ctrl+J). The popup shows how many are waiting.
- **Something is missing:** click **Rescan**. If a file still doesn't appear, open an issue and describe how the professor posted it.

## Privacy

Course pages are read in your logged-in tab. Results are stored only in Chrome's local extension storage. Files go straight from Moodle (or the linked site) to your Downloads folder. To tell downloadable files apart from web pages and to show sizes, the extension asks external links in the course for their first byte (headers only). To detect duplicates, it reads small Moodle files that have the same size and compares their hashes locally. To resolve web links, it reads the linked page, the Drive/SharePoint/Nextcloud folder listing, or YouTube's/Vimeo's public oEmbed info (video title). No course content is sent anywhere else.

## Change log

- **v0.5:**
  - Cloud folders (Drive, SharePoint, Nextcloud) are listed file by file, and the files you pick are packed into one zip per folder.
  - Nextcloud folders are listed instead of downloaded blindly as one big zip.

- **v0.4:**
  - Web links are turned into downloads where possible: YouTube/Vimeo videos (via a generated yt-dlp script), Google Drive folders, SharePoint/OneDrive folders, Nextcloud shares, Binder repositories, paper PDFs, and pages that are just file lists.
  - Content pages stay links.
  - Short links and tracking redirects are followed.
  - Drive files are checked through their view page, because Google rejects extension requests to its download endpoints.

- **v0.3:**
  - Google Drive files of any size download as the real file (lecture recordings used to come back as Google's "virus scan" HTML page).
  - A new Videos & audio category, and file sizes with a download total.
  - Duplicate materials are detected by content and listed once, keeping the copy that fits the course structure.
  - Meeting/join links, polls, forms, help pages and decorative images are dropped. Web links are off by default.
  - External links are verified before download, so login or error pages are never saved as files.

- **v0.2:**
  - Rewritten scanner.
  - Announcements/forums, assignments, pages, books, labels and section summaries are now scanned.
  - Folder sub-directories are kept.
  - Real file extensions come from the server.
  - Smart handling of Google Docs/Drive/Colab/GitHub/Dropbox links, with `.html` link files for web pages.
  - Numbered section folders, configurable naming, and duplicate-safe file names.
  - Downloads are paced, with a progress and failure report.
  - Works on any Moodle site without editing the manifest.
  - Fixed: Refresh crashed on the second run, downloads went through the service worker without the login session, and all courses shared one cache entry.
- **v0.1:** Initial implementation.
