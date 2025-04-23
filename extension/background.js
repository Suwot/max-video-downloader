// Add at the top of the file
import { NativeConnection } from './popup/js/native-connection.js';

let previewGenerationQueue = new Map();
// Store all detected videos per tab
const videosPerTab = {};
// Store HLS playlists per tab
const playlistsPerTab = {};

// Create native connection instance
const nativeConnection = new NativeConnection();

// Health check interval
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

// Keep track of the service worker's active status
let isServiceWorkerActive = true;

// Setup health check
function setupHealthCheck() {
    // Check native host connection periodically
    const healthCheckInterval = setInterval(async () => {
        if (!isServiceWorkerActive) {
            clearInterval(healthCheckInterval);
            return;
        }

        try {
            const isConnected = await nativeConnection.checkNativeHost();
            console.log('Native host connection status:', isConnected ? 'Connected' : 'Disconnected');
        } catch (error) {
            console.error('Error checking native host connection:', error);
        }
    }, HEALTH_CHECK_INTERVAL);
    
    // Listen for service worker lifecycle events
    self.addEventListener('activate', () => {
        console.log('Service worker activated');
        isServiceWorkerActive = true;
    });
    
    self.addEventListener('install', () => {
        console.log('Service worker installed');
    });
    
    // Properly handle when service worker is about to be terminated
    self.addEventListener('beforeunload', () => {
        isServiceWorkerActive = false;
        if (nativeConnection && nativeConnection.connected) {
            nativeConnection.disconnect();
        }
    });
}

// Initialize on startup
setupHealthCheck();

// Receive runtime messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('Background message received:', msg);
  
  // Native host commands that need to be routed to the native connection
  if (msg.type === 'native-command') {
    handleNativeCommand(msg, sendResponse);
    return true; // Keep the message channel open
  }

  if (msg.type === 'downloadHLS' || msg.type === 'download') {
    handleDownload(msg, sendResponse);
    return true; // Keep the message channel open
  }

  if (msg.type === 'generatePreview') {
    handlePreviewGeneration(msg, sendResponse);
    return true; // Keep the message channel open
  }

  if (msg.type === 'getHLSQualities') {
    handleGetQualities(msg, sendResponse);
    return true; // Keep the message channel open
  }
  
  if (msg.type === 'checkNativeConnection') {
    nativeConnection.checkNativeHost().then(isConnected => {
      sendResponse({
        connected: isConnected,
        error: isConnected ? null : nativeConnection.getConnectionErrorDetails()
      });
    }).catch(error => {
      sendResponse({
        connected: false,
        error: error.message
      });
    });
    return true; // Keep the message channel open
  }
  
  return false;
});

/**
 * Handle generic native commands
 */
function handleNativeCommand(msg, sendResponse) {
  // Ensure we have a fresh connection for each command
  nativeConnection.connect().then(connected => {
    if (!connected) {
      sendResponse({
        success: false,
        error: 'Could not connect to native host',
        details: nativeConnection.getConnectionErrorDetails()
      });
      return;
    }
    
    nativeConnection.sendMessage({
      type: msg.command,
      ...msg.params
    }).then(response => {
      sendResponse({
        success: true,
        data: response
      });
    }).catch(error => {
      console.error('Native command error:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    });
  });
}

/**
 * Handle video/HLS download requests
 */
function handleDownload(msg, sendResponse) {
  const notificationId = `download-${Date.now()}`;
  let hasError = false;

  // Show initial notification
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/48.png',
    title: 'Downloading Video',
    message: 'Starting download...'
  });

  // Ensure we have a fresh connection
  nativeConnection.connect().then(connected => {
    if (!connected) {
      chrome.notifications.update(notificationId, {
        title: 'Download Failed',
        message: `Could not connect to native host. ${nativeConnection.getConnectionErrorDetails()}`
      });
      sendResponse({ success: false, error: 'Could not connect to native host' });
      return;
    }
    
    // Use native connection to send message
    nativeConnection.sendMessage({
      type: 'download',
      url: msg.url,
      format: msg.type || 'direct',
      filename: msg.filename || 'video.mp4',
      savePath: msg.savePath,
      quality: msg.quality,
      downloadId: msg.downloadId || notificationId
    }).then(response => {
      if (response.status === 'started') {
        // Add progress listener for this download
        const listenerId = nativeConnection.addEventListener('progress', progressData => {
          if (progressData.downloadId === msg.downloadId || progressData.downloadId === notificationId) {
            // Update notification with progress
            chrome.notifications.update(notificationId, {
              message: `Downloading: ${progressData.progress}%`
            });

            // If download is complete, clean up
            if (progressData.progress >= 100 || progressData.status === 'completed') {
              chrome.notifications.update(notificationId, {
                title: 'Download Complete',
                message: `Saved to: ${progressData.path || 'your downloads folder'}`
              });
              
              // Remove the progress listener
              nativeConnection.removeEventListener('progress', listenerId);
              
              // Send success response if not yet sent
              if (!hasError) {
                sendResponse({ success: true, path: progressData.path });
              }
            } else if (progressData.status === 'error') {
              // Handle error in progress
              hasError = true;
              chrome.notifications.update(notificationId, {
                title: 'Download Failed',
                message: progressData.error || 'Unknown error occurred'
              });
              
              // Remove the progress listener
              nativeConnection.removeEventListener('progress', listenerId);
              
              // Send error response
              sendResponse({ success: false, error: progressData.error });
            }
          }
        });
        
        // Return success initial status
        sendResponse({ success: true, status: 'started' });
      } else if (response.error) {
        hasError = true;
        chrome.notifications.update(notificationId, {
          title: 'Download Failed',
          message: response.error
        });
        sendResponse({ success: false, error: response.error });
      }
    }).catch(error => {
      console.error('Native messaging error:', error);
      if (!hasError) {
        hasError = true;
        chrome.notifications.update(notificationId, {
          title: 'Download Failed',
          message: error.message || 'Failed to communicate with native host'
        });
        sendResponse({ success: false, error: error.message });
      }
    });
  });
}

// Add connection handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ping') {
        // Check native host connection
        nativeConnection.connect()
          .then(connected => {
            sendResponse({ type: 'pong', nativeHostConnected: connected });
          })
          .catch(() => {
            sendResponse({ type: 'pong', nativeHostConnected: false });
          });
        return true;
    }
    
    // Add video detected from content script
    if (message.action === 'addVideo') {
        const tabId = sender.tab?.id;
        if (tabId && tabId > 0) {
            addVideoToTab(tabId, message);
        }
        return false;
    }
    
    // Get stored playlists (legacy support)
    if (message.action === 'getStoredPlaylists') {
        const playlists = playlistsPerTab[message.tabId] 
            ? Array.from(playlistsPerTab[message.tabId])
            : [];
        sendResponse(playlists);
        return true;
    }
    
    // Get all videos for a tab
    if (message.action === 'getVideos') {
        const tabId = message.tabId;
        
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
    
    // Check native host status
    if (message.action === 'checkNativeHost') {
        nativeConnection.connect()
          .then(connected => {
            sendResponse({ connected });
          })
          .catch(error => {
            sendResponse({ connected: false, error: error.message });
          });
        return true;
    }
    
    return true; // Will respond asynchronously
});

/**
 * Handle preview generation requests
 */
function handlePreviewGeneration(msg, sendResponse) {
  // Check if we're already generating this preview
  const cacheKey = msg.url;
  if (previewGenerationQueue.has(cacheKey)) {
    // If we are, wait for the existing promise
    previewGenerationQueue.get(cacheKey).then(sendResponse);
    return;
  }

  // Ensure we have a fresh connection
  nativeConnection.connect().then(connected => {
    if (!connected) {
      sendResponse({
        success: false,
        error: 'Could not connect to native host',
        details: nativeConnection.getConnectionErrorDetails()
      });
      return;
    }

    // Create new preview generation promise
    const previewPromise = nativeConnection.sendMessage({
      type: 'generatePreview',
      url: msg.url
    }).then(response => {
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
      
      return response;
    }).catch(error => {
      previewGenerationQueue.delete(cacheKey);
      console.error('Preview generation error:', error);
      return { success: false, error: error.message };
    });

    // Store the promise
    previewGenerationQueue.set(cacheKey, previewPromise);
    
    // Wait for the preview and send it
    previewPromise.then(sendResponse);
  });
}

/**
 * Handle HLS quality detection requests
 */
function handleGetQualities(msg, sendResponse) {
  // Ensure we have a fresh connection
  nativeConnection.connect().then(connected => {
    if (!connected) {
      sendResponse({
        success: false,
        error: 'Could not connect to native host',
        details: nativeConnection.getConnectionErrorDetails()
      });
      return;
    }

    // Create promise for quality detection
    nativeConnection.sendMessage({
      type: 'getQualities',
      url: msg.url
    }).then(response => {
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
      
      sendResponse(response);
    }).catch(error => {
      console.error('Get qualities error:', error);
      sendResponse({ success: false, error: error.message });
    });
  });
}

/**
 * Normalize URL for consistent mapping
 */
function normalizeUrl(url) {
    try {
        // For HLS URLs, strip parameters that don't affect content
        if (url.includes('.m3u8') || url.includes('/manifest') || url.includes('/playlist')) {
            const urlObj = new URL(url);
            
            // Keep only essential parameters for identification
            const params = new URLSearchParams();
            for (const [key, value] of urlObj.searchParams.entries()) {
                // Keep only parameters that affect content
                if (['id', 'video_id', 'v', 'format', 'quality'].includes(key)) {
                    params.set(key, value);
                }
            }
            
            // Reconstruct URL with only essential parameters
            urlObj.search = params.toString();
            return urlObj.toString();
        }
        
        return url;
    } catch (e) {
        console.error('Error normalizing URL:', e);
        return url;
    }
}

/**
 * Add video information to a tab's collection, avoiding duplicates
 */
function addVideoToTab(tabId, data) {
    if (!videosPerTab[tabId]) {
        videosPerTab[tabId] = new Map();
    }

    // Normalize URL to prevent duplicates
    const normalizedUrl = normalizeUrl(data.url);
    
    // Skip if it's a duplicate
    const isDuplicate = videosPerTab[tabId].has(normalizedUrl);
    if (isDuplicate) {
        console.log(`Skipping duplicate video: ${normalizedUrl}`);
        return;
    }
    
    // Add to the collection
    console.log(`Adding ${data.type} video to tab ${tabId}:`, normalizedUrl);
    videosPerTab[tabId].set(normalizedUrl, {
        ...data,
        url: normalizedUrl
    });
    
    // Handle HLS playlists for backward compatibility
    if (data.type === 'hls' && data.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
    
    console.log(`Tab ${tabId} now has ${videosPerTab[tabId].size} videos`);
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

// Listen for video-related requests
chrome.webRequest.onBeforeRequest.addListener(
    function(details) {
        // Process media requests from tabs only
        if (!details.tabId || details.tabId === -1) return;
        
        const url = details.url;
        console.log(`Checking request: ${url.substring(0, 100)}...`);
        
        // Skip blob URLs as they are often duplicates of already captured requests
        if (url.startsWith('blob:')) {
            // Only add blob URLs if they have specific indicators of being videos
            if (url.indexOf('video') !== -1 || url.indexOf('media') !== -1) {
                console.log('Processing blob URL with video/media indicator:', url);
                addVideoToTab(details.tabId, {
                    url,
                    type: 'blob',
                    title: getFilenameFromUrl(url) || 'Video',
                    source: 'request'
                });
            } else {
                console.log('Skipping non-media blob URL:', url);
            }
            return;
        }

        // Check for HLS playlists
        if (url.includes('.m3u8') || url.endsWith('.m3u') || url.includes('/master.m3u') || 
            url.includes('/playlist.m3u') || url.includes('/manifest.m3u') || 
            url.includes('/hls/') || url.includes('/video/') || url.includes('/media/')) {
            
            // Enhanced HLS detection based on URL patterns
            const isLikelyHLS = 
                url.includes('.m3u8') || 
                url.endsWith('.m3u') || 
                url.includes('/master.m3u') || 
                url.includes('/playlist.m3u') || 
                url.includes('/manifest.m3u') || 
                (url.includes('/hls/') && url.includes('/segment')) ||
                url.includes('/segments/') ||
                url.includes('/segment') ||
                url.includes('/playlist') ||
                url.includes('/manifest');
                
            if (isLikelyHLS) {
                console.log('Detected likely HLS playlist:', url);
                addVideoToTab(details.tabId, {
                    url,
                    type: 'hls',
                    title: getFilenameFromUrl(url) || 'HLS Video',
                    source: 'request'
                });
                return;
            }
        }
        
        // Check for DASH manifests
        if (url.includes('.mpd') || url.includes('/dash/') || url.includes('/manifest')) {
            console.log('Detected DASH manifest:', url);
            addVideoToTab(details.tabId, {
                url,
                type: 'dash',
                title: getFilenameFromUrl(url) || 'DASH Video',
                source: 'request'
            });
            return;
        }
        
        // Check direct video files
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
        if (videoExtensions.some(ext => url.endsWith(ext) || url.includes(ext + '?'))) {
            console.log('Detected direct video file:', url);
            addVideoToTab(details.tabId, {
                url,
                type: 'direct',
                title: getFilenameFromUrl(url) || 'Video',
                source: 'request'
            });
            return;
        }
        
        // Additional checks for audio files
        const audioExtensions = ['.mp3', '.aac', '.wav', '.ogg', '.flac', '.m4a'];
        if (audioExtensions.some(ext => url.endsWith(ext) || url.includes(ext + '?')) ||
            url.includes('/audio/') || url.includes('_audio') || url.includes('/audio_')) {
            console.log('Detected audio file:', url);
            addVideoToTab(details.tabId, {
                url,
                type: 'audio',
                title: getFilenameFromUrl(url) || 'Audio',
                source: 'request'
            });
            return;
        }
    },
    { urls: ["<all_urls>"] }
);

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete videosPerTab[tabId];
    delete playlistsPerTab[tabId];
});

// Initialize connection when extension loads
nativeConnection.connect().catch(error => {
    console.warn('Failed to establish initial native host connection:', error);
    // We don't need to handle this error, as reconnection will happen when needed
});