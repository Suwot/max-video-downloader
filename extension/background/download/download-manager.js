/**
 * Download Manager - Self-contained download orchestration
 * Single responsibility: Manage download lifecycle with simple deduplication and progress tracking
 * No external state dependencies - fully self-contained
 */

import { createLogger } from '../../shared/utils/logger.js';
import nativeHostService from '../messaging/native-host-service.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';
import { settingsManager } from '../index.js';

const logger = createLogger('Download Manager');

// Storage management - will use settings manager for max history size

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
        // Register event listeners for download events
        nativeHostService.addEventListener('download-progress', handleDownloadEvent);
        nativeHostService.addEventListener('download-success', handleDownloadEvent);
        nativeHostService.addEventListener('download-error', handleDownloadEvent);
        nativeHostService.addEventListener('download-canceled', handleDownloadEvent);
        
        // Initialize badge icon - restore count from storage or clear
        await restoreBadgeFromStorage();
        
        // Clean up old history items on startup
        await cleanupOldHistoryItems();
        
        // Set up periodic history cleanup (every 24 hours)
        setInterval(cleanupOldHistoryItems, 24 * 60 * 60 * 1000);
        
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
    
    // Check if no default save path is set - enrich request for first-time setup
    const defaultSavePath = settingsManager.get('defaultSavePath');
    const isFirstTimeSetup = !defaultSavePath;
    
    // Check if this is a "download as" request that needs filesystem dialog
    if (downloadRequest.choosePath) {
        logger.debug('Download As request - handling filesystem dialog first');
        await handleDownloadAsFlow({
            ...downloadRequest,
            isFirstTimeSetup
        });
        return;
    }
    
    // Check if no default save path is set - trigger download-as flow for first-time setup
    if (isFirstTimeSetup) {
        logger.debug('No default save path set - triggering download-as flow for first-time setup');
        await handleDownloadAsFlow({
            ...downloadRequest,
            choosePath: true,
            isFirstTimeSetup: true
        });
        return;
    }
    
    // Use defaultSavePath
    if (defaultSavePath) {
        downloadRequest.savePath = defaultSavePath;
    }
    
    // Simple deduplication check - active downloads or queued downloads
    if (activeDownloads.has(downloadId) || downloadQueue.find(req => req.downloadUrl === downloadId)) {
        logger.debug('Download already active or queued:', downloadId);
        return;
    }
    
    // Check if we're at concurrent download limit
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    if (activeDownloads.size >= maxConcurrentDownloads) {
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
    
    if (downloadRequest.isRedownload) {
        logger.debug('🔄 Using preserved headers for re-download:', Object.keys(downloadRequest.headers || {}));
    }
    
    // Send download command (fire-and-forget)
    // All responses will come through event listeners
    nativeHostService.sendMessage(downloadRequest, { expectResponse: false });
    
    logger.debug('Download command sent:', downloadId);
}

/**
 * Handle download events from native host (event-driven)
 * @param {Object} event - Event from native host
 */
async function handleDownloadEvent(event) {
    const { command, downloadUrl, sessionId } = event;
    const downloadId = downloadUrl; // Use URL as unique ID
    
    logger.debug('Handling download event:', command, downloadId, sessionId);
    
    // Find the corresponding download request (needed for metadata)
    let downloadRequest = null;
    
    // Try to find in active downloads storage
    try {
        const activeDownloads = await getActiveDownloadsStorage();
        downloadRequest = activeDownloads.find(d => d.downloadUrl === downloadUrl);
    } catch (error) {
        logger.warn('Could not retrieve download request from storage:', error);
    }
    
    // Store progress in local map for UI restoration 
    activeDownloadProgress.set(downloadId, event);

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(command)) {
        // Remove from active downloads Set
        activeDownloads.delete(downloadId);
        
        // Remove from active downloads storage
        await removeFromActiveDownloadsStorage(downloadId);
        
        // Add to history storage for success/error only
        if (command === 'download-success' || command === 'download-error') {
            await addToHistoryStorage({
                ...event,
                downloadUrl: downloadUrl,
                masterUrl: downloadRequest?.masterUrl || null,
                filename: event.filename,
                selectedOptionOrigText: event.originalCommand.selectedOptionOrigText || null
            });
        }
        
        // Clean up progress map on completion/error/cancellation
        activeDownloadProgress.delete(downloadId);

        // Notify count change
        notifyDownloadCountChange();

        // Handle specific completion types
        if (command === 'download-error') {
            // Error details will be broadcast via the general broadcastData below
        } else if (command === 'download-canceled') {
            logger.debug('Download canceled:', downloadId);
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
        } else if (command === 'download-success') {
            // Create completion notification
            createCompletionNotification(event.filename || 'Unknown');
        }
        
        // Process next download in queue after ANY completion (success, error, or cancellation)
        processNextDownload();
    }

    // Prepare broadcast data with completion flags for UI
    const broadcastData = (['download-canceled', 'download-success', 'download-error'].includes(command))
        ? { 
            ...event, 
            success: event.success, 
            error: event.error,
            selectedOptionOrigText: downloadRequest?.selectedOptionOrigText || null
        }
        : event;

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
 * Notify all popups about download count changes and update badge icon
 */
function notifyDownloadCountChange() {
    const counts = getActiveDownloadCount();
    broadcastToPopups({
        command: 'downloadCountUpdated',
        counts: counts
    });
    
    // Update badge icon with total count
    updateBadgeIcon(counts.total);
    
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
            type: cancelRequest.type,
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
    // Response will come through event listeners
    nativeHostService.sendMessage({
        command: 'cancel-download',
        downloadUrl: downloadId,
        type: cancelRequest.type
    }, { expectResponse: false });
    
    logger.debug('Cancellation command sent:', downloadId);
}

/**
 * Process next download in queue when space becomes available
 */
async function processNextDownload() {
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    if (downloadQueue.length === 0 || activeDownloads.size >= maxConcurrentDownloads) {
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
 * Update extension badge icon with download count
 * @param {number} count - Total number of active + queued downloads
 */
function updateBadgeIcon(count) {
    try {
        if (count === 0) {
            // Clear badge when no downloads
            chrome.action.setBadgeText({ text: '' });
        } else {
            // Show count on gray background
            chrome.action.setBadgeText({ text: count.toString() });
            chrome.action.setBadgeBackgroundColor({ color: '#444444' }); // Dark gray for white text contrast
        }
        logger.debug('Badge icon updated with count:', count);
    } catch (error) {
        logger.error('Error updating badge icon:', error);
    }
}

/**
 * Restore badge count from storage on extension startup
 */
async function restoreBadgeFromStorage() {
    try {
        const activeDownloads = await getActiveDownloadsStorage();
        const count = activeDownloads.length;
        updateBadgeIcon(count);
        logger.debug('Badge restored from storage with count:', count);
    } catch (error) {
        logger.error('Error restoring badge from storage:', error);
        // Fallback to clear badge
        updateBadgeIcon(0);
    }
}

/**
 * Get active downloads from storage
 * @returns {Promise<Array>} Array of active downloads
 */
async function getActiveDownloadsStorage() {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        return result.downloads_active || [];
    } catch (error) {
        logger.error('Error getting active downloads storage:', error);
        return [];
    }
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
        let history = result.downloads_history || [];
        
        // Add completion timestamp if not present
        if (!progressData.completedAt) {
            progressData.completedAt = Date.now();
        }
        
        history.unshift(progressData); // Add to beginning
        
        // Clean up old history items based on auto-remove interval
        const autoRemoveInterval = settingsManager.get('historyAutoRemoveInterval');
        const cutoffTime = Date.now() - (autoRemoveInterval * 24 * 60 * 60 * 1000); // Convert days to milliseconds
        history = history.filter(item => {
            const itemTime = item.completedAt || 0;
            return itemTime > cutoffTime;
        });
        
        // Maintain history size limit from settings
        const maxHistorySize = settingsManager.get('maxHistorySize');
        if (history.length > maxHistorySize) {
            history.splice(maxHistorySize);
        }
        
        await chrome.storage.local.set({ downloads_history: history });
        logger.debug('Added to history storage:', progressData.downloadUrl, progressData.command);
    } catch (error) {
        logger.error('Error adding to history storage:', error);
    }
}

/**
 * Handle download-as flow: filesystem dialog first, then download
 * @param {Object} downloadRequest - Download request with choosePath flag
 */
async function handleDownloadAsFlow(downloadRequest) {
    const downloadId = downloadRequest.downloadUrl;
    
    try {
        logger.debug(`Handling 'Download As' flow for:`, downloadId);

        // Send filesystem request to native host
        const filesystemResponse = await nativeHostService.sendMessage({
            command: 'fileSystem',
            operation: 'chooseSaveLocation',
            params: {
                defaultName: downloadRequest.defaultFilename || `${downloadRequest.filename || 'video'}.${downloadRequest.defaultContainer || 'mp4'}`,
                title: 'Save Video As'
            }
        });
        
        if (filesystemResponse.error) {
            logger.debug('Filesystem dialog canceled or failed:', filesystemResponse.error);
            // Broadcast error to UI
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
                error: 'File selection canceled'
            });
            return;
        }

        logger.debug('Filesystem dialog successful:', filesystemResponse);
        
        // If this is first-time setup, save the directory as default save path
        if (downloadRequest.isFirstTimeSetup) {
            try {
                const currentSettings = settingsManager.getAll();
                const updatedSettings = {
                    ...currentSettings,
                    defaultSavePath: filesystemResponse.directory
                };
                
                const success = await settingsManager.updateAll(updatedSettings);
                if (success) {
                    logger.debug('Saved default save path from first download:', filesystemResponse.directory);
                    
                    // Broadcast updated settings to any open popups (for UI update)
                    broadcastToPopups({
                        command: 'settingsResponse',
                        settings: settingsManager.getAll(),
                        success: true
                    });
                }
            } catch (error) {
                logger.warn('Failed to save default save path:', error);
            }
        }
        
        // Merge filesystem response with download request
        const updatedRequest = {
            ...downloadRequest,
            savePath: filesystemResponse.directory,
            filename: filesystemResponse.filename
        };
        
        // Remove choosePath flag to prevent recursion
        delete updatedRequest.choosePath;
        delete updatedRequest.defaultFilename;
        delete updatedRequest.isFirstTimeSetup;
        
        // Continue with normal download flow
        await startDownload(updatedRequest);
        
    } catch (error) {
        logger.error('Download As flow failed:', error);
        
        // Broadcast error to UI
        broadcastToPopups({
            command: 'download-canceled',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
            error: `Download As failed: ${error.message}`
        });
    }
}

/**
 * Clean up old history items based on auto-remove interval setting
 */
async function cleanupOldHistoryItems() {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        let history = result.downloads_history || [];
        
        if (history.length === 0) return;
        
        const autoRemoveInterval = settingsManager.get('historyAutoRemoveInterval');
        const cutoffTime = Date.now() - (autoRemoveInterval * 24 * 60 * 60 * 1000); // Convert days to milliseconds
        
        const originalLength = history.length;
        history = history.filter(item => {
            const itemTime = item.completedAt || 0;
            return itemTime > cutoffTime;
        });
        
        if (history.length !== originalLength) {
            await chrome.storage.local.set({ downloads_history: history });
            logger.debug(`Cleaned up ${originalLength - history.length} old history items`);
        }
    } catch (error) {
        logger.error('Error cleaning up old history items:', error);
    }
}
