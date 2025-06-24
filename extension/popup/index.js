/**
 * Popup entry point - simple initialization and coordination
 */

import { initializeUI } from './ui.js';
import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/normalize-url.js';
import { initializeState, setTabId, getTheme, setTheme, getGroupState, setGroupState, setScrollPosition, getScrollPosition } from './state.js';
import { connect, disconnect, sendPortMessage } from './communication.js';

const logger = createLogger('Popup');

/**
 * Apply theme to document
 */
function applyTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('theme-dark');
        document.body.classList.remove('theme-light');
    } else {
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
    }
}

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

        // Initialize state (theme, group states)
        const state = await initializeState();
        
        // Apply current theme to UI
        applyTheme(state.theme);
        
        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)')
            .addEventListener('change', async (event) => {
                const currentResult = await chrome.storage.sync.get(['theme']);
                if (currentResult.theme === undefined) {
                    const newTheme = event.matches ? 'dark' : 'light';
                    await setTheme(newTheme);
                    applyTheme(newTheme);
                }
            });

        // Get active tab and set tab ID
        const activeTab = await getActiveTab();
        setTabId(activeTab.id);

        // Initialize UI
        initializeUI();

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

        // Set up clear cache button
        document.getElementById('clear-cache-btn')?.addEventListener('click', () => {
            logger.debug('Clear cache button clicked');
            sendPortMessage({ command: 'clearCaches' });
        });

        // Set up scroll position handling
        const container = document.getElementById('videos');
        if (container) {
            // Save scroll position on scroll
            container.addEventListener('scroll', () => {
                setScrollPosition(container.scrollTop);
            });
            
            // Restore scroll position
            setTimeout(() => {
                const position = getScrollPosition();
                if (position > 0 && container.scrollHeight > container.clientHeight) {
                    container.scrollTop = position;
                }
            }, 50);
        }
        
    } catch (error) {
        logger.error('Initialization error:', error);
        const container = document.getElementById('videos');
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
window.addEventListener('unload', () => {
    // Save final scroll position
    const container = document.getElementById('videos');
    if (container) {
        setScrollPosition(container.scrollTop);
    }
    
    // Disconnect from background
    disconnect();
});

// Export functions for use by other modules
export {
    getTheme,
    setTheme,
    getGroupState,
    setGroupState,
    getActiveTab,
    applyTheme,
};
