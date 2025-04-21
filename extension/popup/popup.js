// extension/popup/popup.js

// Track if we've already updated the UI
let hasUpdated = false;

// Render list & wire buttons
function render(items) {
  const root = document.getElementById('videos');
  root.innerHTML = '';
  
  if (!items || items.length === 0) {
    root.textContent = 'No videos found on this page.';
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'video-item';

    // Create thumbnail container
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'thumb-container';
    
    if (item.poster) {
      const img = document.createElement('img');
      img.src = item.poster;
      img.className = 'thumb';
      thumbContainer.appendChild(img);
    } else {
      // Try to generate thumbnail for HLS streams
      generateHLSPreview(item.url, thumbContainer);
    }
    div.appendChild(thumbContainer);

    // Video info container
    const infoContainer = document.createElement('div');
    infoContainer.className = 'info-container';

    const link = document.createElement('a');
    link.href = item.url;
    link.textContent = (item.type === 'hls' ? '[HLS] ' : '') + item.url.split('/').pop();
    link.title = item.url;
    link.target = '_blank';
    infoContainer.appendChild(link);

    const btn = document.createElement('button');
    btn.textContent = 'Download';
    btn.className = 'download-btn';
    
    const err = document.createElement('div');
    err.className = 'error';

    btn.onclick = async () => {
      err.textContent = '';
      const defaultName = item.url.split('/').pop().replace(/\.[^/.]+$/, "") + '.mp4';
      const filename = prompt('Save as filename?', defaultName);
      if (!filename) return;
      
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'downloadHLS',
            url: item.url,
            filename,
            quality: 'best'
          }, resolve);
        });

        if (response && response.success) {
          alert(`Saved to: ${response.path}`);
        } else if (response && response.error) {
          err.textContent = response.error;
        }
      } catch (error) {
        err.textContent = error.message || 'Download failed';
      }
    };

    infoContainer.appendChild(btn);
    infoContainer.appendChild(err);
    div.appendChild(infoContainer);
    root.appendChild(div);
  });
}

async function fetchHLSQualities(url, selectElement) {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'getHLSQualities',
        url: url
      }, resolve);
    });
    
    if (response && response.qualities) {
      selectElement.innerHTML = response.qualities.map(q => 
        `<option value="${q.resolution}">${q.resolution}p${q.bitrate ? ` (${q.bitrate}kbps)` : ''}</option>`
      ).join('');
    } else {
      selectElement.innerHTML = '<option value="best">Best quality</option>';
    }
  } catch (err) {
    console.error('Failed to fetch qualities:', err);
    selectElement.innerHTML = '<option value="best">Best quality</option>';
  }
}

async function generateHLSPreview(url, container) {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'generatePreview',
        url: url
      }, resolve);
    });
    
    if (response && response.previewUrl) {
      const img = document.createElement('img');
      img.src = response.previewUrl;
      img.className = 'thumb';
      container.appendChild(img);
    } else {
      console.log('No preview available');
    }
  } catch (err) {
    console.error('Failed to generate preview:', err);
  }
}

// Receive native‑host responses
chrome.runtime.onMessage.addListener(msg => {
  console.log('hostResponse:', msg);
  if (msg.type === 'hostResponse') {
    if (msg.success) {
      alert('Saved to: ' + msg.path);
    } else {
      const errMsg = msg.error || JSON.stringify(msg);
      alert('Error: ' + errMsg);
    }
  }
});

// On load: detect videos & playlists
document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('videos');
  root.textContent = 'Searching for videos...';
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const videos = [];
    
    // Set a timeout to show "No videos found" if nothing is found within 5 seconds
    const timeout = setTimeout(() => {
      if (!hasUpdated) {
        render([]);
      }
    }, 5000);

    // Get videos from content script
    chrome.tabs.sendMessage(tab.id, { action: 'findVideos' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        if (!hasUpdated) {
          render([]);
        }
        return;
      }
      
      if (response) {
        videos.push(...response.map(url => ({ url, type: 'regular' })));
        updateUI();
      }
    });

    // Get HLS playlists from background script
    chrome.runtime.sendMessage({ action: 'getStoredPlaylists', tabId: tab.id }, (playlists) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        return;
      }
      
      if (playlists && playlists.length) {
        videos.push(...playlists.map(url => ({ url, type: 'hls' })));
        updateUI();
      }
    });

    function updateUI() {
      clearTimeout(timeout);
      hasUpdated = true;
      render(videos);
    }

  } catch (error) {
    console.error('Error:', error);
    root.textContent = 'Error searching for videos.';
  }
});

// Listen for video updates from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'videosFound' && message.videos) {
    const newVideos = message.videos.map(url => ({ url, type: url.includes('.m3u8') ? 'hls' : 'regular' }));
    render(newVideos);
  }
});

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getVideoPreview(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
      type: 'generatePreview',
      url: url
    }, response => {
      resolve(response?.previewUrl);
    });
  });
}

async function displayVideos() {
  const tab = await getCurrentTab();
  const container = document.getElementById('videos');
  container.innerHTML = '<div>Searching for videos...</div>';

  // Get videos from content script
  chrome.tabs.sendMessage(tab.id, { action: 'findVideos' }, async (videos) => {
    if (!videos || videos.length === 0) {
      container.innerHTML = '<div>No videos found</div>';
      return;
    }

    container.innerHTML = '';
    for (const url of videos) {
      const div = document.createElement('div');
      div.className = 'video-item';
      
      // Create preview container
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.innerHTML = 'Loading...';

      // Get and set preview
      const previewUrl = await getVideoPreview(url);
      if (previewUrl) {
        preview.innerHTML = `<img src="${previewUrl}" alt="Preview">`;
      } else {
        preview.innerHTML = 'No preview';
      }

      // Create video info and download button
      const info = document.createElement('div');
      info.className = 'video-info';
      
      const filename = url.split('/').pop().split('?')[0] || 'video.mp4';
      const button = document.createElement('button');
      button.className = 'download-btn';
      button.textContent = 'Download';
      button.onclick = () => {
        chrome.runtime.sendMessage({
          type: 'downloadHLS',
          url: url,
          filename: filename
        });
      };

      info.appendChild(document.createTextNode(filename));
      div.appendChild(preview);
      div.appendChild(info);
      div.appendChild(button);
      container.appendChild(div);
    }
  });
}

document.addEventListener('DOMContentLoaded', displayVideos);