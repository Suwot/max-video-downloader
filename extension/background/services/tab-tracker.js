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
    });
    
    // Could add additional tab event listeners here
    // e.g., tab updates, tab activation
}

export {
    initTabTracking
};