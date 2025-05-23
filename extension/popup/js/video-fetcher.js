/**
 * @ai-guide-component VideoFetcher
 * @ai-guide-description Video source detection and metadata retrieval
 * @ai-guide-responsibilities
 * - Retrieves detected videos from background script
 * - Sends commands to background for video processing
 * - Handles background refresh for continuous video detection
 */

// Import from videoStateService
import { fetchVideos,on } from './services/video-state-service.js';
import { renderVideos } from './video-renderer.js';
import { sendPortMessage } from './index.js';
import { validateAndFilterVideos } from '../../js/utilities/video-validator.js';
import { createLogger } from '../../js/utilities/logger.js';

const logger = createLogger('Video Fetcher');

/**
 * Update the video list from background
 * @param {boolean} forceRefresh - Whether to force refresh from background
 * @param {number} tabId - Optional tab ID for the active tab
 * @returns {Promise<Array>} The current videos list
 */
export async function updateVideoList(forceRefresh = false, tabId = null) {
    logger.debug('Updating video list, force refresh:', forceRefresh);
    
    // Show loader
    const container = document.getElementById('videos');
    if (container) {
        showLoader(container);
    }
    
    // Get the tab ID if not provided
    if (!tabId) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab.id;
        } catch (e) {
            logger.error('Error getting current tab:', e);
        }
    }
    
    // Request videos through the state service
    return await fetchVideos({ forceRefresh });
}

// Track the background refresh interval
let backgroundRefreshInterval = null;

/**
 * Start a periodic background refresh loop
 * @param {number} intervalMs - Refresh interval in milliseconds
 * @param {number} tabId - Current tab ID
 */
export function startBackgroundRefreshLoop(intervalMs = 3000, tabId = null) {
    // Clear any existing interval
    stopBackgroundRefreshLoop();
    
    // Get the current tab ID if not provided
    if (!tabId) {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (tab) {
                startBackgroundRefreshLoop(intervalMs, tab.id);
            }
        });
        return null;
    }
    
    logger.debug(`Starting background refresh loop for tab ${tabId}, interval: ${intervalMs}ms`);
    
    // Set up a new interval
    backgroundRefreshInterval = setInterval(() => {
        // Just request videos via port connection - no local caching
        sendPortMessage({ 
            action: 'getVideos', 
            tabId: tabId
        });

    }, intervalMs);
    
    return backgroundRefreshInterval;
}

/**
 * Stop background refresh loop
 */
export function stopBackgroundRefreshLoop() {
    if (backgroundRefreshInterval) {
        clearInterval(backgroundRefreshInterval);
        backgroundRefreshInterval = null;
        logger.debug('Background refresh loop stopped');
    }
}

/**
 * Initialize the video fetcher
 * Sets up event listeners and initial refresh
 */
export function initVideoFetcher() {
    logger.debug('Initializing video fetcher');
    
    // Listen for video updates from state service
    on('videosUpdated', (videos) => {
        logger.debug(`Received ${videos.length} videos from state service`);
        renderVideos(videos);
    });
    
    // Start background refresh
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab) {
            startBackgroundRefreshLoop(3000, tab.id);
        }
    });
}
