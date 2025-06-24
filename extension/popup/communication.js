/**
 * Simple communication handler for popup ↔ background
 * Only handles port connection and message routing
 * Other modules use sendPortMessage directly
 */

import { createLogger } from '../shared/utils/logger.js';
import { updateDownloadProgress } from './video/download-handler.js';
import { renderVideos, updateVideoElement } from './video/video-renderer.js';
import { setVideos, updateVideo, clearVideos, getVideos } from './state.js';

const logger = createLogger('Communication');

// Port connection
let backgroundPort = null;
let isConnected = false;

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
function handleIncomingMessage(message) {
    logger.debug('Received message:', message.command);
    
    switch (message.command) {
        case 'videoStateUpdated':
            if (message.videos) {
                setVideos(message.videos);
                renderVideos();
            }
            break;
            
        case 'videoUpdated':
            if (message.url && message.video) {
                updateVideo(message.url, message.video);
                updateVideoElement(message.url, message.video);
            }
            break;
            
        case 'cachesCleared':
            clearVideos();
            renderVideos();
            break;
            
        case 'previewCacheStats':
            updateCacheStatsDisplay(message.stats);
            break;
            
        case 'download-progress':
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            updateDownloadProgress(message);
            break;
            
        default:
            logger.warn('Unknown message command:', message.command);
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

export {
    connect,
    disconnect,
    sendPortMessage
};
