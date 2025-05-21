/**
 * @ai-guide-component BackgroundScript
 * @ai-guide-description Main extension service worker that manages video detection
 */

// Import services
import { addDetectedVideo, getAllDetectedVideos, initVideoManager } from './services/video-manager.js';
import { initTabTracking } from './services/tab-tracker.js';
import { initDownloadManager } from './services/download-manager.js';
import { initUICommunication } from './services/ui-communication.js';
import { isValidVideoUrl } from '../js/utilities/video-validator.js';
import { createLogger } from '../js/utilities/logger.js';
import { clearCache, getCacheStats } from '../js/utilities/preview-cache.js';

// Create a logger instance for the background script
const logger = createLogger('Background');

// Helper function to extract container format from URL
function getContainerFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const directVideoMatch = urlObj.pathname.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
        if (directVideoMatch && directVideoMatch[1]) {
            return directVideoMatch[1].toLowerCase();
        }
    } catch (e) {
        // If URL parsing fails, try simple regex matching
        const directVideoMatch = url.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i);
        if (directVideoMatch && directVideoMatch[1]) {
            return directVideoMatch[1].toLowerCase();
        }
    }
    return null;
}

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
  // First check if it's a valid video URL using the validator
  if (!isValidVideoUrl(url)) {
    return null;
  }
  
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    
    // Check for HLS streams (.m3u8)
    if (url.includes('.m3u8')) {
      const isActualM3U8 = 
          path.includes('.m3u8') || 
          path.includes('/master.m3u8') || 
          path.includes('/index-f');
      
      if (isActualM3U8) {
        return { 
          type: 'hls'
        };
      }
    }
    
    // Check for DASH manifests (.mpd)
    if (url.includes('.mpd')) {
      const isActualMPD = path.includes('.mpd');
      
      if (isActualMPD) {
        return { 
          type: 'dash'
        };
      }
    }
    
    // Check for direct video files
    if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i.test(url)) {
      return { 
        type: 'direct', 
        container: getContainerFromUrl(url)
      };
    }
    
    // Not a recognized video format
    return null;
    
  } catch (err) {
    // Simple fallback if URL parsing fails
    if (url.includes('.m3u8')) {
      return { type: 'hls' };
    }
    
    if (url.includes('.mpd')) {
      return { type: 'dash' };
    }
    
    if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|m4v|wmv)(\?|$)/i.test(url)) {
      return { 
        type: 'direct', 
        container: getContainerFromUrl(url)
      };
    }
    
    return null;
  }
}

/**
 * Process a video URL from a web request
 * @param {number} tabId - Tab ID where request originated
 * @param {string} url - The URL to process
 */
function processVideoUrl(tabId, url) {
  if (tabId < 0 || !url) return;
  
  // Identify the video type using our helper
  const videoInfo = identifyVideoType(url);
  
  // Skip if not a recognized video type
  if (!videoInfo) return;
  
  // For streaming formats, add directly
  if (videoInfo.type === 'hls' || videoInfo.type === 'dash' || videoInfo.type === 'direct') {
    addDetectedVideo(tabId, {
      url,
      type: videoInfo.type,
      source: `BG_webRequest_${videoInfo.type}`,
      ...(videoInfo.container? {originalContainer: videoInfo.container} : {}),
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
        
        // Initialize video manager (add this first since other services may depend on it)
        await initVideoManager();
        
        // Initialize tab tracking
        await initTabTracking();
        
        // Initialize UI communication
        await initUICommunication();
        
        // Initialize download manager
        await initDownloadManager();
        
        logger.info('All background services initialized');
    } catch (error) {
        logger.error('Failed to initialize background services:', error);
    }
}

// Start the debug logger
startDebugLogger();

// Initialize all services
initializeServices();

// No need for port connection listener here anymore
// Each service now handles its own port connections

// Listen for web requests to catch video-related content
chrome.webRequest.onBeforeRequest.addListener(
    (details) => processVideoUrl(details.tabId, details.url),
    { urls: ["<all_urls>"] }
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
    
    return false;
});

logger.debug('Background script initialized');

// Sleep handler
chrome.runtime.onSuspend.addListener(() => {
  logger.debug('Background going to sleep...');
});