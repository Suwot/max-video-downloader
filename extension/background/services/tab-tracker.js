/**
 * Tab Tracker Service
 * Tracks tab events for cleanup and management
 */

// Add static imports at the top
import { cleanupForTab } from '../video-processing/video-manager.js';
import { createLogger } from '../../js/utilities/logger.js';
import { clearHeadersForTab, clearHeaderRulesForTab } from '../../js/utilities/headers-utils.js'
import { cleanupMpdContext } from '../index.js';

// Create a logger instance for the Tab Tracker module
const logger = createLogger('Tab Tracker');

/**
 * Clean up stored scroll position for a closed tab
 * @param {number} tabId - ID of the tab being removed
 */
function cleanupScrollPositionForTab(tabId) {
    chrome.storage.local.get(['scrollPositions'], (result) => {
        const scrollPositions = result.scrollPositions || {};
        if (scrollPositions[tabId]) {
            logger.debug('Cleaning up scroll position for tab:', tabId);
            delete scrollPositions[tabId];
            chrome.storage.local.set({ scrollPositions });
        }
    });
}

/**
 * Perform cleanup of orphaned scroll positions
 * This checks if tabs still exist and removes positions for closed tabs
 */
function cleanupOrphanedScrollPositions() {
    logger.debug('Running periodic cleanup of orphaned scroll positions');
    
    chrome.storage.local.get(['scrollPositions'], (result) => {
        const scrollPositions = result.scrollPositions || {};
        const tabIds = Object.keys(scrollPositions);
        
        if (tabIds.length === 0) return;
        
        let pendingChecks = tabIds.length;
        let hasChanges = false;
        
        tabIds.forEach(tabIdStr => {
            const tabId = parseInt(tabIdStr, 10);
            
            chrome.tabs.get(tabId, () => {
                if (chrome.runtime.lastError) {
                    // Tab doesn't exist anymore
                    logger.debug('Cleaning up orphaned scroll position for tab:', tabId);
                    delete scrollPositions[tabId];
                    hasChanges = true;
                }
                
                pendingChecks--;
                if (pendingChecks === 0 && hasChanges) {
                    // All checks complete and we have changes to save
                    chrome.storage.local.set({ scrollPositions });
                }
            });
        });
    });
}

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
            
            cleanupForTab(tabId); // Cleanup videos and playlists
            cleanupScrollPositionForTab(tabId); // Cleanup saved scroll positions
            cleanupMpdContext(tabId); // Cleanup MPD context if applicable
            clearHeadersForTab(tabId); // Clear any init request headers
            clearHeaderRulesForTab(tabId); // Clear any header rules per tab
        });
        
        // Could add additional tab event listeners here
        // e.g., tab updates, tab activation
        
        // Set up periodic cleanup of orphaned scroll positions once per hour
        setInterval(cleanupOrphanedScrollPositions, 3600000);

        return true;

    } catch (error) {
        logger.error('Failed to initialize tab tracking:', error);
        return false;
    }
}

export {
    initTabTracking
};