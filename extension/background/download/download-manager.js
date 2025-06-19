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
            command: 'download-error',
            downloadUrl: downloadRequest.downloadUrl,
            masterUrl: downloadRequest.masterUrl || null,
            filename: downloadRequest.filename,
            error: error.message,
            downloadBtnOrigHTML: downloadRequest.downloadBtnOrigHTML || null,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        });
        
        throw error;
    }
}

/**
 * Handle download progress updates and errors from native host
 * @private
 */
function handleDownloadProgress(downloadId, downloadRequest, response) {
    // response can have one of 3 commands: download-progress, download-success, download-error

    // Only add completion flags for UI broadcast
    const broadcastData = (response.success !== undefined || response.error)
        ? { ...response, 
            success: response.success, 
            error: response.error,
            downloadBtnOrigHTML: downloadRequest.downloadBtnOrigHTML || null,
            selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
        }
        : response;

    // Store response data for UI restoration 
    setState(state => ({
        downloads: {
            lastProgress: {
                ...state.downloads.lastProgress,
                [downloadId]: response
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

        if (response.error) {
            logger.error('Download error:', downloadId, response.error);
            broadcastToPopups({
                command: 'download-error',
                downloadUrl: downloadRequest.downloadUrl,
                masterUrl: downloadRequest.masterUrl || null,
                filename: downloadRequest.filename,
                error: response.error,
                downloadBtnOrigHTML: downloadRequest.downloadBtnOrigHTML || null,
                selectedOptionOrigText: downloadRequest.selectedOptionOrigText || null
            });
            return
        }
        // Create completion notification
        if (response.success) {
            createCompletionNotification(downloadRequest.filename);
        }

    }
    // Always notify UI with appropriate progress data via direct broadcast
    broadcastToPopups(broadcastData);
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
