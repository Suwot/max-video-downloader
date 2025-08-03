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

// Unified download state management - Single source of truth
const allDownloads = new Map(); // downloadId -> downloadEntry

// Simple storage operation queue for history operations only
const historyOperationQueue = [];
let isProcessingHistoryQueue = false;

/**
 * Queue a history storage operation to prevent race conditions
 * @param {Function} operation - Async function to execute
 * @returns {Promise} Promise that resolves when operation completes
 */
function queueHistoryOperation(operation) {
    return new Promise((resolve, reject) => {
        const wrappedOperation = async () => {
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        };
        
        historyOperationQueue.push(wrappedOperation);
        processHistoryQueue();
    });
}

/**
 * Process history storage operations sequentially
 */
async function processHistoryQueue() {
    if (isProcessingHistoryQueue || historyOperationQueue.length === 0) {
        return;
    }
    
    isProcessingHistoryQueue = true;
    
    while (historyOperationQueue.length > 0) {
        const operation = historyOperationQueue.shift();
        try {
            await operation();
        } catch (error) {
            logger.error('History storage operation failed:', error);
        }
    }
    
    isProcessingHistoryQueue = false;
}

/**
 * Get active downloads from in-memory Map for UI restoration
 */
export function getActiveDownloads() {
    const activeDownloads = [];
    
    for (const [downloadId, entry] of allDownloads.entries()) {
        if (entry.downloadRequest && entry.downloadRequest.videoData) {
            activeDownloads.push({
                downloadId: entry.downloadId,
                status: entry.status,
                videoData: entry.downloadRequest.videoData,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl,
                filename: entry.downloadRequest.filename,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText,
                streamSelection: entry.downloadRequest.streamSelection,
                isRedownload: entry.downloadRequest.isRedownload || false,
                audioOnly: entry.downloadRequest.audioOnly || false,
                subsOnly: entry.downloadRequest.subsOnly || false
            });
        }
    }
    
    return activeDownloads;
}

/**
 * Notify UI about download count changes and update badge
 */
function notifyDownloadCountChange() {
    const counts = getActiveDownloadCount();
    
    // Update badge icon
    updateBadgeIcon(counts.total);
    
    // Broadcast to all connected popups
    broadcastToPopups({
        command: 'downloadCountUpdated',
        counts: counts
    });
    
    logger.debug('Download count updated:', counts);
}

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
        
        // One-time cleanup: Remove legacy active downloads storage
        try {
            await chrome.storage.local.remove(['downloads_active']);
            logger.debug('Cleaned up legacy active downloads storage');
        } catch (error) {
            logger.debug('No legacy storage to clean up');
        }
        
        // Initialize badge icon with current in-memory count
        updateBadgeIcon(allDownloads.size);
        
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
    const existingEntry = allDownloads.get(downloadId);
    if (existingEntry) {
        logger.debug('Download already active or queued:', downloadId, 'status:', existingEntry.status);
        return;
    }
    
    // Check if we're at concurrent download limit
    const activeCount = Array.from(allDownloads.values())
        .filter(entry => entry.status === 'downloading' || entry.status === 'stopping').length;
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    
    if (activeCount >= maxConcurrentDownloads) {
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
    const downloadId = downloadCommand.downloadId;
    
    // Add to unified downloads map (keep previewUrl for UI recreation during download)
    allDownloads.set(downloadId, {
        downloadId: downloadId,
        status: 'queued',
        downloadRequest: downloadCommand, // This serves as originalCommand for retry functionality
        progressData: {
            command: 'download-queued',
            downloadUrl: downloadCommand.downloadUrl,
            masterUrl: downloadCommand.masterUrl || null,
            filename: downloadCommand.filename,
            selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
            downloadId: downloadId
        },
        timestamp: Date.now()
    });
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Broadcast queue state to UI and create downloads tab item
    broadcastToPopups({
        command: 'download-queued',
        downloadUrl: downloadCommand.downloadUrl,
        masterUrl: downloadCommand.masterUrl || null,
        filename: downloadCommand.filename, // Already includes container extension
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
    
    // Add to unified downloads map
    allDownloads.set(downloadId, {
        downloadId: downloadId,
        status: 'downloading',
        downloadRequest: downloadRequest,
        progressData: {
            command: 'download-started',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
            videoData: downloadRequest.videoData,
            isRedownload: downloadRequest.isRedownload || false,
            audioOnly: downloadRequest.audioOnly || false,
            subsOnly: downloadRequest.subsOnly || false,
            downloadId: downloadId
        },
        timestamp: Date.now()
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
    let downloadEntry = null;
    
    // If no downloadId in event, find it from map or storage (legacy support)
    if (!downloadId) {
        // Try to find in current downloads map first
        for (const [id, entry] of allDownloads.entries()) {
            if (entry.downloadRequest.downloadUrl === downloadUrl) {
                downloadId = id;
                downloadEntry = entry;
                break;
            }
        }
        
        // Final fallback to URL for legacy compatibility
        if (!downloadId) {
            downloadId = downloadUrl;
            logger.debug('Using URL as downloadId fallback:', downloadId);
        }
    }
    
    // Get download entry from map
    if (!downloadEntry) {
        downloadEntry = allDownloads.get(downloadId);
    }
    
    // Update progress data in the entry
    if (downloadEntry) {
        downloadEntry.progressData = { ...event, downloadId };
    }

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(command)) {
        // Remove from unified downloads map
        allDownloads.delete(downloadId);
        
        // Notify count change
        notifyDownloadCountChange();
        
        // Add to history storage for success/error only
        if (command === 'download-success' || command === 'download-error') {
            // Create clean originalCommand for history storage (remove heavy previewUrl)
            const cleanOriginalCommand = downloadEntry?.downloadRequest ? {
                ...downloadEntry.downloadRequest,
                videoData: downloadEntry.downloadRequest.videoData ? {
                    ...downloadEntry.downloadRequest.videoData,
                    previewUrl: undefined // Remove heavy preview data for storage efficiency
                } : undefined
            } : undefined;

            // Create minimal storage object - keep only essential fields for UI and retry
            const minimalStorageData = {
                // Essential completion data
                command: event.command,
                completedAt: event.completedAt,
                path: event.path,
                filename: event.filename,
                downloadUrl: downloadUrl, // Keep - used as filename fallback in UI
                selectedOptionOrigText: downloadEntry?.downloadRequest?.selectedOptionOrigText || null,
                type: event.type,
                downloadStats: event.downloadStats,
                
                // Actual processed duration (different from manifest duration in originalCommand)
                duration: event.duration,
                
                // Flags for UI display
                isPartial: event.isPartial,
                audioOnly: event.audioOnly,
                subsOnly: event.subsOnly,
                isRedownload: event.isRedownload,
                
                // Error and diagnostic info
                errorMessage: event.errorMessage,
                terminationInfo: event.terminationInfo,
                
                // Complete originalCommand for retry functionality (with previewUrl removed)
                originalCommand: cleanOriginalCommand
            };

            await addToHistoryStorage(minimalStorageData);
        }
        
        // Notify count change
        notifyDownloadCountChange();

        // Handle specific completion types
        if (command === 'download-error') {
            // Error details will be broadcast via the general broadcastData below
        } else if (command === 'download-canceled') {
            logger.debug('Download canceled:', downloadId);
            broadcastToPopups({
                command: 'download-canceled',
                downloadUrl: downloadEntry?.downloadRequest?.downloadUrl || downloadUrl,
                masterUrl: downloadEntry?.downloadRequest?.masterUrl || null,
                filename: downloadEntry?.downloadRequest?.filename || 'Unknown',
                selectedOptionOrigText: downloadEntry?.downloadRequest?.selectedOptionOrigText || null,
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
            selectedOptionOrigText: downloadEntry?.downloadRequest?.selectedOptionOrigText || null,
            downloadId: downloadId,
            addedToHistory: settingsManager.get('saveDownloadsInHistory') && (command === 'download-success' || command === 'download-error'),
            // downloadRequest serves as originalCommand (includes complete videoData and context)
            originalCommand: downloadEntry?.downloadRequest,
            // // Add missing context data that was previously sent by native host
            // masterUrl: downloadEntry?.downloadRequest?.masterUrl || null,
            // pageUrl: downloadEntry?.downloadRequest?.pageUrl || null,
            // pageFavicon: downloadEntry?.downloadRequest?.pageFavicon || null
        }
        : { 
            ...event, 
            downloadId: downloadId,
            // Add masterUrl for progress mapping (moved from native host)
            masterUrl: downloadEntry?.downloadRequest?.masterUrl || null
        };

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
    
    for (const [downloadId, entry] of allDownloads.entries()) {
        // Add completion flags that UI expects
        progressArray.push({
            ...entry.progressData,
            success: entry.progressData.success,
            error: entry.progressData.error
        });
    }
    
    logger.debug(`Returning ${progressArray.length} active download progress states`);
    return progressArray;
}

//Get count of active downloads and queue
export function getActiveDownloadCount() {
    const entries = Array.from(allDownloads.values());
    const active = entries.filter(entry => entry.status === 'downloading' || entry.status === 'stopping').length;
    const queued = entries.filter(entry => entry.status === 'queued').length;
    
    return {
        active: active,
        queued: queued,
        total: active + queued
    };
}



// Check if a specific download is currently active
export function isDownloadActive(downloadUrl) {
    for (const entry of allDownloads.values()) {
        if (entry.downloadRequest.downloadUrl === downloadUrl) {
            return true;
        }
    }
    return false;
}

// Get all active download URLs
export function getActiveDownloadUrls() {
    return Array.from(allDownloads.values())
        .map(entry => entry.downloadRequest.downloadUrl);
}

// Debug function to log current download manager state
export function debugDownloadManagerState() {
    const entries = Array.from(allDownloads.values());
    logger.debug('Download Manager State:', {
        allDownloads: entries.map(e => ({ id: e.downloadId, status: e.status, url: e.downloadRequest.downloadUrl })),
        counts: getActiveDownloadCount()
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
    
    const entry = allDownloads.get(downloadId);
    if (!entry) {
        logger.debug('No download found to cancel:', downloadId);
        return;
    }
    
    if (entry.status === 'queued') {
        // Direct removal for queued items
        allDownloads.delete(downloadId);
        
        // Notify count change
        notifyDownloadCountChange();
        
        // Broadcast cancellation to UI
        broadcastToPopups({
            command: 'download-canceled',
            type: cancelRequest.type,
            downloadUrl: entry.downloadRequest.downloadUrl,
            masterUrl: entry.downloadRequest.masterUrl || null,
            filename: entry.downloadRequest.filename,
            selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null,
            downloadId: downloadId
        });
        
        logger.debug('Queued download removed immediately:', downloadId);
        return;
    } else if (entry.status === 'downloading') {
        // Set stopping state, wait for native host
        entry.status = 'stopping';
        
        // Broadcast stopping state to UI
        broadcastToPopups({
            command: 'download-stopping',
            downloadId: downloadId,
            downloadUrl: entry.downloadRequest.downloadUrl,
            masterUrl: entry.downloadRequest.masterUrl || null,
            filename: entry.downloadRequest.filename,
            selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null
        });
        
        // Send cancellation request to native host
        // Response will come through event listeners
        nativeHostService.sendMessage({
            command: 'cancel-download',
            downloadUrl: entry.downloadRequest.downloadUrl,
            type: entry.downloadRequest.type,
            downloadId: downloadId // Pass downloadId for consistent tracking
        }, { expectResponse: false });
        
        logger.debug('Cancellation command sent, status set to stopping:', downloadId);
    } else if (entry.status === 'stopping') {
        logger.debug('Download already stopping:', downloadId);
    }
}

/**
 * Process next download in queue when space becomes available
 */
async function processNextDownload() {
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    const activeCount = Array.from(allDownloads.values())
        .filter(entry => entry.status === 'downloading' || entry.status === 'stopping').length;
    
    if (activeCount >= maxConcurrentDownloads) {
        return;
    }
    
    // Find next queued download
    const queuedEntry = Array.from(allDownloads.values())
        .find(entry => entry.status === 'queued');
    
    if (!queuedEntry) {
        return;
    }
    
    logger.debug('Processing next queued download:', queuedEntry.downloadId);
    
    // Update status to downloading
    queuedEntry.status = 'downloading';
    queuedEntry.progressData = {
        ...queuedEntry.progressData,
        command: 'download-started'
    };
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Broadcast download start to UI
    broadcastToPopups({
        command: 'download-started',
        downloadUrl: queuedEntry.downloadRequest.downloadUrl,
        masterUrl: queuedEntry.downloadRequest.masterUrl || null,
        filename: queuedEntry.downloadRequest.filename, // Already includes container extension
        selectedOptionOrigText: queuedEntry.downloadRequest.selectedOptionOrigText || null,
        videoData: queuedEntry.downloadRequest.videoData,
        downloadId: queuedEntry.downloadId
    });
    

    
    // Send download command to native host
    nativeHostService.sendMessage(queuedEntry.downloadRequest, { expectResponse: false });
    
    logger.debug('Queued download promoted to active:', queuedEntry.downloadId);
}

/**
 * Simple hash function for URL shortening
 * @param {string} str - String to hash
 * @returns {string} - Short hash
 */
function simpleHash(str) {
    if (!str || typeof str !== 'string') {
        return 'unknown';
    }
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
 * Update extension badge icon with download count
 * @param {number} count - Total number of active + queued downloads
 */
function updateBadgeIcon(count) {
    try {
        const badgeText = count === 0 ? '' : count.toString();
        chrome.action.setBadgeText({ text: badgeText });
        
        // Only set background color if we have a badge to show
        if (count > 0) {
            chrome.action.setBadgeBackgroundColor({ color: '#444444' });
        }
        
        logger.debug('Badge updated with count:', count);
    } catch (error) {
        logger.error('Error updating badge:', error);
    }
}



/**
 * Add download to history storage (success/error only)
 * @param {Object} progressData - Final progress data with completion info
 */
async function addToHistoryStorage(progressData) {
    // Check if history saving is enabled
    const saveDownloadsInHistory = settingsManager.get('saveDownloadsInHistory');
    if (!saveDownloadsInHistory) {
        logger.debug('History saving disabled, skipping:', progressData.downloadUrl);
        return;
    }

    return queueHistoryOperation(async () => {
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
            throw error;
        }
    });
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
                        command: 'settingsState',
                        settings: settingsManager.getAll(),
                        success: true
                    });
                }
            } catch (error) {
                logger.warn('Failed to save default save path:', error);
            }
        }
        
        // Ensure filename has correct container extension
        const container = downloadCommand.container || 'mp4';
        const expectedExt = `.${container}`;
        let processedFilename = filesystemResponse.filename;
        
        if (!processedFilename.toLowerCase().endsWith(expectedExt.toLowerCase())) {
            processedFilename = processedFilename + expectedExt;
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
    return queueHistoryOperation(async () => {
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
            throw error;
        }
    });
}
