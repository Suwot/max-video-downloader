/**
 * Tab Tracker Service
 * Tracks tab events for cleanup and management
 */

// Add static imports at the top
import { cleanupForTab } from './video-manager.js';
import { cleanupDownloadsForTab } from './download-manager.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Tab Tracker]', new Date().toISOString(), ...args);
}

/**
 * Clean up stored scroll position for a closed tab
 * @param {number} tabId - ID of the tab being removed
 */
function cleanupScrollPositionForTab(tabId) {
    chrome.storage.local.get(['scrollPositions'], (result) => {
        const scrollPositions = result.scrollPositions || {};
        if (scrollPositions[tabId]) {
            logDebug('Cleaning up scroll position for tab:', tabId);
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
    logDebug('Running periodic cleanup of orphaned scroll positions');
    
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
                    logDebug('Cleaning up orphaned scroll position for tab:', tabId);
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
 */
function initTabTracking() {
    // Listen for tab removal events
    chrome.tabs.onRemoved.addListener((tabId) => {
        logDebug('Tab removed:', tabId);
        
        // Cleanup videos and playlists
        cleanupForTab(tabId);
        
        // Cleanup downloads
        cleanupDownloadsForTab(tabId);
        
        // Cleanup saved scroll positions
        cleanupScrollPositionForTab(tabId);
    });
    
    // Could add additional tab event listeners here
    // e.g., tab updates, tab activation
    
    // Set up periodic cleanup of orphaned scroll positions
    // Run once per hour (3600000ms)
    setInterval(cleanupOrphanedScrollPositions, 3600000);
}

export {
    initTabTracking
};