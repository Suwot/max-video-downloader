/**
 * Video Store Service
 * Manages video data storage, retrieval, and state management
 */

import { normalizeUrl, calculateValidForDisplay } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';
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
 * Dismiss a video for a tab (hide from UI, skip processing)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 */
function dismissVideoFromTab(tabId, url) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return;
    const normalizedUrl = normalizeUrl(url);
    if (!tabMap.has(normalizedUrl)) return;
    
    const video = tabMap.get(normalizedUrl);
    const updatedVideo = {
        ...video,
        timestampDismissed: Date.now(),
        validForDisplay: false
    };
    
    storeAndNotifyUI(updatedVideo, 'structural', 'remove');
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
    
    // Remove timestampDismissed and recalculate validForDisplay
    const updated = { ...video };
    delete updated.timestampDismissed;
    updated.validForDisplay = calculateValidForDisplay(updated);
    
    storeAndNotifyUI(updated, 'structural', 'add');
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

/**
 * Store video data and broadcast UI update - clean 2-stage function
 * Stage 1: Replace allDetectedVideos map entry with new merged data
 * Stage 2: Send to UI on success, send only flags to UI on errors/fails
 * @param {Object} videoData - Complete video data (contains tabId, normalizedUrl, etc.)
 * @param {string} updateType - 'structural' or 'flags'
 * @param {string} action - 'add', 'update', or 'remove' (required for efficiency)
 */
function storeAndNotifyUI(videoData, updateType = 'structural', action = 'update') {
    const { tabId, normalizedUrl } = videoData;
    logger.debug('Received videoData:', videoData, `updateType: ${updateType}, action: ${action}`);
    
    // Stage 1: Store in allDetectedVideos map (always store, regardless of validForDisplay)
    let tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) {
        tabMap = new Map();
        allDetectedVideos.set(tabId, tabMap);
    }
    
    // Store the complete video data
    tabMap.set(normalizedUrl, videoData);
    
    // Stage 2: Send to UI based on validForDisplay and update type
    const nowValidForDisplay = videoData.validForDisplay !== false && calculateValidForDisplay(videoData);
    
    // For flags updates, always send to UI if video is currently displayed
    if (updateType === 'flags') {
        if (nowValidForDisplay) {
            broadcastToPopups({
                command: 'videos-state-update',
                action: 'update',
                updateType: 'flags',
                tabId,
                videoUrl: normalizedUrl,
                video: JSON.parse(JSON.stringify(videoData))
            });
        }
        return; // Don't update counters or tab icon for flag-only updates
    }
    
    // For structural updates, send to UI based on action and validForDisplay
    const shouldSendUIUpdate = (action === 'add' && nowValidForDisplay) || 
                              (action === 'update' && nowValidForDisplay) || 
                              (action === 'remove'); // Always send remove actions
    
    if (shouldSendUIUpdate) {
        // Update counters
        const counts = getVideoTypeCounts(tabId);
        broadcastToPopups({
            command: 'update-ui-counters',
            tabId,
            counts
        });
        
        // Send video update
        broadcastToPopups({
            command: 'videos-state-update',
            action,
            updateType,
            tabId,
            videoUrl: normalizedUrl,
            video: JSON.parse(JSON.stringify(videoData))
        });
        
        updateTabIcon(tabId);
    }
}

export {
    // Core video operations
    getVideo,
    getVideoByUrl,
    getVideoTypeCounts,

    // Video dismissal
    dismissVideoFromTab,
    restoreVideoInTab,

    // Display and cleanup
    getVideosForDisplay,
    cleanupVideosForTab,
    cleanupAllVideos,
    
    // Direct store and UI update
    storeAndNotifyUI
};
