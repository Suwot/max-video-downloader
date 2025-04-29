/**
 * Popup Ports Service
 * Manages communication with popup through persistent connections
 */

// Add static imports at the top
import { getVideosForTab, getPlaylistsForTab, generatePreview, getStreamQualities, 
         fetchManifestContent, storeManifestRelationship, getManifestRelationship } from './video-manager.js';
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
        const videos = getVideosForTab(message.tabId);
        
        port.postMessage({
            action: 'videoListResponse',
            videos: videos
        });
    }
    
    // Handle stored playlists request
    else if (message.action === 'getStoredPlaylists') {
        const playlists = getPlaylistsForTab(message.tabId);
            
        port.postMessage({
            action: 'storedPlaylistsResponse',
            playlists: playlists
        });
    }
    
    // Handle preview generation
    else if (message.type === 'generatePreview') {
        logDebug(`Generating preview for URL: ${message.url}`);
        try {
            const response = await generatePreview(message.url, message.tabId);
            
            // If the port is still open, send the response back
            try {
                port.postMessage({
                    type: 'previewResponse',
                    requestUrl: message.url,
                    previewUrl: response?.previewUrl,
                    error: response?.error
                });
                logDebug(`Preview response sent for ${message.url}`);
            } catch (e) {
                console.error('Error sending preview response:', e);
            }
        } catch (error) {
            logDebug(`Error generating preview: ${error.message}`);
            // If the port is still open, send error
            try {
                port.postMessage({
                    type: 'previewResponse',
                    requestUrl: message.url,
                    error: error.message
                });
            } catch (e) {
                console.error('Error sending preview error response:', e);
            }
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
    
    // Handle manifest-related operations
    else if (message.type === 'fetchManifest') {
        const content = await fetchManifestContent(message.url);
        port.postMessage({
            type: 'manifestContent',
            url: message.url,
            content: content
        });
    }
    else if (message.type === 'storeManifestRelationship') {
        const success = storeManifestRelationship(message.playlistUrl, message.variants);
        port.postMessage({
            type: 'manifestRelationshipStored',
            success: success
        });
    }
    else if (message.type === 'getManifestRelationship') {
        const relationship = getManifestRelationship(message.variantUrl);
        port.postMessage({
            type: 'manifestRelationshipResponse',
            variantUrl: message.variantUrl,
            relationship: relationship
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

    // Handle active downloads list request
    else if (message.action === 'getActiveDownloads') {
        const activeDownloadList = getActiveDownloads();
        
        port.postMessage({
            action: 'activeDownloadsList',
            downloads: activeDownloadList
        });
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
    for (const [portId, portInfo] of popupPorts.entries()) {
        try {
            if (typeof portInfo === 'object' && portInfo.port) {
                portInfo.port.postMessage(message);
            } else {
                // Direct port object
                portInfo.postMessage(message);
            }
        } catch (e) {
            console.error('Error broadcasting to popup:', e);
            popupPorts.delete(portId);
        }
    }
}

/**
 * Gets the active popup port for a specific tab
 * @param {number} tabId - The ID of the tab to find a port for
 * @returns {Port|null} - The port object if found, or null
 */
function getActivePopupPortForTab(tabId) {
    for (const [portId, portInfo] of popupPorts.entries()) {
        if (portInfo.tabId === tabId) {
            return portInfo.port;
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