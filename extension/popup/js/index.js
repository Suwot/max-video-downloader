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

// Global port connection for communicating with the background script
let backgroundPort = null;

/**
 * Establish a connection to the background script
 * @returns {Port} The connection port object
 */
export function getBackgroundPort() {
    if (!backgroundPort) {
        try {
            backgroundPort = chrome.runtime.connect({ name: 'popup' });
            console.log('Connected to background script via port');
            
            // Set up disconnect handler
            backgroundPort.onDisconnect.addListener(() => {
                console.log('Port disconnected from background script');
                backgroundPort = null;
            });
            
            // Set up message handler
            backgroundPort.onMessage.addListener(handlePortMessage);
        } catch (e) {
            console.error('Failed to connect to background script:', e);
            return null;
        }
    }
    return backgroundPort;
}

/**
 * Handle messages received via the port connection
 * @param {Object} message - Message received from background script
 */
function handlePortMessage(message) {
    console.log('Received port message:', message);
    
    // Handle video list responses
    if (message.action === 'videoListResponse' && message.videos) {
        console.log('Received video list via port:', message.videos.length);
        renderVideos(message.videos);
        hideLoadingState();
    }
    
    // Handle video state updates
    else if (message.action === 'videoStateUpdated' && message.videos) {
        console.log('Received video state update via port:', message.videos.length);
        renderVideos(message.videos);
        hideLoadingState();
    }
    
    // Handle manifest responses
    else if (message.type === 'manifestContent') {
        console.log('Received manifest content via port');
        document.dispatchEvent(new CustomEvent('manifest-content', { 
            detail: message 
        }));
    }
    
    // Handle preview responses
    else if (message.type === 'previewResponse') {
        console.log('Received preview data via port');
        document.dispatchEvent(new CustomEvent('preview-generated', { 
            detail: message 
        }));
    }
    
    // Handle quality responses
    else if (message.type === 'qualitiesResponse') {
        console.log('Received qualities data via port');
        document.dispatchEvent(new CustomEvent('qualities-response', { 
            detail: message 
        }));
    }
}

/**
 * Send a message to the background script using the port connection
 * @param {Object} message - Message to send to the background script
 * @returns {Boolean} - Success status
 */
export function sendPortMessage(message) {
    const port = getBackgroundPort();
    if (port) {
        try {
            port.postMessage(message);
            return true;
        } catch (e) {
            console.error('Error sending message via port:', e);
            return false;
        }
    }
    
    // Fall back to one-time message if port isn't available
    try {
        chrome.runtime.sendMessage(message);
        return true;
    } catch (e) {
        console.error('Error sending one-time message:', e);
        return false;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('Popup initializing...');
        
        // Connect to background script via port
        getBackgroundPort();
        
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
        
        // Check for active downloads from previous popup sessions
        import('./download.js').then(downloadModule => {
            // Since checkForActiveDownloads is now async, handle it properly
            downloadModule.checkForActiveDownloads().catch(err => {
                console.error('Error checking for active downloads:', err);
            });
        });
        
        // Get the active tab ID to communicate with background script
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0] || !tabs[0].id) {
            throw new Error('Could not determine active tab');
        }
        const activeTabId = tabs[0].id;
        
        // First check for pre-processed videos from background script storage
        // These are videos that have been fully processed while the popup was closed
        let hasPreProcessedVideos = false;
        try {
            const storageKey = `processedVideos_${activeTabId}`;
            const result = await chrome.storage.local.get(storageKey);
            if (result[storageKey] && result[storageKey].length > 0) {
                console.log('Found pre-processed videos from background storage:', result[storageKey].length);
                renderVideos(result[storageKey]);
                hasPreProcessedVideos = true;
            }
        } catch (e) {
            console.error('Error retrieving pre-processed videos:', e);
        }
        
        // If we don't have pre-processed videos, try getting videos through port
        if (!hasPreProcessedVideos) {
            try {
                // First try using port connection
                sendPortMessage({ 
                    action: 'getVideos', 
                    tabId: activeTabId 
                });
                
                // Also try one-time message as fallback
                const backgroundVideos = await chrome.runtime.sendMessage({ 
                    action: 'getVideos', 
                    tabId: activeTabId 
                });
                
                if (backgroundVideos && backgroundVideos.length > 0) {
                    console.log('Got videos from background script via one-time message:', backgroundVideos.length);
                    renderVideos(backgroundVideos);
                    hasPreProcessedVideos = true;
                }
            } catch (e) {
                console.error('Error fetching videos from background:', e);
            }
        }
        
        // Attempt to render cached videos as a fallback
        let hasCachedVideos = hasPreProcessedVideos;
        if (!hasCachedVideos && state.cachedVideos && state.cachedVideos.length > 0) {
            console.log('Found cached videos, rendering immediately:', state.cachedVideos.length);
            renderVideos(state.cachedVideos);
            hasCachedVideos = true;
        }
        
        // Only show loading state if we have no videos at all
        if (!hasCachedVideos) {
            showLoadingState('Loading videos...');
        }
        
        // Setup message listener for video updates from both content script and background script
        chrome.runtime.onMessage.addListener((message) => {
            // Handle new videos from content script
            if (message.action === 'newVideoDetected' && message.videos && message.videos.length > 0) {
                console.log('Received new videos from content script:', message.videos.length);
                renderVideos(message.videos);
                hideLoadingState();
            }
            
            // Handle video state updates from background script
            if (message.action === 'videoStateUpdated' && 
                message.tabId === activeTabId && 
                message.videos && 
                message.videos.length > 0) {
                
                console.log('Received video state update from background script:', message.videos.length);
                renderVideos(message.videos);
                hideLoadingState();
            }
        });

        // Notify content script that popup is open
        try {
            chrome.tabs.sendMessage(activeTabId, { action: 'popupOpened' })
                .catch(err => console.log('Content script not ready yet:', err));
        } catch (e) {
            console.log('Error notifying content script:', e);
        }

        // Force refresh if we don't have any videos yet
        const forceRefresh = !hasCachedVideos;
        console.log(hasCachedVideos ? 'Using cached videos, requesting background refresh' : 'Requesting fresh videos from background...');
        const freshVideos = await updateVideoList(forceRefresh, activeTabId);
        
        // Start background refresh to automatically get new videos every 3 seconds
        const { startBackgroundRefreshLoop, stopBackgroundRefreshLoop } = await import('./video-fetcher.js');
        startBackgroundRefreshLoop(3000, activeTabId);
        
        // Stop the refresh loop when popup closes
        window.addEventListener('unload', () => {
            stopBackgroundRefreshLoop();
            
            // Disconnect port when popup closes
            if (backgroundPort) {
                try {
                    backgroundPort.disconnect();
                    backgroundPort = null;
                } catch (e) {
                    // Suppress errors during unload
                }
            }
        });
        
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
    
    // Disconnect port
    if (backgroundPort) {
        try {
            backgroundPort.disconnect();
            backgroundPort = null;
        } catch (e) {
            // Suppress errors during unload
        }
    }
});