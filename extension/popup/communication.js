/**
 * Simple communication handler for popup ↔ background
 * Only handles port connection and message routing
 * Other modules use sendPortMessage directly
 */

import { updateDownloadProgress } from './video/download-progress-handler.js';
import { renderVideos, addVideoToUI, updateVideoInUI, removeVideoFromUI, renderHistoryItems, updateHistoryItemDeleted } from './video/video-renderer.js';
import { updateUICounters, showToast, showSuccess, showError } from './ui-utils.js';
import { formatSize } from '../shared/utils/processing-utils.js';
import { updateSettingsUI, updateNativeHostStatus } from './settings-tab.js';
import { currentTabId } from './index.js';

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
        
        console.debug('Connected to background script');
        
        // Handle disconnect
        backgroundPort.onDisconnect.addListener(() => {
            console.debug('Disconnected from background script');
            backgroundPort = null;
            isConnected = false;
        });
        
        // Handle incoming messages
        backgroundPort.onMessage.addListener(handleIncomingMessage);
        
        return backgroundPort;
    } catch (error) {
        console.error('Failed to connect to background:', error);
        backgroundPort = null;
        isConnected = false;
        return null;
    }
}

/**
 * Handle messages from background script
 */
async function handleIncomingMessage(message) {
    console.debug('Received message:', message.command);
    
    // Filter tab-specific messages early to reduce redundant processing
    const tabSpecificCommands = ['videos-state-update', 'update-ui-counters'];
    if (tabSpecificCommands.includes(message.command) && message.tabId) {
        if (currentTabId && message.tabId !== currentTabId) {
            console.debug(`Ignoring ${message.command} for tab ${message.tabId} (current: ${currentTabId})`);
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
            console.warn('Unknown message command:', message.command);
    }
}

/**
 * Handle video state updates
 */
async function handleVideoStateUpdate(message) {
    console.debug(`Video update: ${message.action}`, message);

    try {
        switch (message.action) {
            case 'full-refresh':
                if (message.videos) {
                    await renderVideos(message.videos);
                }
                if (message.counts) {
                    updateUICounters({ videos: message.counts });
                }
                break;

            case 'add':
                if (message.videoData) {
                    await addVideoToUI(message.videoData);
                }
                break;
                
            case 'update':
                if (message.normalizedUrl && message.videoData) {
                    const updateData = message.videoData;
                    await updateVideoInUI(message.normalizedUrl, updateData);
                }
                break;

            case 'remove':
                if (Array.isArray(message.normalizedUrl)) {
                    // Batch removal for variant deduplication
                    for (const url of message.normalizedUrl) {
                        await removeVideoFromUI(url);
                    }
                } else if (message.normalizedUrl) {
                    // Single removal
                    await removeVideoFromUI(message.normalizedUrl);
                }
                break;
        }
    } catch (error) {
        console.error('Error handling video state update:', error);
        // Fallback to full refresh on error
        if (message.videos) {
            await renderVideos(message.videos);
        }
    }
}

/**
 * Send request-response message to background script
 * @param {Object} message - Message object with command and data
 * @param {number} timeout - Timeout in milliseconds (default: 5000)
 * @returns {Promise<Object>} Response from background script
 */
async function sendRuntimeMessage(message, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Message timeout after ${timeout}ms: ${message.command}`));
        }, timeout);
        
        try {
            chrome.runtime.sendMessage(message, (response) => {
                clearTimeout(timeoutId);
                
                if (chrome.runtime.lastError) {
                    console.error('Runtime message failed:', chrome.runtime.lastError.message);
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                
                if (response && response.error) {
                    console.error('Background script error:', response.error);
                    reject(new Error(response.error));
                    return;
                }
                
                resolve(response);
            });
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('Failed to send runtime message:', error);
            reject(error);
        }
    });
}

/**
 * Send fire-and-forget message via persistent port connection
 * @param {Object} message - Message object with command and data
 * @returns {boolean} Success status
 */
function sendPortMessage(message) {
    const port = connect();
    if (!port || !isConnected) {
        console.warn('No port connection available for message:', message.command);
        return false;
    }
    
    try {
        port.postMessage(message);
        return true;
    } catch (error) {
        console.error('Port message failed:', error);
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
        console.debug('Disconnected from background');
    }
}

/**
 * Update cache stats display
 */
function updateCacheStatsDisplay(stats) {
    // Minimal assignment: always write into the button's dataset.dataConstraint.
    const btn = document.getElementById('clear-cache-button');
    const count = (stats?.count) || 0;
    btn.dataset.constraint = (stats && `${count} imgs = ${formatSize(stats?.size || 0)}`) || 'No cache stats available';
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
	sendRuntimeMessage,
    downloadCounts
};
