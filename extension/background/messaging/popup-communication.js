/**
 * UI Communication Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { processDownloadCommand, cancelDownload, getActiveDownloadCount, getActiveDownloads } from '../download/download-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { clearPreviewCache, getCacheStats } from '../../shared/utils/preview-cache.js';
import { clearAllHeaders } from '../../shared/utils/headers-utils.js';
import { getVideo, dismissVideoFromTab, cleanupAllVideos, sendFullRefresh } from '../processing/video-store.js';
import nativeHostService from './native-host-service.js';
import { updateTabIcon } from '../state/tab-manager.js';
import { settingsManager } from '../index.js';
import { generateVideoPreview, clearAllProcessing } from '../processing/video-processor.js';

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
            sendFullRefresh(message.tabId);
            
            // Send current download counts
            const downloadCounts = getActiveDownloadCount();
            port.postMessage({
                command: 'downloadCountUpdated',
                counts: downloadCounts
            });
            break;

        case 'getActiveDownloads':
            // Send active downloads from in-memory Map for UI restoration
            const activeDownloads = getActiveDownloads();
            port.postMessage({
                command: 'activeDownloadsData',
                activeDownloads: activeDownloads
            });
            logger.debug(`Sent ${activeDownloads.length} active downloads with progress data for UI restoration`);
            break;

        case 'generatePreview':
            // Manual preview generation request
            if (message.tabId && message.url) {
                try {
                    const video = getVideo(message.tabId, message.url);
                    if (video) {
                        // Call generateVideoPreview directly - it will handle the full flow
                        await generateVideoPreview(video);
                        logger.debug(`Manual preview generation triggered for: ${message.url}`);
                    }
                } catch (error) {
                    logger.error(`Error in manual preview generation: ${error.message}`);
                }
            }
            break;

        case 'dismissVideo':
            // Dismiss the video for this tab (counters and icon updated automatically)
            dismissVideoFromTab(message.tabId, message.url);
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
            clearAllHeaders(); 
            cleanupAllVideos(); // Includes icon reset for all tabs
			clearAllProcessing(); // Clear all processing state
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
                // Check coapp availability
                const session = await chrome.storage.session.get(['coappAvailable']);
                if (!session.coappAvailable) {
                    throw new Error('CoApp not available');
                }
                
                const result = await nativeHostService.sendMessage({
                    command: 'fileSystem',
                    operation: message.operation,
                    params: message.params
                });
                logger.debug(`File system operation completed: ${message.operation}`, result);
                
                // Handle deleteFile operation - always update history storage regardless of success/error
                if (message.operation === 'deleteFile' && message.completedAt) {
                    try {
                        // Update history entry with deleted flag
                        const historyResult = await chrome.storage.local.get(['downloads_history']);
                        const history = historyResult.downloads_history || [];
                        
                        const updatedHistory = history.map(entry => {
                            if (entry.completedAt == message.completedAt) {
                                return { ...entry, deleted: true };
                            }
                            return entry;
                        });
                        
                        await chrome.storage.local.set({ downloads_history: updatedHistory });
                        logger.debug('Updated history with deleted flag:', message.completedAt);
                        
                        // Send response back to popup for UI update (pass through original result)
                        port.postMessage({
                            command: 'fileSystemResponse',
                            operation: 'deleteFile',
                            success: result.success,
                            error: result.error,
                            completedAt: message.completedAt
                        });
                    } catch (storageError) {
                        logger.error('Failed to update history after file deletion:', storageError);
                        port.postMessage({
                            command: 'fileSystemResponse',
                            operation: 'deleteFile',
                            success: false,
                            error: 'Failed to update history',
                            completedAt: message.completedAt
                        });
                    }
                }
            } catch (error) {
                logger.warn(`File system operation failed: ${message.operation}`, error);
                
                // Handle showInFolder and openFile errors - treat "File not found" as deleted file (reuse existing logic)
                if ((message.operation === 'showInFolder' || message.operation === 'openFile') && error.message === 'File not found' && message.completedAt) {
                    // Reuse the same logic as deleteFile - update storage and send response
                    try {
                        const historyResult = await chrome.storage.local.get(['downloads_history']);
                        const history = historyResult.downloads_history || [];
                        
                        const updatedHistory = history.map(entry => {
                            if (entry.completedAt == message.completedAt) {
                                return { ...entry, deleted: true };
                            }
                            return entry;
                        });
                        
                        await chrome.storage.local.set({ downloads_history: updatedHistory });
                        logger.debug(`Updated history with deleted flag after ${message.operation} error:`, message.completedAt);
                        
                        // Send response back to popup for UI update
                        port.postMessage({
                            command: 'fileSystemResponse',
                            operation: message.operation,
                            success: false,
                            error: 'File not found',
                            completedAt: message.completedAt
                        });
                    } catch (storageError) {
                        logger.error(`Failed to update history after ${message.operation} error:`, storageError);
                        port.postMessage({
                            command: 'fileSystemResponse',
                            operation: message.operation,
                            success: false,
                            error: 'Failed to update history',
                            completedAt: message.completedAt
                        });
                    }
                    return;
                }
                
                // Send error response for deleteFile operation - still update history
                if (message.operation === 'deleteFile' && message.completedAt) {
                    try {
                        // Update history entry with deleted flag even on error
                        const historyResult = await chrome.storage.local.get(['downloads_history']);
                        const history = historyResult.downloads_history || [];
                        
                        const updatedHistory = history.map(entry => {
                            if (entry.completedAt == message.completedAt) {
                                return { ...entry, deleted: true };
                            }
                            return entry;
                        });
                        
                        await chrome.storage.local.set({ downloads_history: updatedHistory });
                        logger.debug('Updated history with deleted flag after error:', message.completedAt);
                    } catch (storageError) {
                        logger.error('Failed to update history after file deletion error:', storageError);
                    }
                    
                    port.postMessage({
                        command: 'fileSystemResponse',
                        operation: 'deleteFile',
                        success: false,
                        error: error.message || 'Failed to delete file',
                        completedAt: message.completedAt
                    });
                }
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
 * Handle runtime messages (request-response pattern)
 * Currently not used at all
 */
async function handleRuntimeMessage(message, sender, sendResponse) {
    logger.debug('Received runtime message:', message.command);
    
    switch (message.command) {
        default:
            logger.warn('Unknown runtime message command:', message.command);
            sendResponse({ success: false, error: 'Unknown command' });
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
 * Initialize the UI communication service
 */
async function initUICommunication() {
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
	
    // Set up listener for runtime messages (request-response pattern)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleRuntimeMessage(message, sender, sendResponse);
        return true; // Keep channel open for async responses
    });
    
    return true;
}

export { 
    setupPopupPort,
    handlePortMessage,
    broadcastToPopups,
    getActivePopupPortForTab,
	initUICommunication
};