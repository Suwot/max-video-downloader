/**
 * Popup Ports Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { getVideosArrayFromMap, getStreamQualities, clearVideoCache } from './video-manager.js';
import { getActiveDownloads, getDownloadDetails, startDownload } from './download-manager.js';

// Track all popup connections for universal communication
const popupPorts = new Map(); // key = portId, value = {port, tabId, url}
const urlToTabMap = new Map(); // key = normalizedUrl, value = tabId

// Debug logging helper
function logDebug(...args) {
    console.log('[Popup Ports]', new Date().toISOString(), ...args);
}

// Handle messages coming through port connection
async function handlePortMessage(message, port, portId) {
    logDebug('Received port message:', message);
    
    // Handle popup registration with URL and tab ID
    if (message.action === 'register' && message.tabId) {
        // Store both port information and tab/URL mapping
        popupPorts.set(portId, {
            port: port,
            tabId: message.tabId,
            url: message.url
        });
        
        // Also map URL to tab ID for reverse lookup
        if (message.url) {
            urlToTabMap.set(message.url, message.tabId);
            logDebug(`Registered popup for tab ${message.tabId} with URL: ${message.url}`);
        } else {
            logDebug(`Registered popup for tab ${message.tabId} (no URL provided)`);
        }
        
        return;
    }
    
    // Handle video list request
    if (message.action === 'getVideos') {
        const videos = getVideosArrayFromMap(message.tabId);
        
        port.postMessage({
            action: 'videoListResponse',
            videos: videos
        });
    }
    
    // Handle preview generation request - now handled through enrichWithPreview in video-manager.js
    else if (message.type === 'generatePreview') {
        logDebug(`Preview request received for URL: ${message.url}`);
        try {
            // Just get the videos and check if any have a matching URL
            const videos = getVideosArrayFromMap(message.tabId);
            const matchingVideo = videos.find(v => v.url === message.url);
            
            // Return any existing preview or let the popup know we're working on it
            if (matchingVideo && matchingVideo.previewUrl) {
                port.postMessage({
                    type: 'previewResponse',
                    requestUrl: message.url,
                    previewUrl: matchingVideo.previewUrl
                });
            } else {
                port.postMessage({
                    type: 'previewPending',
                    requestUrl: message.url
                });
                
                // Add or update the video in video-manager to trigger preview generation
                // The background will notify the popup when the preview is ready
                if (matchingVideo) {
                    // Force preview generation by requesting it through standard channels
                    port.postMessage({
                        action: 'videoPreviewRequested',
                        url: message.url,
                        tabId: message.tabId
                    });
                }
            }
        } catch (error) {
            logDebug(`Error handling preview request: ${error.message}`);
            port.postMessage({
                type: 'previewResponse',
                requestUrl: message.url,
                error: error.message
            });
        }
    }
    
    // Handle download request
    else if (message.type === 'download' || message.type === 'downloadHLS') {
        startDownload(message, port);
    }
    
    // Handle stream qualities request
    else if (message.type === 'getHLSQualities') {
        const response = await getStreamQualities(message.url);
        
        port.postMessage({
            type: 'qualitiesResponse',
            url: message.url,
            ...response
        });
    }

    // Handle download details request
    else if (message.action === 'getDownloadDetails' && message.downloadId) {
        const download = getDownloadDetails(message.downloadId);
        
        if (download) {
            port.postMessage({
                type: 'downloadDetails',
                ...download
            });
        } else {
            port.postMessage({
                type: 'downloadNotFound',
                downloadId: message.downloadId
            });
        }
    }

    // Handle clear caches request from popup
    else if (message.action === 'clearCaches') {
        // Clear video cache in video manager
        clearVideoCache();
        
        port.postMessage({
            action: 'cacheCleared',
            success: true
        });
        
        logDebug('Cleared video caches');
    }

    // Handle active downloads list request
    else if (message.action === 'getActiveDownloads') {
        const activeDownloadList = getActiveDownloads();
        
        try {
            port.postMessage({
                action: 'activeDownloadsList',
                downloads: activeDownloadList
            });
        } catch (e) {
            console.error('Error sending active downloads list:', e);
        }
    }
}

/**
 * Sets up port connection for popup communication
 */
function setupPopupPort(port, portId) {
    // Store in general popup port collection
    popupPorts.set(portId, { port });
    logDebug('Popup connected with port ID:', portId);
    
    // Set up message listener for general popup communication
    port.onMessage.addListener((message) => {
        handlePortMessage(message, port, portId);
    });
    
    // Handle port disconnection
    port.onDisconnect.addListener(() => {
        popupPorts.delete(portId);
        logDebug('Popup port disconnected and removed:', portId);
    });
}

/**
 * Broadcasts a message to all connected popups
 */
function broadcastToPopups(message) {
    const portsToRemove = [];
    
    for (const [portId, portInfo] of popupPorts.entries()) {
        try {
            // First, check if the port exists and appears valid
            if (!portInfo || (!portInfo.port && typeof portInfo !== 'object')) {
                portsToRemove.push(portId);
                continue;
            }
            
            // Check if the port is still connected by accessing its sender
            // This is a more reliable way to check if a port is still valid
            const port = typeof portInfo === 'object' ? portInfo.port : portInfo;
            
            if (port && port.sender) {
                port.postMessage(message);
            } else {
                portsToRemove.push(portId);
            }
        } catch (e) {
            console.error('Error broadcasting to popup:', e);
            portsToRemove.push(portId);
        }
    }
    
    // Clean up any invalid ports identified during broadcast
    if (portsToRemove.length > 0) {
        portsToRemove.forEach(id => popupPorts.delete(id));
        logDebug(`Removed ${portsToRemove.length} invalid port(s)`);
    }
}

/**
 * Gets the active popup port for a specific tab
 * @param {number} tabId - The ID of the tab to find a port for
 * @returns {Port|null} - The port object if found, or null
 */
function getActivePopupPortForTab(tabId) {
    for (const [portId, portInfo] of popupPorts.entries()) {
        try {
            // Check if this port is for the requested tab
            if (portInfo && portInfo.tabId === tabId) {
                // Verify the port is still valid by checking its sender property
                if (portInfo.port && portInfo.port.sender) {
                    return portInfo.port;
                } else {
                    // Port is invalid, clean it up
                    popupPorts.delete(portId);
                    logDebug(`Removed invalid port for tab ${tabId}`);
                }
            }
        } catch (e) {
            console.error(`Error checking port for tab ${tabId}:`, e);
            popupPorts.delete(portId);
        }
    }
    return null;
}

export { 
    setupPopupPort,
    handlePortMessage,
    broadcastToPopups,
    getActivePopupPortForTab
};