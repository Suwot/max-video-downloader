/**
 * Video Store Service
 * Manages video data storage, retrieval, and state management
 */

import { normalizeUrl } from '../../shared/utils/normalize-url.js';
import { createLogger } from '../../shared/utils/logger.js';
import { calculateValidForDisplay } from '../../shared/utils/video-utils.js';
import { sendVideoStateChange } from '../messaging/popup-communication.js';

// Create a logger instance for the Video Store module
const logger = createLogger('Video Store');

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Track relationships between variants and their master playlists
// Map<tabId, Map<normalizedVariantUrl, masterUrl>>
const variantMasterMap = new Map();

// Track dismissed videos per tab
// Map<tabId, Set<normalizedUrl>>
const dismissedVideos = new Map();

// Track tabs that have valid, displayable videos for icon management
// Set<tabId> - if tab is in set, it has videos (colored icon)
const tabsWithVideos = new Set();

// Expose internal maps for debugging and pipeline access
globalThis.allDetectedVideosInternal = allDetectedVideos;
globalThis.variantMasterMapInternal = variantMasterMap;
globalThis.dismissedVideosInternal = dismissedVideos;

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
    
    // Always recalculate validForDisplay
    updatedVideo.validForDisplay = calculateValidForDisplay(updatedVideo);
    
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
        sendVideoStateChange(tabId, normalizedUrl, { updatedVideo, action });
    }

    return updatedVideo;
}

/**
 * Track and update variant-master relationships
 * @param {number} tabId - Tab ID
 * @param {Array} variants - Array of variant objects
 * @param {string} masterUrl - The normalized master URL
 * @returns {Array} Array of updated video objects for variants that were changed
 */
function handleVariantMasterRelationships(tabId, variants, masterUrl) {
    if (!variantMasterMap.has(tabId)) {
        variantMasterMap.set(tabId, new Map());
    }
    
    const tabVariantMap = variantMasterMap.get(tabId);
    const tabVideos = allDetectedVideos.get(tabId);
    
    if (!tabVideos) return [];
    
    const updatedVideos = [];
    
    // Process each variant
    for (const variant of variants) {
        const variantUrl = variant.normalizedUrl;
        
        // Update the variant-master relationship map
        tabVariantMap.set(variantUrl, masterUrl);
        logger.debug(`Tracked variant ${variantUrl} as belonging to master ${masterUrl}`);
        
        // If this variant exists as standalone, update it
        if (tabVideos.has(variantUrl)) {
            const updatedVideo = updateVideo('handleVariantMasterRelationships', tabId, variantUrl, {
                hasKnownMaster: true,
                masterUrl: masterUrl,
                isVariant: true
            });
            if (updatedVideo) {
                logger.debug(`Updated existing standalone variant ${variantUrl} with master info`);
                updatedVideos.push({ variantUrl, updatedVideo });
            }
        }
    }
    
    return updatedVideos;
}

/**
 * Dismiss a video for a tab (hide from UI, skip processing)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 */
function dismissVideoFromTab(tabId, url) {
    if (!dismissedVideos.has(tabId)) {
        dismissedVideos.set(tabId, new Set());
    }
    dismissedVideos.get(tabId).add(url);
    logger.info(`Dismissed video ${url} for tab ${tabId}`);
}

/**
 * Restore a dismissed video for a tab (show in UI, allow processing)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 */
function restoreVideoInTab(tabId, url) {
    if (dismissedVideos.has(tabId)) {
        dismissedVideos.get(tabId).delete(url);
        logger.info(`Restored video ${url} for tab ${tabId}`);
    }
}

/**
 * Checks if a video is dismissed for a tab
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @returns {boolean} True if dismissed
 */
function isVideoDismissed(tabId, url) {
    return dismissedVideos.has(tabId) && dismissedVideos.get(tabId).has(url);
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
        .filter(video => video.validForDisplay && !isVideoDismissed(tabId, video.normalizedUrl))
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
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
    
    // Clean up dismissed videos
    if (dismissedVideos.has(tabId)) {
        dismissedVideos.delete(tabId);
    }
    
    // Clean up icon state
    if (tabsWithVideos.has(tabId)) {
        tabsWithVideos.delete(tabId);
    }
}

/**
 * Clean up all videos from all tabs
 */
function cleanupAllVideos() {
    logger.debug('Cleaning up all detected videos');
    
    allDetectedVideos.clear();
    variantMasterMap.clear();
    dismissedVideos.clear();
    tabsWithVideos.clear();
    logger.info('All detected videos cleared');
}

/**
 * Get tab tracking state
 * @param {number} tabId - Tab ID
 * @returns {boolean} True if tab has videos
 */
function hasVideosInTab(tabId) {
    return tabsWithVideos.has(tabId);
}

/**
 * Add tab to videos tracking
 * @param {number} tabId - Tab ID
 */
function addTabWithVideos(tabId) {
    tabsWithVideos.add(tabId);
}

/**
 * Remove tab from videos tracking
 * @param {number} tabId - Tab ID
 */
function removeTabWithVideos(tabId) {
    tabsWithVideos.delete(tabId);
}

export {
    // Core video operations
    getVideo,
    getVideoByUrl,
    updateVideo,
    
    // Variant-master relationships
    handleVariantMasterRelationships,
    
    // Video dismissal
    dismissVideoFromTab,
    restoreVideoInTab,
    isVideoDismissed,
    
    // Display and cleanup
    getVideosForDisplay,
    cleanupVideosForTab,
    cleanupAllVideos,
    
    // Tab tracking
    hasVideosInTab,
    addTabWithVideos,
    removeTabWithVideos
};
