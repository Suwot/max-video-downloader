/**
 * @ai-guide-component ContentScript
 * @ai-guide-description In-page video detector
 * @ai-guide-responsibilities
 * - Scans DOM for video elements and sources
 * - Monitors network requests for video streams
 * - Detects HLS and DASH manifests in page resources
 * - Extracts metadata from video elements
 * - Intercepts media player initialization
 * - Reports detected videos to background service
 * - Maintains real-time monitoring of video content
 * - Extracts legitimate video URLs from query parameters
 * - Filters out tracking pixels while preserving embedded media URLs
 * - Normalizes URLs for efficient duplicate detection
 * - Propagates metadata about URL extraction origins
 */

// State management for the content script
const state = {
  detectedVideos: new Set(),
  blobUrls: new Map(),
  autoDetectionEnabled: true,
  isInitialized: false,
  pendingQueue: new Map()
};

// Initialize utility functions that will be loaded dynamically
let validateAndFilterVideos;
let isValidVideo;
let isValidVideoUrl;

console.log('Content script loading...');

// Load modules and initialize
(async function() {
  try {
    const validatorUrl = chrome.runtime.getURL('js/utilities/video-validator.js');
    console.log('Loading validator from:', validatorUrl);
    
    // Add a small delay before import to ensure extension is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const module = await import(validatorUrl);
    console.log('Module import successful:', module);
    
    // Attach utilities to global scope for access
    validateAndFilterVideos = module.validateAndFilterVideos;
    isValidVideo = module.isValidVideo;
    isValidVideoUrl = module.isValidVideoUrl;
    console.log('Video validator loaded successfully');
  } catch (error) {
    console.error('Using fallback validation:', error);
    
    // Implement basic fallbacks
    isValidVideoUrl = url => {
      try {
        if (url.startsWith('blob:')) return true;
        const urlObj = new URL(url);
        
        // Skip tracking images and known bad extensions
        if (/\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(urlObj.pathname)) return false;
        
        const ignoredPatterns = [
          /\.gif$/i, /\/ping/i, /\/track/i, /\/pixel/i, 
          /\/stats/i, /\/metric/i, /\/telemetry/i, 
          /\/analytics/i, /jwpltx/, /\/tracking/
        ];
        
        return !ignoredPatterns.some(p => p.test(urlObj.pathname) || p.test(urlObj.hostname));
      } catch (e) {
        console.error('Error validating URL:', e);
        return false;
      }
    };
    
    isValidVideo = video => video && video.url;
    validateAndFilterVideos = videos => videos.filter(v => v && v.url);
  }
  
  // Initialize once modules are loaded
  initializeVideoDetection();
})();

// Core video detection logic
function initializeVideoDetection() {
  if (state.isInitialized) return;
  state.isInitialized = true;
  
  console.log('Initializing video detection...');
  
  // Set up all detection methods
  setupNetworkInterception();
  setupDOMObservers();
  setupMessageListeners();
  
  // Initial scan
  setTimeout(scanForVideos, 500);
}

// Network request monitoring
function setupNetworkInterception() {
  // XHR interception
  const originalXHR = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const xhr = this;
    const originalOnReadyStateChange = xhr.onreadystatechange;
    
    xhr.addEventListener('readystatechange', function() {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const contentType = xhr.getResponseHeader('Content-Type');
        const responseUrl = xhr.responseURL;
        
        if (isVideoContent(responseUrl, contentType)) {
          state.pendingQueue.set(responseUrl, {
            type: 'xhr',
            contentType,
            responseHeaders: parseHeaders(xhr.getAllResponseHeaders())
          });
          processPendingQueue();
        }
      }
      
      if (originalOnReadyStateChange) {
        originalOnReadyStateChange.apply(this, arguments);
      }
    });
    
    return originalXHR.apply(this, [method, url, ...args]);
  };
  
  // Fetch interception
  const originalFetch = window.fetch;
  window.fetch = function(resource, init) {
    const url = resource instanceof Request ? resource.url : resource;
    
    return originalFetch.apply(this, arguments).then(response => {
      const clonedResponse = response.clone();
      
      clonedResponse.headers.get('Content-Type').then(contentType => {
        if (isVideoContent(url, contentType)) {
          state.pendingQueue.set(url, {
            type: 'fetch',
            contentType,
            responseHeaders: Object.fromEntries(clonedResponse.headers.entries())
          });
          processPendingQueue();
        }
      }).catch(() => {});
      
      return response;
    });
  };
}

// Process pending video queue in batches
function processPendingQueue(batchSize = 3) {
  if (state.pendingQueue.size === 0) return;
  
  const entries = Array.from(state.pendingQueue.entries()).slice(0, batchSize);
  const processPromises = entries.map(([url, info]) => {
    return new Promise(async (resolve) => {
      state.pendingQueue.delete(url);

      const videoType = identifyVideoType(url);
      
      // Skip ignored types
      if (videoType === 'ignored' || (typeof videoType === 'object' && videoType.type === 'ignored')) {
        return resolve();
      }

      let finalUrl = url;
      let finalType = info.type;
      let foundFromQueryParam = false;

      // Handle extracted URLs from query parameters
      if (typeof videoType === 'object' && videoType.url && videoType.type) {
        finalUrl = videoType.url;
        finalType = videoType.type;
        foundFromQueryParam = videoType.foundFromQueryParam || false;
      } else if (videoType !== 'ignored' && videoType !== 'unknown') {
        finalType = videoType;
      }

      // Send to background
      await sendToBackground(finalUrl, finalType, {
        contentType: info.contentType,
        headers: info.responseHeaders,
        foundFromQueryParam
      });
      resolve();
    });
  });

  // Process next batch after this one completes
  Promise.all(processPromises).then(() => {
    if (state.pendingQueue.size > 0) {
      setTimeout(() => processPendingQueue(batchSize), 100);
    }
  });
}

// DOM observation for videos
function setupDOMObservers() {
  // Track all video elements for blob URLs and src changes
  const videoObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'attributes' && 
          mutation.attributeName === 'src' && 
          mutation.target.src?.startsWith('blob:')) {
        processBlobURL(mutation.target);
      }
    });
    
    // Also check for new video elements with blob sources
    document.querySelectorAll('video').forEach(video => {
      if (video.src?.startsWith('blob:')) {
        processBlobURL(video);
      }
    });
  });
  
  // Start observing all video elements for attribute changes
  document.querySelectorAll('video').forEach(video => {
    videoObserver.observe(video, { attributes: true });
    if (video.src?.startsWith('blob:')) {
      processBlobURL(video);
    }
  });
  
  // Monitor for new DOM additions and changes
  const documentObserver = new MutationObserver(mutations => {
    if (!state.autoDetectionEnabled) return;
    
    const potentialVideos = new Set();
    
    // Process added nodes
    mutations.forEach(mutation => {
      // Check for newly added video elements
      mutation.addedNodes.forEach(node => {
        if (node.nodeName === 'VIDEO') {
          videoObserver.observe(node, { attributes: true });
          potentialVideos.add(node);
        } else if (node.querySelectorAll) {
          // Check for videos inside other elements
          node.querySelectorAll('video').forEach(video => {
            videoObserver.observe(video, { attributes: true });
            potentialVideos.add(video);
          });
        }
      });
      
      // Check for attribute changes on video elements
      if (mutation.type === 'attributes' && 
          mutation.target.nodeName === 'VIDEO' && 
          (mutation.attributeName === 'src' || mutation.attributeName === 'data-src')) {
        potentialVideos.add(mutation.target);
      }
    });
    
    // Process potential videos after a small delay
    if (potentialVideos.size > 0) {
      setTimeout(() => {
        const newVideos = [];
        
        potentialVideos.forEach(video => {
          // Check for regular src attribute
          if (video.src || video.querySelector('source')) {
            const videoInfo = extractVideoInfo(video);
            if (videoInfo && !state.detectedVideos.has(normalizeUrl(videoInfo.url))) {
              newVideos.push(videoInfo);
              state.detectedVideos.add(normalizeUrl(videoInfo.url));
            }
          }
          
          // Check for blob URLs
          if (video.src?.startsWith('blob:')) {
            processBlobURL(video);
          }
        });
        
        // Send new videos to background script
        if (newVideos.length > 0) {
          notifyBackground(newVideos);
        }
      }, 500);
    }
  });
  
  // Start observing document
  if (document.body) {
    documentObserver.observe(document, { 
      childList: true, 
      subtree: true, 
      attributes: true,
      attributeFilter: ['src', 'data-src'] 
    });
  } else {
    // If body isn't available yet, wait for it
    const bodyWatcher = new MutationObserver(() => {
      if (document.body) {
        documentObserver.observe(document, { 
          childList: true, 
          subtree: true, 
          attributes: true,
          attributeFilter: ['src', 'data-src'] 
        });
        bodyWatcher.disconnect();
      }
    });
    
    bodyWatcher.observe(document.documentElement, { childList: true });
  }
}

// Message communication
function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Content script received message:', message.action);
    
    switch (message.action) {
      case 'findVideos':
        const videos = scanForVideos();
        console.log('Found videos:', videos);
        sendResponse(videos);
        return true;
        
      case 'startBackgroundDetection':
        state.autoDetectionEnabled = true;
        sendResponse({ status: 'ok' });
        return true;
        
      case 'stopBackgroundDetection':
        state.autoDetectionEnabled = false;
        sendResponse({ status: 'ok' });
        return true;
        
      case 'popupOpened':
        // Run an immediate video check when popup opens
        const foundVideos = scanForVideos();
        if (foundVideos && foundVideos.length > 0) {
          notifyBackground(foundVideos);
        }
        sendResponse({ status: 'ready' });
        return true;
        
      case 'popupClosed':
        sendResponse({ status: 'ok' });
        return true;
        
      default:
        sendResponse({ error: 'Unknown message type' });
        return true;
    }
  });
}

// Active video search functions
function scanForVideos() {
  const videos = [];
  
  // Find direct video elements and sources
  document.querySelectorAll('video').forEach(video => {
    // Check direct src attribute
    if (video.src) {
      const videoInfo = extractVideoInfo(video);
      if (videoInfo) {
        videos.push(videoInfo);
        state.detectedVideos.add(normalizeUrl(videoInfo.url));
      }
    }
    
    // Check source elements inside video
    video.querySelectorAll('source').forEach(source => {
      if (source.src) {
        const videoInfo = {
          url: source.src,
          poster: video.poster || null,
          title: getVideoTitle(video),
          timestamp: Date.now()
        };
        
        const validVideo = validateVideo(videoInfo);
        if (validVideo) {
          videos.push(validVideo);
          state.detectedVideos.add(normalizeUrl(validVideo.url));
        }
      }
    });
  });
  
  // Add tracked blob URLs
  state.blobUrls.forEach((info) => {
    videos.push({
      url: info.url,
      type: 'blob',
      poster: info.poster || null,
      title: info.title || 'Blob Video',
      timestamp: info.time || Date.now()
    });
  });
  
  return videos;
}

// Extract video information
function extractVideoInfo(videoElement) {
  // Get source from either src attribute or first source child
  let src = videoElement.src;
  if (!src) {
    const source = videoElement.querySelector('source');
    src = source?.src;
  }
  
  if (!src) return null;
  
  // Create and validate video info
  const videoInfo = {
    url: src,
    poster: videoElement.poster || null,
    title: getVideoTitle(videoElement),
    timestamp: Date.now()
  };
  
  return validateVideo(videoInfo);
}

// Get best title for video
function getVideoTitle(videoElement) {
  // Try to get title from various sources in priority order
  return videoElement.getAttribute('aria-label') || 
         videoElement.getAttribute('title') || 
         findNearbyHeading(videoElement) ||
         document.title || 
         'Video';
}

// Find nearby heading for video title
function findNearbyHeading(element) {
  let parent = element.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const heading = parent.querySelector('h1, h2, h3');
    if (heading?.textContent.trim()) {
      return heading.textContent.trim();
    }
    parent = parent.parentElement;
  }
  return null;
}

// Process blob URL from video element
function processBlobURL(videoElement) {
  const blobUrl = videoElement.src;
  if (!blobUrl || !blobUrl.startsWith('blob:') || state.blobUrls.has(blobUrl)) {
    return false;
  }
  
  // Store basic info about the blob
  const info = {
    url: blobUrl,
    type: 'blob',
    time: Date.now(),
    poster: videoElement.poster || null,
    title: getVideoTitle(videoElement)
  };
  
  state.blobUrls.set(blobUrl, info);
  sendToBackground(blobUrl, 'blob', info);
  return true;
}

// Utility functions
function validateVideo(videoInfo) {
  if (!videoInfo?.url) return null;
  
  const videoType = identifyVideoType(videoInfo.url);
  
  // If type is ignored, skip this video
  if (videoType === 'ignored' || (typeof videoType === 'object' && videoType.type === 'ignored')) {
    return null;
  }
  
  // Skip invalid URLs using the centralized validation function
  if (typeof videoType !== 'object' && videoType !== 'ignored' && !isValidVideoUrl(videoInfo.url)) {
    return null;
  }
  
  // If type is an object with URL and type, update videoInfo with extracted URL
  if (typeof videoType === 'object' && videoType.url && videoType.type) {
    videoInfo.originalUrl = videoInfo.url;
    videoInfo.url = videoType.url;
    videoInfo.type = videoType.type;
    videoInfo.foundFromQueryParam = videoType.foundFromQueryParam || false;
  } else if (videoType !== 'unknown') {
    videoInfo.type = videoType;
  }
  
  return videoInfo;
}

// Determine video type from URL
function identifyVideoType(url) {
  if (url.startsWith('blob:')) return 'blob';
  
  try {
    const urlObj = new URL(url);
    
    // Early rejection: skip tracking images and known bad extensions
    const badExtensions = /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i;
    if (badExtensions.test(urlObj.pathname)) {
      // Check for video URLs embedded in query parameters
      for (const [_, value] of urlObj.searchParams.entries()) {
        try {
          const decoded = decodeURIComponent(value);
          if ((decoded.match(/\.m3u8(\?|$)/) || decoded.match(/\.mpd(\?|$)/)) &&
              (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
            return {
              url: decoded,
              type: decoded.match(/\.m3u8(\?|$)/) ? 'hls' : 'dash',
              foundFromQueryParam: true
            };
          }
        } catch {}
      }
      return 'ignored';
    }
    
    // Check for tracking/analytics URLs
    const ignoredPathPatterns = [
      /\.gif$/i, /\/ping/i, /\/track/i, /\/pixel/i, 
      /\/stats/i, /\/metric/i, /\/telemetry/i, 
      /\/analytics/i, /jwpltx/, /\/tracking/
    ];
    
    if (ignoredPathPatterns.some(p => p.test(urlObj.pathname) || p.test(urlObj.hostname))) {
      return 'ignored';
    }
    
    const baseUrl = url.split('?')[0].split('#')[0];
    
    // Check for HLS
    if (baseUrl.toLowerCase().endsWith('.m3u8')) {
      return 'hls';
    }
    
    // Check for DASH
    if (baseUrl.toLowerCase().endsWith('.mpd')) {
      return 'dash';
    }
    
    // Check for direct video files
    const directVideoMatch = baseUrl.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)$/i);
    if (directVideoMatch) {
      return {
        type: 'direct',
        container: directVideoMatch[1].toLowerCase()
      };
    }
    
    // Check for HLS in paths
    if (urlObj.pathname.includes('/hls/') && 
        (urlObj.pathname.includes('/stream/') || 
         urlObj.pathname.includes('/video/') || 
         urlObj.pathname.includes('/content/') || 
         urlObj.pathname.includes('/media/'))) {
      return 'hls';
    }
    
    // Check query parameters for embedded URLs
    for (const [_, value] of urlObj.searchParams.entries()) {
      try {
        const decoded = decodeURIComponent(value);
        
        if (decoded.match(/\.m3u8(\?|$)/) && 
            (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) &&
            (decoded.includes('/') || decoded.match(/^https?:\/\//))) {
          return {
            url: decoded,
            type: 'hls',
            foundFromQueryParam: true
          };
        }
        
        if (decoded.match(/\.mpd(\?|$)/) && 
            (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) &&
            (decoded.includes('/') || decoded.match(/^https?:\/\//))) {
          return {
            url: decoded,
            type: 'dash',
            foundFromQueryParam: true
          };
        }
      } catch {}
    }
    
  } catch (e) {
    console.error('Error parsing URL:', e);
  }
  
  return 'unknown';
}

// Check if a URL or content type indicates video content
function isVideoContent(url, contentType) {
  try {
    // Quick check for tracking pixels
    const urlObj = new URL(url);
    if (url.includes('ping.gif') || url.includes('jwpltx.com') || 
        urlObj.pathname.includes('/pixel') || urlObj.pathname.includes('/track')) {
      
      // Check for embedded videos in tracking pixels
      for (const [_, value] of urlObj.searchParams.entries()) {
        try {
          const decoded = decodeURIComponent(value);
          if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
              (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
            return true;
          }
        } catch {}
      }
      
      return false;
    }
  } catch {}
  
  // Check URL patterns for video extensions
  const videoPatterns = [
    /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i,
    /\.(m3u8|m3u)(\?|$)/i,
    /\.(mpd)(\?|$)/i,
    /\/(playlist|manifest|master)\.json(\?|$)/i
  ];
  
  if (videoPatterns.some(pattern => pattern.test(url))) {
    return true;
  }
  
  // Check content type for video MIME types
  const videoMimeTypes = [
    'video/',
    'application/x-mpegURL',
    'application/dash+xml',
    'application/vnd.apple.mpegURL'
  ];
  
  if (contentType && videoMimeTypes.some(type => contentType.includes(type))) {
    return true;
  }
  
  return false;
}

// Parse headers string into object
function parseHeaders(headerStr) {
  return headerStr.trim().split(/[\r\n]+/).reduce((headers, line) => {
    const parts = line.split(': ');
    headers[parts[0]] = parts[1];
    return headers;
  }, {});
}

// Normalize URL to avoid duplicates
function normalizeUrl(url) {
  if (url.startsWith('blob:')) return url;
  
  try {
    const urlObj = new URL(url);
    
    // Handle tracking pixels with embedded URLs
    if (url.includes('ping.gif') || url.includes('jwpltx.com') || urlObj.pathname.includes('/pixel')) {
      for (const [_, value] of urlObj.searchParams.entries()) {
        try {
          const decoded = decodeURIComponent(value);
          if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
              (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
            try {
              const fullUrl = decoded.startsWith('/') ? (urlObj.origin + decoded) : decoded;
              return normalizeUrl(fullUrl);
            } catch {}
          }
        } catch {}
      }
    }
    
    // Remove common tracking parameters
    ['_t', '_r', 'cache', '_', 'time', 'timestamp', 'random'].forEach(param => {
      urlObj.searchParams.delete(param);
    });
    
    // Special handling for HLS/DASH
    if (url.includes('.m3u8') || url.includes('.mpd') || url.includes('/hls/')) {
      // Remove common HLS-specific parameters
      ['seq', 'segment', 'cmsid', 'v', 'session'].forEach(param => {
        urlObj.searchParams.delete(param);
      });
      
      // Canonical form for manifest URLs
      const pathname = urlObj.pathname.toLowerCase();
      if (pathname.includes('/manifest') || pathname.includes('/playlist') || 
          pathname.includes('/master.m3u8') || pathname.includes('/index.m3u8')) {
        return urlObj.origin + urlObj.pathname;
      }
    }
    
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Send video to background script
function sendToBackground(url, type, additionalInfo = {}) {
  // Skip ignored types
  if (type === 'ignored') return;
  
  // Normalize URL to avoid duplicates
  const normalizedUrl = normalizeUrl(url);
  
  // Skip if already detected
  if (state.detectedVideos.has(normalizedUrl)) {
    return;
  }
  
  // Add to detected videos
  state.detectedVideos.add(normalizedUrl);
  
  // Send to background
  chrome.runtime.sendMessage({
    action: 'addVideo',
    url: url,
    source: 'content_script',
    type: type,
    foundFromQueryParam: additionalInfo.foundFromQueryParam || false,
    originalContainer: additionalInfo.originalContainer,
    timestampDetected: Date.now(),
    ...additionalInfo
  });
}

// Notify background script of new videos
function notifyBackground(videos) {
  if (!videos || videos.length === 0) return;
  
  // Apply validation to all videos
  const validVideos = videos
    .map(video => validateVideo(video))
    .filter(video => video !== null && video.type !== 'ignored');
  
  if (validVideos.length === 0) return;
  
  // Send each video individually for storage
  validVideos.forEach(video => {
    sendToBackground(video.url, video.type, {
      poster: video.poster,
      title: video.title,
      foundFromQueryParam: video.foundFromQueryParam || false
    });
  });
  
  // Notify about batch update
  chrome.runtime.sendMessage({
    action: 'newVideoDetected',
    videos: validVideos.map(video => ({
      ...video,
      source: 'content_script'
    }))
  }).catch(() => {
    // Suppress expected errors when popup is closed
  });
}

// Initialize based on document state
if (document.readyState !== 'loading') {
  initializeVideoDetection();
} else {
  document.addEventListener('DOMContentLoaded', initializeVideoDetection);
}

// Fallback initialization
setTimeout(() => {
  if (!state.isInitialized) {
    console.log('Fallback initialization...');
    initializeVideoDetection();
  }
}, 500);