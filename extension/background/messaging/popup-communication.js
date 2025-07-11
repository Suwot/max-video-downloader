/**
 * UI Communication Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { startDownload, cancelDownload, getActiveDownloadProgress, getActiveDownloadCount } from '../download/download-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { clearPreviewCache, getCacheStats } from '../../shared/utils/preview-cache.js';
import { clearAllHeaderCaches } from '../../shared/utils/headers-utils.js';
import { getVideosForDisplay, getVideo, dismissVideoFromTab, cleanupAllVideos } from '../processing/video-store.js';
import nativeHostService from './native-host-service.js';
import { updateTabIcon } from '../state/tab-tracker.js';

// Track all popup connections - simplified single map
const popupPorts = new Map(); // key = portId, value = {port, tabId, url}

// Create a logger instance for the UI Communication module
const logger = createLogger('UI Communication');

// Handle messages coming through port connection
async function handlePortMessage(message, port, portId) {
    logger.debug('Received port message:', message);
    
    // Handle popup registration with URL and tab ID
    if (message.command === 'register' && message.tabId) {
        // Store port information with tab/URL mapping
        popupPorts.set(portId, {
            port: port,
            tabId: message.tabId,
            url: message.url || null
        });
        
        logger.debug(`Registered popup for tab ${message.tabId}${message.url ? ` with URL: ${message.url}` : ''}`);
        return;
    }
    
    // Define commands that don't require tab ID (global operations)
    const globalCommands = ['clearCaches', 'getPreviewCacheStats', 'getDownloadProgress', 'fileSystem'];
    
    // Commands that require tab ID validation (tab-specific operations)
    const tabSpecificCommands = ['getVideos', 'generatePreview', 'download'];
    
    // Special handling for re-downloads: they have isRedownload flag and complete data
    const isRedownload = message.command === 'download' && message.isRedownload === true;
    
    // Validate tabId for tab-specific commands only (except re-downloads)
    if (tabSpecificCommands.includes(message.command) && !isRedownload && !message.tabId) {
        logger.error(`Tab-specific command '${message.command}' missing required tabId:`, message);
        return;
    }
    
    // Route commands to appropriate services
    switch (message.command) {
        case 'getVideos':
            // Delegate to video-manager using unified approach
            sendVideoUpdateToUI(message.tabId, null, { _sendFullList: true });
            
            // Send current download counts
            const downloadCounts = getActiveDownloadCount();
            port.postMessage({
                command: 'downloadCountUpdated',
                counts: downloadCounts
            });
            break;

        case 'getDownloadProgress':
            // Send only download progress states (no video updates)
            const downloadProgress = getActiveDownloadProgress();
            if (downloadProgress.length > 0) {
                logger.debug(`Sending ${downloadProgress.length} download progress states for rerender`);
                downloadProgress.forEach(progressData => {
                    port.postMessage(progressData);
                });
            }
            break;

        case 'dismissVideo':
            // Dismiss the video for this tab
            dismissVideoFromTab(message.tabId, message.url);
            updateTabIcon(message.tabId);
            break;
            
        case 'download':
            if (isRedownload) {
                logger.debug('🔄 Processing re-download request:', message);
            }
            startDownload(message);
            break;
            
        case 'cancel-download':
            cancelDownload(message);
            break;
            
        case 'clearCaches':
            clearAllHeaderCaches(); 
            cleanupAllVideos(); // Includes icon reset for all tabs
            await clearPreviewCache(); // Clear preview cache
            logger.debug('Cleared all caches (video + headers + preview + icons)');
            
            // Send confirmation back to popup
            port.postMessage({
                command: 'cachesCleared',
                success: true
            });
            break;
            
        case 'getPreviewCacheStats':
            try {
                const stats = await getCacheStats();
                port.postMessage({
                    command: 'previewCacheStats',
                    stats: stats
                });
                logger.debug('Sent preview cache stats to popup:', stats);
            } catch (error) {
                logger.error('Error getting preview cache stats:', error);
                port.postMessage({
                    command: 'previewCacheStats',
                    stats: { count: 0, size: 0 },
                    error: error.message
                });
            }
            break;
            
        case 'fileSystem':
            // Handle file system operations through native host
            try {
                await nativeHostService.sendMessage({
                    command: 'fileSystem',
                    operation: message.operation,
                    params: message.params
                });
                logger.debug(`File system operation completed: ${message.operation}`);
            } catch (error) {
                logger.error(`File system operation failed: ${message.operation}`, error);
                // For these operations, we don't need to send error back to popup
                // They are fire-and-forget UI operations
            }
            break;
            
        default:
            logger.warn('Unknown command received:', message.command);
    }
}

/**
 * Sets up port connection for popup communication
 */
function setupPopupPort(port, portId) {
    logger.debug('Popup connected with port ID:', portId);
    
    // Set up message listener
    port.onMessage.addListener((message) => {
        handlePortMessage(message, port, portId);
    });
    
    // Handle port disconnection
    port.onDisconnect.addListener(() => {
        const portInfo = popupPorts.get(portId);
        if (portInfo) {
            logger.debug(`Popup disconnected: tab ${portInfo.tabId}, port ${portId}`);
        }
        popupPorts.delete(portId);
    });
}

/**
 * Broadcasts a message to all connected popups
 */
function broadcastToPopups(message) {
    const invalidPorts = [];
    
    for (const [portId, portInfo] of popupPorts.entries()) {
        try {
            // Validate port structure and connection
            if (!portInfo?.port?.sender) {
                invalidPorts.push(portId);
                continue;
            }
            
            portInfo.port.postMessage(message);
        } catch (error) {
            logger.error(`Error broadcasting to port ${portId}:`, error);
            invalidPorts.push(portId);
        }
    }
    
    // Clean up invalid ports
    if (invalidPorts.length > 0) {
        invalidPorts.forEach(id => popupPorts.delete(id));
        logger.debug(`Cleaned up ${invalidPorts.length} invalid port(s)`);
    }
}

/**
 * Gets the active popup port for a specific tab
 * @param {number} tabId - The ID of the tab to find a port for
 * @returns {Port|null} - The port object if found, or null
 */
function getActivePopupPortForTab(tabId) {
    for (const [portId, portInfo] of popupPorts.entries()) {
        if (portInfo?.tabId === tabId) {
            // Verify port is still valid
            if (portInfo.port?.sender) {
                return portInfo.port;
            } else {
                // Clean up invalid port
                popupPorts.delete(portId);
                logger.debug(`Removed invalid port for tab ${tabId}`);
            }
        }
    }
    return null;
}

/**
 * Unified function to send video updates to UI
 * Will automatically use the best available method
 * @param {number} tabId - Tab ID
 * @param {string} [singleVideoUrl] - Optional URL of a specific video to update
 * @param {Object} [singleVideoObj] - Optional video object to update (if provided with URL)
 */
function sendVideoUpdateToUI(tabId, singleVideoUrl = null, singleVideoObj = null) {
    // Get the port first to see if popup is open
    const port = getActivePopupPortForTab(tabId);

    // If we have a specific video URL but no object, try to get it
    if (singleVideoUrl && !singleVideoObj) {
        const video = getVideo(tabId, singleVideoUrl);
        if (video) {
            singleVideoObj = video;
        }
    }

    // Update tab icon when videos change - delegate to tab tracker
    updateTabIcon(tabId);

    // If popup is open, use direct port communication for efficient updates
    if (port) {
        try {
            // If we have a specific video object, send just that update
            if (singleVideoUrl && singleVideoObj) {
                logger.debug(`Sending single video update via port for: ${singleVideoUrl}`);
                port.postMessage({
                    command: 'videoUpdated',
                    url: singleVideoUrl,
                    video: JSON.parse(JSON.stringify(singleVideoObj))
                });
            }

            // Only for specific lifecycle events (like initializing) or when requested,
            // we send the full list to ensure the popup is synchronized
            if (!singleVideoUrl || singleVideoObj?._sendFullList) {
                const processedVideos = getVideosForDisplay(tabId);
                logger.info(`Sending full video list (${processedVideos.length} videos) via port for tab ${tabId}`);

                if (processedVideos.length > 0) {
                    port.postMessage({
                        command: 'videoStateUpdated',
                        tabId: tabId,
                        videos: processedVideos
                    });
                }
            }

            // Return success if we sent via port
            return true;
        } catch (e) {
            logger.debug(`Error sending update via port: ${e.message}, falling back to runtime message`);
            // Fall through to broadcast method
        }
    } else {
        // No port means popup isn't open, so we only update the maps for when popup opens later
        logger.debug(`No active popup for tab ${tabId}, updates will be shown when popup opens`);
        return false;
    }

    // As fallback only for full list updates, not individual video updates
    // This ensures any future opened popup gets the latest state
    if (!singleVideoUrl || singleVideoObj?._sendFullList) {
        try {
            const processedVideos = getVideosForDisplay(tabId);
            logger.debug(`Sending full list via runtime message for tab ${tabId} (fallback)`);

            chrome.runtime.sendMessage({
                command: 'videoStateUpdated',
                tabId: tabId,
                videos: processedVideos
            });

            return true;
        } catch (e) {
            // Ignore errors for sendMessage, as the popup might not be open
            logger.debug('Error sending video update message (popup may not be open):', e.message);
            return false;
        }
    }

    return false;
}

/**
 * Initialize the UI communication service
 */

export async function initUICommunication() {
    logger.info('Initializing UI communication service');
    
    // Set up listener for port connections
    chrome.runtime.onConnect.addListener(port => {
        if (port.name === 'popup') {
            const portId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            setupPopupPort(port, portId);
        } else {
            logger.warn('Unknown port connection:', port.name);
        }
    });
    
    return true;
}

export { 
    setupPopupPort,
    handlePortMessage,
    broadcastToPopups,
    getActivePopupPortForTab,
    sendVideoUpdateToUI,
    dismissVideoFromTab
};