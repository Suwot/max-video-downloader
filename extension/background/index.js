// Import services
import { initStateManager } from './services/state-manager.js';
import { initHeaderTracking } from '../js/utilities/headers-utils.js';
import { getAllDetectedVideos, initVideoManager } from './services/video-manager.js';
import { initTabTracking } from './services/tab-tracker.js';
import { initUICommunication } from './services/ui-communication.js';
import { createLogger } from '../js/utilities/logger.js';
import { clearCache, getCacheStats } from '../js/utilities/preview-cache.js';

// Import video detection
import { 
    cleanupDetectionContext,
    initVideoDetector 
} from './video-detection/video-detector.js';

// Create a logger instance for the background script
const logger = createLogger('Background');

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
 * Initialize all background services
 */
async function initializeServices() {
    try {
        logger.info('Initializing background services');

        await initStateManager();        // Initialize state manager first since other services depend on it
        await initVideoManager();        // Initialize video manager (add this first since other services may depend on it)
        await initVideoDetector();       // Initialize video detector
        await initTabTracking();         // Initialize tab tracking
        await initUICommunication();     // Initialize UI communication
        await initHeaderTracking();      // Initialize header tracking 

        logger.info('All background services initialized');
    } catch (error) {
        logger.error('Failed to initialize background services:', error);
    }
}

// Start the debug logger
startDebugLogger();

// Initialize all services
initializeServices();

// Listen for messages from popup (non-detection messages)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {    
    // Handle preview cache operations
    if (request.command === 'clearPreviewCache') {
        logger.debug('Clearing preview cache');
        clearCache().then(success => {
            sendResponse({ success });
        });
        return true; // Keep channel open for async response
    }

    if (request.command === 'getPreviewCacheStats') {
        logger.debug('Getting preview cache stats');
        getCacheStats().then(stats => {
            sendResponse(stats);
        });
        return true; // Keep channel open for async response
    }
    
    return false;
});

logger.debug('Background script initialized');

// Add cleanup function to handle tab closure
export function cleanupMpdContext(tabId) {
    cleanupDetectionContext(tabId);
}

// Sleep handler
chrome.runtime.onSuspend.addListener(() => {
  logger.debug('Background going to sleep...');
});