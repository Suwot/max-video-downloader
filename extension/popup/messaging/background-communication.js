/**
 * Background Communication Service
 * Single-responsibility handler for all popup ↔ background service worker communication
 * Manages port connection, message routing, command execution, and UI updates
 */

import { updateDownloadProgress } from '../video/download-handler.js';
import { renderVideos } from '../video/video-renderer.js';
import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('BackgroundCommunication');

// Port connection state
let backgroundPort = null;
let isConnected = false;

// Communication state - centralized here
let currentTabId = null;
let isEmptyState = true;
let currentVideos = [];
let lastFetchTime = 0;

/**
 * Initialize the communication service with tab ID
 * @param {number} tabId - Current tab ID
 */
function initialize(tabId) {
    currentTabId = tabId;
    logger.debug('Background communication service initialized with tab:', tabId);
}

/**
 * Update cache stats display element
 * @param {Object} stats - Cache stats
 */
function updateCacheStatsDisplay(stats) {
    const cacheStatsElement = document.querySelector('.cache-stats');
    if (!cacheStatsElement) {
        logger.warn('Cache stats element not found');
        return;
    }

    if (!stats) {
        cacheStatsElement.textContent = 'No cache stats available';
        return;
    }

    const count = stats.count || 0;
    const sizeInKB = Math.round((stats.size || 0) / 1024);
    cacheStatsElement.textContent = `${count} previews (${sizeInKB} KB)`;
}

/**
 * Establish connection to background script
 * @returns {Port|null} The connection port object
 */
function connect() {
    if (!backgroundPort || !isConnected) {
        try {
            backgroundPort = chrome.runtime.connect({ name: 'popup' });
            isConnected = true;
            
            logger.debug('Connected to background script via port');

            // Set up disconnect handler
            backgroundPort.onDisconnect.addListener(() => {
                logger.debug('Port disconnected from background script');
                backgroundPort = null;
                isConnected = false;
            });

            // Set up message handler
            backgroundPort.onMessage.addListener(handleMessage);

        } catch (e) {
            logger.error('Failed to connect to background script:', e);
            backgroundPort = null;
            isConnected = false;
            return null;
        }
    }
    return backgroundPort;
}

/**
 * Handle messages received from background script
 * @param {Object} message - Message received from background script
 */
function handleMessage(message) {
    logger.debug('Received message:', message);

    switch (message.command) {
        case 'videoStateUpdated':
            if (message.videos) {
                logger.debug(`Received ${message.videos.length} videos via port`);
                currentVideos = message.videos; // Update local cache
                renderVideos(message.videos);
            } else {
                logger.warn('videoStateUpdated message missing videos property:', message);
            }
            break;

        case 'cachesCleared':
            logger.debug('Caches cleared, showing initial message');
            const container = document.getElementById('videos');
            container.innerHTML = 
                `<div class="initial-message">
                    <p>No videos found on the page.</p>
                    <p>Play a video or Refresh the page.</p>
                </div>`;
            break;

        case 'videoUpdated':
            logger.debug('Received unified video update:', message.url);
            // Update video in local cache
            const index = currentVideos.findIndex((v) => v.url === message.url);
            if (index !== -1) {
                currentVideos[index] = { ...currentVideos[index], ...message.video };
            }

            updateVideoElement(message.url, message.video);

            break;

        case 'previewCacheStats':
            logger.debug('Received preview cache stats:', message.stats);
            updateCacheStatsDisplay(message.stats);
            break;

        case 'download-progress':
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            updateDownloadProgress(message);
            break;

        default:
            logger.warn('Unknown command received:', message.command, message);
            break;
    }
}

/**
 * Send message to background script
 * @param {Object} message - Message to send
 * @returns {boolean} Success status
 */
function sendPortMessage(message) {
    const port = connect();
    if (port && isConnected) {
        try {
            port.postMessage(message);
            return true;
        } catch (e) {
            logger.error('Error sending message via port:', e);
            backgroundPort = null;
            isConnected = false;
            return false;
        }
    }
    logger.warn('No port connection available for message:', message);
    return false;
}

/**
 * Register popup with background script
 * @param {string} url - Normalized tab URL
 */
function register(url) {
    if (!currentTabId) {
        logger.warn('No tab ID set for registration');
        return false;
    }
    
    return sendPortMessage({
        command: 'register',
        tabId: currentTabId,
        url,
    });
}

/**
 * Request videos for current tab
 * @param {boolean} forceRefresh - Whether to force refresh
 */
function requestVideos(forceRefresh = false) {
    if (!currentTabId) {
        logger.warn('No tab ID provided for video request');
        return false;
    }

    const now = Date.now();

    // Only fetch if forced or it's been a while since last fetch
    if (!forceRefresh && now - lastFetchTime < 2000) {
        logger.debug('Skipping fetch, too soon since last request');
        return false;
    }

    lastFetchTime = now;
    logger.debug(
        'Fetching videos for tab:',
        currentTabId,
        forceRefresh ? '(forced)' : ''
    );
    
    return sendPortMessage({
        command: 'getVideos',
        tabId: currentTabId,
        forceRefresh,
    });
}

/**
 * Clear all caches and local state
 */
function clearCaches() {
    logger.debug('Clearing caches');

    // Clear local cache
    currentVideos = [];

    // Reset last fetch time to force refresh next time
    lastFetchTime = 0;

    // Update UI to show empty state
    renderVideos([]);

    // Request background to clear all caches
    return sendPortMessage({
        command: 'clearCaches',
    });
}

/**
 * Disconnect from background script
 */
function disconnect() {
    if (backgroundPort && isConnected) {
        try {
            backgroundPort.disconnect();
        } catch (e) {
            // Suppress errors during disconnect
        }
        backgroundPort = null;
        isConnected = false;
        logger.debug('Disconnected from background script');
    }
}

/**
 * Get current communication state
 */
function getState() {
    return {
        currentTabId,
        isEmptyState,
        currentVideos: [...currentVideos],
        lastFetchTime,
        isConnected
    };
}

export {
    initialize,
    connect,
    disconnect,
    register,
    requestVideos,
    clearCaches,
    getState,
    sendPortMessage
};
