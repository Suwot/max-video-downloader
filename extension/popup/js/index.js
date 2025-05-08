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
import { initializeState, getCurrentTheme } from './state.js';
import { applyTheme, initializeUI, setupScrollPersistence, scrollToLastPosition, showLoadingState, hideLoadingState, showNoVideosMessage } from './ui.js';
import { renderVideos } from './video-renderer.js';
// Import our new VideoStateService
import { videoStateService } from './services/video-state-service.js';

// Global port connection for communicating with the background script
let backgroundPort = null;
let currentTabId = null;
let refreshInterval = null;
let isEmptyState = true; // Track if we're currently showing "No videos found"

// Batching for metadata updates
const metadataUpdateBatch = {
    updates: new Map(),
    timeoutId: null,
    batchTimeMs: 100, // Process updates every 100ms

    /**
     * Add a metadata update to the batch
     * @param {string} url - Video URL
     * @param {Object} mediaInfo - Media information
     */
    add(url, mediaInfo) {
        this.updates.set(url, mediaInfo);
        
        // Schedule processing if not already scheduled
        if (!this.timeoutId) {
            this.timeoutId = setTimeout(() => this.process(), this.batchTimeMs);
        }
    },
    
    /**
     * Process all batched metadata updates
     */
    process() {
        if (this.updates.size === 0) return;
        
        console.log(`Processing batch of ${this.updates.size} metadata updates`);
        
        // Get the module for DOM updates
        import('./video-renderer.js').then(module => {
            // Process all DOM updates in one go
            this.updates.forEach((mediaInfo, url) => {
                module.updateVideoMetadata(url, mediaInfo);
            });
        });
        
        // Update cache for all videos in batch
        if (currentTabId) {
            chrome.storage.local.get([`processedVideos_${currentTabId}`], result => {
                const storageKey = `processedVideos_${currentTabId}`;
                const videos = result[storageKey] || [];
                let hasChanges = false;
                
                // Update all videos with new metadata
                this.updates.forEach((mediaInfo, url) => {
                    const index = videos.findIndex(v => v.url === url);
                    if (index !== -1) {
                        videos[index] = {
                            ...videos[index],
                            mediaInfo: mediaInfo,
                            resolution: {
                                width: mediaInfo.width,
                                height: mediaInfo.height,
                                fps: mediaInfo.fps,
                                bitrate: mediaInfo.videoBitrate || mediaInfo.totalBitrate
                            }
                        };
                        hasChanges = true;
                    }
                });
                
                // Only update storage if we made changes
                if (hasChanges) {
                    chrome.storage.local.set({
                        [storageKey]: videos,
                        lastVideoUpdate: Date.now()
                    });
                }
            });
        }
        
        // Notify the VideoStateService about the updates
        this.updates.forEach((mediaInfo, url) => {
            document.dispatchEvent(new CustomEvent('metadata-update', {
                detail: { url, mediaInfo }
            }));
        });
        
        // Clear the batch
        this.updates.clear();
        this.timeoutId = null;
    }
};

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
    
    // Handle video updates with a unified approach
    if ((message.action === 'videoListResponse' || message.action === 'videoStateUpdated') && message.videos) {
        console.log(`Received ${message.videos.length} videos via port`);
        updateVideoDisplay(message.videos);
        return;
    }
    
    // Handle new video detection notification
    if (message.action === 'newVideoDetected') {
        console.log('Received new video detection notification');
        // Force a refresh of the video list
        requestVideos(true);
        return;
    }
    
    // Handle metadata updates
    if (message.type === 'metadataUpdate' && message.url && message.mediaInfo) {
        console.log('Received metadata update for video:', message.url);
        metadataUpdateBatch.add(message.url, message.mediaInfo);
        return;
    }
    
    // Handle active downloads list
    if (message.action === 'activeDownloadsList' && message.downloads) {
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
        return;
    }
    
    // Handle manifest responses
    if (message.type === 'manifestContent') {
        console.log('Received manifest content via port');
        document.dispatchEvent(new CustomEvent('manifest-content', { 
            detail: message 
        }));
        return;
    }
    
    // Handle preview responses
    if (message.type === 'previewResponse') {
        console.log('Received preview data via port');
        document.dispatchEvent(new CustomEvent('preview-generated', { 
            detail: message 
        }));
        return;
    }
    
    // Handle live preview updates for proactively generated previews
    if (message.type === 'previewReady') {
        console.log('Received preview update:', message.videoUrl);
        
        // Dispatch an event that VideoStateService listens for
        document.dispatchEvent(new CustomEvent('preview-ready', { 
            detail: {
                videoUrl: message.videoUrl,
                previewUrl: message.previewUrl
            }
        }));
        
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
            }
        }
        return;
    }
    
    // Handle quality responses
    if (message.type === 'qualitiesResponse') {
        console.log('Received qualities data via port');
        document.dispatchEvent(new CustomEvent('qualities-response', { 
            detail: message 
        }));
        return;
    }
}

/**
 * Single entry point for updating videos in the UI
 * @param {Array} videos - The videos to display
 * @param {boolean} updateCache - Whether to update the cache
 */
function updateVideoDisplay(videos, updateCache = true) {
    console.log('Updating video display with', videos.length, 'videos');
    
    // Videos are already processed by the background script,
    // so we can directly render them without additional processing
    
    // Update UI state
    if (videos.length > 0) {
        isEmptyState = false;
        // Render videos directly without additional processing
        renderVideos(videos);
        hideLoadingState();
    } else if (!isEmptyState) {
        // Only update if we're not already showing empty state
        renderVideos(videos);
        hideLoadingState();
        isEmptyState = true;
    }
    
    // Update cache if needed
    if (updateCache && currentTabId) {
        chrome.storage.local.set({
            [`processedVideos_${currentTabId}`]: videos,
            lastVideoUpdate: Date.now()
        });
        console.log('Cached videos for tab', currentTabId);
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

        // Initialize state - we'll keep using this for theme and UI preferences
        const state = await initializeState();
        
        // Apply theme
        applyTheme(state.currentTheme);
        
        // Initialize UI elements
        initializeUI();
        
        // Initialize our VideoStateService
        await videoStateService.initialize();
        
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
            // Use VideoStateService to get videos from storage
            const cachedVideos = await videoStateService.getVideosFromStorage();
            if (cachedVideos && cachedVideos.length > 0) {
                console.log('Found stored videos, rendering immediately:', cachedVideos.length);
                // Use the centralized function to update videos
                updateVideoDisplay(cachedVideos, false); // Don't re-cache
                hasStoredVideos = true;
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
        
        // Add Clear Cache button handler - use our new service
        document.getElementById('clear-cache-btn')?.addEventListener('click', async () => {
            console.log('Clear cache button clicked');
            await videoStateService.clearCaches();
            console.log('Caches cleared, requesting fresh videos');
            requestVideos(true);
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