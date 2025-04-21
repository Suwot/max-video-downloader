// Receive native‑host responses
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('hostResponse:', msg);
  if (msg.type === 'downloadHLS') {
    chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
      type: 'download',
      url: msg.url,
      filename: msg.filename || 'video.mp4'
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

// Add timeout and error handling for native messaging
function sendNativeMessage(message, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Native host communication timeout'));
        }, timeout);

        try {
            chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', message, response => {
                clearTimeout(timeoutId);
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(response);
            });
        } catch (error) {
            clearTimeout(timeoutId);
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
    } else if (request.type === 'downloadHLS') {
        console.log('Downloading HLS:', request.url);
        
        sendNativeMessage({
            type: 'download',
            url: request.url,
            filename: request.filename,
            quality: request.quality
        }).then(response => {
            console.log('Native host response:', response);
            sendResponse({ success: true, response });
        }).catch(error => {
            console.error('Native host error:', error);
            sendResponse({ success: false, error: error.message });
        });
        
        return true; // Keep message channel open for async response
    }
    return true;
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete playlistsPerTab[tabId];
});