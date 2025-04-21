// extension/popup/popup.js

// Track if we've already updated the UI
let hasUpdated = false;

// Render list & wire buttons
async function render(items) {
  const root = document.getElementById('videos');
  root.innerHTML = '';
  
  if (!items || items.length === 0) {
    root.textContent = 'No videos found on this page.';
    return;
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'video-item';
    
    // Preview container
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.innerHTML = 'Loading preview...';
    
    // Try to get preview
    if (item.type === 'hls') {
      const previewUrl = await findPreviewForHLS(item.url);
      if (previewUrl) {
        preview.innerHTML = `<img src="${previewUrl}" alt="Preview">`;
      } else {
        preview.innerHTML = 'No preview available';
      }
    }
    
    // Video info
    const info = document.createElement('div');
    info.className = 'video-info';
    
    const filename = item.url.split('/').pop().split('?')[0] || 'video.mp4';
    
    // Create download button group
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'download-group';

    // Main download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.textContent = 'Download';
    downloadBtn.setAttribute('data-tooltip', 'Download to default location');
    downloadBtn.onclick = () => {
        chrome.runtime.sendMessage({
            type: 'downloadHLS',
            url: item.url,
            filename: filename
        });
    };

    // Save As button
    const saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'save-as-btn';
    saveAsBtn.setAttribute('data-tooltip', 'Choose save location');
    const saveIcon = document.createElement('span');
    saveIcon.className = 'save-icon';
    saveAsBtn.appendChild(saveIcon);

    saveAsBtn.onclick = async () => {
        try {
            // First, prompt for filename
            const suggestedName = prompt('Save as:', filename);
            if (!suggestedName) return;

            // Then show folder picker
            const dirHandle = await window.showDirectoryPicker();
            
            // Send both filename and save path to background
            chrome.runtime.sendMessage({
                type: 'downloadHLS',
                url: item.url,
                filename: suggestedName,
                savePath: dirHandle.name
            });
        } catch (error) {
            console.error('Failed to get save location:', error);
            // If user cancelled the folder picker, just return silently
            if (error.name !== 'AbortError') {
                alert('Failed to select save location: ' + error.message);
            }
        }
    };

    buttonGroup.appendChild(downloadBtn);
    buttonGroup.appendChild(saveAsBtn);

    // Add to the container
    info.appendChild(document.createTextNode(filename));
    div.appendChild(preview);
    div.appendChild(info);
    div.appendChild(buttonGroup);
    root.appendChild(div);
  }
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
      const buttonGroup = document.createElement('div');
      buttonGroup.className = 'download-group';

      // Main download button
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'download-btn';
      downloadBtn.textContent = 'Download';
      downloadBtn.setAttribute('data-tooltip', 'Download to default location');
      downloadBtn.onclick = () => {
          chrome.runtime.sendMessage({
              type: 'downloadHLS',
              url: url,
              filename: filename
          });
      };

      // Save As button
      const saveAsBtn = document.createElement('button');
      saveAsBtn.className = 'save-as-btn';
      saveAsBtn.setAttribute('data-tooltip', 'Choose save location');
      const saveIcon = document.createElement('span');
      saveIcon.className = 'save-icon';
      saveAsBtn.appendChild(saveIcon);

      saveAsBtn.onclick = async () => {
          try {
              // First, prompt for filename
              const suggestedName = prompt('Save as:', filename);
              if (!suggestedName) return;

              // Then show folder picker
              const dirHandle = await window.showDirectoryPicker();
              
              // Send both filename and save path to background
              chrome.runtime.sendMessage({
                  type: 'downloadHLS',
                  url: url,
                  filename: suggestedName,
                  savePath: dirHandle.name
              });
          } catch (error) {
              console.error('Failed to get save location:', error);
              // If user cancelled the folder picker, just return silently
              if (error.name !== 'AbortError') {
                  alert('Failed to select save location: ' + error.message);
              }
          }
      };

      buttonGroup.appendChild(downloadBtn);
      buttonGroup.appendChild(saveAsBtn);

      info.appendChild(document.createTextNode(filename));
      div.appendChild(preview);
      div.appendChild(info);
      div.appendChild(buttonGroup);
      container.appendChild(div);
    }
  });
}

document.addEventListener('DOMContentLoaded', displayVideos);

async function findPreviewForHLS(hlsUrl) {
    // 1. Try to find matching video element first
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
        // Check source elements
        const sources = video.querySelectorAll('source');
        for (const source of sources) {
            if (source.src.includes(hlsUrl)) {
                return video.poster || null;
            }
        }
        
        // Check data attributes
        const dataAttrs = Array.from(video.attributes)
            .filter(attr => attr.name.startsWith('data-'))
            .map(attr => attr.value);
            
        if (dataAttrs.some(value => value.includes(hlsUrl))) {
            return video.poster || null;
        }
    }
    
    // 2. If no matching video found, generate preview using FFmpeg
    return new Promise((resolve) => {
        chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
            type: 'generatePreview',
            url: hlsUrl
        }, response => {
            resolve(response?.previewUrl);
        });
    });
}

function createVideoElement(video) {
    const container = document.createElement('div');
    container.className = 'video-item';

    // Create preview container with loader
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    
    const previewImg = document.createElement('img');
    previewImg.className = 'preview-image';
    
    previewContainer.appendChild(loader);
    previewContainer.appendChild(previewImg);

    // Create video info and controls
    const infoContainer = document.createElement('div');
    infoContainer.className = 'video-info';
    
    const filename = new URL(video.url).pathname.split('/').pop().split('?')[0] || 'video.mp4';
    
    // Add title with better handling of long text
    const titleElement = document.createElement('div');
    titleElement.textContent = video.title || filename;
    titleElement.style.marginBottom = '8px';
    infoContainer.appendChild(titleElement);

    // Create download button group
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'download-group';

    // Main download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.textContent = 'Download';
    downloadBtn.setAttribute('data-tooltip', 'Download to default location');
    downloadBtn.onclick = () => {
        chrome.runtime.sendMessage({
            type: 'downloadHLS',
            url: video.url,
            filename: filename
        });
    };

    // Save As button
    const saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'save-as-btn';
    saveAsBtn.setAttribute('data-tooltip', 'Choose save location');
    const saveIcon = document.createElement('span');
    saveIcon.className = 'save-icon';
    saveAsBtn.appendChild(saveIcon);

    saveAsBtn.onclick = async () => {
        try {
            // First, prompt for filename
            const suggestedName = prompt('Save as:', filename);
            if (!suggestedName) return;

            // Then show folder picker
            const dirHandle = await window.showDirectoryPicker();
            
            // Send both filename and save path to background
            chrome.runtime.sendMessage({
                type: 'downloadHLS',
                url: video.url,
                filename: suggestedName,
                savePath: dirHandle.name
            });
        } catch (error) {
            console.error('Failed to get save location:', error);
            // If user cancelled the folder picker, just return silently
            if (error.name !== 'AbortError') {
                alert('Failed to select save location: ' + error.message);
            }
        }
    };

    buttonGroup.appendChild(downloadBtn);
    buttonGroup.appendChild(saveAsBtn);

    // Assemble the components
    container.appendChild(previewContainer);
    container.appendChild(infoContainer);
    container.appendChild(buttonGroup);

    // Start loading preview in parallel
    loadPreview(video.url, previewImg, loader);

    return container;
}

function loadPreview(videoUrl, imgElement, loaderElement) {
    chrome.runtime.sendMessage({
        type: 'generatePreview',
        url: videoUrl
    }, response => {
        if (response && response.previewUrl) {
            imgElement.onload = () => {
                loaderElement.style.display = 'none';
                imgElement.classList.add('loaded');
            };
            imgElement.src = response.previewUrl;
        } else {
            // If preview generation fails, show a placeholder
            loaderElement.style.display = 'none';
            // Use a data URL for the placeholder to avoid missing file issues
            imgElement.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAMAAAAOusbgAAAAQlBMVEX///+hoaGdnZ2ampqXl5eUlJSRkZGOjo7x8fHt7e3p6ens7Ozo6Ojm5ubj4+Pg4ODd3d3a2trX19fU1NTR0dHOzs4xvP2LAAAAAXRSTlMAQObYZgAAAJlJREFUeNrt1kEKwyAQQNFJTGIa09r0/letCF0FQQcXA++4ePAfRAYAAAAAAP6NHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyCHIIcghyC/ADkFwAA//+QlAX/cFltXwAAAABJRU5ErkJggg==';
            imgElement.classList.add('loaded');
        }
    });
}

function updateVideoList() {
    const container = document.getElementById('videos');
    
    // Clear existing content and show initial loader
    container.innerHTML = '<div class="loader"></div>';

    // Get current tab
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const currentTab = tabs[0];
        
        // First, get all videos
        chrome.runtime.sendMessage({ 
            action: 'getStoredPlaylists',
            tabId: currentTab.id 
        }, videos => {
            // Remove the loader
            container.innerHTML = '';
            
            if (!videos || videos.length === 0) {
                // Create a styled message
                const message = document.createElement('div');
                message.className = 'initial-message';
                message.textContent = 'No videos found';
                container.appendChild(message);
                return;
            }

            // Create elements for each video with loading previews
            videos.forEach(videoUrl => {
                const videoElement = createVideoElement({
                    url: videoUrl,
                    title: new URL(videoUrl).pathname.split('/').pop()
                });
                container.appendChild(videoElement);
            });
        });
    });
}

// Initialize when popup opens
document.addEventListener('DOMContentLoaded', () => {
    updateVideoList();
});

function downloadVideo(url) {
    const filename = new URL(url).pathname.split('/').pop().split('?')[0] || 'video.mp4';
    chrome.runtime.sendMessage({
        type: 'downloadHLS',
        url: url,
        filename: filename
    });
}