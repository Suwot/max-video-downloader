/**
 * Popup entry point - simple initialization and coordination
 */

import { initializeUI } from './ui.js';
import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/processing-utils.js';
import { setTabId, getGroupState, setGroupState } from './state.js';
import { connect, disconnect, sendPortMessage } from './communication.js';
import { restoreActiveDownloads } from './video/download-handler.js';
import { renderHistoryItems } from './video/video-renderer.js';

const logger = createLogger('Popup');



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
        setTabId(activeTab.id);
        logger.debug('Active tab ID set:', activeTab.id);

        // Initialize UI (theme will be handled there)
        await initializeUI();

        // Connect to background and register
        connect();
        
        sendPortMessage({
            command: 'register',
            tabId: activeTab.id,
            url: normalizeUrl(activeTab.url)
        });

        // Request videos
        sendPortMessage({
            command: 'getVideos',
            tabId: activeTab.id,
            forceRefresh: true
        });

        // Restore downloads data
        await restoreActiveDownloads();
        await renderHistoryItems();
        
        // Request current download progress for restored active downloads
        sendPortMessage({ command: 'getDownloadProgress' });
        
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
    // Disconnect from background
    disconnect();
});

// Export functions for use by other modules
export {
    getGroupState,
    setGroupState,
    getActiveTab,
};
