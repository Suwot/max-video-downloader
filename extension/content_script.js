/**
 * @ai-guide-component ContentScript
 * @ai-guide-description Optimized in-page video detector with unified detection pipeline
 * @ai-guide-responsibilities
 * - Scans DOM for video elements and sources using efficient WeakSet tracking
 * - Monitors network requests via XHR and fetch API interception
 * - Implements single-pass validation of video URLs to reduce redundant processing
 * - Detects HLS and DASH manifests with optimized URL pattern matching
 * - Extracts metadata from video elements including titles and poster images
 * - Reports deduplicated videos to background service with source attribution
 * - Normalizes URLs with parameter filtering and caching for performance
 * - Extracts embedded video URLs from query parameters with proper source tracking
 * - Handles blob URL special cases with proper lifecycle management
 * - Manages state clearing during regular and SPA navigation events
 * - Uses unified detection pipeline for consistent processing across sources
 * - Preserves original sources (dom, xhr, fetch, mutation) for analytics purposes
 * - Intelligently extracts video titles from surrounding DOM context
 * - Efficiently handles dynamic page content through mutation observers
 */

// Debug logging helper
function logDebug(...args) {
    console.log('[Content Script]', new Date().toISOString(), ...args);
}

// State management for the content script
const state = {
  detectedVideos: new Set(),  // Track normalized URLs that have been processed
  blobUrls: new Map(),        // Track blob URLs that have been processed
  isInitialized: false,       // Whether the content script has been initialized
  observedVideoElements: new WeakSet(), // Track already observed video elements
  urlNormalizationCache: new Map() // Cache for URL normalization results
};

// Start the detection pipeline immediately
initializeVideoDetection();

/**
 * Initialize the video detection pipeline
 * This sets up all detection methods and observers in a single function
 */
function initializeVideoDetection() {
  if (state.isInitialized) return;
  state.isInitialized = true;
  
  logDebug('Initializing optimized video detection pipeline...');
  
  setupNetworkInterception();  // Network request monitoring
  setupDOMObservers();         // DOM video element detection
  setupNavigationHandling();   // Handle page navigation
  
  // Run initial scan when DOM is more completely loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAllVideos);
    logDebug('Scheduled initial video scan for DOMContentLoaded');
  } else {
    // DOM is already loaded, scan immediately
    scanAllVideos();
  }
  
  // Also scan again after all resources load
  window.addEventListener('load', scanAllVideos);
  logDebug('Scheduled final video scan for window.load event');
}

/**
 * Comprehensive scan for videos that may have been missed in initial setup
 * Reuses existing functions for consistency
 */
function scanAllVideos() {
  logDebug('Running comprehensive video scan at readyState:', document.readyState);
  
  // 1. Process all video elements
  const videoElements = document.querySelectorAll('video');
  if (videoElements.length > 0) {
    logDebug(`Found ${videoElements.length} video elements during scan`);
    videoElements.forEach(video => {
      if (!state.observedVideoElements.has(video)) {
        // Mark as observed to avoid reprocessing
        state.observedVideoElements.add(video);
        
        // Set up observer for future attribute changes
        if (window.videoObserver) {
          window.videoObserver.observe(video, { attributes: true });
        }
        
        const videoInfo = extractVideoInfo(video);
        if (videoInfo) {
          detectVideo(videoInfo.url, null, {
            ...videoInfo,
            source: 'initial_scan'
          });
        }
      }
    });
  }
  
  // 2. Look for standalone source elements that may contain video URLs
  document.querySelectorAll('source').forEach(source => {
    // Skip sources inside already processed videos
    if (source.parentElement?.nodeName === 'VIDEO' && 
        state.observedVideoElements.has(source.parentElement)) {
      return;
    }
    
    const src = source.src || source.getAttribute('src');
    if (src) {
      const mimeType = source.getAttribute('type');
      detectVideo(src, mimeType || null, {
        source: 'initial_scan',
        title: source.parentElement?.nodeName === 'VIDEO' ? 
          getVideoTitle(source.parentElement) : (document.title || 'Video')
      });
    }
  });
  
  // 3. Look for common player configurations
  scanForPlayerConfigs();
}

/**
 * Scans for common video player configurations
 * Many sites use specific patterns for embedding videos
 */
function scanForPlayerConfigs() {
  // Look for specific player elements
  const playerSelectors = [
    '.jwplayer', '.video-js', '.html5-video-container',
    '[data-video-url]', '[data-video-src]', '[data-src*=".mp4"]',
    '[data-setup*="sources"]', '[data-hls-url]', '[data-dash-url]'
  ];
  
  document.querySelectorAll(playerSelectors.join(', ')).forEach(player => {
    // Try to extract video URLs from data attributes
    const dataAttrs = ['data-video-url', 'data-video-src', 'data-src', 
                      'data-setup', 'data-hls-url', 'data-dash-url'];
    
    for (const attr of dataAttrs) {
      const value = player.getAttribute(attr);
      if (!value) continue;
      
      try {
        // Check if it's a JSON string with video configuration
        if (value.includes('{') && value.includes('}')) {
          const config = JSON.parse(value);
          const sources = config.sources || config.source || config.src || config.url;
          
          if (sources) {
            const sourceArray = Array.isArray(sources) ? sources : [sources];
            sourceArray.forEach(source => {
              const url = typeof source === 'object' ? 
                          (source.src || source.file || source.url) : source;
              
              if (typeof url === 'string') {
                const type = typeof source === 'object' ? source.type : null;
                detectVideo(url, type || null, { 
                  source: 'initial_scan_player_config' 
                });
              }
            });
          }
        } else if (value.includes('http') || value.startsWith('/')) {
          // Direct URL
          detectVideo(value, null, { source: 'initial_scan_player_attr' });
        }
      } catch {
        // Simple attribute URL
        if ((value.includes('.mp4') || value.includes('.m3u8') || value.includes('.mpd')) &&
            (value.includes('http') || value.startsWith('/'))) {
          const fullUrl = value.startsWith('/') ? 
                         `${window.location.origin}${value}` : value;
          detectVideo(fullUrl, null, { source: 'initial_scan_player_attr' });
        }
      }
    }
  });
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
        
        // Use the unified detection pipeline instead of separate validation and processing
        detectVideo(responseUrl, contentType, {
          source: 'xhr'
        });
      }
      
      if (originalOnReadyStateChange) {
        originalOnReadyStateChange.apply(this, arguments);
      }
    });

    logDebug('Network interception is set up for XHR:', method, url);
    
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
      
      // Use the unified detection pipeline instead of separate validation and processing
      detectVideo(url, contentType, {
        source: 'fetch'
      });

      logDebug('Network interception is set up for Fetch:', url);
      
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
      // Use the unified detection pipeline for more efficient processing
      detectVideo(videoInfo.url, null, {
        ...videoInfo,
        source: 'dom'
      });
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
          // Use the unified detection pipeline for more efficient processing
          detectVideo(videoInfo.url, null, {
            ...videoInfo, 
            source: 'mutation'
          });
        }
      }
    });
  });
  
  // Start observing all video elements for attribute changes
  document.querySelectorAll('video').forEach(processNewVideoElement);
  
  // Monitor for new DOM additions and changes
  const documentObserver = new MutationObserver(mutations => {
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

    logDebug(`Document observer is now watching the DOM...`);

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

        logDebug(`Observing DOM with bodywatcher init...`);

        bodyWatcher.disconnect();
      }
    });
    
    bodyWatcher.observe(document.documentElement, { childList: true });
  }
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
    src = source?.src || source?.getAttribute('src');
  }
  
  // Skip if no valid source found
  if (!src) return null;

  logDebug('Extracted src:', src);
  
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

/**
 * Unified entry point for video detection that eliminates redundant processing
 * Handles type identification, validation, and content-type checking in one place
 * This function now integrates all validation previously done in validateVideo
 * 
 * @param {string} url - The URL to detect video from
 * @param {string|null} contentType - Optional content type from headers
 * @param {Object} metadata - Additional video metadata
 * @returns {boolean} - Whether a valid video was detected and processed
 */
function detectVideo(url, contentType = null, metadata = {}) {
  logDebug(`Attempting to detect video:`, url);

  if (!url) return false;
  
  // Skip if it's a blob URL we've already processed
  if (url.startsWith('blob:') && state.blobUrls.has(url)) {
    return false;
  }
  
  // One-time type identification
  const detectedType = identifyVideoType(url);
  
  // Pre-determine URL type
  let videoType = null;
  let videoUrl = url;
  let normalizedUrl = null;
  let additionalInfo = {};
  
  // Handle special cases from identifyVideoType
  if (typeof detectedType === 'object') {
    // Handle embedded URLs in query parameters
    if (detectedType.url && detectedType.type) {
      videoUrl = detectedType.url;
      videoType = detectedType.type;
      // If identifyVideoType already normalized the URL, use that
      normalizedUrl = detectedType.normalizedUrl || null;
      additionalInfo.originalUrl = url;
      additionalInfo.foundFromQueryParam = detectedType.foundFromQueryParam || false;
    } 
    // Handle direct video with container info
    else if (detectedType.type === 'direct' && detectedType.container) {
      videoType = detectedType.type;
      additionalInfo.originalContainer = detectedType.container;
    }
  } 
  // Handle simple string type results
  else if (detectedType !== 'unknown' && detectedType !== 'ignored') {
    videoType = detectedType;
  }
  
  // If type detection failed but we have content type, try that as fallback
  // Moving this logic before the early rejection to catch more valid videos
  if (!videoType && contentType) {
    const videoMimeTypes = [
      'video/',
      'application/x-mpegURL',
      'application/dash+xml',
      'application/vnd.apple.mpegURL',
      'application/octet-stream'
    ];
    
    if (videoMimeTypes.some(type => contentType.includes(type))) {
      videoType = contentType.includes('mpegURL') || contentType.includes('x-mpegURL') ? 
                  'hls' : 'direct';
    }
  }
  
  // Early rejection for ignored or unknown types
  if (!videoType || videoType === 'ignored') {
    return false;
  }
  
  // Create normalized URL for deduplication if it wasn't already done
  if (!normalizedUrl) {
    normalizedUrl = normalizeUrl(videoUrl);
  }
  
  // Skip if we've already processed this URL
  if (state.detectedVideos.has(normalizedUrl)) {
    return false;
  }
  
  // Set timestamp once here and trust it in processVideo
  const timestampDetected = Date.now();
  
  // At this point, we have a valid, new video
  // Process it with all the information we've already gathered
  return processVideo(videoUrl, videoType, {
    contentType,
    normalizedUrl,
    timestampDetected,
    ...additionalInfo,
    ...metadata
  });
}

// validateVideo function has been removed as its functionality is now integrated into detectVideo

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
        // Also include the normalized version of the embedded URL
        const normalizedEmbedded = normalizeUrl(embedded);
        return {
          url: embedded,
          normalizedUrl: normalizedEmbedded,
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
        // Also include the normalized version of the embedded URL
        const normalizedEmbedded = normalizeUrl(embedded);
        return {
          url: embedded,
          normalizedUrl: normalizedEmbedded,
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
      // Also include the normalized version of the embedded URL
      const normalizedEmbedded = normalizeUrl(embedded);
      return {
        url: embedded,
        normalizedUrl: normalizedEmbedded,
        type: /\.m3u8/i.test(embedded) ? 'hls' : 'dash',
        foundFromQueryParam: true
      };
    }
    
  } catch (e) {
    // Silent fail, just return unknown
  }
  
  return 'unknown';
}

// isVideoContent function has been removed as its functionality is now integrated into detectVideo

/**
 * Normalize URL to avoid duplicates
 * Creates a canonical form of URLs for effective deduplication
 * 
 * @param {string} url - URL to normalize
 * @param {number} depth - Recursion depth counter to prevent infinite loops
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url, depth = 0) {
  // Prevent infinite recursion by limiting depth
  if (depth > 3) return url; // avoid infinite recursion
  
  // Blob URLs are unique by nature and can't be normalized
  if (url.startsWith('blob:')) return url;
  
  // Generate cache key for the URL (standardizing URL format)
  const cacheKey = url.replace(/[\?#].*$/, '');
  
  // Check cache first
  if (state.urlNormalizationCache.has(cacheKey)) {
    return state.urlNormalizationCache.get(cacheKey);
  }
  
  try {
    const urlObj = new URL(url);
    
    // Handle tracking pixels with embedded video URLs
    if (url.includes('ping.gif') || url.includes('jwpltx.com') || 
        urlObj.pathname.includes('/pixel') || urlObj.pathname.includes('/track')) {
      // Extract video URLs from query parameters
      const embedded = extractEmbeddedVideoUrl(urlObj);
      if (embedded) {
        // Recursive call to normalize the extracted URL with depth counter
        return normalizeUrl(embedded, depth + 1);
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
        const manifesUrl = urlObj.origin + urlObj.pathname;
        // Cache the result using our consistent cache key
        state.urlNormalizationCache.set(cacheKey, manifesUrl);
        return manifesUrl;
      }
    }
    
    const normalized = urlObj.toString();
    
    // Store in cache using our consistent cache key
    state.urlNormalizationCache.set(cacheKey, normalized);
    
    return normalized;
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
  
  // Create a video info object from pre-validated information
  const videoInfo = {
    url,
    type,
    ...metadata
  };
  
  // normalizedUrl is required and must be prepared by detectVideo()
  // If it's missing, this indicates a logic error
  if (!videoInfo.normalizedUrl) {
    console.error('No normalizedUrl provided to processVideo');
    return false;
  }
  
  // Mark this normalized URL as processed to avoid duplicates
  state.detectedVideos.add(videoInfo.normalizedUrl);
  
  // For blob URLs, track them to prevent duplication
  if (url.startsWith('blob:') && !state.blobUrls.has(url)) {
    state.blobUrls.set(url, {
      url,
      type: 'blob',
      timestampDetected: videoInfo.timestampDetected,
      poster: metadata.poster || null,
      title: metadata.title || null
    });
  }

  // Send to background with only the necessary fields
  logDebug(`Sending video to background: ${videoInfo.url} (Type: ${videoInfo.type}, Source: ${videoInfo.source})`);
  
  // Send to background with only the necessary fields
  chrome.runtime.sendMessage({
    action: 'addVideo',
    url: videoInfo.url,
    source: videoInfo.source,
    type: videoInfo.type,
    foundFromQueryParam: videoInfo.foundFromQueryParam || false,
    originalContainer: videoInfo.originalContainer,
    originalUrl: videoInfo.originalUrl,
    timestampDetected: videoInfo.timestampDetected,
    // Include additional metadata but filter out redundant fields
    ...Object.fromEntries(
      Object.entries(videoInfo)
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
 * Handles SPA (Single Page Application) navigation using History API and regular page navigation
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