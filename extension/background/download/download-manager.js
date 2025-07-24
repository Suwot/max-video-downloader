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
 * Process download command - unified entry point for all download types
 * @param {Object} downloadCommand - Complete download command from UI
 * @returns {Promise<void>}
 */
export async function processDownloadCommand(downloadCommand) {
    // Generate unique downloadId once for this download
    const downloadId = generateDownloadId(downloadCommand);
    downloadCommand.downloadId = downloadId;
    
    logger.debug('Processing download command:', downloadCommand.command || 'download');
    logger.debug('Generated downloadId:', downloadId);
    logger.debug('Download URL:', downloadCommand.downloadUrl);
    
    // Resolve paths and handle filesystem dialogs
    const resolvedCommand = await resolveDownloadPaths(downloadCommand);
    if (!resolvedCommand) {
        // Path resolution failed or was canceled
        return;
    }
    
    // Simple deduplication check using downloadId
    const isAlreadyActive = activeDownloads.has(downloadId);
    const isAlreadyQueued = downloadQueue.some(req => req.downloadId === downloadId);
    
    if (isAlreadyActive || isAlreadyQueued) {
        logger.debug('Download already active or queued:', downloadId);
        return;
    }
    
    // Check if we're at concurrent download limit
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    if (activeDownloads.size >= maxConcurrentDownloads) {
        logger.debug('Queue download - at concurrent limit:', downloadId);
        await queueDownload(resolvedCommand);
        return;
    }
    
    // Start download immediately
    await startDownloadImmediately(resolvedCommand);
}

/**
 * Resolve download paths and handle filesystem dialogs
 * @param {Object} downloadCommand - Download command from UI
 * @returns {Promise<Object|null>} Resolved command or null if canceled
 */
async function resolveDownloadPaths(downloadCommand) {
    const defaultSavePath = settingsManager.get('defaultSavePath');
    const isFirstTimeSetup = !defaultSavePath;
    
    // Handle download-as or first-time setup
    if (downloadCommand.choosePath || isFirstTimeSetup) {
        logger.debug('Resolving path via filesystem dialog');
        return await handleDownloadAsFlow({
            ...downloadCommand,
            isFirstTimeSetup: isFirstTimeSetup && !downloadCommand.choosePath
        });
    }
    
    // Use default save path
    if (defaultSavePath && !downloadCommand.savePath) {
        downloadCommand.savePath = defaultSavePath;
    }
    
    return downloadCommand;
}

/**
 * Queue download when at concurrent limit
 * @param {Object} downloadCommand - Resolved download command
 */
async function queueDownload(downloadCommand) {
    // Add to queue
    downloadQueue.push(downloadCommand);
    
    // Add to storage with queued status
    await addToActiveDownloadsStorage(downloadCommand);
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Use the generated downloadId
    const downloadId = downloadCommand.downloadId;
    
    // Store queue state in progress map for UI restoration
    activeDownloadProgress.set(downloadId, {
        command: 'download-queued',
        downloadUrl: downloadCommand.downloadUrl,
        masterUrl: downloadCommand.masterUrl || null,
        filename: downloadCommand.filename,
        selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
        downloadId: downloadId
    });
    
    // Broadcast queue state to UI and create downloads tab item
    broadcastToPopups({
        command: 'download-queued',
        downloadUrl: downloadCommand.downloadUrl,
        masterUrl: downloadCommand.masterUrl || null,
        filename: downloadCommand.filename,
        selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
        videoData: downloadCommand.videoData, // Include video data for UI creation
        downloadId: downloadId // For precise progress mapping
    });
    
    logger.debug('Download queued:', downloadId);
}

/**
 * Start download immediately (extracted from original startDownload logic)
 * @param {Object} downloadRequest - Complete download request
 */
async function startDownloadImmediately(downloadRequest) {
    // Use the generated downloadId
    const downloadId = downloadRequest.downloadId;
    
    // Add to active downloads Set for deduplication
    activeDownloads.add(downloadId);
    
    // Add to storage or update status if already exists (from queue)
    addToActiveDownloadsStorage(downloadRequest).then(() => {
        updateActiveDownloadStatus(downloadRequest.downloadUrl, 'downloading');
    });
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Create Chrome notification
    createDownloadNotification(downloadRequest.filename);
    
    if (downloadRequest.isRedownload) {
        logger.debug('🔄 Using preserved headers for re-download:', Object.keys(downloadRequest.headers || {}));
    }
    
    // Broadcast download start to UI for downloads tab creation (one-time event)
    broadcastToPopups({
        command: 'download-started',
        downloadUrl: downloadRequest.downloadUrl,
        masterUrl: downloadRequest.masterUrl || null,
        filename: downloadRequest.filename,
        selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
        videoData: downloadRequest.videoData,
        isRedownload: downloadRequest.isRedownload || false,
        downloadId: downloadId // For precise progress mapping
    });
    
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
    
    logger.debug('Handling download event:', command, downloadUrl, sessionId);
    logger.debug('Event downloadId:', event.downloadId);
    
    // Use downloadId from native host event (now passed through)
    let downloadId = event.downloadId;
    let downloadRequest = null;
    
    // If no downloadId in event, find it from storage (legacy support)
    if (!downloadId) {
        try {
            const storedDownloads = await getActiveDownloadsStorage();
            const candidates = storedDownloads.filter(d => d.downloadUrl === downloadUrl);
            
            if (candidates.length === 1) {
                downloadRequest = candidates[0];
                downloadId = downloadRequest.downloadId;
            } else if (candidates.length > 1) {
                // Multiple candidates - find the one that's currently active
                downloadRequest = candidates.find(d => d.downloadId && activeDownloads.has(d.downloadId)) || candidates[0];
                downloadId = downloadRequest?.downloadId;
            }
        } catch (error) {
            logger.warn('Could not retrieve download request from storage:', error);
        }
        
        // Final fallback to URL for legacy compatibility
        if (!downloadId) {
            downloadId = downloadUrl;
            logger.debug('Using URL as downloadId fallback:', downloadId);
        }
    } else {
        // We have downloadId from native host, try to find the request for additional data
        try {
            const storedDownloads = await getActiveDownloadsStorage();
            downloadRequest = storedDownloads.find(d => d.downloadId === downloadId);
        } catch (error) {
            logger.warn('Could not retrieve download request from storage:', error);
        }
    }
    
    // Store progress in local map for UI restoration 
    activeDownloadProgress.set(downloadId, { ...event, downloadId });

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(command)) {
        // Remove from active downloads Set using consistent downloadId
        activeDownloads.delete(downloadId);
        
        // Remove from active downloads storage using downloadId
        await removeFromActiveDownloadsStorage(downloadId);
        
        // Add to history storage for success/error only
        if (command === 'download-success' || command === 'download-error') {
            await addToHistoryStorage({
                ...event,
                downloadUrl: downloadUrl,
                masterUrl: downloadRequest?.masterUrl || null,
                filename: event.filename,
                selectedOptionOrigText: event.originalCommand.selectedOptionOrigText || null
                // originalCommand already includes videoData from native host (robust approach)
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
                downloadUrl: downloadRequest?.downloadUrl || downloadUrl,
                masterUrl: downloadRequest?.masterUrl || null,
                filename: downloadRequest?.filename || 'Unknown',
                selectedOptionOrigText: downloadRequest?.selectedOptionOrigText || null,
                downloadId: downloadId // Include downloadId for precise mapping
            });
        } else if (command === 'download-success') {
            // Create completion notification
            createCompletionNotification(event.filename || 'Unknown');
        }
        
        // Process next download in queue after ANY completion (success, error, or cancellation)
        processNextDownload();
    }

    // Prepare broadcast data with completion flags and downloadId (no videoData needed for progress events)
    const broadcastData = (['download-canceled', 'download-success', 'download-error'].includes(command))
        ? { 
            ...event, 
            success: event.success, 
            error: event.error,
            selectedOptionOrigText: downloadRequest?.selectedOptionOrigText || null,
            downloadId: downloadId
        }
        : { ...event, downloadId: downloadId };

    // Always notify UI with progress data via direct broadcast
    broadcastToPopups(broadcastData);
}

// Create download start notification
function createDownloadNotification(filename) {
    if (!settingsManager.get('showDownloadNotifications')) {
        return;
    }
    
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
    if (!settingsManager.get('showDownloadNotifications')) {
        return;
    }
    
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
 * @param {Object} cancelRequest - Cancellation request with downloadId
 * @returns {Promise<void>}
 */
export async function cancelDownload(cancelRequest) {
    const downloadId = cancelRequest.downloadId || cancelRequest.downloadUrl;
    
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
        downloadUrl: cancelRequest.downloadUrl,
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
 * Simple hash function for URL shortening
 * @param {string} str - String to hash
 * @returns {string} - Short hash
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
}

/**
 * Generate unique download ID for deduplication and progress mapping
 * Uses hash for privacy and performance, timestamp for uniqueness
 * @param {Object} request - Download request object
 * @returns {string} - Unique download identifier
 */
function generateDownloadId(request) {
    // Create base identifier with URL hash
    let baseId = simpleHash(request.downloadUrl);
    
    // Add stream selection hash for DASH multi-track downloads
    if (request.type === 'dash' && request.streamSelection) {
        baseId += '_' + simpleHash(request.streamSelection);
    }
    
    // Add audio-only flag for audio extraction
    if (request.audioOnly) {
        baseId += '_audio';
    }
    
    // Add subs-only flag for subtitle extraction
    if (request.subsOnly) {
        baseId += '_subs';
    }
    
    // Add timestamp for uniqueness (handles re-downloads and simultaneous operations)
    const timestamp = Date.now();
    
    return `${baseId}_${timestamp}`;
}

/**
 * Remove download from queue using downloadId as primary key
 * @param {string} downloadId - Download ID to remove from queue
 * @returns {boolean} - True if removed, false if not found
 */
export function removeFromQueue(downloadId) {
    // Find by downloadId (all queued downloads have this)
    const index = downloadQueue.findIndex(req => req.downloadId === downloadId);
    
    if (index !== -1) {
        const removedRequest = downloadQueue.splice(index, 1)[0];
        activeDownloadProgress.delete(downloadId);
        logger.debug('Removed from queue:', downloadId, 'URL:', removedRequest.downloadUrl);
        return true;
    }
    
    // Legacy fallback: try to find by URL for old queue entries
    const urlIndex = downloadQueue.findIndex(req => req.downloadUrl === downloadId);
    if (urlIndex !== -1) {
        const removedRequest = downloadQueue.splice(urlIndex, 1)[0];
        activeDownloadProgress.delete(downloadId);
        logger.debug('Removed from queue (URL fallback):', downloadId);
        return true;
    }
    
    logger.debug('Download not found in queue:', downloadId);
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
        
        // Store the full download entry with video data for recreation
        const downloadEntry = {
            lookupUrl: downloadRequest.masterUrl || downloadRequest.downloadUrl,
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            videoData: downloadRequest.videoData, // Raw video data for recreation
            timestamp: Date.now(),
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
            status: 'queued', // Will be updated to 'downloading' when actually started
            downloadId: downloadRequest.downloadId, // For precise progress mapping
            // Store request data needed for downloadId generation
            type: downloadRequest.type,
            streamSelection: downloadRequest.streamSelection
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
 * Remove download from active downloads storage using downloadId as primary key
 * @param {string} downloadId - Download ID to remove
 */
async function removeFromActiveDownloadsStorage(downloadId) {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        
        // Filter out the entry with matching downloadId
        const updatedActiveDownloads = activeDownloads.filter(entry => {
            // Primary match: downloadId (all new downloads have this)
            if (entry.downloadId) {
                return entry.downloadId !== downloadId;
            }
        });
        
        const removedCount = activeDownloads.length - updatedActiveDownloads.length;
        if (removedCount > 0) {
            await chrome.storage.local.set({ downloads_active: updatedActiveDownloads });
            logger.debug(`Removed ${removedCount} entry from active downloads storage:`, downloadId);
        } else {
            logger.debug('No matching entry found in active downloads storage:', downloadId);
        }
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
 * Handle download-as flow: filesystem dialog first, then return resolved command
 * @param {Object} downloadCommand - Download command with choosePath flag
 * @returns {Promise<Object|null>} Resolved command or null if canceled
 */
async function handleDownloadAsFlow(downloadCommand) {
    const downloadId = downloadCommand.downloadUrl;
    
    try {
        logger.debug(`Handling filesystem dialog for:`, downloadId);

        // Generate default filename with container extension
        const defaultFilename = downloadCommand.defaultFilename || 
            `${downloadCommand.filename || 'video'}.${downloadCommand.defaultContainer || 'mp4'}`;

        // Send filesystem request to native host
        const filesystemResponse = await nativeHostService.sendMessage({
            command: 'fileSystem',
            operation: 'chooseSaveLocation',
            params: {
                defaultName: defaultFilename,
                title: 'Save Video As'
            }
        });
        
        if (filesystemResponse.error) {
            logger.debug('Filesystem dialog canceled or failed:', filesystemResponse.error);
            // Broadcast error to UI
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadCommand.downloadUrl,
                masterUrl: downloadCommand.masterUrl || null,
                filename: downloadCommand.filename,
                selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
                error: 'File selection canceled'
            });
            return null;
        }

        logger.debug('Filesystem dialog successful:', filesystemResponse);
        
        // If this is first-time setup, save the directory as default save path
        if (downloadCommand.isFirstTimeSetup) {
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
        
        // Process filename to remove container extension if present
        // (Native host will add it back)
        const container = downloadCommand.container || 'mp4';
        const expectedExt = `.${container}`;
        let processedFilename = filesystemResponse.filename;
        
        if (processedFilename.toLowerCase().endsWith(expectedExt.toLowerCase())) {
            processedFilename = processedFilename.slice(0, -expectedExt.length);
        }
        
        // Return resolved command
        const resolvedCommand = {
            ...downloadCommand,
            savePath: filesystemResponse.directory,
            filename: processedFilename
        };
        
        // Clean up temporary flags
        delete resolvedCommand.choosePath;
        delete resolvedCommand.defaultFilename;
        delete resolvedCommand.isFirstTimeSetup;
        
        return resolvedCommand;
        
    } catch (error) {
        logger.error('Download As flow failed:', error);
        
        // Broadcast error to UI
        broadcastToPopups({
            command: 'download-canceled',
            downloadUrl: downloadCommand.downloadUrl,
            masterUrl: downloadCommand.masterUrl || null,
            filename: downloadCommand.filename,
            selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
            error: `Download As failed: ${error.message}`
        });
        
        return null;
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
