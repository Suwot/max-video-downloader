// extension/popup/js/index.js
import { initializeState, getCachedVideos } from './state.js';
import { applyTheme, initializeUI, setupScrollPersistence, scrollToLastPosition } from './ui.js';
import { updateVideoList } from './video-fetcher.js';
import { renderVideos } from './video-renderer.js';
import { setupAutoDetection } from './video-fetcher.js';

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Wait for chrome.storage to be available
        if (!chrome.storage) {
            throw new Error('Chrome storage API not available');
        }

        // Notify content script that popup is open
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'popupOpened' })
                        .catch(err => console.log('Content script not ready yet'));
                }
            });
        } catch (e) {
            console.log('Error notifying content script:', e);
        }

        // Initialize state
        const state = await initializeState();
        
        // Apply theme
        applyTheme(state.currentTheme);
        
        // Initialize UI elements
        initializeUI();
        
        // Initial video list update - render cached videos immediately if available
        if (state.cachedVideos) {
            renderVideos(state.cachedVideos);
        }
        
        // Always update in background to get fresh data
        updateVideoList(true);
        
        // Setup auto-detection - always enabled now
        setupAutoDetection();
        
        // Setup scroll persistence
        setupScrollPersistence();
        
        // Restore scroll position if needed
        scrollToLastPosition();
        
    } catch (error) {
        console.error('Initialization error:', error);
        const container = document.getElementById('videos');
        if (container) {
            container.innerHTML = `
                <div class="initial-message">
                    Failed to initialize the extension. Please try reloading.
                </div>
            `;
        }
    }
});

// Listen for popup unload to notify content script
window.addEventListener('unload', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            try {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'popupClosed' });
            } catch (e) {
                // Suppress errors on unload
            }
        }
    });
}); 