// Add at the top of the file
let previewGenerationQueue = new Map();
// Store all detected videos per tab
const videosPerTab = {};
// Store HLS playlists per tab
const playlistsPerTab = {};

// Receive native‑host responses
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('hostResponse:', msg);
  if (msg.type === 'downloadHLS' || msg.type === 'download') {
    const notificationId = `download-${Date.now()}`;
    let hasError = false;

    // Show initial notification
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Downloading Video',
      message: 'Starting download...'
    });

    chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
      type: 'download',
      url: msg.url,
      filename: msg.filename || 'video.mp4',
      savePath: msg.savePath,
      quality: msg.quality
    }, response => {
      if (chrome.runtime.lastError) {
        console.error('Native messaging error:', chrome.runtime.lastError);
        if (!hasError) {
          hasError = true;
          chrome.notifications.update(notificationId, {
            title: 'Download Failed',
            message: chrome.runtime.lastError.message
          });
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        }
        return;
      }

      if (response && response.type === 'progress' && !hasError) {
        chrome.notifications.update(notificationId, {
          message: `Downloading: ${response.progress}%`
        });
      } else if (response && response.success && !hasError) {
        chrome.notifications.update(notificationId, {
          title: 'Download Complete',
          message: `Saved to: ${response.path}`
        });
        sendResponse({ success: true, path: response.path });
      } else if (response && response.error && !hasError) {
        hasError = true;
        chrome.notifications.update(notificationId, {
          title: 'Download Failed',
          message: response.error
        });
        sendResponse({ success: false, error: response.error });
      }
    });
    
    return true;
  }

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

  if (msg.type === 'getHLSQualities') {
    // Create promise for quality detection
    const qualityPromise = new Promise(resolve => {
      chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
        type: 'getQualities',
        url: msg.url
      }, response => {
        // If we got stream info, save it with the video
        if (response && response.streamInfo && msg.tabId && videosPerTab[msg.tabId]) {
          const normalizedUrl = normalizeUrl(msg.url);
          const videoInfo = videosPerTab[msg.tabId].get(normalizedUrl);
          if (videoInfo) {
            videoInfo.resolution = {
              width: response.streamInfo.width,
              height: response.streamInfo.height,
              fps: response.streamInfo.fps,
              bitrate: response.streamInfo.bitrate
            };
            videosPerTab[msg.tabId].set(normalizedUrl, videoInfo);
            
            // Log the stream info for debugging
            console.log('Stream info updated:', {
              url: msg.url,
              streamInfo: response.streamInfo
            });
          }
        }
        
        resolve(response);
      });
    });
    
    // Wait for quality info and send response
    qualityPromise.then(sendResponse);
    return true;
  }
});

// Add connection handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ping') {
        sendResponse({ type: 'pong' });
        return false;
    }
    
    // Add video detected from content script
    if (message.action === 'addVideo') {
        const tabId = sender.tab?.id;
        if (tabId && tabId > 0) {
            addVideoToTab(tabId, message);
        }
        return false;
    }
    
    // ... rest of your message handling
    return true; // Will respond asynchronously
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

// Listen for messages from popup/content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Get stored playlists (legacy support)
    if (request.action === 'getStoredPlaylists') {
        const playlists = playlistsPerTab[request.tabId] 
            ? Array.from(playlistsPerTab[request.tabId])
            : [];
        sendResponse(playlists);
        return true;
    }
    
    // Get all videos for a tab
    if (request.action === 'getVideos') {
        const tabId = request.tabId;
        
        if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
            sendResponse([]);
            return true;
        }
        
        // Convert Map to Array for sending
        const videos = Array.from(videosPerTab[tabId].values());
        
        // Sort by timestamp (newest first)
        videos.sort((a, b) => b.timestamp - a.timestamp);
        
        sendResponse(videos);
        return true;
    }
    
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
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete videosPerTab[tabId];
    delete playlistsPerTab[tabId];
});