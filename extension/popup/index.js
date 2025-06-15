/**
 * - Initializes the popup UI and components
 * - Coordinates interaction between UI components
 * - Handles message passing with background script
 * - Manages video loading and display flow
 * - Coordinates between state management and UI rendering
 * - Handles user interface events and interactions
 * - Implements popup lifecycle management
 */

// Import ServiceInitializer to coordinate service initialization
import { initializeServices, getActiveTab } from './services/service-initializer.js';
import { themeService, applyTheme } from './services/theme-service.js';
import { initializeUI, setScrollPosition, getScrollPosition, hideInitMessage } from './ui.js';
import { renderVideos } from './video/video-renderer.js';
import { createLogger } from '../shared/utilities/logger.js';
import { normalizeUrl } from '../shared/utilities/normalize-url.js';


const logger = createLogger('Popup');

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
            logger.debug('Connected to background script via port');
            
            // Set up disconnect handler
            backgroundPort.onDisconnect.addListener(() => {
                logger.debug('Port disconnected from background script');
                backgroundPort = null;
            });
            
            // Set up message handler
            backgroundPort.onMessage.addListener(handlePortMessage);
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
    if (message.command === 'videoStateUpdated' && message.videos) {
        logger.debug(`Received ${message.videos.length} videos via port`);
        updateVideoDisplay(message.videos);
        return;
    }
    
    // Handle download progress messages - simple mapping to UI
    if (message.command === 'progress') {
        logger.debug('Received download progress:', message.downloadUrl, message.progress + '%');
        
        // Import download module and map progress to UI
        import('./video/download-handler.js').then(downloadModule => {
            downloadModule.updateDownloadProgress(
                null, // video object not needed
                message.progress || 0,
                message
            );
        });
        return;
    }
    
    // Handle download errors
    if (message.command === 'error') {
        logger.debug('Received download error:', message.downloadUrl);
        
        import('./download-handler.js').then(downloadModule => {
            downloadModule.updateDownloadProgress(
                null,
                0,
                { ...message, error: true }
            );
        });
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
        import('./video/video-renderer.js').then(module => {
            module.updateVideoElement(message.url, message.video);
        });
        
        return;
    }

    // Handle active downloads list for popup restoration
    if (message.command === 'activeDownloadsList' && message.downloads) {
        logger.debug('Received active downloads list:', message.downloads);
        
        // Import download module to process active downloads
        import('./download-handler.js').then(downloadModule => {
            message.downloads.forEach(download => {
                logger.debug('Restoring download state for:', download.downloadUrl);
                
                downloadModule.updateDownloadProgress(
                    null,
                    download.progress || 0,
                    download
                );
            });
        });
        return;
    }

    // Handle preview cache stats response
    if (message.command === 'previewCacheStats') {
        logger.debug('Received preview cache stats:', message.stats);
        
        // Dispatch event for VideoStateService to handle
        document.dispatchEvent(new CustomEvent('background-response', {
            detail: {
                command: 'previewCacheStats',
                stats: message.stats
            }
        }));
        return;
    }
}

/**
 * Single entry point for updating videos in the UI
 * @param {Array} videos - The videos to display
 */
function updateVideoDisplay(videos) {
    logger.debug('Updating video display with', videos.length, 'videos');
    
    const hasVideos = videos.length > 0;
    isEmptyState = !hasVideos;
    
    renderVideos(videos);
    hideInitMessage();
    
    logger.debug(hasVideos ? `Updated UI with ${videos.length} videos` : 'No videos to display, showing empty state');
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
        
        // Get the active tab ID and register with background
        const activeTab = await getActiveTab();
        currentTabId = activeTab.id;
        
        // Register this popup with the background script
        sendPortMessage({
            command: 'register',
            tabId: currentTabId,
            url: normalizeUrl(activeTab.url)
        });

        // Request videos directly from background script
        requestVideos(true);
        
        // Set up periodic refresh to check for new videos
        setupPeriodicRefresh();
        
        // Check for active downloads from previous popup sessions
        import('./download-handler.js').then(downloadModule => {
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