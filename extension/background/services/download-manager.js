/**
 * Download Manager Service
 * Handles video download operations including progress tracking and notifications
 * Uses a simplified approach with direct communication to UI through existing popup ports
 * 
 * SIMPLIFIED FLOW:
 * 1. UI sends download request with url field used as ID
 * 2. Download manager tracks download in single Map using url as key
 * 3. Native host downloads and reports progress
 * 4. Download manager broadcasts updates to all UIs via shared communication system
 * 5. UI matches updates to video items by url
 */

// Add static import at the top
import nativeHostService from '../../js/native-host-service.js';
import { getRequestHeaders } from '../../js/utilities/headers-utils.js';
import { createLogger } from '../../js/utilities/logger.js';
import { broadcastToPopups } from './ui-communication.js';

// Track all downloads in a single map using url as key
const downloads = new Map(); // key = url (downloadId), value = { url, progress, status, startTime, etc. }

// Create a logger instance for the Download Manager module
const logger = createLogger('Download Manager');

/**
 * Initialize download manager service
 * @returns {Promise<boolean>} Success status
 */
export async function initDownloadManager() {
    logger.info('Initializing download manager service');
    
    try {
        // Simple initialization - no port setup needed as we use the main UI communication system
        return true;
    } catch (error) {
        logger.error('Failed to initialize download manager:', error);
        return false;
    }
}

/**
 * Broadcasts download status update to all connected popups
 * @param {Object} message - The message to broadcast
 */
function broadcastDownloadUpdate(message) {
    // Use the existing UI communication broadcast system
    broadcastToPopups(message);
}

/**
 * Initiates a download and sets up progress tracking
 * @param {Object} request - Download request details
 * @param {Object} port - Port to send immediate responses to
 * @returns {string} The download ID (same as data-url)
 */
function startDownload(request, port) {
    // Use downloadUrl as the download ID for simple tracking
    const downloadId = request.downloadUrl;
    
    // Check if this download is already in progress
    if (downloads.has(downloadId) && downloads.get(downloadId).status === 'downloading') {
        logger.debug('Download already in progress for:', downloadId);
        
        if (port) {
            try {
                const download = downloads.get(downloadId);
                port.postMessage({
                    command: 'progress',
                    downloadId: downloadId,
                    progress: download.progress || 0,
                    filename: download.filename,
                    downloadUrl: download.downloadUrl
                });
            } catch (e) {
                logger.error('Error sending existing download info to port:', e);
            }
        }
        
        return downloadId;
    }
    
    // Show initial notification
    const notificationId = `download-${downloadId}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: '../../icons/48.png',
      title: 'Downloading Video',
      message: `Starting download: ${request.filename}`
    });
    
    // Store initial download information in a single map
    downloads.set(downloadId, {
        downloadUrl: request.downloadUrl,
        progress: 0,
        status: 'downloading',
        startTime: Date.now(),
        lastUpdated: Date.now(),
        filename: request.filename,
        tabId: request.tabId || -1,
        type: request.type,  // 'hls', 'dash', or 'direct'
        originalContainer: request.originalContainer || null,
        preferredContainer: request.preferredContainer || null,
        notificationId: notificationId,
        savePath: request.savePath || null,
        audioOnly: request.audioOnly || false,
        streamSelection: request.streamSelection || null,
        masterUrl: request.masterUrl || null,
        duration: request.duration || null
    });
    
    // Create response handler with downloadId context
    let hasError = false;
    const responseHandler = (response) => {
        if (!response) return;
        
        const download = downloads.get(downloadId);
        if (!download) {
            logger.error('Received response for unknown download:', downloadId);
            return;
        }
        
        if (response.command === 'progress' && !hasError) {
            // Update stored download information
            download.progress = response.progress || 0;
            download.speed = response.speed;
            download.eta = response.eta;
            download.segmentProgress = response.segmentProgress;
            download.downloaded = response.downloaded;
            download.size = response.size;
            download.lastUpdated = Date.now();
            
            // Update notification less frequently to avoid flooding
            if (response.progress % 10 === 0) {
                let message = `Downloading: ${Math.round(response.progress)}%`;
                if (response.segmentProgress) {
                    message += ` (Segment: ${response.segmentProgress})`;
                }
                
                chrome.notifications.update(download.notificationId, { message });
            }
            
            // Broadcast progress to all connected popups
            broadcastDownloadUpdate({
                command: 'progress',
                progress: response.progress || 0,
                filename: download.filename,
                downloadUrl: download.downloadUrl,
                speed: response.speed,
                eta: response.eta,
                segmentProgress: response.segmentProgress,
                downloaded: response.downloaded,
                size: response.size
            });
            
        } else if (response.success && !hasError) {
            // Update download status
            download.status = 'completed';
            download.completeTime = Date.now();
            download.progress = 100;
            
            // Show completion notification
            chrome.notifications.update(download.notificationId, {
                title: 'Download Complete',
                message: `Saved to: ${response.path}`
            });
            
            // Broadcast completion to all connected popups
            broadcastDownloadUpdate({
                command: 'complete',
                path: response.path,
                filename: download.filename,
                downloadUrl: download.downloadUrl
            });
            
            // Keep completed download info for a while
            setTimeout(() => {
                downloads.delete(downloadId);
                logger.debug('Removed completed download info:', downloadId);
            }, 30 * 60 * 1000); // 30 minutes
            
        } else if (response.error && !hasError) {
            // Update download status
            download.status = 'error';
            download.error = response.error;
            hasError = true;
            
            // Show error notification
            chrome.notifications.update(download.notificationId, {
                title: 'Download Failed',
                message: response.error
            });
            
            // Broadcast error to all connected popups
            broadcastDownloadUpdate({
                command: 'error',
                error: response.error,
                downloadUrl: download.downloadUrl
            });
        }
    };
    
    // Send to native host using our service with correct parameters
    logger.debug('🔄 Forwarding download request to native host:', request.downloadUrl);
    
    try {
        // Fetch headers for the video
        const headers = getRequestHeaders(request.tabId || -1, request.downloadUrl);
        
        // Construct native host message with correctly named parameters that match native host expectations
        const nativeHostMessage = {
            command: 'download',
            // Core parameters - match exactly with native host execute() method
            downloadUrl: request.downloadUrl,
            filename: request.filename,
            savePath: request.savePath || null,
            type: request.type,
            fileSizeBytes: request.fileSizeBytes || null,
            segmentCount: request.segmentCount || null,
            preferredContainer: request.preferredContainer || null,
            originalContainer: request.originalContainer || 'mp4',
            audioOnly: request.audioOnly || false,
            streamSelection: request.streamSelection || null,
            masterUrl: request.masterUrl || null,
            duration: request.duration || null,
            headers: headers || {}
        };

        logger.debug('Sending download request to native host with params:', nativeHostMessage);

        // Send to native host service
        nativeHostService.sendMessage(nativeHostMessage, responseHandler)
            .catch(error => {
                logger.error('❌ Native host error:', error);
                
                // Update download status
                const download = downloads.get(downloadId);
                if (download) {
                    download.status = 'error';
                    download.error = error.message;
                }
                
                // Show error notification
                chrome.notifications.update(notificationId, {
                    title: 'Download Failed',
                    message: error.message
                });
                
                // Broadcast error to UI
                broadcastDownloadUpdate({
                    command: 'error',
                    error: error.message,
                    downloadUrl: request.downloadUrl
                });
            });
    } catch (error) {
        logger.error('❌ Error initiating download:', error);
        
        // Update download status
        const download = downloads.get(downloadId);
        if (download) {
            download.status = 'error';
            download.error = error.message;
        }
        
        // Show error notification
        chrome.notifications.update(notificationId, {
            title: 'Download Failed',
            message: error.message
        });
        
        // Broadcast error to UI
        broadcastDownloadUpdate({
            command: 'error',
            error: error.message,
            downloadUrl: request.downloadUrl
        });
    }
    
    return downloadId;
}

/**
 * Gets list of active downloads
 */
function getActiveDownloads() {
    return Array.from(downloads.entries())
        .filter(([id, info]) => info.status === 'downloading')
        .map(([id, info]) => ({
            downloadId: id,
            downloadUrl: info.downloadUrl,
            progress: info.progress || 0,
            status: info.status,
            filename: info.filename || info.title,
            startTime: info.startTime,
            lastUpdated: info.lastUpdated,
            speed: info.speed,
            eta: info.eta,
            segmentProgress: info.segmentProgress,
        }));
}

/**
 * Gets details of a specific download by ID
 */
function getDownloadDetails(downloadId) {
    const download = downloads.get(downloadId);
    if (!download) return null;
    
    return {
        downloadId: downloadId,
        downloadUrl: download.downloadUrl,
        progress: download.progress || 0,
        status: download.status,
        filename: download.filename
    };
}

/**
 * Cleans up downloads for a closed tab
 */
function cleanupDownloadsForTab(tabId) {
    for (const [downloadId, downloadInfo] of downloads.entries()) {
        if (downloadInfo.tabId === tabId && downloadInfo.status === 'downloading') {
            logger.debug('Cleaning up download for closed tab:', downloadId);
            // Currently just logs the event - could add cancellation logic here if desired
            // downloads.delete(downloadId);
        }
    }
}

export { 
    startDownload,
    getActiveDownloads,
    getDownloadDetails,
    cleanupDownloadsForTab
};