# Moodle Course Archiver

A Chrome extension that helps you download and archive files from Moodle courses for offline study.

## Features

- 🔍 Automatically scans Moodle course pages for downloadable files
- 📁 Organizes downloads by course sections
- 📄 Supports various file types (PDF, DOC, PPT, XLS, etc.)
- 🔗 Handles Google Docs/Sheets/Slides links by converting them to downloadable formats
- 📂 Extracts files from Moodle folder modules
- 🎯 Selective downloading - choose which files to download

## Installation

1. **Download the Extension Files**
   - Clone this repository or download it as a ZIP file
   - Extract the files to a folder on your computer

2. **Enable Developer Mode in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Toggle the "Developer mode" switch in the top-right corner

3. **Load the Extension**
   - Click "Load unpacked" button
   - Select the folder containing the extension files
   - The extension should now appear in your extensions list

4. **Pin the Extension (Optional)**
   - Click the puzzle piece icon (🧩) in Chrome's toolbar
   - Find "Moodle Course Archiver" and click the pin icon to keep it visible

## How to Use

1. **Navigate to a Moodle Course**
   - Go to your Moodle site and open any course page
   - The extension currently supports `moodle.pmf.uns.ac.rs` but can be modified for other Moodle instances

2. **Open the Extension**
   - Click the Moodle Course Archiver icon in your browser toolbar
   - The extension will automatically scan the page for downloadable files

3. **Select Files to Download**
   - Review the list of files organized by course sections
   - Check the boxes next to files you want to download
   - Use "Select all" or "Select none" buttons for quick selection

4. **Download Files**
   - Click "Download selected" button
   - Enter a folder name for organizing your downloads
   - Files will be automatically downloaded and organized in folders by section

## Supported File Types

- **Direct Files**: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT, RTF, ZIP, RAR
- **Google Services**: Google Docs, Sheets, and Presentations (automatically converted to downloadable formats)
- **Moodle Modules**: 
  - Resource files
  - Folder contents
  - Book modules (saved as HTML)
  - Page modules (saved as HTML)

## Configuration for Other Moodle Sites

To use this extension with a different Moodle installation:

1. Open `manifest.json`
2. Update the `host_permissions` and `content_scripts.matches` arrays with your Moodle site URL:

```json
{
  "host_permissions": [
    "https://your-moodle-site.com/*",
    "https://*/*"
  ],
  "content_scripts": [
    {
      "matches": ["https://your-moodle-site.com/course/view.php*"],
      "js": ["content_script.js"],
      "run_at": "document_idle"
    }
  ]
}
```

3. Reload the extension in Chrome

## Troubleshooting

### Extension Not Working
- Make sure you're on a Moodle course page (not the dashboard or other pages)
- Try clicking "Refresh list" in the extension popup
- Check if the Moodle site URL matches the configuration in `manifest.json`

### No Files Found
- Ensure the course page has loaded completely
- Some files might be restricted or require special permissions
- Try refreshing the page and reopening the extension

### Download Issues
- Check Chrome's download settings and permissions
- Some files might be blocked by your browser's security settings
- Large files might take time to process

### Permission Errors
- The extension needs permission to access your Moodle site
- Make sure you've granted the necessary permissions when installing

## File Organization

Downloaded files are organized as follows:
```
CourseName/
├── Section 1 Name/
│   ├── file1.pdf
│   └── file2.docx
├── Section 2 Name/
│   ├── presentation.pptx
│   └── FolderName/
│       ├── subfolder_file1.pdf
│       └── subfolder_file2.txt
└── ...
```

## Privacy and Security

- The extension only accesses Moodle pages you visit
- No data is sent to external servers
- Files are downloaded directly to your computer
- Course data is stored locally in Chrome's storage

## Contributing

Feel free to submit issues, feature requests, or pull requests to improve this extension.

## License

This project is open source. Please check the license file for details.

## Version History

- **v0.1** - Initial release
  - Basic file detection and downloading
  - Support for common file types
  - Section-based organization
  - Google Docs integration