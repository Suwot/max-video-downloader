/**
 * Video Store Service
 * Manages video data storage, retrieval, and state management
 */

import { normalizeUrl } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { calculateValidForDisplay } from '../../shared/utils/processing-utils.js';
import { sendVideoStateChange } from '../messaging/popup-communication.js';
import { updateTabIcon } from '../state/tab-manager.js';

// Create a logger instance for the Video Store module
const logger = createLogger('Video Store');

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Track relationships between video tracks and their master playlists
// Map<tabId, Map<normalizedVideoTrackUrl, masterUrl>>
const variantMasterMap = new Map();

// Expose internal maps for debugging and pipeline access
globalThis.allDetectedVideosInternal = allDetectedVideos;
globalThis.variantMasterMapInternal = variantMasterMap;

/**
 * Helper function to get a video from store
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @returns {Object|null} Video object or null if not found
 */
function getVideo(tabId, normalizedUrl) {
    const tabMap = allDetectedVideos.get(tabId);
    return tabMap ? tabMap.get(normalizedUrl) : null;
}

/**
 * Get a video by URL from any tab
 * @param {string} url - The URL of the video to find
 * @returns {Object|null} Video object or null if not found
 */
function getVideoByUrl(url) {
    try {
        const normalizedUrl = normalizeUrl(url);
        
        // Search through all tabs
        for (const [tabId, urlMap] of allDetectedVideos.entries()) {
            if (urlMap instanceof Map && urlMap.has(normalizedUrl)) {
                return urlMap.get(normalizedUrl);
            }
        }
        
        return null;
    } catch (err) {
        logger.error(`Error in getVideoByUrl: ${err.message}`);
        return null;
    }
}

/**
 * Single entry point for all video updates with proper logging and action detection
 * @param {string} functionName - Function making the update
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Video URL
 * @param {Object} updates - Fields to update (or complete object)
 * @param {boolean} [replace=false] - If true, replace the entire object instead of merging
 * @param {boolean} [sendToUI=true] - If true, automatically send UI updates
 * @returns {Object|null} - Updated video object or null if video not found
 */
function updateVideo(functionName, tabId, normalizedUrl, updates, replace = false, sendToUI = true) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return null;

    // Track existence and display state before update
    const existed = tabMap.has(normalizedUrl);
    const previousVideo = existed ? tabMap.get(normalizedUrl) : null;
    const wasValidForDisplay = previousVideo?.validForDisplay || false;

    // For replace mode, only check if tabMap exists
    // For update mode, also check if the video exists
    if (!replace && !existed) return null;

    // Create updated video object
    let updatedVideo;
    if (replace) {
        updatedVideo = { ...updates };
    } else {
        updatedVideo = { ...previousVideo, ...updates };
    }

    // If video is dismissed, always force validForDisplay to false
    if (updatedVideo.timestampDismissed) {
        updatedVideo.validForDisplay = false;
    } else {
        // Only allow validForDisplay to be true if not dismissed
        updatedVideo.validForDisplay = calculateValidForDisplay(updatedVideo);
    }

    // Set the value in the map
    tabMap.set(normalizedUrl, updatedVideo);

    // Determine action based on validForDisplay state transitions only
    let action = 'update';
    const nowValidForDisplay = updatedVideo.validForDisplay;

    if (!wasValidForDisplay && nowValidForDisplay) {
        action = 'add';
    } else if (wasValidForDisplay && !nowValidForDisplay) {
        action = 'remove';
    } else if (wasValidForDisplay && nowValidForDisplay) {
        action = 'update';
    } else {
        // Both false/undefined - no UI change needed
        sendToUI = false;
    }

    logger.debug(`Updated video with action: '${action}' by ${functionName}, for URL: ${normalizedUrl}, ${sendToUI ? 'SENT to UI' : 'NOT SENT to UI'}`, updatedVideo);
    // Send UI update if requested
    if (sendToUI) {
        // Always send structural updates - flags are handled via CSS classes in UI
        sendVideoStateChange(tabId, normalizedUrl, { updatedVideo, action, updateType: 'structural' });
        updateTabIcon(tabId);
    }

    return updatedVideo;
}

/**
 * Dismiss a video for a tab (hide from UI, skip processing)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 */
function dismissVideoFromTab(tabId, url) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return;
    const normalizedUrl = normalizeUrl(url);
    if (!tabMap.has(normalizedUrl)) return;
    updateVideo('dismissVideoFromTab', tabId, normalizedUrl, {
        timestampDismissed: Date.now(),
        validForDisplay: false
    });
    logger.info(`Dismissed video ${url} for tab ${tabId}`);
}


/**
 * Restore a dismissed video for a tab (show in UI, allow processing)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 */
function restoreVideoInTab(tabId, url) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return;
    const normalizedUrl = normalizeUrl(url);
    if (!tabMap.has(normalizedUrl)) return;
    const video = tabMap.get(normalizedUrl);
    // Only restore if it was dismissed
    if (!video.timestampDismissed) return;
    // Remove timestampDismissed and re-evaluate validForDisplay
    const updated = { ...video };
    delete updated.timestampDismissed;
    // validForDisplay will be recalculated in updateVideo
    updateVideo('restoreVideoInTab', tabId, normalizedUrl, updated, true);
    logger.info(`Restored video ${url} for tab ${tabId}`);
}

/**
 * Get videos for UI display with efficient filtering
 * @param {number} tabId - Tab ID
 * @returns {Array} Filtered and processed videos
 */
function getVideosForDisplay(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    if (!tabVideosMap) return [];
    return Array.from(tabVideosMap.values())
        .filter(video => video.validForDisplay)
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
}

/**
 * Get video counts by type for a tab (only validForDisplay videos)
 * @param {number} tabId - Tab ID
 * @returns {Object} { hls, dash, direct, unknown, total }
 */
function getVideoTypeCounts(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    const counts = { hls: 0, dash: 0, direct: 0, unknown: 0, total: 0 };
    if (!tabVideosMap) return counts;
    for (const video of tabVideosMap.values()) {
        if (!video.validForDisplay) continue;
        if (video.type && counts.hasOwnProperty(video.type)) {
            counts[video.type]++;
        } else {
            counts.unknown++;
        }
        counts.total++;
    }
    return counts;
}

/**
 * Clean up videos for a specific tab
 * @param {number} tabId - Tab ID
 */
function cleanupVideosForTab(tabId) {
    logger.debug(`Cleaning up videos for tab ${tabId}`);
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
    }
    
    // Clean up variant-master relationships
    if (variantMasterMap.has(tabId)) {
        variantMasterMap.delete(tabId);
    }
    
}

/**
 * Clean up all videos from all tabs
 */
function cleanupAllVideos() {
    logger.debug('Cleaning up all detected videos');
    
    allDetectedVideos.clear();
    variantMasterMap.clear();

    logger.info('All detected videos cleared');
}

export {
    // Core video operations
    getVideo,
    getVideoByUrl,
    updateVideo,
    getVideoTypeCounts,

    // Video dismissal
    dismissVideoFromTab,
    restoreVideoInTab,

    // Display and cleanup
    getVideosForDisplay,
    cleanupVideosForTab,
    cleanupAllVideos
};
