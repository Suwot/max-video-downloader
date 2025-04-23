// extension/popup/js/index.js
import { initializeState, getCachedVideos } from './state.js';
import { applyTheme, initializeUI, setupScrollPersistence, scrollToLastPosition, showNotification } from './ui.js';
import { updateVideoList } from './video-fetcher.js';
import { renderVideos } from './video-renderer.js';
import { setupAutoDetection } from './video-fetcher.js';
import { initializeNativeConnection, checkNativeHost } from './native-connection.js';

// Check native host connection and show notification if needed
async function checkNativeConnection() {
    try {
        // Check with background script for connection status
        const response = await chrome.runtime.sendMessage({ type: 'checkNativeConnection' });
        
        if (!response || !response.connected) {
            const errorMessage = response.error || "Could not connect to native host. Please ensure the native application is installed properly.";
            console.warn('Native connection issue:', errorMessage);
            
            // Show user-friendly notification
            showNotification({
                type: 'warning',
                title: 'Native Host Connection Issue',
                message: errorMessage,
                duration: 10000, // Show for 10 seconds
                actions: [
                    {
                        label: 'Installation Guide',
                        callback: () => {
                            chrome.tabs.create({ url: 'https://github.com/your-repo/video-downloader/wiki/installation' });
                        }
                    }
                ]
            });
            
            return false;
        }
        
        return true;
    } catch (error) {
        console.error('Error checking native connection:', error);
        return false;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Wait for chrome.storage to be available
        if (!chrome.storage) {
            throw new Error('Chrome storage API not available');
        }

        // Notify content script that popup is open
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
                try {
                    // First check if content script is ready with ping
                    await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
                    
                    // If we get here, content script is ready
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'popupOpened' })
                        .catch(err => console.warn('Error notifying content script:', err));
                } catch (err) {
                    console.warn('Content script not ready yet, popup features may be limited');
                    
                    // Try to inject the content script
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tabs[0].id },
                            files: ["content_script.js"]
                        });
                        
                        // Wait a bit for it to initialize
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        // Try one more time to notify
                        chrome.tabs.sendMessage(tabs[0].id, { action: 'popupOpened' })
                            .catch(err => console.warn('Content script still not ready'));
                    } catch (injectErr) {
                        console.warn('Could not inject content script:', injectErr);
                    }
                }
            }
        } catch (e) {
            console.warn('Error with tab query:', e);
        }

        // Initialize state
        const state = await initializeState();
        
        // Apply theme
        applyTheme(state.currentTheme);
        
        // Initialize UI elements
        initializeUI();
        
        // Initialize native connection and check status
        try {
            await initializeNativeConnection();
            // Check connection status after initialization
            checkNativeConnection();
        } catch (err) {
            console.warn('Native connection initialization failed:', err);
            // Show notification about the error
            showNotification({
                type: 'error',
                title: 'Native Host Connection Failed',
                message: err.message || 'Could not connect to native host application',
                duration: 8000
            });
            // Continue with limited functionality
        }
        
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
                    <div class="error-details">${error.message}</div>
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