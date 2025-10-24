// Find all sections on the page
const sections = Array.from(document.querySelectorAll('li[id^="section-"]'));
let sectionsData = [];

// Helper function to check if URL points to a downloadable file
async function checkUrlForFile(url) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    
    // Look for the actual URL in the page content - prioritize .urlworkaround pattern
    const urlworkaroundMatch = html.match(/<div class="urlworkaround">.*?<a href="([^"]+)">/i);
    
    let actualUrl = null;
    if (urlworkaroundMatch && urlworkaroundMatch[1]) {
      actualUrl = urlworkaroundMatch[1];
    } else {
      // Fallback patterns if urlworkaround is not found
      const urlMatch = html.match(/window\.open\('([^']+)'/i) ||
                      html.match(/<a[^>]+href="([^"]+)"[^>]*>.*?click here to open resource/i) ||
                      html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
                      html.match(/<iframe[^>]+src="([^"]+)"/i);
      if (urlMatch && urlMatch[1]) {
        actualUrl = urlMatch[1];
      }
    }
    
    if (actualUrl) {
      // First check if it's a video platform - exclude these
      if (actualUrl.includes('youtube.com') ||
          actualUrl.includes('youtu.be') ||
          actualUrl.includes('vimeo.com') ||
          actualUrl.includes('twitch.tv') ||
          actualUrl.includes('dailymotion.com')) {
        return { isFile: false, actualUrl: null };
      }
      
      // Check if this looks like a downloadable file
      if (actualUrl.match(/\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|rtf|zip|rar)$/i) ||
          actualUrl.includes('docs.google.com') ||
          actualUrl.includes('drive.google.com') ||
          actualUrl.includes('dropbox.com') ||
          actualUrl.includes('onedrive.com')) {
        return { isFile: true, actualUrl: actualUrl };
      }
    }
    
    return { isFile: false, actualUrl: null };
  } catch (e) {
    console.warn('Error checking URL:', url, e);
    return { isFile: false, actualUrl: null };
  }
}

// Process sections with async URL checking
async function processSections() {
  for (const section of sections) {
    const sectionId = section.id;
    const sectionNumber = sectionId.replace('section-', '');
    
    // Get section title
    const titleElement = section.querySelector('.sectionname a, .sectionname');
    let sectionTitle = 'Section ' + sectionNumber;
    
    if (titleElement) {
      sectionTitle = titleElement.textContent?.trim() || sectionTitle;
    }
    
    // Clean up section title for folder naming
    const cleanTitle = sectionTitle
      .replace(/[\/\\?%*:|"<>]/g, '_')
      .trim()
      .slice(0, 50); // Limit length
    
    // Find all links within this section
    const sectionAnchors = Array.from(section.querySelectorAll('a'));
    const sectionFiles = [];
    
    for (const a of sectionAnchors) {
      const href = a.href;
      const text = a.textContent?.trim() || a.getAttribute('title') || href;
      
      if (!href) continue;
      
      // Direct file links and module pages - add immediately
      if (href.includes('/pluginfile.php') ||
          href.includes('/mod/resource/') ||
          href.includes('/mod/book/') ||
          href.includes('/mod/page/')) {
        sectionFiles.push({ href, text });
      }
      
      // Handle folder modules (Direktorijum) - fetch page in page context and extract files
      else if (href.includes('/mod/folder/')) {
        // Attempt to fetch the folder page from the page (has cookies) and extract pluginfile links
        try {
          const folderResp = await fetch(href);
          const folderHtml = await folderResp.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(folderHtml, 'text/html');

          // Folder module usually lists files with links to pluginfile.php
          const links = Array.from(doc.querySelectorAll('a[href*="/pluginfile.php"]'));

          // Clean folder/module name to use as subfolder name
          // Remove common labels like "Direktorijum" (and common misspellings), then sanitize
          const folderCleanName = (text || href)
            .replace(/\bDirektorijum\b/gi, '')
            .replace(/\bDirektorijujm\b/gi, '')
            .replace(/\bFolder\b/gi, '')
            .replace(/[\/\\?%*:|"<>]/g, '_')
            .trim()
            .replace(/^[-_\s]+|[-_\s]+$/g, '') // trim leading/trailing separators
            .slice(0, 100);

          if (links.length > 0) {
            links.forEach(link => {
              const fileHref = link.href;
              const fileText = link.textContent?.trim() || link.getAttribute('title') || fileHref;
              const cleanFileText = fileText
                .replace(/[\/\\?%*:|"<>]/g, '_')
                .trim()
                .slice(0, 200);

              // Push each file found inside the folder as an individual entry and attach folderName
              sectionFiles.push({ href: fileHref, text: cleanFileText, folderName: folderCleanName });
            });
          } else {
            // If we couldn't find pluginfile links, keep the folder link as a fallback so background can try
            sectionFiles.push({ href, text, isFolder: true });
          }
        } catch (e) {
          console.warn('Error fetching folder page in content script:', href, e);
          // Fallback to adding the folder link so background will attempt to process it
          sectionFiles.push({ href, text, isFolder: true });
        }
      }
      
      // Handle mod/url links - check if they point to files
      else if (href.includes('/mod/url/')) {
        const urlCheck = await checkUrlForFile(href);
        if (urlCheck.isFile) {
          // Use the actual URL if we found one, otherwise use the Moodle wrapper
          sectionFiles.push({ 
            href: urlCheck.actualUrl || href, 
            text,
            needsUrlExtraction: !urlCheck.actualUrl
          });
        }
        // If not a file, we simply don't add it to the list
      }
    }
    
    // Remove duplicates within section
    const uniqueSectionFiles = sectionFiles.filter((f, i, arr) => 
      arr.findIndex(x => x.href === f.href) === i
    );
    
    if (uniqueSectionFiles.length > 0 || sectionNumber === '0') {
      sectionsData.push({
        id: sectionId,
        number: sectionNumber,
        title: sectionTitle,
        cleanTitle: cleanTitle,
        files: uniqueSectionFiles
      });
    }
  }

  const courseKey = `course_${window.location.pathname}`;
  chrome.storage.local.set({ [courseKey]: sectionsData });
  chrome.runtime.sendMessage({ type: 'course-sections-found', sections: sectionsData, courseKey });
}

// Start processing
processSections();
