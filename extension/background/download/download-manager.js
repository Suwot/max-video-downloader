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

// Maximum concurrent downloads (set to 1 for dev/testing)
const MAX_CONCURRENT_DOWNLOADS = 1;

// Storage management constants
const MAX_DOWNLOAD_HISTORY_ITEMS = 50;

// Simple Set for active download deduplication
const activeDownloads = new Set();

// Simple Map for tracking download progress per URL (for UI restoration)
// Key: downloadUrl, Value: full progress message from NHS
const activeDownloadProgress = new Map();

// Queue for pending download requests
// Array of complete download request objects
const downloadQueue = [];

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
    
    // Simple deduplication check - active downloads or queued downloads
    if (activeDownloads.has(downloadId) || downloadQueue.find(req => req.downloadUrl === downloadId)) {
        logger.debug('Download already active or queued:', downloadId);
        return;
    }
    
    // Check if we're at concurrent download limit
    if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        logger.debug('Queue download - at concurrent limit:', downloadId);
        
        // Add to queue
        downloadQueue.push(downloadRequest);
        
        // Add to storage with queued status
        await addToActiveDownloadsStorage(downloadRequest);
        
        // Notify count change
        notifyDownloadCountChange();
        
        // Store queue state in progress map for UI restoration
        activeDownloadProgress.set(downloadId, {
            command: 'download-queued',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        });
        
        // Broadcast queue state to UI
        broadcastToPopups({
            command: 'download-queued',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        });
        
        logger.debug('Download queued:', downloadId);
        return;
    }
    
    // Start download immediately
    await startDownloadImmediately(downloadRequest);
}

/**
 * Start download immediately (extracted from original startDownload logic)
 * @param {Object} downloadRequest - Complete download request
 */
async function startDownloadImmediately(downloadRequest) {
    const downloadId = downloadRequest.downloadUrl;
    
    // Add to active downloads Set for deduplication
    activeDownloads.add(downloadId);
    
    // Add to storage or update status if already exists (from queue)
    addToActiveDownloadsStorage(downloadRequest).then(() => {
        updateActiveDownloadStatus(downloadId, 'downloading');
    });
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Create Chrome notification
    createDownloadNotification(downloadRequest.filename);
    
    // Prepare native host message using object spread for all fields,
    // only overriding command and headers which need transformation
    const nativeHostMessage = {
        ...downloadRequest,
        command: 'download',
        // For re-downloads, use existing headers; for new downloads, get fresh headers
        headers: downloadRequest.isRedownload && downloadRequest.headers ? 
            downloadRequest.headers : 
            (getRequestHeaders(downloadRequest.tabId || -1, downloadRequest.downloadUrl) || {})
    };
    
    if (downloadRequest.isRedownload) {
        logger.debug('🔄 Using preserved headers for re-download:', Object.keys(downloadRequest.headers || {}));
    }
    
    // Start download with progress tracking
    try {
        const finalResult = await nativeHostService.sendMessage(nativeHostMessage, (response) => {
            handleDownloadProgress(downloadId, downloadRequest, response);
        });
        
        if (finalResult?.success) {
            logger.warn('🔄 Download succeeded:', downloadId, finalResult);
        } else {
            logger.error('🔄 Download failed:', downloadId, finalResult);
        }
    } catch (error) {
        // Only handle communication errors, not download content errors
        logger.error('Failed to communicate with native host:', error);
        
        // Clean up failed download from active set
        activeDownloads.delete(downloadId);
        notifyDownloadCountChange();
    }
}

// Handle download progress updates and errors from native host
async function handleDownloadProgress(downloadId, downloadRequest, response) {
    // response can have one of 6 commands: download-progress, download-success, download-error, download-canceled, download-queued, download-unqueued

    // Store progress in local map for UI restoration 
    activeDownloadProgress.set(downloadId, response);

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(response.command)) {
        // Remove from active downloads Set
        activeDownloads.delete(downloadId);
        
        // Remove from active downloads storage
        await removeFromActiveDownloadsStorage(downloadId);
        
        // Add to history storage for success/error only
        if (response.command === 'download-success' || response.command === 'download-error') {
            await addToHistoryStorage({
                ...response,
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: response.filename,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
        }
        
        // Clean up progress map on completion/error/cancellation
        activeDownloadProgress.delete(downloadId);

        // Notify count change
        notifyDownloadCountChange();

        // Handle specific completion types
        if (response.command === 'download-error') {
            // Error details will be broadcast via the general broadcastData below
        } else if (response.command === 'download-canceled') {
            logger.debug('Download canceled:', downloadId);
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
        } else if (response.command === 'download-success') {
            // Create completion notification
            createCompletionNotification(downloadRequest.filename);
        }
        
        // Remove from active downloads storage
        removeFromActiveDownloadsStorage(downloadId);
        
        // Process next download in queue after ANY completion (success, error, or cancellation)
        processNextDownload();
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

//Get count of active downloads and queue
export function getActiveDownloadCount() {
    return {
        active: activeDownloads.size,
        queued: downloadQueue.length,
        total: activeDownloads.size + downloadQueue.length
    };
}

/**
 * Notify all popups about download count changes
 */
function notifyDownloadCountChange() {
    const counts = getActiveDownloadCount();
    broadcastToPopups({
        command: 'downloadCountUpdated',
        counts: counts
    });
    logger.debug('Download count updated:', counts);
}

// Check if a specific URL is currently being downloaded – not used anywhere yet
export function isDownloadActive(downloadUrl) {
    return activeDownloads.has(downloadUrl);
}

// Get all active download URLs – not used anywhere yet
export function getActiveDownloadUrls() {
    return Array.from(activeDownloads);
}

// Debug function to log current download manager state – not used anywhere yet
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
    
    // Check if download is queued - remove from queue
    if (removeFromQueue(downloadId)) {
        // Remove from storage as well
        await removeFromActiveDownloadsStorage(downloadId);
        
        // Notify count change after queue removal
        notifyDownloadCountChange();
        
        // Broadcast unqueue state to UI
        broadcastToPopups({
            command: 'download-unqueued',
            downloadUrl: downloadId,
            masterUrl: cancelRequest.masterUrl || null,
            filename: cancelRequest.filename || 'Unknown',
            selectedOptionOrigText: cancelRequest.selectedOptionOrigText || null
        });
        return;
    }
    
    // Check if download is actually active
    if (!activeDownloads.has(downloadId)) {
        logger.debug('No active download found to cancel:', downloadId);
        return;
    }
    
    // Send cancellation request to native host
    try {
        const response = await nativeHostService.sendMessage({
            command: 'cancel-download',
            downloadUrl: downloadId
        });
        
        // Native host will send download-canceled message through progress handler
        // No need to clean up here - let the normal completion flow handle it
    } catch (error) {
        // Only handle communication errors, not cancellation content errors
        logger.error('Failed to communicate cancel request to native host:', error);
    }
}

/**
 * Process next download in queue when space becomes available
 */
async function processNextDownload() {
    if (downloadQueue.length === 0 || activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        return;
    }
    
    // Get next download from queue
    const nextDownload = downloadQueue.shift();
    logger.debug('Processing next queued download:', nextDownload.downloadUrl);
    
    // Notify count change after queue shift
    notifyDownloadCountChange();
    
    // Remove from progress map (will be re-added when download starts)
    activeDownloadProgress.delete(nextDownload.downloadUrl);
    
    // Start the download
    await startDownloadImmediately(nextDownload);
}

/**
 * Remove download from queue
 * @param {string} downloadUrl - URL to remove from queue
 * @returns {boolean} - True if removed, false if not found
 */
export function removeFromQueue(downloadUrl) {
    const initialLength = downloadQueue.length;
    const index = downloadQueue.findIndex(req => req.downloadUrl === downloadUrl);
    
    if (index !== -1) {
        downloadQueue.splice(index, 1);
        activeDownloadProgress.delete(downloadUrl);
        logger.debug('Removed from queue:', downloadUrl);
        return true;
    }
    
    return false;
}

/**
 * Add download to active downloads storage
 * @param {Object} downloadRequest - Download request data (includes elementHTML from UI)
 */
async function addToActiveDownloadsStorage(downloadRequest) {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        
        // Store the full download entry as created by UI, preserving all original data
        const downloadEntry = {
            lookupUrl: downloadRequest.masterUrl || downloadRequest.downloadUrl,
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            elementHTML: downloadRequest.elementHTML, // Full HTML from UI cloning
            timestamp: Date.now(),
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
            status: 'queued' // Will be updated to 'downloading' when actually started
        };
        
        activeDownloads.push(downloadEntry);
        await chrome.storage.local.set({ downloads_active: activeDownloads });
        
        logger.debug('Added to active downloads storage:', downloadRequest.downloadUrl);
    } catch (error) {
        logger.error('Error adding to active downloads storage:', error);
    }
}

/**
 * Update download status in active downloads storage
 * @param {string} downloadUrl - Download URL to update
 * @param {string} status - New status ('downloading', 'queued')
 */
async function updateActiveDownloadStatus(downloadUrl, status) {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        
        const downloadIndex = activeDownloads.findIndex(entry => 
            entry.downloadUrl === downloadUrl || entry.lookupUrl === downloadUrl
        );
        
        if (downloadIndex !== -1) {
            activeDownloads[downloadIndex].status = status;
            await chrome.storage.local.set({ downloads_active: activeDownloads });
            logger.debug('Updated download status in storage:', downloadUrl, status);
        }
    } catch (error) {
        logger.error('Error updating download status:', error);
    }
}

/**
 * Remove download from active downloads storage
 * @param {string} downloadUrl - Download URL to remove
 */
async function removeFromActiveDownloadsStorage(downloadUrl) {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        
        const lookupUrl = downloadUrl;
        const updatedActiveDownloads = activeDownloads.filter(entry => 
            entry.lookupUrl !== lookupUrl && entry.downloadUrl !== lookupUrl
        );
        
        await chrome.storage.local.set({ downloads_active: updatedActiveDownloads });
        logger.debug('Removed from active downloads storage:', downloadUrl);
    } catch (error) {
        logger.error('Error removing from active downloads storage:', error);
    }
}

/**
 * Add download to history storage (success/error only)
 * @param {Object} progressData - Final progress data with completion info
 */
async function addToHistoryStorage(progressData) {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        const history = result.downloads_history || [];
        
        history.unshift(progressData); // Add to beginning
        
        // Maintain history size limit
        if (history.length > MAX_DOWNLOAD_HISTORY_ITEMS) {
            history.splice(MAX_DOWNLOAD_HISTORY_ITEMS);
        }
        
        await chrome.storage.local.set({ downloads_history: history });
        logger.debug('Added to history storage:', progressData.downloadUrl, progressData.command);
    } catch (error) {
        logger.error('Error adding to history storage:', error);
    }
}
