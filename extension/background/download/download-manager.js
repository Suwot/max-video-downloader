/**
 * Download Manager - Self-contained download orchestration
 * Single responsibility: Manage download lifecycle with simple deduplication and progress tracking
 * No external state dependencies - fully self-contained
 */

import nativeHostService from '../messaging/native-host-service.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';
import { settingsManager } from '../index.js';

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
            console.error('History storage operation failed:', error);
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
        if (entry.downloadRequest && entry.downloadRequest.videoData && entry.status !== 'orphaned') {
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
    
    console.debug('Download count updated:', counts);
}

/**
 * Initialize download manager
 */
export async function initDownloadManager() {
    console.info('Initializing download manager');
    
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
            console.debug('Cleaned up legacy active downloads storage');
        } catch (error) {
            console.debug('No legacy storage to clean up');
        }
        
        // Initialize badge icon with current in-memory count
        updateBadgeIcon(allDownloads.size);
        
        // Clean up old history items on startup
        await cleanupOldHistoryItems();
        
        // Set up periodic history cleanup (every 24 hours)
        setInterval(cleanupOldHistoryItems, 24 * 60 * 60 * 1000);
        
        console.info('Download manager initialized successfully');
        return true;
    } catch (error) {
        console.error('Failed to initialize download manager:', error);
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
    
    console.debug('Processing download command:', downloadCommand.command || 'download');
    console.debug('Generated downloadId:', downloadId);
    console.debug('Download URL:', downloadCommand.downloadUrl);
    
    // Resolve paths and handle filesystem dialogs
    const resolvedCommand = await resolveDownloadPaths(downloadCommand);
    if (!resolvedCommand) {
        // Path resolution failed or was canceled
        return;
    }
    
    // Simple deduplication check using downloadId
    const existingEntry = allDownloads.get(downloadId);
    if (existingEntry) {
        console.debug('Download already active or queued:', downloadId, 'status:', existingEntry.status);
        return;
    }
    
    // Check if we're at concurrent download limit
    const activeCount = Array.from(allDownloads.values())
        .filter(entry => entry.status === 'downloading' || entry.status === 'stopping').length;
    const maxConcurrentDownloads = settingsManager.get('maxConcurrentDownloads');
    
    if (activeCount >= maxConcurrentDownloads) {
        console.debug('Queue download - at concurrent limit:', downloadId);
        await queueDownload(resolvedCommand);
        return;
    }
    
    // Start download immediately (unified flow handles both coapp and browser downloads)
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
    
    // Handle download-as or first-time setup (but not for browser downloads)
    if ((downloadCommand.choosePath || isFirstTimeSetup) && !downloadCommand.browserDownload) {
        console.debug('Resolving path via filesystem dialog');
        return await handleDownloadAsFlow({
            ...downloadCommand,
            isFirstTimeSetup: isFirstTimeSetup && !downloadCommand.choosePath
        });
    }
    
    // For browser downloads with choosePath, skip CoApp dialog - Chrome will handle saveAs
    if (downloadCommand.browserDownload && downloadCommand.choosePath) {
        console.debug('Browser download with choosePath - skipping CoApp dialog, Chrome will handle saveAs');
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
    
    console.debug('Download queued:', downloadId);
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
        console.debug('🔄 Using preserved headers for re-download:', Object.keys(downloadRequest.headers || {}));
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
    
    // Route to appropriate download method
    if (downloadRequest.browserDownload) {
        await startBrowserDownload(downloadId, downloadRequest);
    } else {
        // Send download command to native host (fire-and-forget)
        // All responses will come through event listeners
        nativeHostService.sendMessage(downloadRequest, { expectResponse: false });
        console.debug('Download command sent:', downloadId);
    }
}

/**
 * Start browser download - lean deterministic flow
 * @param {string} downloadId - Download ID
 * @param {Object} downloadRequest - Complete download request
 */
async function startBrowserDownload(downloadId, downloadRequest) {
    try {
        // Sanitize filename with proper container extension
        const sanitizedFilename = (downloadRequest.filename || 'video')
            .replace(/[<>:"/\\|*]/g, '_').replace(/\?/g, ' ').trim() + '.' + (downloadRequest.container || 'mp4');
        
        // Create Chrome download with saveAs support for download-as flow
        const downloadOptions = {
            url: downloadRequest.downloadUrl,
            filename: sanitizedFilename
        };
        
        // Add saveAs parameter for download-as flow (choosePath flag)
        if (downloadRequest.choosePath) {
            downloadOptions.saveAs = true;
            console.debug('Using saveAs dialog for download-as flow');
        }
        
        const browserDownloadId = await chrome.downloads.download(downloadOptions);
        
        console.debug('Browser download started:', downloadId, ', Chrome ID:', browserDownloadId);
        
        // Get existing entry and add minimal browser download state
        const entry = allDownloads.get(downloadId);
        if (entry) {
            entry.browserDownloadId = browserDownloadId;
            entry.progressClock = {
                startTime: Date.now(),
                lastBytes: 0,
                lastTime: Date.now()
            };
            
            // Start polling every 1 second
            entry.pollIntervalId = setInterval(() => {
                tickPoll(downloadId);
            }, 1000);
        }
        
    } catch (error) {
        console.error('Browser download failed:', error);
        
        // Use existing error handling flow
        const errorEvent = {
            command: 'download-error',
            downloadId,
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null,
            errorMessage: error.message || 'Browser download failed',
            browserDownload: true
        };
        
        await handleDownloadEvent(errorEvent);
    }
}

/**
 * Poll Chrome download by ID and convert to existing event format
 * @param {string} downloadId - Internal download ID
 * @param {number} chromeDownloadId - Chrome download ID
 */
async function tickPoll(downloadId) {
    const entry = allDownloads.get(downloadId);
    if (!entry || !entry.browserDownloadId) {
        return;
    }
    
    try {
        // Fetch current state
        const [item] = await chrome.downloads.search({ id: entry.browserDownloadId });
        
        if (!item) {
            stopPolling(entry);
            const errorEvent = {
                command: 'download-error',
                downloadId,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl || null,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null,
                errorMessage: 'Download not found',
                browserDownload: true
            };
            await handleDownloadEvent(errorEvent);
            return;
        }
        
        // Branch by state
        if (item.state === 'complete') {
            // Compute final totals
            const finalPath = item.filename;
            const finalName = finalPath.split('/').pop();
            const finalSize = item.totalBytes || entry.progressData?.totalSize || 0;
            
            stopPolling(entry);
            
            // Emit unified success
            const successEvent = {
                command: 'download-success',
                downloadId,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl || null,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null,
                filename: finalName,
                path: finalPath,
                downloadStats: { totalSize: finalSize },
                browserDownload: true
            };
            
            await handleDownloadEvent(successEvent);
            return;
        }
        
        if (item.state === 'interrupted') {
            stopPolling(entry);
            
            // Emit unified error
            const errorEvent = {
                command: 'download-error',
                downloadId,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl || null,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null,
                errorMessage: item.error || 'Download interrupted',
                browserDownload: true
            };
            
            await handleDownloadEvent(errorEvent);
            return;
        }
        
        if (item.state === 'in_progress') {
            // Read numbers
            const bytes = item.bytesReceived || 0;
            const total = item.totalBytes ?? 0; // treat 0 as "unknown"
            
            // Compute dynamics
            const now = Date.now();
            const dt = Math.max(1, (now - entry.progressClock.lastTime) / 1000);
            const dB = Math.max(0, bytes - entry.progressClock.lastBytes);
            const speed = dB / dt; // B/s
            const progress = total > 0 ? Math.round((bytes / total) * 100) : 0;
            const eta = (total > 0 && speed > 0) ? Math.round((total - bytes) / speed) : null;
            const elapsed = Math.round((now - entry.progressClock.startTime) / 1000);
            
            // Update clock
            entry.progressClock.lastBytes = bytes;
            entry.progressClock.lastTime = now;
            
            // Emit unified progress
            const progressEvent = {
                command: 'download-progress',
                downloadId,
                downloadUrl: entry.downloadRequest.downloadUrl,
                masterUrl: entry.downloadRequest.masterUrl || null,
                selectedOptionOrigText: entry.downloadRequest.selectedOptionOrigText || null,
                type: entry.downloadRequest.type,
                downloadedBytes: bytes,
                totalSize: total || 0,
                progress,
                speed: speed > 0 ? Math.round(speed) : null,
                eta,
                elapsedTime: elapsed,
                browserDownload: true
            };
            
            await handleDownloadEvent(progressEvent);
        }
        
    } catch (error) {
        console.error('Error polling browser download (will retry):', downloadId, error);
        // Keep polling; next tick will retry
    }
}

/**
 * Stop polling helper - lean cleanup
 * @param {Object} entry - Download entry
 */
function stopPolling(entry) {
    if (entry.pollIntervalId) {
        clearInterval(entry.pollIntervalId);
        entry.pollIntervalId = null;
    }
}

/**
 * Cancel browser download - find and cancel Chrome download
 * @param {string} downloadId - Internal download ID
 * @param {Object} entry - Download entry
 */
async function cancelBrowserDownload(downloadId, entry) {
    try {
        // Cancel Chrome download directly using stored ID
        if (entry.browserDownloadId) {
            await chrome.downloads.cancel(entry.browserDownloadId);
            console.debug('Canceled Chrome download:', entry.browserDownloadId);
        }
        
    } catch (error) {
        console.warn('Failed to cancel Chrome download:', error);
    }
    
    // Clean up polling
    stopPolling(entry);
    
    // Use unified completion flow (handles delete, notify, broadcast, processNext)
    await handleDownloadEvent({
        command: 'download-canceled',
        downloadId,
        downloadUrl: entry.downloadRequest?.downloadUrl,
        masterUrl: entry.downloadRequest?.masterUrl || null,
        selectedOptionOrigText: entry.downloadRequest?.selectedOptionOrigText || null,
        browserDownload: true
    });
    
    console.debug('Browser download canceled:', downloadId);
}

// Handle download events from native host (event-driven)
async function handleDownloadEvent(event) {
    const { command, downloadUrl, sessionId, downloadId } = event;
    
    console.debug('Handling download event:', command, downloadUrl, sessionId);
    console.debug('Event downloadId:', event.downloadId);
    
    const downloadEntry = allDownloads.get(downloadId);
    if (!downloadEntry) {
        console.warn('Download entry not found for downloadId:', downloadId);
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

        console.debug('Filename resolved for download:', downloadId, event.resolvedFilename);
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
    console.debug('Download Manager State:', {
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
    
    console.debug('Canceling download:', downloadId);
    
    const entry = allDownloads.get(downloadId);
    if (!entry) {
        console.debug('No download found to cancel:', downloadId);
        return;
    }
    
    if (entry.status === 'queued') {
        // Direct removal for queued items
        allDownloads.delete(downloadId);
        
        // Notify count change
        notifyDownloadCountChange();
        
        // Broadcast cancellation to UI - include downloadUrl for videos tab matching
        broadcastToPopups({
            command: 'download-canceled',
            downloadId,
            downloadUrl: entry.downloadRequest.downloadUrl,
            masterUrl: entry.downloadRequest.masterUrl || null,
        });
        
        console.debug('Queued download removed immediately:', downloadId);
        return;
    } else if (entry.status === 'downloading') {
        // Check if this is a browser download (has browserDownloadId)
        if (entry.browserDownloadId) {
            await cancelBrowserDownload(downloadId, entry);
            return;
        }
        
        // Native host download cancellation
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
        
        // 5sec timeout - mark as orphaned, UI treats as canceled
        setTimeout(() => {
            const currentEntry = allDownloads.get(downloadId);
            if (currentEntry && currentEntry.status === 'stopping') {
                currentEntry.status = 'orphaned';
                notifyDownloadCountChange();
                processNextDownload();
                
                // UI treats orphaned same as canceled
                broadcastToPopups({
                    command: 'download-canceled',
                    downloadId,
                    downloadUrl: currentEntry.downloadRequest?.downloadUrl,
                    masterUrl: currentEntry.downloadRequest?.masterUrl || null,
                    selectedOptionOrigText: currentEntry.downloadRequest?.selectedOptionOrigText || null,
                    addedToHistory: false
                });
                
                console.debug('Download marked as orphaned after timeout:', downloadId);
            }
        }, 5000);
        
        // 1min hardcap - silent cleanup if NH never responds
        setTimeout(() => {
            const currentEntry = allDownloads.get(downloadId);
            if (currentEntry && currentEntry.status === 'orphaned') {
                allDownloads.delete(downloadId);
                console.warn('Removed orphaned download after 1min timeout:', downloadId);
            }
        }, 60000);
        
        console.debug('Cancellation command sent, status set to stopping:', downloadId);
    } else if (entry.status === 'stopping') {
        console.debug('Download already stopping:', downloadId);
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
    
    // Get downloadId from the Map entry we found
    const downloadId = Array.from(allDownloads.entries())
        .find(([id, entry]) => entry === queuedEntry)?.[0];
    
    console.debug('Processing next queued download:', downloadId);
    
    // Remove from queue and restart through unified flow
    allDownloads.delete(downloadId);
    
    // Restart through unified flow (handles both native and browser downloads)
    await startDownloadImmediately(queuedEntry.downloadRequest);
    
    console.debug('Queued download promoted to active:', downloadId);
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
        const ss = typeof request.streamSelection === 'string'
            ? request.streamSelection
            : JSON.stringify(request.streamSelection);
        baseId += '_' + simpleHash(ss);
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
        
        console.debug('Badge updated with count:', count);
    } catch (error) {
        console.error('Error updating badge:', error);
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
        console.debug('History saving disabled, skipping:', progressData.downloadUrl);
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
            console.debug('Added to history storage:', progressData.downloadUrl, progressData.command);
        } catch (error) {
            console.error('Error adding to history storage:', error);
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
    const downloadId = downloadCommand.downloadId || downloadCommand.downloadUrl;
    
    try {
        console.debug(`Handling filesystem dialog for:`, downloadId);

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
            console.debug('Filesystem dialog canceled or failed:', filesystemResponse.error);
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

        console.debug('Filesystem dialog successful:', filesystemResponse);
        
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
                    console.debug('Saved default save path from first download:', filesystemResponse.directory);
                    
                    // Broadcast updated settings to any open popups (for UI update)
                    broadcastToPopups({
                        command: 'settingsState',
                        settings: settingsManager.getAll(),
                        success: true
                    });
                }
            } catch (error) {
                console.warn('Failed to save default save path:', error);
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
        console.error('Download As flow failed:', error);
        
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
                console.debug(`Cleaned up ${originalLength - history.length} old history items`);
            }
        } catch (error) {
            console.error('Error cleaning up old history items:', error);
            throw error;
        }
    });
}