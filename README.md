# Moodle Course Archiver

A small Chrome extension that helps you collect files from a Moodle course so you can study offline.

This extension scans a course page, lists downloadable files by section, and lets you save chosen files into a folder structure on your machine.

## What it does

- Scans course sections for direct file links and common Moodle modules.
- Extracts files inside "folder" modules and lists them individually so you can pick which ones to download.
- Converts some Google Docs links into export URLs when possible.
- Downloads files into a folder structure organized by course and section.

## Install (developer mode)

1. Clone or download this repository and extract it to a local folder.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable "Developer mode" (toggle in the top-right).
4. Click "Load unpacked" and choose the folder with the extension files.

The extension should appear in the list. You can pin it to the toolbar if you use it often.

## How to use

1. Open a Moodle course page in your browser.
2. Click the extension icon. The popup will show files found on the page, grouped by section.
3. Select the files you want and click "Download selected". You will be asked for a folder name for the course.

Notes:
- If a folder module contains files, the extension will attempt to extract those files and present them as individual items. If extraction fails, the folder may appear as a single entry and the extension will try to fall back to a background fetch.
- For pages that require login, the extension extracts folder contents from the page context so it will work with authenticated courses.

## Supported file types

Common formats are supported, including PDF, Word, PowerPoint, Excel, text and archives. Google Docs/Sheets/Slides links are converted to downloadable export URLs when possible.

## Using this with a different Moodle site

If you want the extension to run on a different Moodle instance, open `manifest.json` and update the `host_permissions` and `content_scripts.matches` entries to include your site URL (for example `https://your-moodle-site.example/*` and `https://your-moodle-site.example/course/view.php*`). Then reload the extension.

## Troubleshooting

- If the extension shows "No files found", make sure the course page has finished loading and then click "Refresh list" in the popup.
- If a file doesn't download, check Chrome's downloads page and any browser security prompts.
- If a folder's contents aren't listed, the folder page might render dynamically; in that case the extension may need a small fallback to run extraction after rendering. Tell me if you see that and I can add it.

## How downloads are organized on disk

Files are saved under the course folder you provide, then grouped by section and (when applicable) by the folder module name. For example:

```
CourseName/
   Section Name/
      file1.pdf
      file2.docx
   Another Section/
      Folder Module Name/
         inside-file.pdf
```

## Privacy

The extension only accesses Moodle pages you open in your browser and stores course file lists locally in Chrome's storage. Files are downloaded directly to your computer; the extension does not send course content to any external servers.

## Contributing

If you find bugs or have ideas for improvements, open an issue or submit a pull request.

## License

This project is open source; see the repository license for details.

## Change log

- v0.1 — Initial implementation: scans course pages, lists files, and downloads selected items.
