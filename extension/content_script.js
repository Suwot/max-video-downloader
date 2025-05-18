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

// Initialize utility functions directly
let isValidVideo;
let isValidVideoUrl;

console.log('Content script loading...');

function isValidVideoUrl(url) {
  if (!url) return false;
  
  // Use our identifyVideoType function for consistent validation
  const videoType = identifyVideoType(url);
  return videoType !== 'ignored' && videoType !== 'unknown' && videoType !== 'error';
}

function isValidVideo(video) {
  return video && video.url && isValidVideoUrl(video.url);
}

// Start the detection pipeline immediately
initializeVideoDetection();

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
  setupNavigationHandling();   // Handle page navigation
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
    
    // Process video source through our unified pipeline
    const videoInfo = extractVideoInfo(video);
    if (videoInfo) {
      // Process the video with the central processor
      processVideo(videoInfo.url, videoInfo.url.startsWith('blob:') ? 'blob' : null, videoInfo);
    }
  }

  // Track all video elements for blob URLs and src changes
  const videoObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'attributes' && 
          mutation.attributeName === 'src' && 
          mutation.target.src) {
        // Process any src change through the unified pipeline
        const videoInfo = extractVideoInfo(mutation.target);
        if (videoInfo) {
          processVideo(videoInfo.url, videoInfo.url.startsWith('blob:') ? 'blob' : null, videoInfo);
        }
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
 * Gets source and metadata without validation or normalization
 * 
 * @param {HTMLVideoElement} videoElement - The video element to extract info from
 * @returns {Object|null} - Raw video info or null if no source
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
  return {
    url: src,
    poster: videoElement.poster || null,
    title: getVideoTitle(videoElement)
  };
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

// processBlobURL has been removed and merged into processVideo

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
  
  // Handle type identification up-front if not provided
  // This eliminates redundancy between validation and processing
  if (!videoInfo.type) {
    const detectedType = identifyVideoType(videoInfo.url);
    
    // If identifyVideoType returns an object, it has detailed info
    if (typeof detectedType === 'object') {
      // Handle embedded URLs in query parameters
      if (detectedType.url && detectedType.type) {
        videoInfo.originalUrl = videoInfo.url;
        videoInfo.url = detectedType.url;
        videoInfo.type = detectedType.type;
        videoInfo.foundFromQueryParam = detectedType.foundFromQueryParam || false;
      } 
      // Handle direct video with container info
      else if (detectedType.type === 'direct' && detectedType.container) {
        videoInfo.type = detectedType.type;
        videoInfo.originalContainer = detectedType.container;
      }
    } 
    // Handle simple string type results
    else if (detectedType !== 'unknown' && detectedType !== 'ignored') {
      videoInfo.type = detectedType;
    }
  }
  
  // Filter out ignored types immediately
  if (videoInfo.type === 'ignored' || !videoInfo.type) {
    return null;
  }
  
  // Early normalization for deduplication
  videoInfo.normalizedUrl = normalizeUrl(videoInfo.url);
  
  // Early deduplication check to avoid unnecessary processing
  if (state.detectedVideos.has(videoInfo.normalizedUrl)) {
    return null;
  }
  
  // Skip URL validation for blob URLs (they're always valid)
  if (!videoInfo.url.startsWith('blob:')) {
    // Use external validator if available, or basic validation
    const isValid = typeof isValidVideoUrl === 'function' 
      ? isValidVideoUrl(videoInfo.url) 
      : isVideoContent(videoInfo.url);
      
    if (!isValid) return null;
  }
  
  return videoInfo;
}

/**
 * Extract embedded video URL from query parameters
 * Used by both identifyVideoType and normalizeUrl
 * 
 * @param {URL} urlObj - URL object to extract from
 * @returns {string|null} - Extracted video URL or null
 */
function extractEmbeddedVideoUrl(urlObj) {
  for (const [_, value] of urlObj.searchParams.entries()) {
    try {
      const decoded = decodeURIComponent(value);
      if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
          (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
        // Handle relative URLs
        return decoded.startsWith('/') ? (urlObj.origin + decoded) : decoded;
      }
    } catch {}
  }
  return null;
}

/**
 * Identify the type of video from a URL
 * Optimized to parse URL only once and make efficient decisions
 * 
 * @param {string} url - URL to identify type from
 * @returns {string|Object} - Video type or object with detailed information
 */
function identifyVideoType(url) {
  if (url.startsWith('blob:')) return 'blob';
  
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    
    // Quick filtering of known non-video URLs
    if (/\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(path)) {
      // Check for embedded videos in image URLs
      const embedded = extractEmbeddedVideoUrl(urlObj);
      
      if (embedded) {
        return {
          url: embedded,
          type: /\.m3u8/i.test(embedded) ? 'hls' : 'dash',
          foundFromQueryParam: true
        };
      }
      return 'ignored';
    }
    
    // Check for tracking/analytics URLs
    if (/\/(ping|track|pixel|stats|metric|telemetry|analytics|tracking)/i.test(path) || 
        url.includes('jwpltx')) {
      // Check for embedded videos in tracking URLs
      const embedded = extractEmbeddedVideoUrl(urlObj);
      
      if (embedded) {
        return {
          url: embedded,
          type: /\.m3u8/i.test(embedded) ? 'hls' : 'dash',
          foundFromQueryParam: true
        };
      }
      return 'ignored';
    }
    
    // Check for direct formats by extension
    if (/\.m3u8(\?|$)/i.test(path)) return 'hls';
    if (/\.mpd(\?|$)/i.test(path)) return 'dash';
    
    // Check for direct video files
    const directMatch = path.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
    if (directMatch) {
      return {
        type: 'direct',
        container: directMatch[1].toLowerCase()
      };
    }
    
    // Check for streaming paths
    if (/\/hls\/.*\/(index|master|playlist)/i.test(path) || path.includes('/master.m3u8')) {
      return 'hls';
    }
    
    if (/\/dash\/.*\/(manifest|playlist)/i.test(path)) {
      return 'dash';
    }
    
    // Check for embedded videos in any query parameter
    const embedded = extractEmbeddedVideoUrl(urlObj);
    
    if (embedded) {
      return {
        url: embedded,
        type: /\.m3u8/i.test(embedded) ? 'hls' : 'dash',
        foundFromQueryParam: true
      };
    }
    
  } catch (e) {
    // Silent fail, just return unknown
  }
  
  return 'unknown';
}

/**
 * Check if a URL or content type indicates video content
 * Leverages identifyVideoType for consistent detection
 * 
 * @param {string} url - URL to check
 * @param {string} contentType - Content-Type HTTP header value (if available)
 * @returns {boolean} - Whether the content appears to be video
 */
function isVideoContent(url, contentType) {
  // First use our comprehensive identifyVideoType function
  const videoType = identifyVideoType(url);
  
  // If identifyVideoType returned a valid type directly, use that result
  if (videoType !== 'unknown' && videoType !== 'ignored') {
    return true;
  }
  
  // If it's an object with type info, use that
  if (typeof videoType === 'object' && videoType.type && videoType.type !== 'ignored') {
    return true;
  }
  
  // Fall back to content type checking if available
  if (contentType) {
    const videoMimeTypes = [
      'video/',
      'application/x-mpegURL',
      'application/dash+xml',
      'application/vnd.apple.mpegURL',
      'application/octet-stream' // Sometimes used for video content
    ];
    
    if (videoMimeTypes.some(type => contentType.includes(type))) {
      return true;
    }
  }
  
  return false;
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
      const embedded = extractEmbeddedVideoUrl(urlObj);
      if (embedded) {
        // Recursive call to normalize the extracted URL
        return normalizeUrl(embedded);
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
 * @param {string} type - Video type or null for auto-detection
 * @param {Object} metadata - Additional information about the video
 * @returns {boolean} - Whether the video was processed and sent
 */
function processVideo(url, type = null, metadata = {}) {
  // Quick validation
  if (!url) return false;

  // Always set timestamp here for consistency
  const timestamp = Date.now();
  
  // Create a normalized video info object
  const videoInfo = {
    url,
    type,
    timestampDetected: timestamp,
    ...metadata
  };
  
  // For blob URLs, track them to prevent duplication
  if (url.startsWith('blob:') && !state.blobUrls.has(url)) {
    state.blobUrls.set(url, {
      url,
      type: 'blob',
      timestampDetected: timestamp,
      poster: metadata.poster || null,
      title: metadata.title || null
    });
  }
  
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
 * Set up navigation handling to clear state on page navigation
 * Handles SPA navigation using History API and regular page navigation
 */
function setupNavigationHandling() {
  // Listen for regular page navigations via beforeunload
  window.addEventListener('beforeunload', () => {
    // Clear state when navigating away from the page
    state.detectedVideos.clear();
    state.blobUrls.clear();
    // No need to clear the WeakSet as it will be garbage collected
  });

  // Handle SPA (Single Page Application) navigation via History API
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  // Override pushState
  history.pushState = function(...args) {
    // Call original function first
    const result = originalPushState.apply(this, args);
    
    // Then clear our state for the new page
    state.detectedVideos.clear();
    state.blobUrls.clear();
    
    // Notify via custom event so we can handle it elsewhere if needed
    window.dispatchEvent(new CustomEvent('video-downloader-navigation'));
    
    return result;
  };
  
  // Override replaceState
  history.replaceState = function(...args) {
    // Call original function first
    const result = originalReplaceState.apply(this, args);
    
    // Then clear our state for the new page
    state.detectedVideos.clear();
    state.blobUrls.clear();
    
    // Notify via custom event so we can handle it elsewhere if needed
    window.dispatchEvent(new CustomEvent('video-downloader-navigation'));
    
    return result;
  };
  
  // Also listen for popstate events (browser back/forward)
  window.addEventListener('popstate', () => {
    state.detectedVideos.clear();
    state.blobUrls.clear();
    
    window.dispatchEvent(new CustomEvent('video-downloader-navigation'));
  });
}