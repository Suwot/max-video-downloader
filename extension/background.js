// Add at the top of the file
let previewGenerationQueue = new Map();
const videosPerTab = {};
const playlistsPerTab = {};
const downloadPorts = new Map();

// Handle port connections from popup
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'download_progress') {
    // Create unique ID for each port connection
    const portId = Date.now().toString();
    downloadPorts.set(portId, port);
    
    port.onDisconnect.addListener(() => {
      downloadPorts.delete(portId);
    });
  }
});

// Single message listener for all messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('Message received:', msg);
  
  // Handle download requests
  if (msg.type === 'downloadHLS' || msg.type === 'download') {
    const notificationId = `download-${Date.now()}`;
    let hasError = false;
    
    // Get all active download ports
    const ports = Array.from(downloadPorts.values());

    // Create response handler
    const responseHandler = (response) => {
      if (chrome.runtime.lastError) {
        console.error('Native messaging error:', chrome.runtime.lastError);
        handleDownloadError(chrome.runtime.lastError.message, notificationId, ports);
        return;
      }

      // Handle different response types
      if (response && response.type === 'progress' && !hasError) {
        // Update notification less frequently
        if (response.progress % 10 === 0) {
          chrome.notifications.update(notificationId, {
            message: `Downloading: ${response.progress}%`
          });
        }
        
        // Forward progress to all connected popups
        ports.forEach(port => {
          try {
            port.postMessage(response);
          } catch (e) {
            console.error('Error sending progress to port:', e);
          }
        });
      } else if (response && response.success && !hasError) {
        handleDownloadSuccess(response, notificationId, ports);
      } else if (response && response.error && !hasError) {
        hasError = true;
        handleDownloadError(response.error, notificationId, ports);
      }
    };

    // Show initial notification
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Downloading Video',
      message: 'Starting download...'
    });

    // Send to native host
    chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
      type: 'download',
      url: msg.url,
      filename: msg.filename || 'video.mp4',
      savePath: msg.savePath,
      quality: msg.quality
    }, responseHandler);

    return true; // Keep channel open for progress updates
  }

  // Handle video detection from content script
  if (msg.action === 'addVideo') {
    const tabId = sender.tab?.id;
    if (tabId && tabId > 0) {
      addVideoToTab(tabId, msg);
    }
    return false;
  }

  // Handle stored playlists request
  if (msg.action === 'getStoredPlaylists') {
    const playlists = playlistsPerTab[msg.tabId] 
      ? Array.from(playlistsPerTab[msg.tabId])
      : [];
    sendResponse(playlists);
    return true;
  }

  // Handle videos list request
  if (msg.action === 'getVideos') {
    const tabId = msg.tabId;
    
    if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
      sendResponse([]);
      return true;
    }
    
    // Convert Map to Array for sending
    const videos = Array.from(videosPerTab[tabId].values());
    videos.sort((a, b) => b.timestamp - a.timestamp);
    sendResponse(videos);
    return true;
  }

  // Handle preview generation
  if (msg.type === 'generatePreview') {
    // Check if we're already generating this preview
    const cacheKey = msg.url;
    if (previewGenerationQueue.has(cacheKey)) {
      // If we are, wait for the existing promise
      previewGenerationQueue.get(cacheKey).then(sendResponse);
      return true;
    }

    // Create new preview generation promise
    const previewPromise = new Promise(resolve => {
      chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
        type: 'generatePreview',
        url: msg.url
      }, response => {
        previewGenerationQueue.delete(cacheKey);
        
        // If we successfully generated a preview, cache it with the video
        if (response && response.previewUrl && msg.tabId && videosPerTab[msg.tabId]) {
          const normalizedUrl = normalizeUrl(msg.url);
          const videoInfo = videosPerTab[msg.tabId].get(normalizedUrl);
          if (videoInfo) {
            videoInfo.previewUrl = response.previewUrl;
            videosPerTab[msg.tabId].set(normalizedUrl, videoInfo);
          }
        }
        
        resolve(response);
      });
    });

    // Store the promise
    previewGenerationQueue.set(cacheKey, previewPromise);
    
    // Wait for the preview and send it
    previewPromise.then(sendResponse);
    return true;
  }

  // Handle stream qualities request
  if (msg.type === 'getHLSQualities') {
    // Create promise for quality detection
    const qualityPromise = new Promise(resolve => {
      console.log('🎥 Requesting media info from native host for:', msg.url);
      chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
        type: 'getQualities',
        url: msg.url
      }, response => {
        if (response?.streamInfo) {
          console.group('📊 Received media info from native host:');
          console.log('URL:', msg.url);
          if (response.streamInfo.hasVideo) {
            console.log('Video:', {
              codec: response.streamInfo.videoCodec.name,
              resolution: `${response.streamInfo.width}x${response.streamInfo.height}`,
              fps: response.streamInfo.fps,
              bitrate: response.streamInfo.videoBitrate ? `${(response.streamInfo.videoBitrate / 1000000).toFixed(2)} Mbps` : 'unknown'
            });
          }
          if (response.streamInfo.hasAudio) {
            console.log('Audio:', {
              codec: response.streamInfo.audioCodec.name,
              channels: response.streamInfo.audioCodec.channels,
              sampleRate: response.streamInfo.audioCodec.sampleRate ? `${response.streamInfo.audioCodec.sampleRate}Hz` : 'unknown'
            });
          }
          console.log('Duration:', response.streamInfo.duration ? `${Math.floor(response.streamInfo.duration / 60)}:${Math.floor(response.streamInfo.duration % 60).toString().padStart(2, '0')}` : 'unknown');
          console.log('Container:', response.streamInfo.container);
          console.groupEnd();
          // Always send complete stream info in response
          resolve({ streamInfo: response.streamInfo });
        } else {
          console.warn('❌ Failed to get media info:', response?.error || 'Unknown error');
          resolve(response);
        }
      });
    });
    
    // Wait for quality info and send response
    qualityPromise.then(sendResponse);
    return true;
  }

  return false;
});

// Add URL normalization to prevent duplicates
function normalizeUrl(url) {
    // Don't normalize blob URLs
    if (url.startsWith('blob:')) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        // Remove common parameters that don't affect the content
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
    }
}

// Add video to tab's collection
function addVideoToTab(tabId, videoInfo) {
    if (!videosPerTab[tabId]) {
        videosPerTab[tabId] = new Map();
    }
    
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Skip if already detected
    if (videosPerTab[tabId].has(normalizedUrl)) {
        return;
    }
    
    // Add video info
    const timestamp = Date.now();
    videosPerTab[tabId].set(normalizedUrl, {
        url: videoInfo.url,
        type: videoInfo.type,
        source: videoInfo.source || 'unknown',
        timestamp: timestamp,
        title: videoInfo.title || getFilenameFromUrl(videoInfo.url),
        poster: videoInfo.poster || null,
        resolution: null, // Will be populated later
        previewUrl: null  // Will be populated later
    });
    
    console.log(`Added ${videoInfo.type} video to tab ${tabId}:`, videoInfo.url);
    
    // For HLS playlists, also add to that specific collection for back-compat
    if (videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
}

// Extract filename from URL
function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        if (filename && filename.length > 0) {
            return filename;
        }
    } catch {}
    
    return 'video';
}

// Listen for web requests to catch video-related content
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const url = details.url;
        // Check for HLS, DASH, and direct video files
        if (
            url.includes('.m3u8') || 
            url.includes('.mpd') || 
            /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)
        ) {
            // Determine type
            let type = 'unknown';
            if (url.includes('.m3u8')) {
                type = 'hls';
            } else if (url.includes('.mpd')) {
                type = 'dash';
            } else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)) {
                type = 'direct';
            }
            
            // Add video
            addVideoToTab(details.tabId, {
                url: url,
                type: type,
                source: 'webRequest'
            });
        }
    },
    { urls: ["<all_urls>"] }
);

// Error handling for native messaging
let nativePort = null;

function connectNativeHost() {
    try {
        nativePort = chrome.runtime.connectNative('com.mycompany.ffmpeg');
        
        nativePort.onDisconnect.addListener(() => {
            console.error('Native host disconnected:', chrome.runtime.lastError);
            nativePort = null;
        });

        return true;
    } catch (error) {
        console.error('Failed to connect to native host:', error);
        return false;
    }
}

// Update your message sending function to handle reconnection
async function sendNativeMessage(message) {
    if (!nativePort && !connectNativeHost()) {
        throw new Error('Could not connect to native host');
    }

    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', message, response => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(response);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete videosPerTab[tabId];
    delete playlistsPerTab[tabId];
});

function handleDownloadSuccess(response, notificationId, ports) {
  chrome.notifications.update(notificationId, {
    title: 'Download Complete',
    message: `Saved to: ${response.path}`
  });
  
  // Notify all connected popups
  ports.forEach(port => {
    try {
      port.postMessage(response);
    } catch (e) {
      console.error('Error sending success to port:', e);
    }
  });
}

function handleDownloadError(error, notificationId, ports) {
  chrome.notifications.update(notificationId, {
    title: 'Download Failed',
    message: error
  });
  
  // Notify all connected popups
  ports.forEach(port => {
    try {
      port.postMessage({ success: false, error: error });
    } catch (e) {
      console.error('Error sending error to port:', e);
    }
  });
}