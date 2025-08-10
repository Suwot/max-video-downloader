/**
 * Popup entry point - simple initialization and coordination
 */

import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl, formatCacheStats } from '../shared/utils/processing-utils.js';
import { connect, disconnect, sendPortMessage, sendRuntimeMessage } from './communication.js';
import { restoreActiveDownloads, cleanupAllElapsedTimeTimers } from './video/download-progress-handler.js';
import { renderHistoryItems, renderVideos } from './video/video-renderer.js';
import { initializeSettingsTab } from './settings-tab.js';
import { switchTab, updateUICounters } from './ui-utils.js';

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
 * Load and display cache stats
 */
async function loadCacheStats(cacheStatsElement) {
    try {
        const response = await sendRuntimeMessage({ command: 'get-preview-cache-stats' });
        if (response.success) {
            cacheStatsElement.textContent = formatCacheStats(response.stats);
        } else {
            cacheStatsElement.textContent = 'Failed to load stats';
            logger.error('Cache stats request failed:', response.error);
        }
    } catch (error) {
        logger.error('Failed to load cache stats:', error);
        cacheStatsElement.textContent = 'Failed to load stats';
    }
}

/**
 * Clear caches and update display
 */
async function clearCaches(cacheStatsElement) {
    try {
        const response = await sendRuntimeMessage({ command: 'clear-caches' });
        if (response.success) {
            cacheStatsElement.textContent = formatCacheStats(response.stats);
            logger.debug('Caches cleared successfully:', response.message);
 
            await renderVideos([]);
            updateUICounters({ videos: { hls: 0, dash: 0, direct: 0, unknown: 0, total: 0 } });
            
            return true;
        } else {
            cacheStatsElement.textContent = 'Failed to clear cache';
            logger.error('Cache clear request failed:', response.error);
            return false;
        }
    } catch (error) {
        logger.error('Failed to clear caches:', error);
        cacheStatsElement.textContent = 'Failed to clear cache';
        return false;
    }
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

    // Clear cache button
    const clearCacheButton = document.getElementById('clear-cache-button');
    const cacheStats = clearCacheButton?.querySelector('.cache-stats');
	// Load initial stats using runtime messaging
	loadCacheStats(cacheStats);
	
	// Handle click with real response feedback
	clearCacheButton.addEventListener('click', async () => {
		clearCacheButton.disabled = true;
		cacheStats.textContent = 'Clearing...';
		
		const success = await clearCaches(cacheStats);
		if (success) {
			// Show temporary success message, then reload stats
			cacheStats.textContent = 'Cache cleared!';
			setTimeout(() => {
				loadCacheStats(cacheStats);
			}, 1500);
		}
		
		clearCacheButton.disabled = false;
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
