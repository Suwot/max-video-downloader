/**
 * @ai-guide-component PopupController
 * @ai-guide-description Main entry point for popup UI functionality
 * @ai-guide-responsibilities
 * - Initializes the popup UI and components
 * - Coordinates interaction between UI components
 * - Handles message passing with background script
 * - Manages video loading and display flow
 * - Coordinates between state management and UI rendering
 * - Handles user interface events and interactions
 * - Implements popup lifecycle management
 */

// extension/popup/js/index.js
import { initializeState, getCachedVideos, getCurrentTheme } from './state.js';
import { applyTheme, initializeUI, setupScrollPersistence, scrollToLastPosition, showLoadingState, hideLoadingState, showNoVideosMessage } from './ui.js';
import { updateVideoList } from './video-fetcher.js';
import { renderVideos } from './video-renderer.js';

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('Popup initializing...');
        
        // Wait for chrome.storage to be available
        if (!chrome.storage) {
            throw new Error('Chrome storage API not available');
        }

        // Initialize state
        const state = await initializeState();
        
        // Apply theme
        applyTheme(state.currentTheme);
        
        // Initialize UI elements
        initializeUI();
        
        // Show loading state immediately - will be hidden when we get videos
        showLoadingState('Loading videos...');
        
        // Get the active tab ID to communicate with background script
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0] || !tabs[0].id) {
            throw new Error('Could not determine active tab');
        }
        const activeTabId = tabs[0].id;
        
        // Attempt to render cached videos immediately
        let hasCachedVideos = false;
        if (state.cachedVideos && state.cachedVideos.length > 0) {
            console.log('Found cached videos, rendering immediately:', state.cachedVideos.length);
            renderVideos(state.cachedVideos);
            hasCachedVideos = true;
            hideLoadingState();
        }
        
        // Setup message listener for new videos from content script
        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === 'newVideoDetected') {
                console.log('Received new videos from content script:', message.videos.length);
                if (message.videos && message.videos.length > 0) {
                    renderVideos(message.videos);
                    hideLoadingState();
                }
            }
        });

        // Notify content script that popup is open
        try {
            chrome.tabs.sendMessage(activeTabId, { action: 'popupOpened' })
                .catch(err => console.log('Content script not ready yet:', err));
        } catch (e) {
            console.log('Error notifying content script:', e);
        }

        // Only force refresh if we don't have cached videos or if they're stale
        // This is crucial to preserve metadata on popup reopens
        const forceRefresh = !hasCachedVideos;
        console.log(hasCachedVideos ? 'Using cached videos, requesting background refresh' : 'Requesting fresh videos from background...');
        const freshVideos = await updateVideoList(forceRefresh, activeTabId);
        
        // Hide loading state if we have videos
        if (freshVideos && freshVideos.length > 0) {
            console.log('Received videos from background:', freshVideos.length);
            hideLoadingState();
        } else if (!hasCachedVideos) {
            // If no cached videos and no fresh videos, show "no videos" message
            console.log('No videos found');
            showNoVideosMessage();
        }
        
        // Watch for system theme changes
        const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        darkModeMediaQuery.addEventListener('change', (e) => {
            // Only update theme automatically if user hasn't set a preference
            chrome.storage.sync.get(['theme'], (result) => {
                // If theme was not explicitly set by the user, follow system preference
                if (result.theme === undefined) {
                    const newTheme = e.matches ? 'dark' : 'light';
                    applyTheme(newTheme);
                }
            });
        });

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