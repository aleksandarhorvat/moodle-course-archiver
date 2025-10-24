document.addEventListener('DOMContentLoaded', async () => {
  const filesDiv = document.getElementById('files');
  const downloadBtn = document.getElementById('download');
  const refreshBtn = document.getElementById('refresh');
  const selectAllBtn = document.getElementById('select-all');
  const selectNoneBtn = document.getElementById('select-none');
  const themeToggle = document.getElementById('theme-toggle');

  // Apply stored theme preference (default: light)
  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }

  try {
    const stored = await chrome.storage.local.get('popupTheme');
    const pref = stored.popupTheme || 'light';
    applyTheme(pref);
    if (themeToggle) themeToggle.checked = (pref === 'dark');
  } catch (e) {
    // ignore
  }

  if (themeToggle) {
    themeToggle.addEventListener('change', async () => {
      const theme = themeToggle.checked ? 'dark' : 'light';
      applyTheme(theme);
      try { await chrome.storage.local.set({ popupTheme: theme }); } catch (e) {}
    });
  }

  async function getCurrentCourseKey() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    try { return `course_${new URL(tab.url).pathname}`; } 
    catch { return null; }
  }

  // Select/deselect all functionality
  selectAllBtn.onclick = () => {
    const checkboxes = Array.from(filesDiv.querySelectorAll('input[type=checkbox]'));
    checkboxes.forEach(cb => cb.checked = true);
  };

  selectNoneBtn.onclick = () => {
    const checkboxes = Array.from(filesDiv.querySelectorAll('input[type=checkbox]'));
    checkboxes.forEach(cb => cb.checked = false);
  };

  async function loadFiles() {
    filesDiv.innerHTML = 'Loading...';
    const courseKey = await getCurrentCourseKey();
    if (!courseKey) {
      filesDiv.innerHTML = '<em>Not a course page.</em>';
      downloadBtn.disabled = true;
      return;
    }

    // Clear previous list
    filesDiv.innerHTML = '';

    const data = await chrome.storage.local.get(courseKey);
    const sections = data[courseKey] || [];

    if (sections.length === 0) {
      filesDiv.innerHTML = '<em>No sections found on this page. Click Refresh.</em>';
      downloadBtn.disabled = true;
      return;
    }

    let hasFiles = false;

    sections.forEach((section, sectionIndex) => {
      if (section.files.length === 0) return;
      
      hasFiles = true;

      // Create section header
      const sectionDiv = document.createElement('div');
      sectionDiv.className = 'section';
      sectionDiv.innerHTML = `<strong>${section.title}</strong>`;
      filesDiv.appendChild(sectionDiv);

      // Create files in this section
      section.files.forEach((file, fileIndex) => {
        const div = document.createElement('div');
        div.className = 'file';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        cb.dataset.sectionIndex = sectionIndex;
        cb.dataset.fileIndex = fileIndex;

        const label = document.createElement('label');
        const displayText = (file.text || file.href).slice(0, 80);
        label.textContent = file.isFolder ? `📁 ${displayText}` : displayText;
        label.onclick = () => cb.checked = !cb.checked; // Allow clicking label to toggle

        div.appendChild(cb);
        div.appendChild(label);
        filesDiv.appendChild(div);
      });
    });

    if (!hasFiles) {
      filesDiv.innerHTML = '<em>No files found in any section. Click Refresh.</em>';
      downloadBtn.disabled = true;
      return;
    }

    downloadBtn.disabled = false;
  }

  refreshBtn.onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_script.js']
    });
    setTimeout(loadFiles, 400); // small delay to let content_script finish
  };

  downloadBtn.onclick = async () => {
    const courseKey = await getCurrentCourseKey();
    if (!courseKey) return;

    const data = await chrome.storage.local.get(courseKey);
    const sections = data[courseKey] || [];

    const checkboxes = Array.from(filesDiv.querySelectorAll('input[type=checkbox]'));
    const selected = [];

    checkboxes.forEach(cb => {
      if (cb.checked) {
        const sectionIndex = parseInt(cb.dataset.sectionIndex);
        const fileIndex = parseInt(cb.dataset.fileIndex);
        const section = sections[sectionIndex];
        const file = section.files[fileIndex];
        
        selected.push({
          ...file,
          sectionTitle: section.cleanTitle,
          sectionNumber: section.number,
          sectionName: section.cleanTitle
        });
      }
    });

    if (selected.length === 0) {
      alert('Select at least one file.');
      return;
    }

    const courseName = prompt('Enter folder name for this course:', 'MyCourse');
    if (!courseName) return;

    chrome.runtime.sendMessage({
      type: 'download-files',
      files: selected,
      courseName
    });

    window.close();
  };

  // Load fresh files when popup opens
  loadFiles();
});