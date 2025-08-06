// Import services
import { SettingsManager } from './state/settings-manager.js';
import nativeHostService from './messaging/native-host-service.js';
import { initHeaderTracking } from '../shared/utils/headers-utils.js';
import { cleanupOrphanedRules } from './processing/parsing-dnr.js';
import { initTabTracking } from './state/tab-manager.js';
import { initUICommunication } from './messaging/popup-communication.js';
import { initDownloadManager } from './download/download-manager.js';
import { initVideoDetector } from './detection/video-detector.js';
import { createLogger } from '../shared/utils/logger.js';

// Create a logger instance for the background script
const logger = createLogger('Background');

// Create and export Settings Manager instance
export const settingsManager = new SettingsManager();

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

        // Initialize Settings Manager first since other services depend on it
        await settingsManager.initialize();
        
        // Initialize native host connection early for UI readiness
        nativeHostService.ensureConnection().catch(err => {
            logger.debug('Initial native host connection failed:', err.message);
        });
        

        await initDownloadManager();     // Initialize download manager early since it uses state manager
        initVideoDetector();       // Initialize video detector
        initTabTracking();         // Initialize tab tracking
        await initUICommunication();     // Initialize UI communication
        await initHeaderTracking();      // Initialize header tracking
        await cleanupOrphanedRules();    // Clean up orphaned parsing rules

        logger.info('All background services initialized');
    } catch (error) {
        logger.error('Failed to initialize background services:', error);
    }
}

startDebugLogger();
initializeServices(); // Initialize all services

// Handle service worker wake events
chrome.runtime.onStartup.addListener(() => {
    logger.info('Extension startup - ensuring native host connection');
    nativeHostService.ensureConnection().catch(err => {
        logger.debug('Startup native host connection failed:', err.message);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    logger.info('Extension installed - ensuring native host connection');
    nativeHostService.ensureConnection().catch(err => {
        logger.debug('Install native host connection failed:', err.message);
    });
});

// Sleep handler
chrome.runtime.onSuspend.addListener(() => {
  logger.debug('Background going to sleep - native host will continue running active operations');
});