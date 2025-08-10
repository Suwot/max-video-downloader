/**
 * Popup entry point - simple initialization and coordination
 */

import { initializeUI } from './ui.js';
import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/processing-utils.js';
import { connect, disconnect, sendPortMessage } from './communication.js';
import { restoreActiveDownloads, cleanupAllElapsedTimeTimers } from './video/download-progress-handler.js';
import { renderHistoryItems } from './video/video-renderer.js';
import { initializeSettingsTab } from './settings-tab.js';
const logger = createLogger('Popup');

// Simple local tab ID - no need for separate state management
let currentTabId = null;

/**
 * Get current active tab
 */
async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) {
        throw new Error('Could not determine active tab');
    }
    return tabs[0];
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        logger.debug('Popup initializing...');

        // Get active tab and set tab ID first
        const activeTab = await getActiveTab();
        currentTabId = activeTab.id;
        logger.debug('Active tab ID set:', activeTab.id);

        // Initialize UI (theme will be handled there)
        await initializeUI();

        // Initialize settings tab
        await initializeSettingsTab();

        // Connect to background and register
        connect();
        
        sendPortMessage({
            command: 'register',
            tabId: activeTab.id,
            url: normalizeUrl(activeTab.url)
        });

        // Ensure native host connection for immediate UI state
        sendPortMessage({ command: 'ensureNativeHostConnection' });

        // Request videos
        sendPortMessage({
            command: 'getVideos',
            tabId: activeTab.id
        });

        // Restore downloads data (this will handle both active downloads and progress)
        await restoreActiveDownloads();
        await renderHistoryItems();
    } catch (error) {
        logger.error('Initialization error:', error);
        const container = document.getElementById('videos-list');
        if (container) {
            container.innerHTML = `
                <div class='initial-message'>
                    Failed to initialize the extension. Please try reloading.
                </div>
            `;
        }
    }
});

// Clean up on popup close
window.addEventListener('beforeunload', () => {
    // Clean up elapsed time timers
    cleanupAllElapsedTimeTimers();
    // Disconnect from background
    disconnect();
});

// Export functions for use by other modules
export {
    getActiveTab,
    currentTabId
};
