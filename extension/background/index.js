// Import services
import { initStateManager } from './state/state-manager.js';
import { initHeaderTracking } from '../shared/utils/headers-utils.js';
import { initVideoManager } from './processing/video-manager.js';
import { initTabTracking } from './state/tab-tracker.js';
import { initUICommunication } from './messaging/popup-communication.js';
import { initDownloadManager } from './download/download-manager.js';
import { createLogger } from '../shared/utils/logger.js';

// Import video detection
import { 
    cleanupDetectionContext,
    initVideoDetector 
} from './detection/video-detector.js';

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
        await initDownloadManager();     // Initialize download manager early since it uses state manager
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

logger.debug('Background script initialized');

// Add cleanup function to handle tab closure
export function cleanupMpdContext(tabId) {
    cleanupDetectionContext(tabId);
}

// Sleep handler
chrome.runtime.onSuspend.addListener(() => {
  logger.debug('Background going to sleep...');
});