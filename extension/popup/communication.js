/**
 * Simple communication handler for popup ↔ background
 * Only handles port connection and message routing
 * Other modules use sendPortMessage directly
 */

import { createLogger } from '../shared/utils/logger.js';
import { updateDownloadProgress } from './video/download-progress-handler.js';
import { renderVideos, addVideoToUI, updateVideoInUI, removeVideoFromUI, renderHistoryItems, updateHistoryItemDeleted, updateVideoFlags } from './video/video-renderer.js';
import { updateUICounters, showToast, showSuccess, showError } from './ui-utils.js';
import { updateSettingsUI, updateNativeHostStatus } from './settings-tab.js';
import { getTabId } from './state.js';

const logger = createLogger('Communication');

// Port connection
let backgroundPort = null;
let isConnected = false;

// Store download counts for tab counter
let downloadCounts = { active: 0, queued: 0, total: 0 };

// No need for currentVideos abstraction - pass data directly to render functions

/**
 * Connect to background script
 */
function connect() {
    if (backgroundPort && isConnected) {
        return backgroundPort;
    }
    
    try {
        backgroundPort = chrome.runtime.connect({ name: 'popup' });
        isConnected = true;
        
        logger.debug('Connected to background script');
        
        // Handle disconnect
        backgroundPort.onDisconnect.addListener(() => {
            logger.debug('Disconnected from background script');
            backgroundPort = null;
            isConnected = false;
        });
        
        // Handle incoming messages
        backgroundPort.onMessage.addListener(handleIncomingMessage);
        
        return backgroundPort;
    } catch (error) {
        logger.error('Failed to connect to background:', error);
        backgroundPort = null;
        isConnected = false;
        return null;
    }
}

/**
 * Handle messages from background script
 */
async function handleIncomingMessage(message) {
    logger.debug('Received message:', message.command);
    
    // Filter tab-specific messages early to reduce redundant processing
    const tabSpecificCommands = ['videos-state-update', 'update-ui-counters'];
    if (tabSpecificCommands.includes(message.command) && message.tabId) {
        const currentTabId = getTabId();
        if (currentTabId && message.tabId !== currentTabId) {
            logger.debug(`Ignoring ${message.command} for tab ${message.tabId} (current: ${currentTabId})`);
            return;
        }
    }
    
    switch (message.command) {
        case 'videos-state-update':
            await handleVideoStateUpdate(message);
            break;

        case 'update-ui-counters':
            updateUICounters({ videos: message.counts });
            break;

        case 'cachesCleared':
            await renderVideos([]); // Pass empty array directly
            updateUICounters({ videos: { hls: 0, dash: 0, direct: 0, unknown: 0, total: 0 } });
            break;

        case 'previewCacheStats':
            updateCacheStatsDisplay(message.stats);
            break;

        case 'download-progress':
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
        case 'download-queued':
        case 'download-started':
        case 'download-stopping':
        case 'filename-resolved':
            await updateDownloadProgress(message);
            break;

        case 'downloadCountUpdated':
            if (message.counts) {
                downloadCounts = message.counts;
                updateUICounters({ downloads: message.counts });
            }
            break;

        case 'activeDownloadsData':
            // Handle active downloads data from background for UI restoration
            const { handleActiveDownloadsData } = await import('./video/download-progress-handler.js');
            handleActiveDownloadsData(message.activeDownloads);
            break;

        case 'settingsState':
            updateSettingsUI(message.settings);
            
            // Handle history trimming updates
            if (message.historyTrimmed && message.historyTrimmed > 0) {
                // Re-render history items to reflect trimmed entries
                await renderHistoryItems(true); // Full re-render
                
                // Show toast notification
                showToast(`${message.historyTrimmed} history entries were removed`, 'info');
            }
            break;
            
        case 'nativeHostConnectionState':
            handleNativeHostStateUpdate(message.connectionState);
            break;
            
        case 'fileSystemResponse':
            if (message.operation === 'deleteFile') {
                if (message.success) {
                    showSuccess('File deleted');
                } else {
                    const errorMessage = message.error === 'File not found' ? 'File not found' : 'Failed to delete file';
                    showError(errorMessage);
                }
                // Always update UI regardless of success/error - file is considered "deleted" either way
                updateHistoryItemDeleted(message.completedAt);
            } else if ((message.operation === 'showInFolder' || message.operation === 'openFile') && !message.success && message.error === 'File not found') {
                // File not found when trying to show in folder or open file - reuse same logic as deleteFile
                showError('File not found');
                updateHistoryItemDeleted(message.completedAt);
            }
            break;

        default:
            logger.warn('Unknown message command:', message.command);
    }
}

/**
 * Handle action-based video state updates
 */
async function handleVideoStateUpdate(message) {
    logger.debug(`Video update: ${message.type} ${message.action}`, message);

    try {
        if (message.type === 'full-refresh') {
            // Full refresh with all videos and counts
            if (message.videos) {
                await renderVideos(message.videos);
            }
            if (message.counts) {
                updateUICounters({ videos: message.counts });
            }
            return;
        }

        if (message.type === 'structural') {
            // Structural updates with complete video data
            switch (message.action) {
                case 'add':
                    if (message.videoData) {
                        await addVideoToUI(message.videoData);
                    }
                    break;
                    
                case 'update':
                    if (message.videoData && message.normalizedUrl) {
                        await updateVideoInUI(message.normalizedUrl, message.videoData, 'structural');
                    }
                    break;
            }
        } 
        else if (message.type === 'flag') {
            // Flag updates with minimal data
            if (message.action === 'remove') {
                // Handle batch removal
                if (Array.isArray(message.normalizedUrl)) {
                    // Batch removal for variant deduplication
                    for (const url of message.normalizedUrl) {
                        await removeVideoFromUI(url);
                    }
                } else {
                    // Single removal
                    await removeVideoFromUI(message.normalizedUrl);
                }
            } else if (message.action === 'update') {
                // Flag updates (like generatingPreview)
                if (message.normalizedUrl && message.flags) {
                    await updateVideoInUI(message.normalizedUrl, message.flags, 'flag');
                }
            }
        }
    } catch (error) {
        logger.error('Error handling video state update:', error);
        // Fallback to full refresh on error
        if (message.videos) {
            await renderVideos(message.videos || []);
        }
    }
}

/**
 * Send message to background script
 * This function is used by other modules directly
 */
function sendPortMessage(message) {
    const port = connect();
    if (!port || !isConnected) {
        logger.warn('No connection available for message:', message.command);
        return false;
    }
    
    try {
        port.postMessage(message);
        return true;
    } catch (error) {
        logger.error('Error sending message:', error);
        backgroundPort = null;
        isConnected = false;
        return false;
    }
}

/**
 * Disconnect from background script
 */
function disconnect() {
    if (backgroundPort && isConnected) {
        try {
            backgroundPort.disconnect();
        } catch (error) {
            // Ignore disconnect errors
        }
        backgroundPort = null;
        isConnected = false;
        logger.debug('Disconnected from background');
    }
}

/**
 * Update cache stats display
 */
function updateCacheStatsDisplay(stats) {
    const element = document.querySelector('.cache-stats');
    if (!element) return;
    
    if (!stats) {
        element.textContent = 'No cache stats available';
        return;
    }
    
    const count = stats.count || 0;
    const sizeInKB = Math.round((stats.size || 0) / 1024);
    element.textContent = `${count} previews (${sizeInKB} KB)`;
}

/**
 * Handle native host state updates
 */
function handleNativeHostStateUpdate(connectionState) {
    // Only update if settings tab is active
    const settingsTab = document.querySelector('.tab-content[data-tab-id="settings-tab"]');
    if (settingsTab && !settingsTab.classList.contains('hidden')) {
        updateNativeHostStatus(connectionState);
    }
}

export {
    connect,
    disconnect,
    sendPortMessage,
    downloadCounts
};
