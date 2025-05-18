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
  observedVideoElements: new WeakSet() // Track already observed video elements
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
          // Process video directly without queueing
          processVideo(responseUrl, null, {
            contentType,
            responseHeaders: parseHeaders(xhr.getAllResponseHeaders()),
            source: 'xhr'
          });
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
      
      // Headers.get() returns a string directly, not a promise
      const contentType = clonedResponse.headers.get('Content-Type');
      
      if (isVideoContent(url, contentType)) {
        // Process video directly without queueing
        processVideo(url, null, {
          contentType,
          responseHeaders: Object.fromEntries(clonedResponse.headers.entries()),
          source: 'fetch'
        });
      }
      
      return response;
    });
  };
}

// This function has been replaced by direct processing

// DOM observation for videos
function setupDOMObservers() {
  // Process a new video element - avoids duplicate processing
  function processNewVideoElement(video) {
    // Skip if already processed
    if (state.observedVideoElements.has(video)) return;
    state.observedVideoElements.add(video);
    
    // Observe for attribute changes
    videoObserver.observe(video, { attributes: true });
    
    // Process initial state
    if (video.src?.startsWith('blob:')) {
      processBlobURL(video);
    }
    
    // Process regular video sources
    const videoInfo = extractVideoInfo(video);
    if (videoInfo) {
      processVideo(videoInfo.url, videoInfo.type, {
        poster: videoInfo.poster,
        title: videoInfo.title,
        timestampDetected: videoInfo.timestampDetected
      });
    }
  }

  // Track all video elements for blob URLs and src changes
  const videoObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'attributes' && 
          mutation.attributeName === 'src' && 
          mutation.target.src?.startsWith('blob:')) {
        processBlobURL(mutation.target);
      }
    });
  });
  
  // Start observing all video elements for attribute changes
  document.querySelectorAll('video').forEach(processNewVideoElement);
  
  // Monitor for new DOM additions and changes
  const documentObserver = new MutationObserver(mutations => {
    if (!state.autoDetectionEnabled) return;
    
    const potentialVideos = new Set();
    
    // Process added nodes
    mutations.forEach(mutation => {
      // Check for newly added video elements
      mutation.addedNodes.forEach(node => {
        if (node.nodeName === 'VIDEO') {
          potentialVideos.add(node);
        } else if (node.querySelectorAll) {
          // Check for videos inside other elements
          node.querySelectorAll('video').forEach(video => {
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
        potentialVideos.forEach(processNewVideoElement);
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
        // Return an appropriate response for backward compatibility
        // The video-fetcher.js expects an array, so we'll send an empty one
        // Videos are already being sent to background directly
        sendResponse([]);
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
        // Just acknowledge that content script is active
        sendResponse({ status: 'ready' });
        return true;
        
      case 'popupClosed':
        // This handler has no real effect but is kept for API compatibility
        sendResponse({ status: 'ok' });
        return true;
        
      default:
        sendResponse({ error: 'Unknown message type' });
        return true;
    }
  });
}

// Video detection is now handled entirely through DOM observation and network interception

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
    timestampDetected: Date.now()
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

/**
 * Universal function to process and send video URLs to background
 * Handles validation, normalization, deduplication, and sending in one place
 * 
 * @param {string} url - The video URL
 * @param {string} type - Video type (hls, dash, blob, etc)
 * @param {Object} metadata - Additional information about the video
 * @returns {boolean} - Whether the video was new and sent
 */
function processVideo(url, type, metadata = {}) {
  // Skip invalid URLs
  if (!url) return false;
  
  // Get video type if not provided
  const videoType = type || identifyVideoType(url);
  
  // Skip ignored types
  if (videoType === 'ignored' || (typeof videoType === 'object' && videoType.type === 'ignored')) {
    return false;
  }

  let finalUrl = url;
  let finalType = typeof videoType === 'string' ? videoType : type;
  let foundFromQueryParam = metadata.foundFromQueryParam || false;
  let originalContainer = metadata.originalContainer;
  
  // Handle URL extraction from query params or type objects
  if (typeof videoType === 'object') {
    if (videoType.url && videoType.type) {
      finalUrl = videoType.url;
      finalType = videoType.type;
      foundFromQueryParam = videoType.foundFromQueryParam || false;
    } else if (videoType.type === 'direct' && videoType.container) {
      finalType = videoType.type;
      originalContainer = videoType.container;
    }
  }
  
  // Skip invalid URLs (unless it's a blob which is always valid)
  if (!finalUrl.startsWith('blob:') && 
      typeof videoType !== 'object' && 
      videoType !== 'ignored' && 
      !isValidVideoUrl(finalUrl)) {
    return false;
  }
  
  // Normalize the URL for deduplication
  const normalizedUrl = normalizeUrl(finalUrl);
  
  // Skip if already detected
  if (state.detectedVideos.has(normalizedUrl)) {
    return false;
  }
  
  // Add to detected videos
  state.detectedVideos.add(normalizedUrl);
  
  // Send to background
  chrome.runtime.sendMessage({
    action: 'addVideo',
    url: finalUrl,
    source: 'content_script',
    type: finalType,
    foundFromQueryParam,
    originalContainer,
    originalUrl: finalUrl !== url ? url : undefined,
    timestampDetected: Date.now(),
    ...metadata
  });
  
  return true;
}

// Send video to background script
function sendToBackground(url, type, additionalInfo = {}) {
  // Use the universal processing function instead
  return processVideo(url, type, additionalInfo);
}

// Send multiple videos to background script
function notifyBackground(videos) {
  if (!videos || !Array.isArray(videos)) return false;
  
  // Filter and validate videos
  const validVideos = Array.isArray(validateAndFilterVideos) 
    ? validateAndFilterVideos(videos) 
    : videos.filter(v => v && v.url);
  
  // Process each video individually
  let processedCount = 0;
  validVideos.forEach(video => {
    if (processVideo(video.url, video.type, {
      poster: video.poster,
      title: video.title,
      timestampDetected: video.timestampDetected
    })) {
      processedCount++;
    }
  });
  
  return processedCount > 0;
}