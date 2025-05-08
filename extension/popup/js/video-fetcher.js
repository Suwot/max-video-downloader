/**
 * @ai-guide-component VideoFetcher
 * @ai-guide-description Video source detection and metadata retrieval
 * @ai-guide-responsibilities
 * - Retrieves detected videos from background script
 * - Sends commands to background for video processing
 * - Handles background refresh for continuous video detection
 */

// Import from videoStateService
import { 
    fetchVideos,
    refreshVideos,
    on
} from './services/video-state-service.js';

import { showLoader, restoreScrollPosition } from './ui.js';
import { renderVideos } from './video-renderer.js';
import { sendPortMessage } from './index.js';
import { validateAndFilterVideos } from '../../js/utilities/video-validator.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Video Fetcher]', new Date().toISOString(), ...args);
}

/**
 * Update the video list from background
 * @param {boolean} forceRefresh - Whether to force refresh from background
 * @param {number} tabId - Optional tab ID for the active tab
 * @returns {Promise<Array>} The current videos list
 */
export async function updateVideoList(forceRefresh = false, tabId = null) {
    logDebug('Updating video list, force refresh:', forceRefresh);
    
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
            logDebug('Error getting current tab:', e);
        }
    }
    
    // Request videos through the state service
    return await fetchVideos({ forceRefresh });
}

/**
 * Request scan for new videos in the current tab
 * @param {number} tabId - Tab ID
 */
export async function requestNewVideoScan(tabId) {
    if (!tabId) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab.id;
        } catch (e) {
            logDebug('Error getting current tab:', e);
            return false;
        }
    }
    
    logDebug('Requesting new video scan for tab:', tabId);
    
    try {
        // Tell content script to look for videos
        const response = await chrome.tabs.sendMessage(tabId, { action: 'findVideos' });
        
        if (response && response.length) {
            logDebug('Found new videos in scan:', response.length);
            
            // Filter response with validation
            const filteredVideos = validateAndFilterVideos(response);
            
            if (filteredVideos.length > 0) {
                // Send new videos to background for processing
                sendPortMessage({
                    action: 'addNewVideos',
                    videos: filteredVideos,
                    tabId: tabId
                });
                
                // Refresh our videos list
                setTimeout(() => refreshVideos(), 500);
                return true;
            }
        }
    } catch (error) {
        logDebug('Error in video scan:', error);
    }
    
    return false;
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
    
    logDebug(`Starting background refresh loop for tab ${tabId}, interval: ${intervalMs}ms`);
    
    // Set up a new interval
    backgroundRefreshInterval = setInterval(() => {
        // Just request videos via port connection - no local caching
        sendPortMessage({ 
            action: 'getVideos', 
            tabId: tabId
        });
        
        // Also scan for new videos occasionally
        if (Math.random() < 0.3) { // ~30% chance
            requestNewVideoScan(tabId);
        }
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
        logDebug('Background refresh loop stopped');
    }
}

/**
 * Initialize the video fetcher
 * Sets up event listeners and initial refresh
 */
export function initVideoFetcher() {
    logDebug('Initializing video fetcher');
    
    // Listen for video updates from state service
    on('videosUpdated', (videos) => {
        logDebug(`Received ${videos.length} videos from state service`);
        renderVideos(videos);
        restoreScrollPosition();
    });
    
    // Start background refresh
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab) {
            startBackgroundRefreshLoop(3000, tab.id);
        }
    });
}

// Export previously existing functions that might be used elsewhere
export const refreshInBackground = requestNewVideoScan;