// extension/popup/popup.js

// Track if we've already updated the UI
let hasUpdated = false;

// Render list & wire buttons
async function render(items) {
  const root = document.getElementById('videos');
  root.innerHTML = '';
  
  if (!items || items.length === 0) {
    const message = document.createElement('div');
    message.className = 'initial-message';
    message.textContent = 'No videos found on this page.';
    root.appendChild(message);
    return;
  }

  for (const item of items) {
    const videoElement = createVideoElement({
      url: item.url,
      title: new URL(item.url).pathname.split('/').pop(),
      type: item.type
    });
    root.appendChild(videoElement);
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
  const container = document.getElementById('videos');
  
  try {
    // Wait for the background script to be ready
    await new Promise(resolve => {
      const checkConnection = () => {
        chrome.runtime.sendMessage({ type: 'ping' }, response => {
          if (chrome.runtime.lastError) {
            setTimeout(checkConnection, 100);
          } else {
            resolve();
          }
        });
      };
      checkConnection();
    });

    // Show loading state
    container.innerHTML = '<div class="initial-loader">Searching for videos...</div>';
    
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const videos = [];
    let videosFound = false;

    // Set a timeout for "No videos found" message
    const timeout = setTimeout(() => {
      if (!videosFound) {
        container.innerHTML = '<div class="initial-message">No videos found</div>';
      }
    }, 5000);

    // Get videos from content script
    try {
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'findVideos' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      });

      if (response) {
        videos.push(...response.map(url => ({ url, type: 'regular' })));
      }
    } catch (error) {
      console.error('Content script error:', error);
    }

    // Get HLS playlists from background script
    try {
      const playlists = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ 
          action: 'getStoredPlaylists', 
          tabId: tab.id 
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(response || []);
        });
      });

      if (playlists.length) {
        videos.push(...playlists.map(url => ({ url, type: 'hls' })));
      }
    } catch (error) {
      console.error('Background script error:', error);
    }

    // Update UI only if we have videos
    if (videos.length > 0) {
      videosFound = true;
      clearTimeout(timeout);
      container.innerHTML = '';
      videos.forEach(video => {
        const videoElement = createVideoElement(video);
        container.appendChild(videoElement);
      });
    } else if (!container.querySelector('.initial-message')) {
      // Only update if there's no message already
      container.innerHTML = '<div class="initial-message">No videos found</div>';
    }

  } catch (error) {
    console.error('Initialization error:', error);
    container.innerHTML = '<div class="initial-message">Failed to initialize</div>';
  }
});

// Listen for video updates from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'error') {
        // Handle error messages
        const container = document.getElementById('videos');
        container.innerHTML = `<div class="initial-message">${message.error}</div>`;
        sendResponse(); // Send empty response to close the message channel
    } else if (message.action === 'videosFound' && message.videos) {
        const container = document.getElementById('videos');
        const videos = message.videos.map(url => ({ 
            url, 
            type: url.includes('.m3u8') ? 'hls' : 'regular' 
        }));

        if (videos.length > 0) {
            container.innerHTML = '';
            videos.forEach(video => {
                const videoElement = createVideoElement(video);
                container.appendChild(videoElement);
            });
        }
        sendResponse(); // Send empty response to close the message channel
    }
    // Only return true if we need to respond asynchronously
    return false; // We're handling responses synchronously now
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

    // Left column - Preview
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-column';
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    
    const previewImg = document.createElement('img');
    previewImg.className = 'preview-image';
    previewImg.style.display = 'none'; // Hide initially
    
    previewContainer.appendChild(loader);
    previewContainer.appendChild(previewImg);

    // Right column - Info & Controls
    const infoContainer = document.createElement('div');
    infoContainer.className = 'info-column';
    
    // Title row with copy button
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    
    const titleText = document.createElement('div');
    titleText.className = 'video-title';
    titleText.textContent = video.title || new URL(video.url).pathname.split('/').pop();
    
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">
        <path d="M16 1H4C3 1 2 2 2 3v14h2V3h12V1zm3 4H8C7 5 6 6 6 7v14c0 1 1 2 2 2h11c1 0 2-1 2-2V7c0-1-1-2-2-2zm0 16H8V7h11v14z"/>
    </svg>`;
    copyButton.title = "Copy HLS URL";
    
    copyButton.onclick = () => {
        navigator.clipboard.writeText(video.url).then(() => {
            const tooltip = document.createElement('div');
            tooltip.className = 'tooltip';
            tooltip.textContent = 'Copied!';
            copyButton.appendChild(tooltip);
            setTimeout(() => tooltip.remove(), 2000);
        });
    };
    
    titleRow.appendChild(titleText);
    titleRow.appendChild(copyButton);

    // Resolution info
    const resolutionInfo = document.createElement('div');
    resolutionInfo.className = 'resolution-info';
    resolutionInfo.textContent = 'Loading resolution...';
    
    // Get resolution info
    getStreamResolution(video.url).then(resolution => {
        resolutionInfo.textContent = resolution || 'Resolution unknown';
    });

    // Download buttons container
    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'download-group';

    // Main download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.textContent = 'Download';
    
    // Save As button (simplified)
    const saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'save-as-btn';
    saveAsBtn.textContent = 'Save as...';

    // Handle download clicks
    const handleDownload = async (customPath = false) => {
        const btn = customPath ? saveAsBtn : downloadBtn;
        const originalText = btn.textContent;
        
        btn.innerHTML = '<div class="button-loader"></div>';
        btn.disabled = true;

        try {
            if (customPath) {
                const defaultName = getUniqueFilename(video.url);
                const suggestedName = prompt('Save as:', defaultName);
                if (!suggestedName) {
                    btn.textContent = originalText;
                    btn.disabled = false;
                    return;
                }

                const dirHandle = await window.showDirectoryPicker();
                chrome.runtime.sendMessage({
                    type: 'downloadHLS',
                    url: video.url,
                    filename: suggestedName,
                    savePath: dirHandle.name
                });
            } else {
                chrome.runtime.sendMessage({
                    type: 'downloadHLS',
                    url: video.url,
                    filename: getUniqueFilename(video.url),
                    savePath: 'Desktop'
                });
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                alert('Failed to select save location: ' + error.message);
            }
        }

        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
        }, 1000);
    };

    downloadBtn.onclick = () => handleDownload(false);
    saveAsBtn.onclick = () => handleDownload(true);

    buttonGroup.appendChild(downloadBtn);
    buttonGroup.appendChild(saveAsBtn);

    // Assemble the right column
    infoContainer.appendChild(titleRow);
    infoContainer.appendChild(resolutionInfo);
    infoContainer.appendChild(buttonGroup);

    // Assemble the main container
    container.appendChild(previewContainer);
    container.appendChild(infoContainer);

    // Start loading preview in parallel
    loadPreview(video.url, previewImg, loader, previewContainer);

    return container;
}

function loadPreview(videoUrl, imgElement, loaderElement, containerElement) {
    chrome.runtime.sendMessage({
        type: 'generatePreview',
        url: videoUrl
    }, response => {
        if (chrome.runtime.lastError) {
            console.error('Preview generation error:', chrome.runtime.lastError);
            // Show placeholder on error
            loaderElement.style.display = 'none';
            imgElement.src = '../icons/video-placeholder.png';
            imgElement.style.display = 'block';
            imgElement.classList.add('placeholder');
            return;
        }

        if (response && response.previewUrl) {
            imgElement.onload = () => {
                loaderElement.style.display = 'none';
                imgElement.style.display = 'block';
            };
            imgElement.src = response.previewUrl;
        } else {
            // If preview generation failed, show placeholder
            loaderElement.style.display = 'none';
            imgElement.src = '../icons/video-placeholder.png';
            imgElement.style.display = 'block';
            imgElement.classList.add('placeholder');
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
document.addEventListener('DOMContentLoaded', async () => {
    // Wait for the background script to be ready
    try {
        await new Promise(resolve => {
            const checkConnection = () => {
                chrome.runtime.sendMessage({ type: 'ping' }, response => {
                    if (chrome.runtime.lastError) {
                        setTimeout(checkConnection, 100);
                    } else {
                        resolve();
                    }
                });
            };
            checkConnection();
        });
        
        // Now that connection is established, update the video list
        updateVideoList();
    } catch (error) {
        console.error('Failed to initialize:', error);
        const container = document.getElementById('videos');
        container.innerHTML = '<div class="initial-message">Failed to connect to extension</div>';
    }
});

function downloadVideo(url) {
    const filename = new URL(url).pathname.split('/').pop().split('?')[0] || 'video.mp4';
    chrome.runtime.sendMessage({
        type: 'downloadHLS',
        url: url,
        filename: filename
    });
}

// Add this new function to get stream resolution
async function getStreamResolution(url) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            type: 'getHLSQualities',
            url: url
        }, response => {
            if (chrome.runtime.lastError) {
                console.error('Resolution fetch error:', chrome.runtime.lastError);
                resolve('Resolution unknown');
                return;
            }

            try {
                if (response && response.streamInfo) {
                    const { width, height, fps } = response.streamInfo;
                    if (width && height) {
                        resolve(`${width}x${height} @ ${fps}fps`);
                    } else {
                        resolve('Resolution unknown');
                    }
                } else {
                    resolve('Resolution unknown');
                }
            } catch (error) {
                console.error('Resolution parse error:', error);
                resolve('Resolution unknown');
            }
        });
    });
}

// Add this helper function at the top of the file
function getUniqueFilename(url) {
    // Extract stream name from URL (e.g., "4mplf/video_3" from "https://cdn.hotscope.tv/videos/4mplf/video_3.m3u8")
    const urlPath = new URL(url).pathname;
    const streamName = urlPath.split('/').slice(-2).join('_').replace('.m3u8', '');
    return `${streamName}.mp4`;
}