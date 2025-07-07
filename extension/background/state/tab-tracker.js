/**
 * Tab Tracker Service
 * Tracks tab events for cleanup and management
 */

// Add static imports at the top
import { cleanupVideosForTab } from '../processing/video-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { cleanupHeadersForTab, cleanupHeaderRulesForTab } from '../../shared/utils/headers-utils.js'
import { cleanupMPDContextForTab } from '../detection/video-detector.js'

// Create a logger instance for the Tab Tracker module
const logger = createLogger('Tab Tracker');

/**
 * Initialize tab tracking
 * @returns {Promise<boolean>} Success status
 */
function initTabTracking() {
    logger.info('Initializing tab tracking service');
    
    try {
        // Listen for tab removal events
        chrome.tabs.onRemoved.addListener((tabId) => {
            logger.debug('Tab removed:', tabId);
            
            cleanupVideosForTab(tabId); // Cleanup videos and playlists (includes icon reset)
            cleanupMPDContextForTab(tabId); // Cleanup DASH context if applicable
            cleanupHeadersForTab(tabId); // Clear any init request headers
            cleanupHeaderRulesForTab(tabId); // Clear any header rules per tab
        });
        
        // Could add additional tab event listeners here
        // e.g., tab updates, tab activation

        return true;

    } catch (error) {
        logger.error('Failed to initialize tab tracking:', error);
        return false;
    }
}

export {
    initTabTracking
};