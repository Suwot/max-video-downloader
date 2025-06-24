/**
 * Download Manager - Self-contained download orchestration
 * Single responsibility: Manage download lifecycle with simple deduplication and progress tracking
 * No external state dependencies - fully self-contained
 */

import { createLogger } from '../../shared/utils/logger.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getRequestHeaders } from '../../shared/utils/headers-utils.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';

const logger = createLogger('Download Manager');

// Simple Set for active download deduplication
const activeDownloads = new Set();

// Simple Map for tracking download progress per URL (for UI restoration)
// Key: downloadUrl, Value: full progress message from NHS
const activeDownloadProgress = new Map();

/**
 * Initialize download manager
 */
export async function initDownloadManager() {
    logger.info('Initializing download manager');
    
    try {
        logger.info('Download manager initialized successfully');
        return true;
    } catch (error) {
        logger.error('Failed to initialize download manager:', error);
        return false;
    }
}

/**
 * Start a new download
 * @param {Object} downloadRequest - Complete download request
 * @returns {Promise<void>}
 */
export async function startDownload(downloadRequest) {
    const downloadId = downloadRequest.downloadUrl; // Use URL as unique ID
    
    logger.debug('Starting download:', downloadId);
    
    // Simple deduplication check using Set
    if (activeDownloads.has(downloadId)) {
        logger.debug('Download already active:', downloadId);
        return;
    }
    
    try {
        // Add to active downloads Set for deduplication
        activeDownloads.add(downloadId);
        
        // Create Chrome notification
        createDownloadNotification(downloadRequest.filename);
        
        // Prepare native host message
        const nativeHostMessage = {
            command: 'download',
            downloadUrl: downloadRequest.downloadUrl,
            filename: downloadRequest.filename,
            savePath: downloadRequest.savePath || null,
            type: downloadRequest.type,
            fileSizeBytes: downloadRequest.fileSizeBytes || null,
            segmentCount: downloadRequest.segmentCount || null,
            preferredContainer: downloadRequest.preferredContainer || null,
            originalContainer: downloadRequest.originalContainer || 'mp4',
            audioOnly: downloadRequest.audioOnly || false,
            streamSelection: downloadRequest.streamSelection || null,
            masterUrl: downloadRequest.masterUrl || null,
            duration: downloadRequest.duration || null,
            headers: getRequestHeaders(downloadRequest.tabId || -1, downloadRequest.downloadUrl) || {}
        };
        
        // Start download with progress tracking
        nativeHostService.sendMessage(nativeHostMessage, (response) => {
            handleDownloadProgress(downloadId, downloadRequest, response);
        });
        
        logger.debug('🔄 Download initiated successfully:', downloadId);
        
    } catch (error) {
        logger.error('Failed to start download:', error);
        
        // Clean up failed download from active set
        activeDownloads.delete(downloadId);
        
        // Notify error to UI via direct broadcast
        broadcastToPopups({
            command: 'download-error',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            error: error.message,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        });
        
        throw error;
    }
}

// Handle download progress updates and errors from native host
function handleDownloadProgress(downloadId, downloadRequest, response) {
    // response can have one of 4 commands: download-progress, download-success, download-error, download-canceled

    // Store progress in local map for UI restoration 
    activeDownloadProgress.set(downloadId, response);

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(response.command)) {
        // Remove from active downloads Set
        activeDownloads.delete(downloadId);
        
        // Clean up progress map on completion/error/cancellation
        activeDownloadProgress.delete(downloadId);

        if (response.command === 'download-error') {
            logger.error('Download error:', downloadId, response.error);
            broadcastToPopups({
                command: 'download-error',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                error: response.error,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
            return;
        }
        
        if (response.command === 'download-canceled') {
            logger.debug('Download canceled:', downloadId);
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
            return;
        }
        
        // Create completion notification
        if (response.command === 'download-success') {
            createCompletionNotification(downloadRequest.filename);
        }
    }

    // Prepare broadcast data with completion flags for UI
    const broadcastData = (['download-canceled', 'download-success', 'download-error'].includes(response.command))
        ? { ...response, 
            success: response.success, 
            error: response.error,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        }
        : response;

    // Always notify UI with progress data via direct broadcast
    broadcastToPopups(broadcastData);
}

// Create download start notification
function createDownloadNotification(filename) {
    const notificationId = `download-${Date.now()}`;
    chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: '../../icons/48.png',
        title: 'Downloading Video',
        message: `Starting download: ${filename}`
    });
}

// Create download completion notification
function createCompletionNotification(filename) {
    const notificationId = `complete-${Date.now()}`;
    chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: '../../icons/48.png',
        title: 'Download Complete',
        message: `Finished: ${filename}`
    });
}

/**
 * Get all active download progress for popup restoration
 * @returns {Array} Array of progress objects with completion flags
 */
export function getActiveDownloadProgress() {
    const progressArray = [];
    
    for (const [downloadId, progressData] of activeDownloadProgress.entries()) {
        // Add completion flags that UI expects
        progressArray.push({
            ...progressData,
            success: progressData.success,
            error: progressData.error
        });
    }
    
    logger.debug(`Returning ${progressArray.length} active download progress states`);
    return progressArray;
}

//Get count of active downloads
export function getActiveDownloadCount() {
    return activeDownloads.size;
}

// Check if a specific URL is currently being downloaded
export function isDownloadActive(downloadUrl) {
    return activeDownloads.has(downloadUrl);
}

// Get all active download URLs
export function getActiveDownloadUrls() {
    return Array.from(activeDownloads);
}

// Debug function to log current download manager state
export function debugDownloadManagerState() {
    logger.debug('Download Manager State:', {
        activeDownloads: Array.from(activeDownloads),
        activeProgress: Array.from(activeDownloadProgress.keys()),
        counts: {
            active: activeDownloads.size,
            withProgress: activeDownloadProgress.size
        }
    });
}

/**
 * Cancel an active download
 * @param {Object} cancelRequest - Cancellation request with downloadUrl
 * @returns {Promise<void>}
 */
export async function cancelDownload(cancelRequest) {
    const downloadId = cancelRequest.downloadUrl;
    
    logger.debug('Canceling download:', downloadId);
    
    // Check if download is actually active
    if (!activeDownloads.has(downloadId)) {
        logger.debug('No active download found to cancel:', downloadId);
        return;
    }
    
    try {
        // Send cancellation request to native host
        const response = await nativeHostService.sendMessage({
            command: 'cancel-download',
            downloadUrl: downloadId
        });
        
        // Native host will send download-canceled message through progress handler
        // No need to clean up here - let the normal completion flow handle it
        
    } catch (error) {
        logger.error('Failed to cancel download:', error);
        
        // If cancel failed, force cleanup
        activeDownloads.delete(downloadId);
        activeDownloadProgress.delete(downloadId);
        
        // Broadcast error to UI
        broadcastToPopups({
            command: 'download-error',
            downloadUrl: downloadId,
            message: `Cancel failed: ${error.message}`
        });
    }
}
