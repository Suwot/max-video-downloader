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
  detectedVideos: new Set(),  // Track normalized URLs that have been processed
  blobUrls: new Map(),        // Track blob URLs that have been processed
  autoDetectionEnabled: true, // Whether automatic detection is enabled
  isInitialized: false,       // Whether the content script has been initialized
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

/**
 * Initialize the video detection pipeline
 * This sets up all detection methods and observers in a single function
 */
function initializeVideoDetection() {
  if (state.isInitialized) return;
  state.isInitialized = true;
  
  console.log('Initializing optimized video detection pipeline...');
  
  // Set up all detection methods - now with a unified processing flow:
  // 1. Detect video through XHR/Fetch interception or DOM observation
  // 2. Validate, normalize, and deduplicate using validateVideo
  // 3. Process and report unique videos through processVideo
  setupNetworkInterception();  // Network request monitoring
  setupDOMObservers();         // DOM video element detection
  setupMessageListeners();     // Background script communication
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
          // Process video through our optimized validation, normalization and deduplication pipeline
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

// DOM observation for videos
function setupDOMObservers() {
  /**
   * Process a new video element while avoiding duplicate processing
   * Track with WeakSet to ensure each element is only processed once
   * 
   * @param {HTMLVideoElement} video - The video element to process
   */
  function processNewVideoElement(video) {
    // Skip if this element was already processed
    if (state.observedVideoElements.has(video)) return;
    
    // Mark as processed using WeakSet (memory-efficient tracking)
    state.observedVideoElements.add(video);
    
    // Set up observer for future attribute changes
    videoObserver.observe(video, { attributes: true });
    
    // Special handling for blob URLs
    if (video.src?.startsWith('blob:')) {
      processBlobURL(video);
    }
    
    // Process regular video sources through our unified pipeline
    const videoInfo = extractVideoInfo(video);
    if (videoInfo) {
      // The extractVideoInfo function already calls validateVideo
      // so the video is already normalized and validated
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

// Set up message listeners for communication with background script
function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Content script received message:', message.action);
    
    switch (message.action) {
      case 'startBackgroundDetection':
        // Enable automatic video detection
        state.autoDetectionEnabled = true;
        sendResponse({ status: 'ok' });
        return true;
        
      case 'stopBackgroundDetection':
        // Disable automatic video detection
        state.autoDetectionEnabled = false;
        sendResponse({ status: 'ok' });
        return true;
      
      default:
        sendResponse({ error: 'Unknown message type' });
        return true;
    }
  });
}

/**
 * Extract video information from a video element
 * Gets source, metadata, and validates in a single function
 * 
 * @param {HTMLVideoElement} videoElement - The video element to extract info from
 * @returns {Object|null} - Validated video info or null if invalid
 */
function extractVideoInfo(videoElement) {
  // Get source from either src attribute or first source child
  let src = videoElement.src;
  if (!src) {
    const source = videoElement.querySelector('source');
    src = source?.src;
  }
  
  // Skip if no valid source found
  if (!src) return null;
  
  // Gather metadata from the video element
  const videoInfo = {
    url: src,
    poster: videoElement.poster || null,
    title: getVideoTitle(videoElement),
    timestampDetected: Date.now()
  };
  
  // Run through our unified validation pipeline
  // This handles normalization, deduplication, and type identification
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

/**
 * Process blob URL from video element
 * Special handling for blob URLs since they're ephemeral and need to be tracked separately
 * 
 * @param {HTMLVideoElement} videoElement - The video element with a blob URL
 * @returns {boolean} - Whether the blob URL was processed
 */
function processBlobURL(videoElement) {
  const blobUrl = videoElement.src;
  
  // Skip invalid blobs or already processed ones
  if (!blobUrl || !blobUrl.startsWith('blob:') || state.blobUrls.has(blobUrl)) {
    return false;
  }
  
  // Extract metadata from the video element
  const videoData = {
    url: blobUrl,
    type: 'blob',
    timestampDetected: Date.now(),
    poster: videoElement.poster || null,
    title: getVideoTitle(videoElement)
  };
  
  // Validate using the enhanced validation flow
  const validatedVideo = validateVideo(videoData);
  
  if (!validatedVideo) {
    return false;
  }
  
  // Store blob URL data for reference and to avoid duplicates
  state.blobUrls.set(blobUrl, {
    url: blobUrl,
    type: 'blob',
    timestampDetected: validatedVideo.timestampDetected,
    poster: validatedVideo.poster || null,
    title: validatedVideo.title
  });
  
  // Use central processing function to handle the video
  return processVideo(validatedVideo.url, validatedVideo.type, validatedVideo);
}

/**
 * Enhanced video validation function that handles normalization,
 * deduplication, type identification, and filtering in one place
 * 
 * @param {Object} videoInfo - The video information object
 * @returns {Object|null} - Validated video info or null if invalid/duplicate
 */
function validateVideo(videoInfo) {
  // Validate basic input
  if (!videoInfo?.url) return null;
  
  // Early normalization to handle embedded URLs in query params
  const normalizedUrl = normalizeUrl(videoInfo.url);
  
  // Early deduplication check to avoid unnecessary processing
  if (state.detectedVideos.has(normalizedUrl)) {
    return null;
  }
  
  // Identify the video type once
  const videoType = identifyVideoType(videoInfo.url);
  
  // Filter out ignored types immediately
  if (videoType === 'ignored' || (typeof videoType === 'object' && videoType.type === 'ignored')) {
    return null;
  }
  
  // Basic URL validation
  if (typeof videoType !== 'object' && videoType !== 'ignored' && 
      !videoInfo.url.startsWith('blob:') && !isValidVideoUrl(videoInfo.url)) {
    return null;
  }
  
  // Set normalized URL for tracking and deduplication
  videoInfo.normalizedUrl = normalizedUrl;
  
  // Process extracted URLs from query parameters
  if (typeof videoType === 'object') {
    if (videoType.url && videoType.type) {
      // Store original URL before updating
      videoInfo.originalUrl = videoInfo.url;
      videoInfo.url = videoType.url;
      
      // Re-normalize the extracted URL and check again for duplicates
      videoInfo.normalizedUrl = normalizeUrl(videoType.url);
      if (state.detectedVideos.has(videoInfo.normalizedUrl)) {
        return null;
      }
      
      videoInfo.type = videoType.type;
      videoInfo.foundFromQueryParam = videoType.foundFromQueryParam || false;
    } else if (videoType.type === 'direct' && videoType.container) {
      videoInfo.type = videoType.type;
      videoInfo.originalContainer = videoType.container;
    }
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

/**
 * Check if a URL or content type indicates video content
 * Determines whether a URL should be processed as potential video
 * 
 * @param {string} url - URL to check
 * @param {string} contentType - Content-Type HTTP header value (if available)
 * @returns {boolean} - Whether the content appears to be video
 */
function isVideoContent(url, contentType) {
  try {
    // Quick check for tracking pixels and analytics
    const urlObj = new URL(url);
    if (url.includes('ping.gif') || url.includes('jwpltx.com') || 
        urlObj.pathname.includes('/pixel') || urlObj.pathname.includes('/track')) {
      
      // Check for embedded videos in tracking pixel parameters
      for (const [_, value] of urlObj.searchParams.entries()) {
        try {
          const decoded = decodeURIComponent(value);
          // Look for streaming URLs in parameters
          if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
              (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
            return true;
          }
        } catch {}
      }
      
      return false;
    }
  } catch {}
  
  // Check URL patterns for common video extensions and paths
  const videoPatterns = [
    /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i,
    /\.(m3u8|m3u)(\?|$)/i,
    /\.(mpd)(\?|$)/i,
    /\/(playlist|manifest|master)\.json(\?|$)/i,
    /\/hls\/.*\/(index|master|playlist)/i,
    /\/dash\/.*\/manifest/i
  ];
  
  if (videoPatterns.some(pattern => pattern.test(url))) {
    return true;
  }
  
  // Check content type for video MIME types
  const videoMimeTypes = [
    'video/',
    'application/x-mpegURL',
    'application/dash+xml',
    'application/vnd.apple.mpegURL',
    'application/octet-stream' // Sometimes used for video content
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

/**
 * Normalize URL to avoid duplicates
 * Creates a canonical form of URLs for effective deduplication
 * 
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
  // Blob URLs are unique by nature and can't be normalized
  if (url.startsWith('blob:')) return url;
  
  try {
    const urlObj = new URL(url);
    
    // Handle tracking pixels with embedded video URLs
    if (url.includes('ping.gif') || url.includes('jwpltx.com') || 
        urlObj.pathname.includes('/pixel') || urlObj.pathname.includes('/track')) {
      // Extract video URLs from query parameters
      for (const [_, value] of urlObj.searchParams.entries()) {
        try {
          const decoded = decodeURIComponent(value);
          if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
              (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
            try {
              // For relative URLs, add origin
              const fullUrl = decoded.startsWith('/') ? (urlObj.origin + decoded) : decoded;
              // Recursive call to normalize the extracted URL
              return normalizeUrl(fullUrl);
            } catch {}
          }
        } catch {}
      }
    }
    
    // Remove all common tracking parameters
    const trackingParams = [
      '_t', '_r', 'cache', '_', 'time', 'timestamp', 'random', 'nonce', 
      'ref', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 
      'unique', 'cb', 'nocache', 't'
    ];
    
    trackingParams.forEach(param => {
      urlObj.searchParams.delete(param);
    });
    
    // Special handling for streaming formats
    if (url.includes('.m3u8') || url.includes('.mpd') || 
        url.includes('/hls/') || url.includes('/dash/')) {
      // Remove streaming-specific parameters
      const streamingParams = [
        'seq', 'segment', 'cmsid', 'v', 'session', 'bitrate', 'quality',
        'ts', 'starttime', 'endtime', 'start', 'end', 'init'
      ];
      
      streamingParams.forEach(param => {
        urlObj.searchParams.delete(param);
      });
      
      // Create canonical forms for manifest URLs
      const pathname = urlObj.pathname.toLowerCase();
      if (pathname.includes('/manifest') || pathname.includes('/playlist') || 
          pathname.includes('/master.m3u8') || pathname.includes('/index.m3u8')) {
        return urlObj.origin + urlObj.pathname;
      }
    }
    
    return urlObj.toString();
  } catch {
    // If URL parsing fails, return original
    return url;
  }
}

/**
 * Universal function to process and send video URLs to background
 * This is the central processor for all video detection methods
 * 
 * @param {string} url - The video URL
 * @param {string} type - Video type (hls, dash, blob, etc)
 * @param {Object} metadata - Additional information about the video
 * @returns {boolean} - Whether the video was processed and sent
 */
function processVideo(url, type, metadata = {}) {
  // Quick validation
  if (!url) return false;
  
  // Create a normalized video info object
  const videoInfo = {
    url,
    type,
    ...metadata,
    timestampDetected: metadata.timestampDetected || Date.now()
  };
  
  // Validate, enrich, filter, normalize, and deduplicate in one step
  const validatedVideo = validateVideo(videoInfo);
  
  // Skip if validation failed or video is a duplicate
  if (!validatedVideo) {
    return false;
  }
  
  // Mark this normalized URL as processed to avoid duplicates
  state.detectedVideos.add(validatedVideo.normalizedUrl);
  
  // Send to background with only the necessary fields
  chrome.runtime.sendMessage({
    action: 'addVideo',
    url: validatedVideo.url,
    source: 'content_script',
    type: validatedVideo.type,
    foundFromQueryParam: validatedVideo.foundFromQueryParam || false,
    originalContainer: validatedVideo.originalContainer,
    originalUrl: validatedVideo.originalUrl,
    timestampDetected: validatedVideo.timestampDetected,
    // Include additional metadata but filter out redundant fields
    ...Object.fromEntries(
      Object.entries(validatedVideo)
        .filter(([key]) => ![
          'normalizedUrl', 'url', 'type', 'foundFromQueryParam',
          'originalContainer', 'originalUrl', 'timestampDetected'
        ].includes(key))
    )
  });
  
  return true;
}

/**
 * Send video to background script - Simply calls through to processVideo
 * Maintained for backward compatibility with existing code
 * 
 * @param {string} url - The video URL
 * @param {string} type - Video type
 * @param {Object} additionalInfo - Additional metadata
 * @returns {boolean} - Whether the video was processed
 */
function sendToBackground(url, type, additionalInfo = {}) {
  // Simply use our centralized video processing function
  return processVideo(url, type, additionalInfo);
}

/**
 * Process multiple videos at once
 * Uses the unified validation and processing pipeline
 * 
 * @param {Array} videos - Array of video objects to process
 * @returns {boolean} - Whether any videos were processed
 */
function notifyBackground(videos) {
  if (!videos || !Array.isArray(videos)) return false;
  
  // Apply centralized validation to filter videos
  const validVideos = Array.isArray(validateAndFilterVideos) 
    ? validateAndFilterVideos(videos) 
    : videos.filter(v => v && v.url);
  
  // Process each valid video through our unified pipeline
  let processedCount = 0;
  validVideos.forEach(video => {
    // Extract metadata and pass to processVideo
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