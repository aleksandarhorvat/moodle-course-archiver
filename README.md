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
- **Chrome holds a file with "Keep / Discard":** some file types (scripts, executables) need your confirmation in Chrome's downloads page (Ctrl+J). The popup shows how many are waiting.
- **Something is missing:** click **Rescan**. If a file still doesn't appear, open an issue and describe how the professor posted it.

## Privacy

Course pages are read in your logged-in tab. Results are stored only in Chrome's local extension storage. Files go straight from Moodle (or the linked site) to your Downloads folder. To tell downloadable files apart from web pages and to show sizes, the extension asks external links in the course for their first byte (headers only). To detect duplicates, it reads small Moodle files that have the same size and compares their hashes locally. No course content is sent anywhere else.

## Change log

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
