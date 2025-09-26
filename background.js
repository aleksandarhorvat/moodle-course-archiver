chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'download-files') {
    const files = msg.files || [];
    const courseName = msg.courseName || 'MyCourse';

    files.forEach(async f => {
      // Handle folder modules (Direktorijum) differently
      if (f.isFolder) {
        try {
          // Fetch the folder page to get all files within it
          const response = await fetch(f.href);
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          
          // Find all file links in the folder
          const fileLinks = Array.from(doc.querySelectorAll('a[href*="/pluginfile.php"]'));
          
          fileLinks.forEach(link => {
            const fileUrl = link.href;
            const fileName = link.textContent?.trim() || link.getAttribute('title') || 'file';
            
            // Clean up filename
            const cleanFileName = fileName
              .replace(/[\/\\?%*:|"<>]/g, '_')
              .trim()
              .slice(0, 100);
            
            // Download each file in the folder
            chrome.downloads.download({
              url: fileUrl,
              filename: `${courseName}/${f.sectionName || 'Unknown'}/${f.text.replace(/[\/\\?%*:|"<>]/g, '_')}/${cleanFileName}`,
              saveAs: false
            });
          });
          
        } catch (error) {
          console.error('Error processing folder:', f.href, error);
        }
        return; // Don't process as regular file
      }

      let url = f.href;
      let name = (f.text || f.href)
        .replace(/\bDatoteka\b/gi, '')  // remove word
        .replace(/[\/\\?%*:|"<>]/g, '_')
        .trim()
        .slice(0, 100);

      // Handle Moodle URL modules that need URL extraction
      if (f.needsUrlExtraction && url.includes('/mod/url/')) {
        try {
          // Fetch the Moodle URL page to extract the actual URL
          const response = await fetch(url);
          const html = await response.text();
          
          // Look for the actual URL in the page content - prioritize .urlworkaround pattern
          const urlworkaroundMatch = html.match(/<div class="urlworkaround">.*?<a href="([^"]+)">/i);
          
          let urlMatch = null;
          if (urlworkaroundMatch && urlworkaroundMatch[1]) {
            urlMatch = [null, urlworkaroundMatch[1]];
          } else {
            // Fallback patterns if urlworkaround is not found
            urlMatch = html.match(/window\.open\('([^']+)'/i) ||
                      html.match(/<a[^>]+href="([^"]+)"[^>]*>.*?click here to open resource/i) ||
                      html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
                      html.match(/<iframe[^>]+src="([^"]+)"/i);
          }
          
          if (urlMatch && urlMatch[1]) {
            const actualUrl = urlMatch[1];
            // Check if this looks like a document
            if (actualUrl.match(/\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|rtf|zip|rar)$/i) ||
                actualUrl.includes('docs.google.com') ||
                actualUrl.includes('drive.google.com') ||
                actualUrl.includes('dropbox.com') ||
                actualUrl.includes('onedrive.com')) {
              url = actualUrl;
              console.log('Extracted URL from Moodle page:', actualUrl);
            } else {
              console.log('Skipping non-document URL:', actualUrl);
              return; // Skip this file
            }
          } else {
            console.log('Could not extract URL from Moodle page:', url);
            return; // Skip this file
          }
        } catch (e) {
          console.warn('Error extracting URL from Moodle page:', e);
          return; // Skip this file
        }
      }

      // Convert Google Docs/Sheets/Slides links to export links
      try {
        const gdocMatch = url.match(/https:\/\/docs\.google\.com\/document\/d\/([^\/]+)/);
        const gsheetMatch = url.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([^\/]+)/);
        const gslideMatch = url.match(/https:\/\/docs\.google\.com\/presentation\/d\/([^\/]+)/);

        if (gdocMatch) {
          url = `https://docs.google.com/document/d/${gdocMatch[1]}/export?format=pdf`;
          name += '.pdf';
        } else if (gsheetMatch) {
          url = `https://docs.google.com/spreadsheets/d/${gsheetMatch[1]}/export?format=xlsx`;
          name += '.xlsx';
        } else if (gslideMatch) {
          url = `https://docs.google.com/presentation/d/${gslideMatch[1]}/export/pptx`;
          name += '.pptx';
        }
      } catch (e) {
        console.warn('Error converting Google Doc link', url);
      }

      // Handle Moodle module pages - these are links to pages that might contain documents
      // We'll save them as .html files so users can browse them
      let isMoodlePage = false;
      if (url.includes('/mod/page/view.php') || 
          url.includes('/mod/book/view.php') || 
          url.includes('/mod/folder/view.php')) {
        isMoodlePage = true;
        if (!name.endsWith('.html')) {
          name += '.html';
        }
      }

      // Extract file extension from other URLs (only for direct files, not Moodle pages)
      if (!isMoodlePage) {
        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname;
          const extMatch = path.match(/\.([a-z0-9]+)$/i);
          if (extMatch && !name.endsWith(extMatch[0])) {
            name += extMatch[0];
          }
        } catch(e) {
          console.warn('Invalid URL', url);
        }
      }

      // Create the folder path: CourseName/SectionName/filename
      let folderPath = courseName;
      if (f.sectionTitle && f.sectionTitle.trim()) {
        folderPath += `/${f.sectionTitle}`;
      }
      
      const filename = `${folderPath}/${name}`;

      chrome.downloads.download({
        url,
        filename: filename
      }, id => {
        if (chrome.runtime.lastError) console.error('Download error', chrome.runtime.lastError);
        else console.log('Started download', id, 'to', filename);
      });
    });
  }
});
