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

// Helper to clean display text by removing common type labels (accesshide content)
function cleanDisplayText(raw) {
  if (!raw) return raw;
  // Remove common suffixes that Moodle adds for accessibility like "URL adresa", "Stranica", "Datoteka"
  let s = raw.replace(/\b(URL adresa|Stranica|Datoteka|URL)\b/gi, '');
  // Collapse whitespace and trim
  s = s.replace(/\s+/g, ' ').trim();
  return s;
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
    
    // We'll iterate the activity items in DOM order and track subsection labels (e.g. "Vežbe 1").
    // Labels in the page are represented as activities with modtype_label and their title
    // appears in .activity-altcontent (often <strong>Vežbe 1</strong> inside).
    const activityItems = Array.from(section.querySelectorAll('li.activity'));
    const sectionFiles = [];
    let currentSubsection = null;

    for (const item of activityItems) {
      // If this is a label acting as a subsection header, extract its text and set currentSubsection
      if (item.classList.contains('modtype_label')) {
        // Try several fallbacks to find the visible label text
        let labelText = null;
        const altContent = item.querySelector('.activity-altcontent');
        if (altContent) {
          const strong = altContent.querySelector('strong');
          if (strong && strong.textContent?.trim()) {
            labelText = strong.textContent.trim();
          } else if (altContent.textContent?.trim()) {
            labelText = altContent.textContent.trim();
          }
        }
        // Fallback to data-activityname or activityname text
        if (!labelText) {
          labelText = item.getAttribute('data-activityname') || item.querySelector('.activityname')?.textContent?.trim();
        }

        if (labelText) {
          // Clean common words and sanitize
          const cleaned = labelText
            .replace(/\bDirektorijum\b/gi, '')
            .replace(/\bFolder\b/gi, '')
            .replace(/[\/\\?%*:|"<>]/g, '_')
            .trim()
            .replace(/^[-_\s]+|[-_\s]+$/g, '')
            .slice(0, 100);
          currentSubsection = cleaned || null;
        } else {
          currentSubsection = null;
        }
        // Move on — labels don't contain downloadable anchors themselves (usually)
        continue;
      }

      // For non-label activities, find links inside this activity and treat them as belonging to currentSubsection
      const anchors = Array.from(item.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.href;
        const rawText = a.textContent?.trim() || a.getAttribute('title') || href;
        const text = cleanDisplayText(rawText);
        if (!href) continue;

        // Direct file links and module pages - add immediately
        if (href.includes('/pluginfile.php') ||
            href.includes('/mod/resource/') ||
            href.includes('/mod/book/') ||
            href.includes('/mod/page/')) {
          sectionFiles.push({ href, text, subSectionName: currentSubsection });
          continue;
        }

        // Handle folder modules (Direktorijum) - fetch page in page context and extract files
        if (href.includes('/mod/folder/')) {
          try {
            const folderResp = await fetch(href);
            const folderHtml = await folderResp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(folderHtml, 'text/html');

            const links = Array.from(doc.querySelectorAll('a[href*="/pluginfile.php"]'));

            const folderCleanName = (text || href)
              .replace(/\bDirektorijum\b/gi, '')
              .replace(/\bDirektorijujm\b/gi, '')
              .replace(/\bFolder\b/gi, '')
              .replace(/[\/\\?%*:|"<>]/g, '_')
              .trim()
              .replace(/^[-_\s]+|[-_\s]+$/g, '')
              .slice(0, 100);

            if (links.length > 0) {
              links.forEach(link => {
                const fileHref = link.href;
                const rawFileText = link.textContent?.trim() || link.getAttribute('title') || fileHref;
                const fileText = cleanDisplayText(rawFileText);
                const cleanFileText = fileText
                  .replace(/[\/\\?%*:|"<>]/g, '_')
                  .trim()
                  .slice(0, 200);

                sectionFiles.push({ href: fileHref, text: cleanFileText, folderName: folderCleanName, subSectionName: currentSubsection });
              });
            } else {
              sectionFiles.push({ href, text, isFolder: true, subSectionName: currentSubsection });
            }
          } catch (e) {
            console.warn('Error fetching folder page in content script:', href, e);
            sectionFiles.push({ href, text, isFolder: true, subSectionName: currentSubsection });
          }
          continue;
        }

        // Handle mod/url links - check if they point to files
        if (href.includes('/mod/url/')) {
          const urlCheck = await checkUrlForFile(href);
          if (urlCheck.isFile) {
            sectionFiles.push({ 
              href: urlCheck.actualUrl || href, 
              text: cleanDisplayText(text),
              needsUrlExtraction: !urlCheck.actualUrl,
              subSectionName: currentSubsection
            });
          }
          continue;
        }
      }
    }
    
    // Also include anchors that appear in the section summary (intro text) which are not activity items
    try {
      const summaryAnchors = Array.from(section.querySelectorAll('.summarytext a, .summary a, .no-overflow a'));
      summaryAnchors.forEach(a => {
        const href = a.href;
        const rawText = a.textContent?.trim() || a.getAttribute('title') || href;
        const text = cleanDisplayText(rawText);
        if (!href) return;

        if (href.includes('/pluginfile.php') ||
            href.includes('/mod/resource/') ||
            href.includes('/mod/book/') ||
            href.includes('/mod/page/')) {
          // summary anchors don't belong to a subsection label, attach null
          sectionFiles.push({ href, text, subSectionName: null });
        }
        // We intentionally don't try to expand folders or mod/url in summary text here to keep it simple
      });
    } catch (e) {
      // ignore summary parsing errors
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
