/**
 * Download Manager - Centralized download orchestration
 * Single responsibility: Manage download lifecycle using state manager as single source of truth
 */

import { createLogger } from '../../shared/utils/logger.js';
import { setState, select } from '../state/state-manager.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getRequestHeaders } from '../../shared/utils/headers-utils.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';

const logger = createLogger('Download Manager');

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
    
    // Check for duplicate download (simple active list check)
    const isAlreadyActive = select(state => state.downloads.active.includes(downloadId));
    if (isAlreadyActive) {
        logger.debug('Download already active:', downloadId);
        return;
    }
    
    try {
        // Add to active downloads list (simple URL tracking)
        setState(state => ({
            downloads: {
                active: [...state.downloads.active, downloadId]
            }
        }));
        
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
        }).catch(error => {
            handleDownloadError(downloadId, downloadRequest, error);
        });
        
        logger.debug('🔄 Download initiated successfully:', downloadId);
        
    } catch (error) {
        logger.error('Failed to start download:', error);
        
        // Clean up failed download from active list and progress data
        setState(state => ({
            downloads: {
                active: state.downloads.active.filter(id => id !== downloadId),
                // Clean up any progress data for failed start
                lastProgress: Object.fromEntries(
                    Object.entries(state.downloads.lastProgress).filter(([id]) => id !== downloadId)
                )
            }
        }));
        
        // Notify error to UI via direct broadcast
        broadcastToPopups({
            command: 'error',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Get list of active downloads with their last known progress
 * @returns {Array} Active download objects with progress data
 */
export function getActiveDownloads() {
    const activeUrls = select(state => state.downloads.active);
    const lastProgress = select(state => state.downloads.lastProgress);
    
    // Return enhanced download objects with last progress
    return activeUrls.map(url => ({
        url,
        progress: lastProgress[url] || null
    }));
}

/**
 * Handle download progress updates from native host
 * @private
 */
function handleDownloadProgress(downloadId, downloadRequest, response) {
    logger.debug('Download progress update:', downloadId, response.progress + '%');
    
    // Single progress data creation with conditional filtering
    const baseProgressData = {
        command: 'progress',
        downloadUrl: downloadRequest.downloadUrl,
        masterUrl: downloadRequest.masterUrl || null,
        filename: downloadRequest.filename,
        progress: response.progress,
        speed: response.speed,
        eta: response.eta,
        segmentProgress: response.segmentProgress,
        currentSegment: response.currentSegment,
        totalSegments: response.totalSegments,
        downloadedBytes: response.downloadedBytes,
        totalBytes: response.totalBytes
    };

    // Only add completion flags for UI broadcast
    const broadcastData = (response.success !== undefined || response.error)
        ? { ...baseProgressData, success: response.success, error: response.error }
        : baseProgressData;

    // Store base data (without completion flags) for UI restoration
    setState(state => ({
        downloads: {
            lastProgress: {
                ...state.downloads.lastProgress,
                [downloadId]: baseProgressData
            }
        }
    }));

    // Handle completion/error - update state lists and stats
    if (response.success !== undefined || response.error) {
        setState(state => ({
            downloads: {
                // Remove from active
                active: state.downloads.active.filter(id => id !== downloadId),
                // Add to history
                history: [downloadId, ...state.downloads.history],
                // Clean up progress data
                lastProgress: Object.fromEntries(
                    Object.entries(state.downloads.lastProgress).filter(([id]) => id !== downloadId)
                ),
                // Update stats
                stats: {
                    ...state.downloads.stats,
                    completed: response.success ? state.downloads.stats.completed + 1 : state.downloads.stats.completed,
                    failed: response.error ? state.downloads.stats.failed + 1 : state.downloads.stats.failed,
                    lastDownload: Date.now()
                }
            }
        }));
        
        // Create completion notification
        if (response.success) {
            createCompletionNotification(downloadRequest.filename);
        }
    }
    
    // Always notify UI with appropriate progress data via direct broadcast
    broadcastToPopups(broadcastData);
}

/**
 * Handle download errors
 * @private
 */
function handleDownloadError(downloadId, downloadRequest, error) {
    logger.error('Download error:', downloadId, error);
    
    // Update state - remove from active, add to history, clean up progress, update stats
    setState(state => ({
        downloads: {
            active: state.downloads.active.filter(id => id !== downloadId),
            history: [downloadId, ...state.downloads.history],
            // Clean up progress data
            lastProgress: Object.fromEntries(
                Object.entries(state.downloads.lastProgress).filter(([id]) => id !== downloadId)
            ),
            stats: {
                ...state.downloads.stats,
                failed: state.downloads.stats.failed + 1,
                lastDownload: Date.now()
            }
        }
    }));
    
    // Notify UI of error via direct broadcast
    broadcastToPopups({
        command: 'error',
        downloadUrl: downloadRequest.downloadUrl,
        masterUrl: downloadRequest.masterUrl || null,
        filename: downloadRequest.filename,
        error: error.message
    });
}

/**
 * Create download start notification
 * @private
 */
function createDownloadNotification(filename) {
    const notificationId = `download-${Date.now()}`;
    chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: '../../icons/48.png',
        title: 'Downloading Video',
        message: `Starting download: ${filename}`
    });
}

/**
 * Create download completion notification
 * @private
 */
function createCompletionNotification(filename) {
    const notificationId = `complete-${Date.now()}`;
    chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: '../../icons/48.png',
        title: 'Download Complete',
        message: `Finished: ${filename}`
    });
}
