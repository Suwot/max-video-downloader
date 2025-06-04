// Import services
import { initStateManager } from './services/state-manager.js';
import { addDetectedVideo, getAllDetectedVideos, initVideoManager } from './services/video-manager.js';
import { initTabTracking } from './services/tab-tracker.js';
import { initDownloadManager } from './services/download-manager.js';
import { initUICommunication } from './services/ui-communication.js';
import { createLogger } from '../js/utilities/logger.js';
import { clearCache, getCacheStats } from '../js/utilities/preview-cache.js';

// Create a logger instance for the background script
const logger = createLogger('Background');

// tabId -> timestamp when MPD was detected
const tabsWithMpd = new Map();

// tabId -> Set of segment paths
const dashSegmentPathCache = new Map();

// Debug logger for allDetectedVideos - will log every 10 seconds
let debugInterval;
function startDebugLogger() {
  if (debugInterval) {
    clearInterval(debugInterval);
  }
  
  debugInterval = setInterval(() => {
    console.log('=== DEBUG: allDetectedVideos Map ===');
    
    try {
      // Get direct access to the internal structure via globalThis
      const rawStructure = globalThis.allDetectedVideosInternal;
      if (rawStructure && rawStructure instanceof Map) {
        // This is the raw nested Map structure
        console.log('Total tabs with videos:', rawStructure.size);
        
        // Display each tab's data separately for clearer output
        for (const [tabId, urlMap] of rawStructure.entries()) {
          if (urlMap instanceof Map) {
            console.log(`Tab ${tabId}: (${urlMap.size} videos)`);
            // Convert urlMap entries to a regular object for easier console viewing
            try {
              const urlMapObj = {};
              for (const [url, videoInfo] of urlMap.entries()) {
                urlMapObj[url] = videoInfo;
              }
              console.log('  Videos:', urlMapObj);
            } catch (err) {
              console.log('  Videos:', urlMap);
              console.error('  Error processing tab videos:', err);
            }
          } else {
            console.log(`Tab ${tabId}: (urlMap is not a Map)`, urlMap);
          }
        }
      } else {
        // Fallback to using the getAllDetectedVideos function
        console.log('Using getAllDetectedVideos() - flattened view:');
        const videos = getAllDetectedVideos();
        if (videos instanceof Map) {
          console.log('Total videos across all tabs:', videos.size);
          
          // Group by tab ID
          const byTab = {};
          try {
            for (const [url, video] of videos.entries()) {
              const tabId = video.tabId;
              if (!byTab[tabId]) byTab[tabId] = [];
              byTab[tabId].push({ url, ...video });
            }
            
            // Print the grouping
            for (const tabId in byTab) {
              console.log(`Tab ${tabId}: (${byTab[tabId].length} videos)`);
              console.log('  Videos:', byTab[tabId]);
            }
          } catch (err) {
            console.error('  Error processing videos by tab:', err);
            console.log('  Raw videos object:', videos);
          }
        } else {
          console.log('getAllDetectedVideos() did not return a Map:', videos);
        }
      }
    } catch (e) {
      console.error('Error in debug logger:', e);
    }
    
    console.log('================================');
  }, 10000); // Log every 10 seconds
}

/**
 * Process and identify video type from URL
 * @param {string} url - URL to process
 * @returns {Object|null} Video type info or null if not video
 */
function identifyVideoType(url) {
  if (!url) return null;
  
  // Quick checks before expensive URL parsing
  const urlLower = url.toLowerCase();
  
  // Skip known segment formats without needing URL parsing
  if (urlLower.endsWith('.m4s') || urlLower.endsWith('.ts')) {
    return null;
  }
  
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    
    // Combined exclusion patterns - do these checks first to exit early
    if (
      // Check for image extensions
      /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(path) ||
      // Known analytics endpoints
      /\/(ping|track|pixel|analytics|telemetry|stats|metrics)\//i.test(path)
    ) {
      return null;
    }
    
    // Positive checks for media types
    
    // Check for HLS streams (.m3u8)
    if (urlLower.includes('.m3u8')) {
      const isActualM3U8 = path.includes('.m3u8') || 
                          path.includes('/index-f');
      
      if (isActualM3U8) {
        return { type: 'hls' };
      }
    }
    
    // Check for DASH manifests (.mpd)
    if (path.includes('.mpd')) {
      return { type: 'dash' };
    }
    
    // Check for direct video files
    const directVideoMatch = path.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
    if (directVideoMatch) {
      return { 
        type: 'direct', 
        container: directVideoMatch[1].toLowerCase()
      };
    }
    
  } catch (err) {
    // Simple fallback if URL parsing fails - use string matching
    
    // Check for streaming formats
    if (urlLower.includes('.m3u8')) {
      return { type: 'hls' };
    }
    
    if (urlLower.includes('.mpd')) {
      return { type: 'dash' };
    }
    
    // Check for direct video files
    const directVideoMatch = url.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
    if (directVideoMatch) {
      return { 
        type: 'direct', 
        container: directVideoMatch[1].toLowerCase()
      };
    }
  }
  
  // Not a recognized video format
  return null;
}

/**
 * Process a video URL from a web request
 * @param {number} tabId - Tab ID where request originated
 * @param {string} url - The URL to process
 * @param {Object} metadata - Optional metadata from response headers
 */
function processVideoUrl(tabId, url, metadata = null) {
  if (tabId < 0 || !url) return;

  logger.debug(`Processing video URL: ${url} with metadata:`, metadata);
  
  // If we have a content type from metadata, check it first - this is our primary detection for DASH/HLS
  if (metadata && metadata.contentType) {
    const contentType = metadata.contentType.toLowerCase(); // Normalize for consistent matching
    
    // Define MIME type matchers
    const dashMimePatterns = ['dash+xml', 'vnd.mpeg.dash.mpd'];
    const hlsMimePatterns = ['mpegurl', 'm3u8', 'm3u'];
    const possibleDashMimePatterns = ['application/xml', 'text/xml', 'octet-stream'];
    
    // Check for DASH manifests (MPD files)
    const isDash = dashMimePatterns.some(pattern => contentType.includes(pattern));
    
    // More restrictive check for misconfigured DASH
    const isPossibleDash = 
      possibleDashMimePatterns.some(pattern => contentType.includes(pattern)) &&
      url.toLowerCase().includes('.mpd');
    
    if (isDash || isPossibleDash) {
      // Record that this tab has an MPD manifest
      tabsWithMpd.set(tabId, Date.now());

      addDetectedVideo(tabId, {
        url,
        type: 'dash',
        source: 'BG_webRequest_mime_dash',
        timestampDetected: metadata.timestampDetected || Date.now(),
        metadata: metadata
      });
      return;
    }
    
    // Check for HLS manifests (M3U8 files)
    const isHls = hlsMimePatterns.some(pattern => contentType.includes(pattern));
    
    // More restrictive check for misconfigured HLS
    const isLikelyHls = url.toLowerCase().includes('.m3u8');

    if (isHls || isLikelyHls) {
      addDetectedVideo(tabId, {
        url,
        type: 'hls',
        source: 'BG_webRequest_mime_hls',
        timestampDetected: metadata.timestampDetected || Date.now(),
        metadata: metadata
      });
      return;
    }
    
    // For direct video/audio files, check MIME type AND apply filters
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
      // First check file size before anything else
      if (metadata.contentLength < 100 * 1024) {  // Skip files smaller than 100kb
        logger.debug(`Skipping small media file (${metadata.contentLength} bytes): ${url}`);
        return;
      } 
      
      // Skip TS segments typically used in HLS and M4S segments used in DASH
      if (url.endsWith('.ts') || url.endsWith('.m4s') || contentType === 'video/mp2t') {
        return;
      }
      
      // OPTIMIZED SEGMENT DETECTION
      // 1. Fast pre-filtering for common segment indicators
      if (url.endsWith('.ts') || url.endsWith('.m4s') || 
          contentType === 'video/mp2t' || 
          (url.includes('.mp4') && url.includes('range='))) {
        logger.debug(`Skipping detected segment by extension/query: ${url}`);
        return;
      }
      
      // 2. Check for MPD context
      const hasMpdContext = tabsWithMpd.has(tabId);
      
      // 3. Check against cached segment paths
      if (hasMpdContext && dashSegmentPathCache.has(tabId)) {
        const segmentPaths = dashSegmentPathCache.get(tabId);
        
        try {
          // Extract path from URL for comparison
          const urlObj = new URL(url);
          const urlPath = urlObj.pathname;
          
          // Check if any cached segment path is part of this URL's path
          for (const basePath of segmentPaths) {
            if (urlPath.includes(basePath)) {
              logger.debug(`Skipping segment matching cached path pattern: ${basePath} in ${url}`);
              return;
            }
          }
        } catch (e) {
          // URL parsing failed, fall back to string includes
          for (const basePath of segmentPaths) {
            if (url.includes(basePath)) {
              logger.debug(`Skipping segment matching cached path pattern (string match): ${basePath} in ${url}`);
              return;
            }
          }
        }
      }
      
      // 4. Standard segment pattern detection (as a fallback)
      const segmentPatterns = [
        /segment-\d+/, /chunk-\d+/, /frag-\d+/, /seq-\d+/, /part-\d+/,
        /\/(media|video|audio)_\d+/, /dash\d+/, /\d+\.(m4s|ts)$/,
        /-\d+\.m4[sv]$/i,
        /[_-]\d+_\d+\.(m4s|mp4)$/i
      ];
      
      if (segmentPatterns.some(pattern => pattern.test(url))) {
        logger.debug(`Skipping media segment by pattern: ${url}`);
        return;
      }
      
      // 5. Check byte ranges as the last resort (most expensive check)
      let hasByteRanges = false;
      if (hasMpdContext) {
        // First check if the URL contains "bytes=" or "range=" before expensive URL parsing
        if (url.includes('bytes=') || url.includes('range=')) {
          try {
            const parsedUrl = new URL(url);
            const byteRangePattern = /(?:bytes|range)=\d+-\d+/i;
            hasByteRanges = byteRangePattern.test(parsedUrl.search);
          } catch (e) {
            // Fallback for URL parsing failure
            hasByteRanges = /bytes=\d+-\d+/.test(url) || /range=\d+-\d+/.test(url);
          }
        }
        
        if (hasByteRanges) {
          logger.debug(`Skipping media segment with byte ranges: ${url}`);
          return;
        }
      }

      // Determine if it's audio-only or video content
      const mediaType = contentType.startsWith('audio/') ? 'audio' : 'video';
  
      
      addDetectedVideo(tabId, {
        url,
        type: 'direct',
        mediaType: mediaType, // Add explicit type for UI differentiation
        source: 'BG_webRequest_mime_direct',
        originalContainer: contentType.split('/')[1],
        timestampDetected: metadata.timestampDetected || Date.now(),
        metadata: metadata
      });
      return;
    }
  }
  
  // For URLs without MIME type information, fall back to URL-based detection
  const videoInfo = identifyVideoType(url);
  
  // Skip if not a recognized video type
  if (!videoInfo) return;
  
  // For streaming formats, add directly
  if (videoInfo.type === 'hls' || videoInfo.type === 'dash' || videoInfo.type === 'direct') {
    addDetectedVideo(tabId, {
      url,
      type: videoInfo.type,
      source: `BG_webRequest_${videoInfo.type}`,
      ...(videoInfo.container ? {originalContainer: videoInfo.container} : {}),
      ...(metadata ? {metadata: metadata} : {}), // Still pass metadata even in URL-based detection
      timestampDetected: Date.now()
    });
  }
}

/**
 * Initialize all background services
 */
async function initializeServices() {
    try {
        logger.info('Initializing background services');

        await initStateManager();        // Initialize state manager first since other services depend on it
        await initVideoManager();        // Initialize video manager (add this first since other services may depend on it)
        await initTabTracking();         // Initialize tab tracking
        await initUICommunication();     // Initialize UI communication
        await initDownloadManager();     // Initialize download manager

        logger.info('All background services initialized');
    } catch (error) {
        logger.error('Failed to initialize background services:', error);
    }
}

// Start the debug logger
startDebugLogger();

// Initialize all services
initializeServices();

// Add header monitoring to detect all types of relevant requests
chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    // Extract all relevant headers into a metadata object
    const metadata = {
      contentType: null,
      contentLength: null,
      contentEncoding: null,
      lastModified: null,
      etag: null,
      contentDisposition: null,
      filename: null,
      supportsRanges: false,
      timestampDetected: Date.now()
    };
    
    // Process important headers
    for (const header of details.responseHeaders) {
      const headerName = header.name.toLowerCase();
      
      switch(headerName) {
        case 'content-type':
          metadata.contentType = header.value;
          break;
        case 'content-length':
          metadata.contentLength = parseInt(header.value, 10);
          break;
        case 'content-encoding':
          metadata.contentEncoding = header.value;
          break;
        case 'last-modified':
          metadata.lastModified = header.value;
          break;
        case 'etag':
          metadata.etag = header.value;
          break;
        case 'content-disposition':
          metadata.contentDisposition = header.value;
          // Extract filename from Content-Disposition if present
          const filenameMatch = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(header.value);
          if (filenameMatch && filenameMatch[1]) {
            let filename = filenameMatch[1].replace(/['"]/g, '').trim();
            // Decode URL encoded characters
            try {
              filename = decodeURIComponent(filename);
            } catch (e) {
              // If decoding fails, use the original value
            }
            metadata.filename = filename;
          }
          break;
        case 'accept-ranges':
          metadata.supportsRanges = header.value === 'bytes';
          break;
        case 'access-control-allow-origin':
          metadata.cors = header.value;
          break;
        case 'x-content-type-options':
          metadata.xContentTypeOptions = header.value;
          break;
      }
    }

    // If no filename was found in Content-Disposition, try to extract from URL
    if (!metadata.filename) {
      try {
        const urlObj = new URL(details.url);
        const pathParts = urlObj.pathname.split('/');
        const lastPart = pathParts[pathParts.length - 1];
        
        // Only use the URL part if it looks like a filename with extension
        if (lastPart && /\.\w{2,5}$/i.test(lastPart)) {
          // Decode URL encoded characters
          let filename;
          try {
            filename = decodeURIComponent(lastPart);
          } catch (e) {
            filename = lastPart;
          }
          // Remove extension if present
          const dotIndex = filename.lastIndexOf('.');
          if (dotIndex > 0) {
            filename = filename.substring(0, dotIndex);
          }
          metadata.filename = filename;
        }
      } catch (e) {
        // URL parsing failed, no filename will be set
      }
    }

    // Call the unified processVideoUrl function with the metadata
    processVideoUrl(details.tabId, details.url, metadata);
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media"] },
  ["responseHeaders"]
);

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {    
    // Handle video detection from content script
    if (request.action === 'addVideo') {
        const tabId = sender.tab?.id;
        if (tabId && tabId > 0) {
            addDetectedVideo(tabId, request);
        }
        return false;
    }
    
    // Handle preview cache operations
    if (request.action === 'clearPreviewCache') {
        logger.debug('Clearing preview cache');
        clearCache().then(success => {
            sendResponse({ success });
        });
        return true; // Keep channel open for async response
    }
    
    if (request.action === 'getPreviewCacheStats') {
        logger.debug('Getting preview cache stats');
        getCacheStats().then(stats => {
            sendResponse(stats);
        });
        return true; // Keep channel open for async response
    }
    
    // Handle DASH segment paths from parser
    if (request.action === 'registerDashSegmentPaths' && request.paths) {
        let tabId = request.tabId;
        
        // If no tabId was provided but we have a URL, try to find the corresponding tab
        if (!tabId && request.url) {
            // Try to find the tab that loaded this MPD
            for (const [existingTabId, timestamp] of tabsWithMpd.entries()) {
                // We can check if this tab has the same MPD URL in its detected videos
                // This is a simplified approach - in a real implementation you might want
                // to check if the URL is actually from this tab
                if (timestamp > Date.now() - 60000) { // Only check tabs with recent MPD activity (1 minute)
                    tabId = existingTabId;
                    logger.debug(`Found matching tab ${tabId} for MPD URL: ${request.url}`);
                    break;
                }
            }
        }
        
        if (tabId) {
            // Initialize segment paths set for this tab if it doesn't exist
            if (!dashSegmentPathCache.has(tabId)) {
                dashSegmentPathCache.set(tabId, new Set());
            }
            
            // Add all paths to the cache
            const pathCache = dashSegmentPathCache.get(tabId);
            request.paths.forEach(path => pathCache.add(path));
            
            logger.debug(`Added ${request.paths.length} segment paths to cache for tab ${tabId}`);
        } else {
            logger.warn('Could not determine tab ID for segment paths, ignoring');
        }
        return false;
    }
    
    return false;
});

logger.debug('Background script initialized');

// Add cleanup function to handle tab closure
export function cleanupMpdContext(tabId) {
  if (tabsWithMpd.has(tabId)) {
    tabsWithMpd.delete(tabId);
  }
  
  // Also clean up segment paths
  if (dashSegmentPathCache.has(tabId)) {
    dashSegmentPathCache.delete(tabId);
    logger.debug(`Cleaned up segment paths for tab ${tabId}`);
  }
}

// Sleep handler
chrome.runtime.onSuspend.addListener(() => {
  logger.debug('Background going to sleep...');
});