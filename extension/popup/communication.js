/**
 * Simple communication handler for popup ↔ background
 * Only handles port connection and message routing
 * Other modules use sendPortMessage directly
 */

import { createLogger } from '../shared/utils/logger.js';
import { updateDownloadProgress } from './video/download-progress-handler.js';
import { renderVideos, addVideoToUI, updateVideoInUI, removeVideoFromUI, renderHistoryItems } from './video/video-renderer.js';
import { setVideos, updateVideo, clearVideos } from './state.js';
import { updateUICounters, showToast } from './ui-utils.js';
import { updateSettingsUI, updateNativeHostStatus } from './settings-tab.js';

const logger = createLogger('Communication');

// Port connection
let backgroundPort = null;
let isConnected = false;

// Store download counts for tab counter
let downloadCounts = { active: 0, queued: 0, total: 0 };

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
    
    switch (message.command) {
        case 'videos-state-update':
            await handleVideoStateUpdate(message);
            break;

        case 'update-ui-counters':
            updateUICounters({ videos: message.counts });
            break;

        case 'cachesCleared':
            clearVideos();
            await renderVideos();
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

        default:
            logger.warn('Unknown message command:', message.command);
    }
}

/**
 * Handle action-based video state updates
 */
async function handleVideoStateUpdate(message) {
    logger.debug(`Delegated '${message.action}' action for video: ${message.videoUrl}`);

    try {
        switch (message.action) {
            case 'add':
                if (message.video) {
                    // Update state first
                    updateVideo(message.videoUrl, message.video);
                    // Add to UI
                    await addVideoToUI(message.video);
                }
                break;
                
            case 'update':
                if (message.video) {
                    // Update state first
                    updateVideo(message.videoUrl, message.video);
                    // Update in UI with updateType
                    await updateVideoInUI(message.videoUrl, message.video, message.updateType);
                }
                break;
                
            case 'remove':
                if (message.videoUrl) {
                    // Remove from UI first
                    await removeVideoFromUI(message.videoUrl);
                    // Note: We don't remove from state as it might be needed for restoration
                }
                break;
                
            case 'full-refresh':
                if (message.videos) {
                    setVideos(message.videos);
                    await renderVideos();
                }
                break;
                
            default:
                logger.warn('Unknown video state action:', message.action);
        }
    } catch (error) {
        logger.error('Error handling video state update:', error);
        // Fallback to full refresh on error
        if (message.videos) {
            setVideos(message.videos);
            await renderVideos();
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
