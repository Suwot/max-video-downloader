/**
 * UI Communication Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { processDownloadCommand, cancelDownload, getActiveDownloadProgress, getActiveDownloadCount } from '../download/download-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { clearPreviewCache, getCacheStats } from '../../shared/utils/preview-cache.js';
import { clearAllHeaderCaches } from '../../shared/utils/headers-utils.js';
import { getVideosForDisplay, getVideo, dismissVideoFromTab, cleanupAllVideos, getVideoTypeCounts } from '../processing/video-store.js';
import nativeHostService from './native-host-service.js';
import { updateTabIcon } from '../state/tab-manager.js';
import { settingsManager } from '../index.js';
import { generateVideoPreview } from '../processing/video-processor.js';

// Track all popup connections - simplified single map
const popupPorts = new Map(); // key = portId, value = {port, tabId, url}

// Create a logger instance for the UI Communication module
const logger = createLogger('UI Communication');

// Debounce map for rapid updates to same video
const updateDebounceMap = new Map(); // key: `${tabId}-${videoUrl}`, value: timeoutId

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
            // Send full refresh when popup requests videos
            sendVideoUpdateToUI(message.tabId, 'full-refresh');
            
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

        case 'generatePreview':
            // Manual preview generation request
            if (message.tabId && message.url) {
                try {
                    const video = getVideo(message.tabId, message.url);
                    if (video) {
                        // Call generateVideoPreview directly - it will handle the full flow
                        await generateVideoPreview(message.tabId, message.url, video.headers || {});
                        logger.debug(`Manual preview generation triggered for: ${message.url}`);
                    }
                } catch (error) {
                    logger.error(`Error in manual preview generation: ${error.message}`);
                }
            }
            break;

        case 'dismissVideo':
            // Dismiss the video for this tab
            dismissVideoFromTab(message.tabId, message.url);
            updateTabIcon(message.tabId);
            // Send updated counters after dismissal
            {
                const videoCounts = getVideoTypeCounts(message.tabId);
                port.postMessage({
                    command: 'update-ui-counters',
                    tabId: message.tabId,
                    counts: videoCounts
                });
            }
            break;
            
        case 'download':
            if (isRedownload) {
                logger.debug('🔄 Processing re-download request:', message);
            }
            processDownloadCommand(message);
            break;
            
        case 'cancel-download':
            cancelDownload(message);
            break;
            
        case 'clearCaches':
            updateTabIcon();
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
            
        case 'chooseSavePath':
            try {
                const result = await settingsManager.chooseSavePath();
                port.postMessage({
                    command: 'settingsState',
                    settings: settingsManager.getAll(),
                    success: result.success
                });
            } catch (error) {
                logger.error('Error choosing save path:', error);
                port.postMessage({
                    command: 'settingsState',
                    settings: settingsManager.getAll(),
                    success: false,
                    error: error.message
                });
            }
            break;
            
        case 'getNativeHostState':
            port.postMessage({
                command: 'nativeHostConnectionState',
                connectionState: nativeHostService.getConnectionState()
            });
            break;
            
        case 'reconnectNativeHost':
            try {
                await nativeHostService.reconnect();
                // Connection state will be broadcast automatically via nativeHostConnectionState
            } catch (error) {
                logger.error('Error reconnecting native host:', error);
                // Send current state even on error - it contains the error info
                port.postMessage({
                    command: 'nativeHostConnectionState',
                    connectionState: nativeHostService.getConnectionState()
                });
            }
            break;
            
        case 'ensureNativeHostConnection':
            // Ensure native host connection for popup startup
            nativeHostService.ensureConnection().catch(err => {
                logger.debug('Popup native host connection failed:', err.message);
            });
            break;
            
        case 'fileSystem':
            // Handle file system operations through native host
            try {
                const result = await nativeHostService.sendMessage({
                    command: 'fileSystem',
                    operation: message.operation,
                    params: message.params
                });
                logger.debug(`File system operation completed: ${message.operation}`, result);
            } catch (error) {
                logger.error(`File system operation failed: ${message.operation}`, error);
                // For these operations, we don't need to send error back to popup
                // They are fire-and-forget UI operations
            }
            break;
            
        case 'getSettings':
            try {
                const settings = settingsManager.getAll();
                port.postMessage({
                    command: 'settingsState',
                    settings: settings
                });
                logger.debug('Sent current settings to popup:', settings);
            } catch (error) {
                logger.error('Error getting settings:', error);
                port.postMessage({
                    command: 'settingsState',
                    settings: {},
                    error: error.message
                });
            }
            break;
            
        case 'updateSettings':
            try {
                const success = await settingsManager.updateAll(message.settings);
                const updatedSettings = settingsManager.getAll();
                port.postMessage({
                    command: 'settingsState',
                    settings: updatedSettings,
                    success: success
                });
                logger.debug('Updated settings and sent response to popup:', updatedSettings);
            } catch (error) {
                logger.error('Error updating settings:', error);
                port.postMessage({
                    command: 'settingsState',
                    settings: settingsManager.getAll(),
                    success: false,
                    error: error.message
                });
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

// Set up broadcast function for native host service to avoid circular dependency
nativeHostService.setBroadcastFunction(broadcastToPopups);

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
 * Enhanced function to send video updates to UI with action-based updates
 * @param {number} tabId - Tab ID
 * @param {string} action - Update action: 'add', 'update', 'remove', or 'full-refresh'
 * @param {string} [videoUrl] - Video URL for targeted updates
 * @param {Object} [videoData] - Video data for add/update actions
 * @param {Object} [options] - Additional options including updateType
 */
function sendVideoUpdateToUI(tabId, action = 'full-refresh', videoUrl = null, videoData = null, options = {}) {
    // Get the port first to see if popup is open
    const port = getActivePopupPortForTab(tabId);

    // If no popup is open, skip sending updates
    if (!port) {
        logger.debug(`No active popup for tab ${tabId}, skipping update`);
        return false;
    }

    try {
        // Always send updated counters with every update
        const videoCounts = getVideoTypeCounts(tabId);
        port.postMessage({
            command: 'update-ui-counters',
            tabId,
            counts: videoCounts
        });

        // Handle different action types
        switch (action) {
            case 'add':
            case 'update':
                if (videoUrl && videoData) {
                    port.postMessage({
                        command: 'videos-state-update',
                        action: action,
                        updateType: options.updateType || 'structural',
                        tabId: tabId,
                        videoUrl: videoUrl,
                        video: JSON.parse(JSON.stringify(videoData))
                    });
                    return true;
                }
                break;
            case 'remove':
                if (videoUrl) {
                    port.postMessage({
                        command: 'videos-state-update',
                        action: 'remove',
                        tabId: tabId,
                        videoUrl: videoUrl
                    });
                    return true;
                }
                break;
            case 'full-refresh':
                const processedVideos = getVideosForDisplay(tabId);
                logger.debug(`Sending full refresh with ${processedVideos.length} videos for tab ${tabId}`);
                port.postMessage({
                    command: 'videos-state-update',
                    action: 'full-refresh',
                    tabId: tabId,
                    videos: processedVideos
                });
                return true;
        }
        logger.warn(`Invalid action or missing parameters for sendVideoUpdateToUI: ${action}`);
        return false;
    } catch (error) {
        logger.error(`Error sending video update: ${error.message}`);
        return false;
    }
}

/**
 * Helper function to send video state changes with automatic action detection
 * @param {number} tabId - Tab ID
 * @param {string} videoUrl - Video URL
 * @param {Object} updateResult - Result from updateVideo function
 * @param {Object} [options] - Additional options
 */
function sendVideoStateChange(tabId, videoUrl, updateResult, options = {}) {
    if (!updateResult?.updatedVideo) {
        logger.warn(`No valid update result for video: ${videoUrl}`);
        return false;
    }

    const { updatedVideo, action, updateType } = updateResult;
    const debounceKey = `${tabId}-${videoUrl}`;

    // Clear existing debounce timer
    if (updateDebounceMap.has(debounceKey)) {
        clearTimeout(updateDebounceMap.get(debounceKey));
    }

    // Use shorter debounce for flag updates, longer for structural updates
    const debounceMs = updateType === 'flags' ? 25 : (options.debounceMs || 50);

    // Set debounce timer for rapid updates
    const timeoutId = setTimeout(() => {
        updateDebounceMap.delete(debounceKey);
        sendVideoUpdateToUI(tabId, action, videoUrl, updatedVideo, { ...options, updateType });
    }, debounceMs);

    updateDebounceMap.set(debounceKey, timeoutId);
    return true;
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
    sendVideoStateChange,
    dismissVideoFromTab
};