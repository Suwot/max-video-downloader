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
 * Composes complete data from entry + progressData without duplication
 */
export function getActiveDownloads() {
    const activeDownloads = [];
    
    for (const [downloadId, entry] of allDownloads.entries()) {
        if (entry.downloadRequest && entry.downloadRequest.videoData) {
            activeDownloads.push({
                // Core identifiers and metadata from downloadRequest
                downloadId,
                status: entry.status,
                videoData: entry.downloadRequest.videoData,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl,
                filename: entry.downloadRequest.filename,
                resolvedFilename: entry.resolvedFilename,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText,
                streamSelection: entry.downloadRequest.streamSelection,
                isRedownload: entry.downloadRequest.isRedownload || false,
                audioOnly: entry.downloadRequest.audioOnly || false,
                subsOnly: entry.downloadRequest.subsOnly || false,
                type: entry.downloadRequest.type,
                // Pure progress data only (null if no progress yet)
                progressData: entry.progressData,
                timestamp: entry.timestamp
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
        nativeHostService.addEventListener('filename-resolved', handleDownloadEvent);
        
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
    
    // Add to unified downloads map - no progressData needed for queued state
    allDownloads.set(downloadId, {
        status: 'queued',
        downloadRequest: downloadCommand, // Complete original command
        progressData: null, // No progress data until download starts
        timestamp: Date.now()
    });
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Broadcast queue state to UI - compose from entry data
    broadcastToPopups({
        command: 'download-queued',
        downloadId,
        downloadUrl: downloadCommand.downloadUrl,
        masterUrl: downloadCommand.masterUrl || null,
        filename: downloadCommand.filename,
        selectedOptionOrigText: downloadCommand.selectedOptionOrigText || null,
        videoData: downloadCommand.videoData, // Include video data for UI creation
        audioOnly: downloadCommand.audioOnly || false,
        subsOnly: downloadCommand.subsOnly || false
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
    
    // Add to unified downloads map - no progressData until first progress event
    allDownloads.set(downloadId, {
        status: 'downloading',
        downloadRequest: downloadRequest,
        progressData: null, // Will be populated by first progress event from native host
        timestamp: Date.now()
    });
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Create Chrome notification
    createDownloadNotification(downloadRequest.filename);
    
    if (downloadRequest.isRedownload) {
        logger.debug('🔄 Using preserved headers for re-download:', Object.keys(downloadRequest.headers || {}));
    }
    
    // Broadcast download start to UI - compose from entry data
    broadcastToPopups({
        command: 'download-started',
        downloadId,
        downloadUrl: downloadRequest.downloadUrl,
        masterUrl: downloadRequest.masterUrl || null,
        filename: downloadRequest.filename,
        selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
        videoData: downloadRequest.videoData,
        isRedownload: downloadRequest.isRedownload || false,
        audioOnly: downloadRequest.audioOnly || false,
        subsOnly: downloadRequest.subsOnly || false
    });
    
    // Send download command (fire-and-forget)
    // All responses will come through event listeners
    nativeHostService.sendMessage(downloadRequest, { expectResponse: false });
    
    logger.debug('Download command sent:', downloadId);
}

// Handle download events from native host (event-driven)
async function handleDownloadEvent(event) {
    const { command, downloadUrl, sessionId, downloadId } = event;
    
    logger.debug('Handling download event:', command, downloadUrl, sessionId);
    logger.debug('Event downloadId:', event.downloadId);
    
    const downloadEntry = allDownloads.get(downloadId);
    if (!downloadEntry) {
        logger.warn('Download entry not found for downloadId:', downloadId);
        return;
    }

    // Handle filename resolution
    if (command === 'filename-resolved') {
        downloadEntry.resolvedFilename = event.resolvedFilename;

        // Broadcast filename update to UI - compose from entry data
        broadcastToPopups({
            command: 'filename-resolved',
            downloadId,
            resolvedFilename: event.resolvedFilename,
            downloadUrl: downloadEntry.downloadRequest.downloadUrl,
            masterUrl: downloadEntry.downloadRequest.masterUrl || null
        });

        logger.debug('Filename resolved for download:', downloadId, event.resolvedFilename);
        return; // Don't process further for filename-resolved events
    }

    // Handle pure progress updates - store only progress data
    if (command === 'download-progress') {
        // Extract progress data by removing command and downloadId
        const { command: _, downloadId: __, ...progressData } = event;
        
        // Store pure progress data only
        downloadEntry.progressData = progressData;

        // Broadcast progress update - compose complete message
        broadcastToPopups({
            command: 'download-progress',
            downloadId,
            downloadUrl: downloadEntry.downloadRequest.downloadUrl,
            masterUrl: downloadEntry.downloadRequest.masterUrl || null,
            selectedOptionOrigText: downloadEntry.downloadRequest.selectedOptionOrigText || null,
            type: downloadEntry.downloadRequest.type,
            ...progressData
        });
        
        return; // Don't process completion logic for progress events
    }

    // Handle completion/error/cancellation - clean up active tracking
    if (['download-canceled', 'download-success', 'download-error'].includes(command)) {
        // Remove from unified downloads map
        allDownloads.delete(downloadId);
        
        notifyDownloadCountChange();
        
        // Add to history storage for success/error only (merge FFmpeg data with stored entry data)
        if (command === 'download-success' || command === 'download-error') {
			// Deconstruct videoData to remove previewUrl for history storage
			const { previewUrl: _, ...cleanVideoData } = downloadEntry?.downloadRequest?.videoData || {};
			const cleanOriginalCommand = { ...downloadEntry.downloadRequest, videoData: cleanVideoData };

            await addToHistoryStorage({ ...event, originalCommand: cleanOriginalCommand });
        }

        // Handle specific completion types
        if (command === 'download-success') {
            // Create completion notification
            createCompletionNotification(event.filename || 'Unknown');
        }
        
        // Process next download in queue after ANY completion (success, error, or cancellation)
        processNextDownload();

        // Broadcast minimal UI update - only data needed for element state reset
        broadcastToPopups({
            command: event.command,
            downloadId,
            downloadUrl: downloadEntry?.downloadRequest?.downloadUrl,
            masterUrl: downloadEntry?.downloadRequest?.masterUrl || null,
            selectedOptionOrigText: downloadEntry?.downloadRequest?.selectedOptionOrigText || null,
            addedToHistory: settingsManager.get('saveDownloadsInHistory') && (command === 'download-success' || command === 'download-error')
        });
    }
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
    const entries = Array.from(allDownloads.entries());
    logger.debug('Download Manager State:', {
        allDownloads: entries.map(([id, entry]) => ({ id, status: entry.status, url: entry.downloadRequest.downloadUrl })),
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
        
        // Broadcast cancellation to UI - minimal data
        broadcastToPopups({
            command: 'download-canceled',
            downloadId
        });
        
        logger.debug('Queued download removed immediately:', downloadId);
        return;
    } else if (entry.status === 'downloading') {
        // Set stopping state, wait for native host
        entry.status = 'stopping';
        
        // Broadcast stopping state to UI - minimal data
        broadcastToPopups({
            command: 'download-stopping',
            downloadId
        });
        
        // Send cancellation request to native host - minimal data
        // Response will come through event listeners
        nativeHostService.sendMessage({
            command: 'cancel-download',
            downloadId // Only need downloadId for cancellation
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
    // Don't update progressData here - it will be set by first progress event
    
    // Notify count change
    notifyDownloadCountChange();
    
    // Get downloadId from the Map entry we found
    const downloadId = Array.from(allDownloads.entries())
        .find(([id, entry]) => entry === queuedEntry)?.[0];
    
    // Broadcast download start to UI - compose from entry data with downloadId
    broadcastToPopups({
        command: 'download-started',
        downloadId, // Essential for UI deduplication
        videoData: queuedEntry.downloadRequest.videoData
    });
    
    // Send download command to native host
    nativeHostService.sendMessage(queuedEntry.downloadRequest, { expectResponse: false });
    
    logger.debug('Queued download promoted to active:', downloadId);
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

        // Generate default filename with container extension (native host will handle final naming)
        const defaultName = `${downloadCommand.filename}.${downloadCommand.container}`;

        // Send filesystem request to native host
        const filesystemResponse = await nativeHostService.sendMessage({
            command: 'fileSystem',
            operation: 'chooseSaveLocation',
            params: {
                defaultName,
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
            filename: processedFilename,
            allowOverwrite: filesystemResponse.willOverwrite || false // Pass through overwrite flag from OS dialog
        };
        
        // Clean up temporary flags
        delete resolvedCommand.choosePath;
        delete resolvedCommand.isFirstTimeSetup;
        
        return resolvedCommand;
        
    } catch (error) {
        logger.error('Download As flow failed:', error);
        
        // Broadcast error to UI
        broadcastToPopups({
            command: 'download-canceled',
            downloadUrl: downloadCommand.downloadUrl,
            masterUrl: downloadCommand.masterUrl || null,
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
