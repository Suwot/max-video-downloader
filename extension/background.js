// Add at the top of the file
let previewGenerationQueue = new Map();

// Receive native‑host responses
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('hostResponse:', msg);
  if (msg.type === 'downloadHLS') {
    chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
      type: 'download',
      url: msg.url,
      filename: msg.filename || 'video.mp4',
      savePath: msg.savePath
    }, response => {
      console.log('Native host response:', response);
      if (response && response.success) {
        // Show success notification with actual path
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
          title: 'Download Complete',
          message: `Saved to: ${response.path}`
        });
      } else {
        // Show error notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/48.png',
          title: 'Download Failed',
          message: response?.error || 'Unknown error occurred'
        });
      }
    });
    return true;
  }
});

// Store HLS playlists per tab
const playlistsPerTab = {};

// Add URL normalization to prevent duplicates
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
    }
}

// Listen for web requests to catch HLS playlists
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const url = details.url;
        if (url.includes('.m3u8')) {
            if (!playlistsPerTab[details.tabId]) {
                playlistsPerTab[details.tabId] = new Set();
            }
            playlistsPerTab[details.tabId].add(normalizeUrl(url));
            console.log('Found HLS playlist:', url);
        }
    },
    { urls: ["<all_urls>"] }
);

// Add connection handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ping') {
        sendResponse({ type: 'pong' });
        return false;
    }
    // ... rest of your message handling
    return true; // Will respond asynchronously
});

// Add error handling for native messaging
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

// Listen for messages from popup/content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getStoredPlaylists') {
        const playlists = playlistsPerTab[request.tabId] 
            ? Array.from(playlistsPerTab[request.tabId])
            : [];
        sendResponse(playlists);
        return true;
    } 
    
    if (request.type === 'downloadHLS' || request.type === 'download') {
        const notificationId = `download-${Date.now()}`;
        let hasError = false;

        chrome.notifications.create(notificationId, {
            type: 'basic',
            iconUrl: 'icons/48.png',
            title: 'Downloading Video',
            message: 'Starting download...'
        });

        chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
            type: 'download',
            url: request.url,
            filename: request.filename || 'video.mp4',
            savePath: request.savePath,
            quality: request.quality
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

    if (request.type === 'generatePreview') {
        // Check if we're already generating this preview
        const cacheKey = request.url;
        if (previewGenerationQueue.has(cacheKey)) {
            // If we are, wait for the existing promise
            previewGenerationQueue.get(cacheKey).then(sendResponse);
            return true;
        }

        // Create new preview generation promise
        const previewPromise = new Promise(resolve => {
            chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
                type: 'generatePreview',
                url: request.url
            }, response => {
                previewGenerationQueue.delete(cacheKey);
                resolve(response);
            });
        });

        // Store the promise
        previewGenerationQueue.set(cacheKey, previewPromise);
        
        // Wait for the preview and send it
        previewPromise.then(sendResponse);
        return true;
    }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete playlistsPerTab[tabId];
});