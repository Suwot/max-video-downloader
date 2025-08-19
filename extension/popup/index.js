/**
 * Popup entry point - simple initialization and coordination
 */

import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/processing-utils.js';
import { connect, disconnect, sendPortMessage } from './communication.js';
import { restoreActiveDownloads } from './video/download-progress-handler.js';
import { renderHistoryItems } from './video/video-renderer.js';
import { initializeSettingsTab } from './settings-tab.js';
import { switchTab, initializeTooltips } from './ui-utils.js';

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

/**
 * Initialize UI event handlers - minimal logic
 */
function initializeUIEventHandlers() {
    // Tab navigation
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tabId));
    });

    // Collapsible sections
    document.querySelectorAll('.section-header.collapsible').forEach(header => 
        header.addEventListener('click', () => {
            header.nextElementSibling?.classList.toggle('collapsed');
            header.querySelector('.toggle-icon')?.classList.toggle('rotated');
        })
    );

    // Clear cache button - stats are stored in the button's dataset.constraint
    const clearCacheButton = document.getElementById('clear-cache-button');

    // Request initial stats (background should respond and update dataset via port message)
    sendPortMessage({ command: 'getPreviewCacheStats' });

    // Handle click - update dataset.constraint directly
    clearCacheButton.addEventListener('click', () => {
        clearCacheButton.disabled = true;
        try {
            sendPortMessage({ command: 'clearCaches' });
            clearCacheButton.dataset.constraint = 'Cache cleared!';
        } catch (error) {
            logger.error('Error clearing cache:', error);
            clearCacheButton.dataset.constraint = 'Failed to clear cache';
        } finally {
            clearCacheButton.disabled = false;
        }
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        logger.debug('Popup initializing...');

        // Get active tab and set tab ID first
        const activeTab = await getActiveTab();
        currentTabId = activeTab.id;
        logger.debug('Active tab ID set:', activeTab.id);

        // Initialize UI event handlers
        initializeUIEventHandlers();

        // Initialize global tooltip system
        initializeTooltips();

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
    // Disconnect from background
    disconnect();
});

// Export functions for use by other modules
export {
    getActiveTab,
    currentTabId
};
