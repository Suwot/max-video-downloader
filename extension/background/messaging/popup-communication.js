/**
 * UI Communication Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { sendVideoUpdateToUI, cleanupAllVideos } from '../processing/video-manager.js';
import { startDownload } from '../download/download-manager.js';
import { createLogger } from '../../shared/utils/logger.js';
import { clearPreviewCache, getCacheStats } from '../../shared/utils/preview-cache.js';
import { clearAllHeaderCaches } from '../../shared/utils/headers-utils.js'

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
    const globalCommands = ['clearCaches', 'getPreviewCacheStats'];
    
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
            
        case 'download':
            startDownload(message);
            break;
            
        case 'clearCaches':
            clearAllHeaderCaches(); 
            cleanupAllVideos(); // everything from video-manager
            await clearPreviewCache(); // Clear preview cache
            logger.debug('Cleared all caches (video + headers + preview)');
            
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
    getActivePopupPortForTab
};