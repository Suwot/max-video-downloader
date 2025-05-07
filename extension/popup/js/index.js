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
import { renderVideos } from './video-renderer.js';

// Global port connection for communicating with the background script
let backgroundPort = null;
let currentTabId = null;
let refreshInterval = null;
let isEmptyState = true; // Track if we're currently showing "No videos found"

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
            
            // Register this popup with tab ID and URL
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
                if (backgroundPort && tabs[0]) {
                    // Normalize URL by removing query params and fragments
                    const normalizedUrl = normalizeUrl(tabs[0].url);
                    currentTabId = tabs[0].id;
                    
                    backgroundPort.postMessage({
                        action: 'register',
                        tabId: tabs[0].id,
                        url: normalizedUrl
                    });
                }
            });
        } catch (e) {
            console.error('Failed to connect to background script:', e);
            return null;
        }
    }
    return backgroundPort;
}

/**
 * Normalize URL by removing query params and fragments
 * @param {string} url - The URL to normalize
 * @return {string} - Normalized URL
 */
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.origin}${urlObj.pathname}`;
    } catch (e) {
        return url;
    }
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
        
        // If we get videos when previously there were none, update the UI
        if (message.videos.length > 0) {
            isEmptyState = false;
            renderVideos(message.videos);
            hideLoadingState();
        } else if (!isEmptyState) {
            // Only update if we're not already showing empty state
            renderVideos(message.videos);
            hideLoadingState();
            isEmptyState = true;
        }
        
        // Cache videos for future quick access
        if (currentTabId) {
            chrome.storage.local.set({
                [`processedVideos_${currentTabId}`]: message.videos,
                lastVideoUpdate: Date.now()
            });
            console.log('Cached videos for tab', currentTabId);
        }
    }
    
    // Handle video state updates
    else if (message.action === 'videoStateUpdated' && message.videos) {
        console.log('Received video state update via port:', message.videos.length);
        
        // If we get videos when previously there were none, update the UI
        if (message.videos.length > 0) {
            isEmptyState = false;
            renderVideos(message.videos);
            hideLoadingState();
        } else if (!isEmptyState) {
            // Only update if we're not already showing empty state
            renderVideos(message.videos);
            hideLoadingState();
            isEmptyState = true;
        }
        
        // Cache updated videos
        if (message.tabId && message.tabId === currentTabId) {
            chrome.storage.local.set({
                [`processedVideos_${message.tabId}`]: message.videos,
                lastVideoUpdate: Date.now()
            });
            console.log('Cached updated videos for tab', message.tabId);
        }
    }
    
    // Handle new video detection notification - this is the key to auto-updating
    else if (message.action === 'newVideoDetected') {
        console.log('Received new video detection notification');
        // Force a refresh of the video list
        requestVideos(true);
    }
    
    // Handle metadata updates
    else if (message.type === 'metadataUpdate' && message.url && message.mediaInfo) {
        console.log('Received metadata update for video:', message.url);
        import('./video-renderer.js').then(module => {
            module.updateVideoMetadata(message.url, message.mediaInfo);
            
            // Also update the cache
            import('./state.js').then(stateModule => {
                stateModule.addMediaInfoToCache(message.url, message.mediaInfo);
            });
        });
    }
    
    // Handle active downloads list
    else if (message.action === 'activeDownloadsList' && message.downloads) {
        console.log('Received active downloads list:', message.downloads);
        
        // Import download module to process active downloads
        import('./download.js').then(downloadModule => {
            // Process each active download
            message.downloads.forEach(download => {
                // Update UI for each download
                downloadModule.updateDownloadProgress(
                    { url: download.url },
                    download.progress || 0,
                    download
                );
            });
        });
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
    
    // Handle live preview updates for proactively generated previews
    else if (message.type === 'previewReady') {
        console.log('Received preview update:', message.videoUrl);
        
        // Find the video element in the UI
        const videoElement = document.querySelector(`.video-item[data-url="${message.videoUrl}"]`);
        if (videoElement) {
            // Find the preview image
            const previewImage = videoElement.querySelector('.preview-image');
            const loader = videoElement.querySelector('.loader');
            const regenerateButton = videoElement.querySelector('.regenerate-button');
            
            if (previewImage) {
                // Add load handler before setting src
                previewImage.onload = () => {
                    previewImage.classList.remove('placeholder');
                    previewImage.classList.add('loaded');
                    if (loader) loader.style.display = 'none';
                    if (regenerateButton) regenerateButton.classList.add('hidden');
                };
                
                // Set the preview source
                previewImage.src = message.previewUrl;
                
                // Cache the preview for future use
                import('./state.js').then(stateModule => {
                    stateModule.addPosterToCache(message.videoUrl, message.previewUrl);
                });
            }
        }
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
            backgroundPort = null;
            return false;
        }
    }
    console.warn('No port connection available', message);
    return false;
}

/**
 * Request videos for the current tab
 * @param {boolean} forceRefresh - Whether to force a refresh from the background
 */
function requestVideos(forceRefresh = false) {
    if (!currentTabId) return;
    
    sendPortMessage({ 
        action: 'getVideos', 
        tabId: currentTabId,
        forceRefresh
    });
}

/**
 * Set up a periodic refresh to check for new videos
 * Especially important if popup was opened before videos were detected
 */
function setupPeriodicRefresh() {
    // Clear any existing interval
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    
    // Create a new interval - refresh every 2.5 seconds if we're in empty state
    refreshInterval = setInterval(() => {
        if (isEmptyState) {
            console.log("Performing periodic check for new videos...");
            requestVideos(true);
        }
    }, 2500);
}

/**
 * Clean up the periodic refresh interval
 */
function cleanupPeriodicRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

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
        
        // Connect to background script via port (but don't request videos yet)
        getBackgroundPort();
        
        // Get the active tab ID
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0] || !tabs[0].id) {
            throw new Error('Could not determine active tab');
        }
        currentTabId = tabs[0].id;
        
        // Show loading state initially
        showLoadingState('Loading videos...');
        
        // STEP 1: Fast render from storage (for immediate display)
        let hasStoredVideos = false;
        try {
            const storageKey = `processedVideos_${currentTabId}`;
            const result = await chrome.storage.local.get(storageKey);
            if (result[storageKey] && result[storageKey].length > 0) {
                console.log('Found stored videos, rendering immediately:', result[storageKey].length);
                renderVideos(result[storageKey]);
                hasStoredVideos = true;
                isEmptyState = false;
                hideLoadingState();
            } else {
                isEmptyState = true;
            }
        } catch (e) {
            console.error('Error retrieving stored videos:', e);
            isEmptyState = true;
        }
        
        // STEP 2: Request fresh videos through port connection
        requestVideos(!hasStoredVideos);
        
        // STEP 3: Set up periodic refresh to check for new videos
        setupPeriodicRefresh();
        
        // Check for active downloads from previous popup sessions
        import('./download.js').then(downloadModule => {
            downloadModule.checkForActiveDownloads().catch(err => {
                console.error('Error checking for active downloads:', err);
            });
        });
        
        // Notify content script that popup is open
        try {
            chrome.tabs.sendMessage(currentTabId, { action: 'popupOpened' })
                .catch(err => console.log('Content script not ready yet:', err));
        } catch (e) {
            console.log('Error notifying content script:', e);
        }
        
        // Add Clear Cache button handler
        document.getElementById('clear-cache-btn')?.addEventListener('click', () => {
            console.log('Clear cache button clicked');
            import('./state.js').then(stateModule => {
                stateModule.clearAllCaches().then(() => {
                    console.log('Caches cleared, requesting fresh videos');
                    requestVideos(true);
                });
            });
        });
        
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
    // Clean up the refresh interval
    cleanupPeriodicRefresh();
    
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