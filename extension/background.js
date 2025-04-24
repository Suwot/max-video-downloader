// Add at the top of the file
import { parseHLSManifest, parseDASHManifest } from './popup/js/manifest-parser.js';

let previewGenerationQueue = new Map();
const videosPerTab = {};
const playlistsPerTab = {};
const downloadPorts = new Map();
const metadataProcessingQueue = new Map();
const manifestRelationships = new Map();

// Handle port connections from popup
chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'download_progress') {
        const portId = Date.now().toString();
        downloadPorts.set(portId, port);
        port.onDisconnect.addListener(() => {
            downloadPorts.delete(portId);
        });
    }
});

// Helper function to extract stream metadata
async function getStreamMetadata(url) {
    try {
        const response = await new Promise(resolve => {
            chrome.runtime.sendNativeMessage('com.mycompany.ffmpeg', {
                type: 'getQualities',
                url: url
            }, resolve);
        });

        if (response?.streamInfo) {
            // Add variants if available
            if (response.streamInfo.type === 'hls' || response.streamInfo.type === 'dash') {
                try {
                    const manifestResponse = await fetch(url);
                    const content = await manifestResponse.text();
                    
                    // Use appropriate parser based on type
                    const variants = response.streamInfo.type === 'hls' ?
                        parseHLSManifest(content, url) :
                        parseDASHManifest(content, url);
                        
                    if (variants.length > 0) {
                        response.streamInfo.variants = variants;
                    }
                } catch (error) {
                    console.warn('Failed to fetch manifest:', error);
                }
            }
            return response.streamInfo;
        }
        return null;
    } catch (error) {
        console.error('Failed to get stream metadata:', error);
        return null;
    }
}

// Process metadata queue with retry mechanism
async function processMetadataQueue(maxConcurrent = 3, maxRetries = 2) {
    if (metadataProcessingQueue.size === 0) return;
    
    const entries = Array.from(metadataProcessingQueue.entries()).slice(0, maxConcurrent);
    const processPromises = entries.map(async ([url, info]) => {
        let retries = 0;
        while (retries < maxRetries) {
            try {
                metadataProcessingQueue.delete(url);
                const streamInfo = await getStreamMetadata(url);
                
                if (streamInfo) {
                    if (info.tabId && videosPerTab[info.tabId]) {
                        const normalizedUrl = normalizeUrl(url);
                        const existingVideo = videosPerTab[info.tabId].get(normalizedUrl);
                        if (existingVideo) {
                            videosPerTab[info.tabId].set(normalizedUrl, {
                                ...existingVideo,
                                streamInfo,
                                qualities: streamInfo.variants || []
                            });
                        }
                    }
                    break;
                }
                retries++;
            } catch (error) {
                console.error(`Failed to process metadata for ${url} (attempt ${retries + 1}):`, error);
                if (retries >= maxRetries - 1) break;
                await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
            }
        }
    });

    await Promise.all(processPromises);
    
    if (metadataProcessingQueue.size > 0) {
        setTimeout(() => processMetadataQueue(maxConcurrent, maxRetries), 100);
    }
}

// Extract variants from manifest content
function extractVariantsFromManifest(content, baseUrl, type) {
    const variants = [];
    
    if (type === 'hls') {
        // Basic HLS manifest parsing
        const lines = content.split('\n');
        let currentVariant = null;
        
        lines.forEach(line => {
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                currentVariant = {
                    bandwidth: extractAttribute(line, 'BANDWIDTH'),
                    resolution: extractAttribute(line, 'RESOLUTION'),
                    codecs: extractAttribute(line, 'CODECS')
                };
            } else if (line && !line.startsWith('#') && currentVariant) {
                currentVariant.url = resolveUrl(baseUrl, line.trim());
                variants.push(currentVariant);
                currentVariant = null;
            }
        });
    } else if (type === 'dash') {
        // Basic DASH manifest parsing
        try {
            const parser = new DOMParser();
            const xml = parser.parseFromString(content, 'text/xml');
            const representations = xml.querySelectorAll('Representation');
            
            representations.forEach(rep => {
                variants.push({
                    bandwidth: rep.getAttribute('bandwidth'),
                    width: rep.getAttribute('width'),
                    height: rep.getAttribute('height'),
                    codecs: rep.getAttribute('codecs')
                });
            });
        } catch (error) {
            console.error('Failed to parse DASH manifest:', error);
        }
    }
    
    return variants;
}

// Helper to extract attributes from HLS manifest
function extractAttribute(line, attr) {
    const match = new RegExp(attr + '=([^,]+)').exec(line);
    return match ? match[1].replace(/"/g, '') : null;
}

// Helper to resolve relative URLs
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch {
        return relative;
    }
}

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
          
          // Log video info if available
          if (response.streamInfo.hasVideo) {
            console.log('Video:', {
              codec: response.streamInfo.videoCodec.name,
              resolution: `${response.streamInfo.width}x${response.streamInfo.height}`,
              fps: response.streamInfo.fps,
              bitrate: response.streamInfo.videoBitrate ? 
                  `${(response.streamInfo.videoBitrate / 1000000).toFixed(2)} Mbps` : 'unknown'
            });
          }
          
          // Log audio info if available
          if (response.streamInfo.hasAudio) {
            console.log('Audio:', {
              codec: response.streamInfo.audioCodec.name,
              channels: response.streamInfo.audioCodec.channels,
              sampleRate: response.streamInfo.audioCodec.sampleRate ? 
                  `${response.streamInfo.audioCodec.sampleRate}Hz` : 'unknown'
            });
          }
          
          // Log duration and container info
          if (response.streamInfo.duration) {
            const minutes = Math.floor(response.streamInfo.duration / 60);
            const seconds = Math.floor(response.streamInfo.duration % 60);
            console.log('Duration:', `${minutes}:${seconds.toString().padStart(2, '0')}`);
          }
          console.log('Container:', response.streamInfo.container);
          
          // Process stream variants
          if (response.streamInfo.variants && response.streamInfo.variants.length > 0) {
            console.log('Available qualities:', response.streamInfo.variants.length);
            response.streamInfo.variants.forEach((variant, index) => {
              console.log(`Quality ${index + 1}:`, {
                resolution: variant.resolution || `${variant.width}x${variant.height}`,
                bitrate: variant.bandwidth ? 
                    `${(variant.bandwidth / 1000000).toFixed(2)} Mbps` : 'unknown',
                codecs: variant.codecs || 'unknown'
              });
            });
          }
          
          console.groupEnd();
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

  // Handle manifest fetching
  if (msg.type === 'fetchManifest') {
    fetchManifestContent(msg.url).then(content => {
        sendResponse({ content });
    });
    return true;
  }

  // Handle manifest relationship storage
  if (msg.type === 'storeManifestRelationship') {
    msg.variants.forEach(variant => {
        manifestRelationships.set(variant.url, {
            playlistUrl: msg.playlistUrl,
            bandwidth: variant.bandwidth,
            resolution: variant.resolution,
            codecs: variant.codecs,
            fps: variant.fps
        });
    });
    sendResponse({ success: true });
    return true;
  }

  // Handle manifest relationship lookup
  if (msg.type === 'getManifestRelationship') {
    sendResponse(manifestRelationships.get(msg.variantUrl) || null);
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

// Add video to tab's collection with enhanced metadata handling
function addVideoToTab(tabId, videoInfo) {
    if (!videosPerTab[tabId]) {
        videosPerTab[tabId] = new Map();
    }
    
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Skip if already detected
    if (videosPerTab[tabId].has(normalizedUrl)) {
        return;
    }
    
    // Add to metadata processing queue
    if (!metadataProcessingQueue.has(normalizedUrl)) {
        metadataProcessingQueue.set(normalizedUrl, {
            ...videoInfo,
            tabId,
            timestamp: Date.now()
        });
        processMetadataQueue();
    }
    
    // Add basic video info immediately
    const timestamp = Date.now();
    videosPerTab[tabId].set(normalizedUrl, {
        url: videoInfo.url,
        type: videoInfo.type,
        source: videoInfo.source || 'unknown',
        timestamp: timestamp,
        title: videoInfo.title || getFilenameFromUrl(videoInfo.url),
        poster: videoInfo.poster || null,
        contentType: videoInfo.contentType,
        headers: videoInfo.headers
    });
    
    // For HLS playlists, also add to that specific collection
    if (videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
    
    console.log(`Added ${videoInfo.type} video to tab ${tabId}:`, videoInfo.url);
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
    
    // Clear manifest relationships for this tab's URLs
    for (const [url, info] of manifestRelationships.entries()) {
        if (url.includes(tabId.toString())) {
            manifestRelationships.delete(url);
        }
    }
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

// Helper function to fetch manifest content
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.statusText}`);
        }
        return await response.text();
    } catch (error) {
        console.error('Error fetching manifest:', error);
        return null;
    }
}