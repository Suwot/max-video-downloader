/**
 * Tab Tracker Service
 * Tracks tab events for cleanup and management
 */

// Add static imports at the top
import { cleanupVideosForTab, updateTabIcon } from '../processing/video-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { cleanupHeadersForTab, cleanupHeaderRulesForTab } from '../../shared/utils/headers-utils.js'
import { cleanupMPDContextForTab } from '../detection/video-detector.js'

// Create a logger instance for the Tab Tracker module
const logger = createLogger('Tab Tracker');

// Track domain (origin) for each tab to detect domain changes
// Map<tabId, origin> - tracks the current domain for each tab
const tabDomains = new Map();

/**
 * Check if navigation represents a domain change that requires cleanup
 * @param {number} tabId - Tab ID
 * @param {string} newUrl - New URL after navigation
 * @returns {boolean} - True if domain changed and cleanup is needed
 */
function shouldCleanupOnNavigation(tabId, newUrl) {
    if (!newUrl) return false;
    
    try {
        const newOrigin = new URL(newUrl).origin;
        const currentOrigin = tabDomains.get(tabId);
        
        // If we don't have a current origin, store the new one and don't cleanup
        if (!currentOrigin) {
            tabDomains.set(tabId, newOrigin);
            return false;
        }
        
        // If origins are the same, no cleanup needed
        if (currentOrigin === newOrigin) {
            return false;
        }
        
        // Domain changed - update tracking and return true for cleanup
        tabDomains.set(tabId, newOrigin);
        logger.debug(`Domain change detected for tab ${tabId}: ${currentOrigin} -> ${newOrigin}`);
        return true;
        
    } catch (error) {
        logger.warn(`Error checking domain change for tab ${tabId}:`, error);
        return false;
    }
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
            cleanupVideosForTab(tabId, false); // Cleanup videos and playlists (includes icon reset)
            cleanupMPDContextForTab(tabId); // Cleanup DASH context if applicable
            cleanupHeadersForTab(tabId); // Clear any init request headers
            cleanupHeaderRulesForTab(tabId); // Clear any header rules per tab
            
            // Clean up domain tracking
            if (tabDomains.has(tabId)) {
                tabDomains.delete(tabId);
            }
        });
        
        // Listen for tab activation (when a tab becomes visible/active)
        chrome.tabs.onActivated.addListener((activeInfo) => {
            logger.debug('Tab activated:', activeInfo.tabId);
            updateTabIcon(activeInfo.tabId);
        });

        // Listen for tab updates - only update icon when tab is complete
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            // Only update icon if the tab is complete (fully loaded)
            if (changeInfo.status === 'complete') {
                logger.debug('Tab loaded completely:', tabId);
                updateTabIcon(tabId);
            }
        });

        // Listen for page navigation to clear videos only on domain change
        chrome.webNavigation.onCommitted.addListener((details) => {
            // Only handle main frame navigation (not iframes)
            if (details.frameId === 0) {
                if (shouldCleanupOnNavigation(details.tabId, details.url)) {
                    logger.debug(`Domain change detected, cleaning up tab ${details.tabId}`);
                    cleanupVideosForTab(details.tabId);
                } else {
                    logger.debug(`Same domain navigation for tab ${details.tabId}, preserving videos`);
                    // Chrome resets extension icons during navigation, so we need to restore it
                    updateTabIcon(details.tabId);
                }
            }
        });

        return true;

    } catch (error) {
        logger.error('Failed to initialize tab tracking:', error);
        return false;
    }
}

export {
    initTabTracking
};