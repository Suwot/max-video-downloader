/**
 * UI Communication Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { getVideosForDisplay, clearVideoCache, sendVideoUpdateToUI } from './video-manager.js';
import nativeHostService from './native-host-service.js';
import { getRequestHeaders } from '../../js/utilities/headers-utils.js';
import { createLogger } from '../../js/utilities/logger.js';
import { clearCache, getCacheStats } from '../../js/utilities/preview-cache.js';

// Track all popup connections - simplified single map
const popupPorts = new Map(); // key = portId, value = {port, tabId, url}

// Track active downloads for popup restoration - minimal state
const activeDownloads = new Map(); // key = downloadUrl, value = {downloadUrl, masterUrl, filename, progress, status, startTime}

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
    const globalCommands = ['clearCaches', 'getActiveDownloads', 'getPreviewCacheStats'];
    
    // Commands that require tab ID validation (tab-specific operations)
    const tabSpecificCommands = ['getVideos', 'generatePreview', 'download'];
    
    // Validate tabId for tab-specific commands only
    if (tabSpecificCommands.includes(message.command) && !message.tabId) {
        logger.error(`Tab-specific command '${message.command}' missing required tabId:`, message);
        return;
    }
    
    // Route commands to appropriate services
    switch (message.command) {
        case 'getVideos':
            // Delegate to video-manager using unified approach
            sendVideoUpdateToUI(message.tabId, null, { _sendFullList: true });
            break;
            
        case 'generatePreview':
            // Pure delegation - let video-manager handle everything
            logger.debug(`Preview request for ${message.url} - delegating to video-manager`);
            // Video-manager will handle preview generation through its processing pipeline
            // No need to duplicate logic here - just log the request
            break;
            
        case 'download':
            handleDownloadRequest(message, port);
            break;
            
        case 'clearCaches':
            // Clear both video cache and preview cache
            clearVideoCache();
            await clearCache(); // Clear preview cache
            logger.debug('Cleared all caches (video + preview)');
            
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
            
        case 'getActiveDownloads':
            try {
                const activeDownloadList = Array.from(activeDownloads.values());
                port.postMessage({
                    command: 'activeDownloadsList',
                    downloads: activeDownloadList
                });
                logger.debug(`Sent ${activeDownloadList.length} active downloads to popup`, activeDownloadList);
            } catch (error) {
                logger.error('Error sending active downloads list:', error);
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
 * Streamlined download handler - core of simplified flow
 * @param {Object} message - Download request message
 * @param {Port} port - Port connection for immediate response
 */
async function handleDownloadRequest(message, port) {
    // Check for duplicate download (duplicate prevention)
    if (activeDownloads.has(message.downloadUrl)) {
        logger.debug('Download already active:', message.downloadUrl);
        const existingDownload = activeDownloads.get(message.downloadUrl);
        
        // Send current state to requesting popup
        port.postMessage({
            command: 'progress',
            downloadUrl: message.downloadUrl,
            masterUrl: message.masterUrl || null,
            filename: message.filename,
            progress: existingDownload.progress || 0,
            status: existingDownload.status
        });
        return;
    }
    
    try {
        // Prepare native host message
        const nativeHostMessage = {
            command: 'download',
            downloadUrl: message.downloadUrl,
            filename: message.filename,
            savePath: message.savePath || null,
            type: message.type,
            fileSizeBytes: message.fileSizeBytes || null,
            segmentCount: message.segmentCount || null,
            preferredContainer: message.preferredContainer || null,
            originalContainer: message.originalContainer || 'mp4',
            audioOnly: message.audioOnly || false,
            streamSelection: message.streamSelection || null,
            masterUrl: message.masterUrl || null,
            duration: message.duration || null,
            headers: getRequestHeaders(message.tabId || -1, message.downloadUrl) || {}
        };
        
        // Add to active downloads map (single source of truth)
        activeDownloads.set(message.downloadUrl, {
            downloadUrl: message.downloadUrl,
            masterUrl: message.masterUrl || null,
            filename: message.filename,
            progress: 0,
            status: 'downloading',
            startTime: Date.now()
        });
        
        // Create notification immediately
        const notificationId = `download-${Date.now()}`;
        chrome.notifications.create(notificationId, {
            type: 'basic',
            iconUrl: '../../icons/48.png',
            title: 'Downloading Video',
            message: `Starting download: ${message.filename}`
        });
        
        // Start download with progress stream
        nativeHostService.sendMessage(nativeHostMessage, (response) => {
            // Update active downloads state
            if (activeDownloads.has(message.downloadUrl)) {
                const download = activeDownloads.get(message.downloadUrl);
                download.progress = response.progress || 0;
                download.status = response.success !== undefined ? 'complete' : 'downloading';
                
                // Clean up completed downloads
                if (response.success !== undefined || response.error) {
                    activeDownloads.delete(message.downloadUrl);
                }
            }
            
            // Broadcast progress to all popups (they will map if needed)
            broadcastToPopups({
                command: 'progress',
                downloadUrl: message.downloadUrl,
                masterUrl: message.masterUrl || null,
                filename: message.filename,
                ...response
            });
        }).catch(error => {
            logger.error('Download failed:', error);
            activeDownloads.delete(message.downloadUrl);
            
            broadcastToPopups({
                command: 'error',
                downloadUrl: message.downloadUrl,
                masterUrl: message.masterUrl || null,
                error: error.message
            });
        });
        
        logger.debug('🔄 Download initiated:', message.downloadUrl);
        
    } catch (error) {
        logger.error('Download setup failed:', error);
        activeDownloads.delete(message.downloadUrl);
        
        broadcastToPopups({
            command: 'error',
            downloadUrl: message.downloadUrl,
            masterUrl: message.masterUrl || null,
            error: error.message
        });
    }
}

/**
 * Initialize the UI communication service
 * @returns {Promise<boolean>} Success status
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
    getActivePopupPortForTab
};