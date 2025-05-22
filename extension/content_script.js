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
  
  // Track URLs we've seen in this scan to avoid edge-case duplicates
  const seenUrls = new Set();
  let videoElementsFound = false;
  
  // 1. Process all video elements
  const videoElements = document.querySelectorAll('video');
  if (videoElements.length > 0) {
    videoElementsFound = true;
    logDebug(`Found ${videoElements.length} video elements during scan`);
    videoElements.forEach(video => {
      if (!state.observedVideoElements.has(video)) {
        const originalSource = video._source;
        video._source = 'CS_initial_scan'; // Temporarily mark source for tracking
        processNewVideoElement(video);
        video._source = originalSource; // Restore original source if any
      }
    });
  }
  
  // 2. Look for standalone source elements
  document.querySelectorAll('source:not(video > source)').forEach(source => {
    const src = source.src || source.getAttribute('src');
    if (src && !seenUrls.has(src)) {
      videoElementsFound = true; // Count source elements as video elements too
      seenUrls.add(src);
      const mimeType = source.getAttribute('type');
      detectVideo(src, mimeType || null, {
        source: 'CS_initial_scan',
        title: document.title || 'Video'
      });
    }
  });
  
  // 3. Only look for player configurations if no standard video elements were found
  if (!videoElementsFound) {
    logDebug('No standard video elements found, scanning for player configurations');
    scanForPlayerConfigs(seenUrls);
  } else {
    logDebug('Standard video elements found, skipping player configuration scan');
  }
}

/**
 * Scans for common video player configurations
 * Many sites use specific patterns for embedding videos
 * Focus only on player configs that might not be detected through network requests
 */
function scanForPlayerConfigs(seenUrls) {
  // Use the passed seenUrls if available, otherwise create a new Set
  const foundUrls = seenUrls || new Set();
  
  // Look for specific player elements with focus on those that might contain JSON configs
  const playerSelectors = [
    '.jwplayer', '.video-js', '.html5-video-container',
    '[data-video-url]', '[data-video-src]',
    '[data-setup*="sources"]', '[data-player-config]',
    // Avoid specific format detection that background script handles better
  ];
  
  document.querySelectorAll(playerSelectors.join(', ')).forEach(player => {
    // Try to extract video URLs from data attributes
    const dataAttrs = ['data-video-url', 'data-video-src', 'data-src', 
                      'data-setup', 'data-player-config'];
    
    for (const attr of dataAttrs) {
      const value = player.getAttribute(attr);
      if (!value) continue;
      
      try {
        // Focus on extracting URLs from JSON configs - this is something
        // the background script can't see through network requests
        if (value.includes('{') && value.includes('}')) {
          const config = JSON.parse(value);
          const sources = config.sources || config.source || config.src || config.url;
          
          if (sources) {
            const sourceArray = Array.isArray(sources) ? sources : [sources];
            sourceArray.forEach(source => {
              const url = typeof source === 'object' ? 
                          (source.src || source.file || source.url) : source;
              
              if (typeof url === 'string' && !foundUrls.has(url)) {
                foundUrls.add(url);
                // Just send to background without determining type
                detectVideo(url, null, { 
                  source: 'CS_player_config' 
                });
              }
            });
          }
        } 
        // Handle direct URLs without trying to determine their type
        else if ((value.includes('http') || value.startsWith('/')) && !foundUrls.has(value)) {
          const fullUrl = value.startsWith('/') ? 
                        `${window.location.origin}${value}` : value;
          
          if (!foundUrls.has(fullUrl)) {
            foundUrls.add(fullUrl);
            // Let background handle type detection
            detectVideo(fullUrl, null, { source: 'CS_player_attr' });
          }
        }
      } catch (e) {
        // Simply forward non-JSON values that might be URLs
        if ((value.includes('http') || value.startsWith('/')) && !foundUrls.has(value)) {
          const fullUrl = value.startsWith('/') ? 
                        `${window.location.origin}${value}` : value;
          
          if (!foundUrls.has(fullUrl)) {
            foundUrls.add(fullUrl);
            detectVideo(fullUrl, null, { source: 'CS_player_attr' });
          }
        }
      }
    }
  });
}

// Network request monitoring - focused ONLY on blob or data URLs that background can't see
function setupNetworkInterception() {
  // Only intercept XHR for blob/data URLs that background script can't access
  const originalXHR = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    // Only monitor special URL schemes that background script can't access
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const xhr = this;
      const originalOnReadyStateChange = xhr.onreadystatechange;
      
      xhr.addEventListener('readystatechange', function() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          const contentType = xhr.getResponseHeader('Content-Type');
          
          // Only process if it has video content type
          if (contentType && contentType.includes('video/')) {  
            detectVideo(xhr.responseURL || url, contentType, {
              source: 'CS_xhr_blob'
            });
          }
        }
        
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      });
    }
    
    return originalXHR.apply(this, [method, url, ...args]);
  };
}

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
  if (window.videoObserver) {
    window.videoObserver.observe(video, { attributes: true });
  }
  
  // Process video source through our unified pipeline
  const videoInfo = extractVideoInfo(video);
  if (videoInfo) {
    // Use the unified detection pipeline for more efficient processing
    detectVideo(videoInfo.url, null, {
      ...videoInfo,
      source: video._source || 'CS_dom'
    });
  }
}

// DOM observation for videos
function setupDOMObservers() {
  // Make videoObserver available globally so we can check if it exists
  window.videoObserver = new MutationObserver(mutations => {
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
            source: 'CS_mutation'
          });
        }
      }
    });
  });

  // The videoObserver is now defined at the top of setupDOMObservers
  
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
 * Streamlined entry point for video detection
 * Focuses on DOM-based detection and leaves type identification to background script
 * 
 * @param {string} url - The URL to detect video from
 * @param {string|null} contentType - Optional content type from headers
 * @param {Object} metadata - Additional video metadata
 * @returns {boolean} - Whether the video was detected and sent
 */
function detectVideo(url, contentType = null, metadata = {}) {
  if (!url) return false;
  
  // Skip if it's a blob URL we've already processed
  if (url.startsWith('blob:') && state.blobUrls.has(url)) {
    return false;
  }
  
  // Use minimal local detection for deduplication only
  let videoType = null;
  let videoUrl = url;
  let normalizedUrl = null;
  let additionalInfo = {};
  
  // Check if this is a special case the content script needs to handle specifically
  const videoTypeInfo = identifyVideoType(url);
  
  // Handle blob URLs
  if (url.startsWith('blob:')) {
    videoType = 'blob';
    normalizedUrl = url; // Blob URLs are already unique
  } 
  // For embedded URLs from query parameters
  else if (typeof videoTypeInfo === 'object' && videoTypeInfo?.foundFromQueryParam) {
    videoType = videoTypeInfo.type;
    videoUrl = videoTypeInfo.url;
    normalizedUrl = videoTypeInfo.normalizedUrl;
    additionalInfo.originalUrl = url;
    additionalInfo.foundFromQueryParam = true;
  }
  // Direct videos with known container from metadata
  else if (metadata.originalContainer) {
    videoType = 'direct';
    additionalInfo.originalContainer = metadata.originalContainer;
    normalizedUrl = normalizeUrl(url);
  }
  // For all other URLs, only do minimal checking
  else {
    // Check for direct video extension for local deduplication
    try {
      const path = new URL(url).pathname.toLowerCase();
      const directMatch = path.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
      if (directMatch) {
        videoType = 'direct';
        additionalInfo.originalContainer = directMatch[1].toLowerCase();
      } else {
        // Let the background script identify all other types
        videoType = 'unknown';
      }
    } catch {
    videoType = 'unknown'; // Let background handle type detection
    }
    
    normalizedUrl = normalizeUrl(url);
  }
  
  // Skip if we've already processed this URL
  if (state.detectedVideos.has(normalizedUrl)) {
    return false;
  }
  
  // At this point, we have a new video URL to send to background
  return processVideo(videoUrl, videoType, {
    contentType,
    normalizedUrl,
    timestampDetected: Date.now(),
    ...additionalInfo,
    ...metadata
  });
}

// validateVideo function has been removed as its functionality is now integrated into detectVideo

/**
 * Extract embedded video URL from query parameters
 * Used by both identifyVideoType and normalizeUrl
 * Supports more video formats by passing any potential URLs to background script
 * 
 * @param {URL} urlObj - URL object to extract from
 * @returns {string|null} - Extracted video URL or null
 */
function extractEmbeddedVideoUrl(urlObj) {
  for (const [_, value] of urlObj.searchParams.entries()) {
    try {
      const decoded = decodeURIComponent(value);
      // Look for any potential video URLs - let background determine validity
      if ((decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) && 
          // Ensure it's not an image or document
          !/\.(jpg|jpeg|png|gif|webp|svg|pdf|doc|docx)(\?|$)/i.test(decoded)) {
        // Handle relative URLs
        return decoded.startsWith('/') ? (urlObj.origin + decoded) : decoded;
      }
    } catch {}
  }
  return null;
}

/**
 * Ultra-minimal video type identification
 * Only handles blob URLs and embedded query parameters
 * Leaves all other URL analysis to the background script
 * 
 * @param {string} url - URL to identify type from
 * @returns {string|Object|null} - 'blob' string, embedded URL object, or null
 */
function identifyVideoType(url) {
  // Only special case blob URLs that background can't access directly
  if (url.startsWith('blob:')) return 'blob';
  
  try {
    // Quick check for query parameter embedded videos
    const urlObj = new URL(url);
    const embedded = extractEmbeddedVideoUrl(urlObj);
    if (embedded) {
      return {
        url: embedded,
        normalizedUrl: normalizeUrl(embedded),
        type: 'embedded',
        foundFromQueryParam: true
      };
    }
  } catch (e) {
    // Silent fail
  }
  
  return null;
}

// isVideoContent function has been removed as its functionality is now integrated into detectVideo

/**
 * Simplified URL normalization focused only on basic deduplication
 * Leaves advanced URL processing to the background script
 * 
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
  // Blob URLs are unique by nature and can't be normalized
  if (url.startsWith('blob:')) return url;
  
  // Generate cache key for the URL
  const cacheKey = url.replace(/[\?#].*$/, '');
  
  // Check cache first for performance
  if (state.urlNormalizationCache.has(cacheKey)) {
    return state.urlNormalizationCache.get(cacheKey);
  }
  
  try {
    const urlObj = new URL(url);
    
    // Only remove the most obvious tracking parameters
    // Let background do the rest of the normalization
    const commonParams = ['_t', 'cache', 'timestamp', 'random'];
    commonParams.forEach(param => {
      urlObj.searchParams.delete(param);
    });
    
    const normalized = urlObj.toString();
    
    // Store in cache
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
  
  // normalizedUrl should always be prepared by detectVideo() by this point
  // This was a defensive check that is no longer needed, but we keep it as a safeguard
  if (!videoInfo.normalizedUrl) {
    return false; // This should never happen with the current implementation
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