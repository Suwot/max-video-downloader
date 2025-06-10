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

// Import ServiceInitializer to coordinate service initialization
import { initializeServices, getActiveTab } from './services/service-initializer.js';
import { themeService, applyTheme } from './services/theme-service.js';
import { initializeUI, setScrollPosition, getScrollPosition, hideInitMessage } from './ui.js';
import { renderVideos } from './video-list/video-renderer.js';
import { createLogger } from '../../js/utilities/logger.js';
import { normalizeUrl } from '../../js/utilities/normalize-url.js';


const logger = createLogger('Popup');

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
        
        logger.debug(`Processing batch of ${this.updates.size} metadata updates`);
        
        // Get the module for DOM updates
        import('./video-list/video-renderer.js').then(module => {
            // Process all DOM updates in one go
            this.updates.forEach((mediaInfo, url) => {
                module.updateVideoElement(url, mediaInfo, true);
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
            logger.debug('Connected to background script via port');
            
            // Set up disconnect handler
            backgroundPort.onDisconnect.addListener(() => {
                logger.debug('Port disconnected from background script');
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
                        command: 'register',
                        tabId: tabs[0].id,
                        url: normalizedUrl
                    });
                }
            });
        } catch (e) {
            logger.error('Failed to connect to background script:', e);
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
    logger.debug('Received port message:', message);
    
    // Handle video updates with a unified approach
    if ((message.command === 'videoListResponse' || message.command === 'videoStateUpdated') && message.videos) {
        logger.debug(`Received ${message.videos.length} videos via port`);
        updateVideoDisplay(message.videos);
        return;
    }

    // Handle metadata updates
    if (message.command === 'metadataUpdate' && message.url && message.mediaInfo) {
        logger.debug('Received metadata update for video:', message.url);
        metadataUpdateBatch.add(message.url, message.mediaInfo);
        return;
    }
    
    // Handle active downloads list
    if (message.command === 'activeDownloadsList' && message.downloads) {
        logger.debug('Received active downloads list:', message.downloads);
        
        // Import download module to process active downloads
        import('./download.js').then(downloadModule => {
            // Process each active download
            message.downloads.forEach(download => {
                // Update UI for each download
                downloadModule.updateDownloadProgress(
                    { downloadUrl: download.downloadUrl },
                    download.progress || 0,
                    download
                );
            });
        });
        return;
    }
    
    // Handle manifest responses
    if (message.command === 'manifestContent') {
        logger.debug('Received manifest content via port');
        document.dispatchEvent(new CustomEvent('manifest-content', { 
            detail: message 
        }));
        return;
    }
    
    // Handle preview responses
    if (message.command === 'previewResponse') {
        logger.debug('Received preview data via port');
        document.dispatchEvent(new CustomEvent('preview-generated', { 
            detail: message 
        }));
        return;
    }
    
    // Handle live preview updates for proactively generated previews
    if (message.command === 'previewReady') {
        logger.debug('Received preview update:', message.videoUrl);
        
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
            
            if (previewImage) {
                // Add load handler before setting src
                previewImage.onload = () => {
                    previewImage.classList.remove('placeholder');
                    previewImage.classList.add('loaded');
                    if (loader) loader.style.display = 'none';
                };
                
                // Set the preview source
                previewImage.src = message.previewUrl;
                
                // Add hover functionality for the newly loaded preview
                const previewContainer = videoElement.querySelector('.preview-container');
                if (previewContainer) {
                    import('./video-list/video-renderer.js').then(module => {
                        previewContainer.addEventListener('mouseenter', (event) => {
                            if (module.showHoverPreview) {
                                module.showHoverPreview(message.previewUrl, event);
                            }
                        });
                        
                        previewContainer.addEventListener('mousemove', (event) => {
                            if (module.showHoverPreview) {
                                module.showHoverPreview(message.previewUrl, event);
                            }
                        });
                        
                        previewContainer.addEventListener('mouseleave', () => {
                            if (module.hideHoverPreview) {
                                module.hideHoverPreview();
                            }
                        });
                    });
                }
            }
        }
        return;
    }

    // Handle unified video updates - new handler for single video updates
    if (message.command === 'videoUpdated') {
        logger.debug('Received unified video update:', message.url);
        
        // Dispatch an event that VideoStateService will handle
        document.dispatchEvent(new CustomEvent('video-updated', { 
            detail: {
                url: message.url,
                video: message.video
            }
        }));
        
        // Also update the UI element directly for faster response
        import('./video-list/video-renderer.js').then(module => {
            module.updateVideoElement(message.url, message.video);
        });
        
        return;
    }
}

/**
 * Single entry point for updating videos in the UI
 * @param {Array} videos - The videos to display
 */
function updateVideoDisplay(videos) {
    logger.debug('Updating video display with', videos.length, 'videos');
    
    // Update VideoStateService with the new videos
    import('./services/video-state-service.js').then(module => {
        module.updateVideos(videos);
    }).catch(err => {
        logger.error('Error importing video-state-service:', err);
    });
    
    // Update UI state immediately without waiting for import
    if (videos.length > 0) {
        isEmptyState = false;
        // Render videos directly
        renderVideos(videos);
        hideInitMessage();
        logger.debug('Updated UI with', videos.length, 'videos');
    } else if (!isEmptyState) {
        // Only update if we're not already showing empty state
        renderVideos(videos);
        hideInitMessage();
        isEmptyState = true;
        logger.debug('No videos to display, showing empty state');
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
            logger.error('Error sending message via port:', e);
            backgroundPort = null;
            return false;
        }
    }
    logger.warn('No port connection available', message);
    return false;
}

/**
 * Request videos for the current tab
 * @param {boolean} forceRefresh - Whether to force a refresh from the background
 */
function requestVideos(forceRefresh = false) {
    if (!currentTabId) return;
    
    sendPortMessage({ 
        command: 'getVideos', 
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
            logger.debug("Performing periodic check for new videos...");
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
        logger.debug('Popup initializing...');
        
        // Initialize all services in the proper order
        const serviceState = await initializeServices();
        
        // Apply theme using ThemeService
        applyTheme(themeService.getTheme());
        
        // Initialize UI elements
        initializeUI();
        
        // Connect to background script via port
        getBackgroundPort();
        
        // Get the active tab ID using our helper
        const activeTab = await getActiveTab();
        currentTabId = activeTab.id;

        // Request videos directly from background script
        requestVideos(true);
        
        // Set up periodic refresh to check for new videos
        setupPeriodicRefresh();
        
        // Check for active downloads from previous popup sessions
        import('./download.js').then(downloadModule => {
            downloadModule.checkForActiveDownloads().catch(err => {
                logger.error('Error checking for active downloads:', err);
            });
        });
        
        // Add Clear Cache button handler - simplified for in-memory approach
        document.getElementById('clear-cache-btn')?.addEventListener('click', async () => {
            logger.debug('Clear cache button clicked');
            requestVideos(true);
        });
        
        // Watch for system theme changes
        const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        darkModeMediaQuery.addEventListener('change', themeService.handleSystemThemeChange.bind(themeService));

        // Set up scroll position handling
        const container = document.getElementById('videos');
        if (container && currentTabId) {
            // Save position when scrolling
            container.addEventListener('scroll', () => {
                setScrollPosition(currentTabId, container.scrollTop);
            });
            
            // Restore position for this tab
            getScrollPosition(currentTabId, (position) => {
                setTimeout(() => {
                    if (container.scrollHeight > container.clientHeight) {
                        container.scrollTop = position;
                    }
                }, 50);
            });
        }
        
    } catch (error) {
        logger.error('Initialization error:', error);
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
    
    // Save final scroll position
    const container = document.getElementById('videos');
    if (container && currentTabId) {
        setScrollPosition(currentTabId, container.scrollTop);
    }
    
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