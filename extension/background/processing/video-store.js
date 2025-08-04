/**
 * Video Store Service
 * Manages video data storage, retrieval, and state management
 */

import { normalizeUrl } from '../../shared/utils/processing-utils.js';
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

// Remove the old determineUpdateType function - no longer needed

/**
 * Simplified video update function with explicit type and action
 * @param {string} updateType - 'structural' or 'flag'
 * @param {string} action - 'add', 'update', or 'remove'
 * @param {number} tabId - Tab ID
 * @param {string|Array<string>} urlOrUrls - Single URL or array of URLs for batch operations
 * @param {Object} videoData - Complete video data (for structural) or flags (for flag updates)
 * @param {string} [functionName] - Function making the update (for logging)
 * @returns {boolean} - Success status
 */
function updateVideo(type, action, updates) {
    const { tabId, normalizedUrl } = updates;
    
    if (!tabId || !normalizedUrl) {
        logger.error('[UV]: updateVideo requires tabId and normalizedUrl in updates');
        return false;
    }
    
    logger.debug(`[UV]: received update with type: ${type}, action: ${action}`, updates);

    // Initialize tab map if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    const tabMap = allDetectedVideos.get(tabId);

    // Handle batch operations for flag+remove (variant deduplication)
    if (type === 'flag' && action === 'remove' && Array.isArray(normalizedUrl)) {
        const urls = normalizedUrl;
        logger.debug(`[UV]: Batch remove operation: ${urls.length} URLs`);
        
        // Apply updates to all URLs with consistent merge logic
        urls.forEach(url => {
            const existingVideo = tabMap.get(url) || {};
			
			if (existingVideo) {
				const mergedVideo = { 
					...existingVideo, 
					...updates,
					normalizedUrl: url, // Override with individual URL
				};
				tabMap.set(url, mergedVideo);
			}
        });

        // Extract flags from updates (exclude tabId, normalizedUrl)
        const { tabId: _, normalizedUrl: __, ...flags } = updates;

        // Send batch removal to UI
        broadcastToPopups({
            command: 'videos-state-update',
            type: type,
            action: action,
            tabId: tabId,
            normalizedUrl: urls, // Array for batch operation
            flags: flags
        });

        // Batch remove always affects count, so update icon and counters
        updateTabIcon(tabId);
        
        // Send updated counters after batch removal
        const videoCounts = getVideoTypeCounts(tabId);
        broadcastToPopups({
            command: 'update-ui-counters',
            tabId: tabId,
            counts: videoCounts
        });
        return true;
    }

    // Handle single URL operations with consistent merge logic
    const existingVideo = tabMap.get(normalizedUrl) || {};
    const finalVideo = { ...existingVideo, ...updates };
    
    // Always store merged result
    tabMap.set(normalizedUrl, finalVideo);
    
    if (type === 'structural') {
        // Send complete merged video data to UI
        broadcastToPopups({
            command: 'videos-state-update',
            type: type,
            action: action,
            tabId: tabId,
            normalizedUrl: normalizedUrl,
            videoData: JSON.parse(JSON.stringify(finalVideo)) // Deep clone for UI
        });
        
        logger.debug(`[UV]: ${type} ${action}: ${normalizedUrl}`);
    } 
    else if (type === 'flag') {
        // Extract flags from updates (exclude tabId, normalizedUrl)
        const { tabId: _, normalizedUrl: __, ...flags } = updates;
        
        // Send only flags to UI
        broadcastToPopups({
            command: 'videos-state-update',
            type: type,
            action: action,
            tabId: tabId,
            normalizedUrl: normalizedUrl,
            flags: flags
        });
        
        logger.debug(`[UV]: ${type} ${action}: ${normalizedUrl}`, flags);
    }

    // Only update tab icon and send counters when video count changes (add/remove actions)
    if (action === 'add' || action === 'remove') {
        updateTabIcon(tabId);
        
        // Send updated counters when count changes
        const videoCounts = getVideoTypeCounts(tabId);
        broadcastToPopups({
            command: 'update-ui-counters',
            tabId: tabId,
            counts: videoCounts
        });
    }
    return true;
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
    
    // Send only the changes - updateVideo will merge internally
    updateVideo('flag', 'remove', {
        tabId,
        normalizedUrl,
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
    
    // Send only the changes - updateVideo will merge and calculate validForDisplay
    updateVideo('structural', 'add', {
        tabId,
        normalizedUrl,
        timestampDismissed: undefined, // Remove the dismissed timestamp
        validForDisplay: true
    });
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
 * Send full refresh of all videos to UI (for popup open)
 * @param {number} tabId - Tab ID
 */
function sendFullRefresh(tabId) {
    const videos = getVideosForDisplay(tabId);
    const videoCounts = getVideoTypeCounts(tabId);
    
    // Send both counters and videos in a single message for efficiency
    broadcastToPopups({
        command: 'videos-state-update',
        type: 'full-refresh',
        tabId: tabId,
        videos: videos,
        counts: videoCounts // Include counts in full refresh
    });
    
    logger.debug(`Sent full refresh with ${videos.length} videos for tab ${tabId}`);
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
    sendFullRefresh,
    cleanupVideosForTab,
    cleanupAllVideos
};
