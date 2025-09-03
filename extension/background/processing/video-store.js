/**
 * Video Store Service
 * Manages video data storage, retrieval, and state management
 */

import { normalizeUrl } from '../../shared/utils/processing-utils.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';
import { updateTabIcon } from '../state/tab-manager.js';

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
        console.error(`Error in getVideoByUrl: ${err.message}`);
        return null;
    }
}

// Remove the old determineUpdateType function - no longer needed

/**
 * Update video in store and notify UI
 * @param {string} action - 'add', 'update', or 'remove'
 * @param {Object} updates - Update object containing tabId, normalizedUrl, and video data
 * @returns {boolean} - Success status
 */
function updateVideo(action, updates) {
    const { tabId, normalizedUrl } = updates;
    
    if (!tabId || !normalizedUrl) {
        console.error('[UV]: updateVideo requires tabId and normalizedUrl in updates');
        return false;
    }
    
    console.debug(`[UV]: ${action} for ${normalizedUrl}`, updates);

    // Initialize tab map if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    const tabMap = allDetectedVideos.get(tabId);

    // Handle batch removal operations (variant deduplication)
    if (action === 'remove' && Array.isArray(normalizedUrl)) {
        const urls = normalizedUrl;
        console.debug(`[UV]: Batch remove operation: ${urls.length} URLs`);
        
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

        // Send batch removal to UI with complete video data
        broadcastToPopups({
            command: 'videos-state-update',
            action: action,
            tabId: tabId,
            normalizedUrl: urls, // Array for batch operation
            videoData: updates // Send the update data
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
    
    // Send complete merged video data to UI
    broadcastToPopups({
        command: 'videos-state-update',
        action: action,
        tabId: tabId,
        normalizedUrl: normalizedUrl,
        videoData: JSON.parse(JSON.stringify(finalVideo)) // Deep clone for UI
    });
    
    console.debug(`[UV]: ${action} completed for ${normalizedUrl}`);

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

// hide from UI display basically
function dismissVideoFromTab(tabId, url) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return;
    const normalizedUrl = normalizeUrl(url);
    if (!tabMap.has(normalizedUrl)) return;
    
    // Send only the changes - updateVideo will merge internally
    updateVideo('remove', {
        tabId,
        normalizedUrl,
        timestampDismissed: Date.now(),
        validForDisplay: false
    });
    
    console.info(`Dismissed video ${url} for tab ${tabId}`);
}


// recover in UI display – not used yet
function restoreVideoInTab(tabId, url) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return;
    const normalizedUrl = normalizeUrl(url);
    if (!tabMap.has(normalizedUrl)) return;
    const video = tabMap.get(normalizedUrl);
    // Only restore if it was dismissed
    if (!video.timestampDismissed) return;
    
    // Send only the changes - updateVideo will merge and calculate validForDisplay
    updateVideo('add', {
        tabId,
        normalizedUrl,
        timestampDismissed: undefined, // Remove the dismissed timestamp
        validForDisplay: true
    });
    console.info(`Restored video ${url} for tab ${tabId}`);
}

// Get videos for UI display with efficient filtering
function getVideosForDisplay(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    if (!tabVideosMap) return [];
    return Array.from(tabVideosMap.values())
        .filter(video => video.validForDisplay)
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
}

// Send full refresh of all videos to UI (for popup open)
function sendFullRefresh(tabId) {
    const videos = getVideosForDisplay(tabId);
    const videoCounts = getVideoTypeCounts(tabId);
    
    // Send both counters and videos in a single message for efficiency
    broadcastToPopups({
        command: 'videos-state-update',
        action: 'full-refresh',
        tabId: tabId,
        videos: videos,
        counts: videoCounts // Include counts in full refresh
    });
    
    console.debug(`Sent full refresh with ${videos.length} videos for tab ${tabId}`);
}

// Get video counts by type for a tab (only validForDisplay videos) { hls, dash, direct, unknown, total }
function getVideoTypeCounts(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    const counts = { hls: 0, dash: 0, direct: 0, unknown: 0, total: 0 };
    if (!tabVideosMap) return counts;
    for (const video of tabVideosMap.values()) {
        if (!video.validForDisplay) continue;
        if (video.type && Object.prototype.hasOwnProperty.call(counts, video.type)) {
            counts[video.type]++;
        } else {
            counts.unknown++;
        }
        counts.total++;
    }
    return counts;
}

// Clean up videos for a specific tab
function cleanupVideosForTab(tabId) {
    console.debug(`Cleaning up videos for tab ${tabId}`);
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
    }
    
    // Clean up variant-master relationships
    if (variantMasterMap.has(tabId)) {
        variantMasterMap.delete(tabId);
    }
    
    // Reset tab icon immediately after cleanup
    updateTabIcon(tabId);
}

// Clean up all videos from all tabs
function cleanupAllVideos() {
    console.debug('Cleaning up all detected videos');
    
    allDetectedVideos.clear();
    variantMasterMap.clear();
    
    // Reset all tab icons after global cleanup
    updateTabIcon(); // Global reset (no tabId parameter)

    console.info('All detected videos cleared');
}

export {
    // Core video operations
    getVideo,
    getVideoByUrl,
    updateVideo,
    getVideoTypeCounts,
    dismissVideoFromTab,
    restoreVideoInTab,
    getVideosForDisplay,
    sendFullRefresh,
    cleanupVideosForTab,
    cleanupAllVideos
};
