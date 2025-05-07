/**
 * @ai-guide-component VideoStore
 * @ai-guide-description Centralized video data store for the extension
 * @ai-guide-responsibilities
 * - Provides a single source of truth for video data
 * - Manages the video object lifecycle
 * - Handles tab-specific video collections
 * - Provides API for adding, removing, and retrieving videos
 * - Broadcasts video updates to listening components
 * - Ensures data consistency across the extension
 */

import { normalizeUrl } from '../../../js/utilities/normalize-url.js';
import nativeHostService from '../../../js/native-host-service.js';
import { getActivePopupPortForTab } from '../popup-ports.js';
import { parseHLSManifest, parseDASHManifest } from '../../../popup/js/manifest-parser.js';

// Debug logging helper
function logDebug(...args) {
  console.log('[Video Store]', new Date().toISOString(), ...args);
}

// Extract filename from URL
function getFilenameFromUrl(url) {
  if (url.startsWith('blob:')) {
    return 'video_blob';
  }
  
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    
    if (filename && filename.length > 0) {
      return filename;
    }
  } catch {}
  
  return 'video';
}

// Internal video storage
const videosByTab = new Map();

/**
 * Add a video to the store for a specific tab
 * @param {number} tabId - Tab ID
 * @param {Object} videoInfo - Video information
 * @returns {Object|null} The added video or null if already exists
 */
function addVideo(tabId, videoInfo) {
  if (!tabId || !videoInfo || !videoInfo.url) {
    console.error('[Video Store] Invalid video data', videoInfo);
    return null;
  }
  
  // Initialize videos array for this tab if needed
  if (!videosByTab.has(tabId)) {
    videosByTab.set(tabId, new Map());
  }
  
  const tabVideos = videosByTab.get(tabId);
  const url = videoInfo.url;
  
  // Check if we already have this video
  if (tabVideos.has(url)) {
    // Update existing video with any new properties
    const existingVideo = tabVideos.get(url);
    const updatedVideo = { ...existingVideo, ...videoInfo };
    
    // Only update if something actually changed
    if (JSON.stringify(existingVideo) !== JSON.stringify(updatedVideo)) {
      console.log(`[Video Store] Updating existing video for tab ${tabId}:`, url);
      tabVideos.set(url, updatedVideo);
      return updatedVideo;
    }
    
    return null; // No change
  }
  
  // Add new video
  console.log(`[Video Store] Added new video for tab ${tabId}:`, url);
  tabVideos.set(url, videoInfo);
  return videoInfo;
}

/**
 * Get a video by URL for a specific tab
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @returns {Object|null} Video object or null if not found
 */
function getVideo(tabId, url) {
  if (!tabId || !url) return null;
  
  const tabVideos = videosByTab.get(tabId);
  if (!tabVideos) return null;
  
  return tabVideos.get(url) || null;
}

/**
 * Get all videos for a specific tab
 * @param {number} tabId - Tab ID
 * @returns {Array} Array of videos
 */
function getVideosForTab(tabId) {
  if (!tabId) return [];
  
  const tabVideos = videosByTab.get(tabId);
  if (!tabVideos) return [];
  
  // Convert Map values to Array
  return Array.from(tabVideos.values());
}

/**
 * Remove a video by URL from a specific tab
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @returns {boolean} Whether the video was removed
 */
function removeVideo(tabId, url) {
  if (!tabId || !url) return false;
  
  const tabVideos = videosByTab.get(tabId);
  if (!tabVideos) return false;
  
  return tabVideos.delete(url);
}

/**
 * Clear all videos for a specific tab
 * @param {number} tabId - Tab ID
 */
function clearTab(tabId) {
  if (!tabId) return;
  
  videosByTab.delete(tabId);
  console.log(`[Video Store] Cleared videos for tab ${tabId}`);
}

/**
 * Broadcast video updates to a popup for a specific tab
 * @param {number} tabId - Tab ID for which to broadcast
 */
function broadcastVideoUpdate(tabId) {
  if (!tabId) return;
  
  const videos = getVideosForTab(tabId);
  console.log(`[Video Store] Broadcasting video update for tab ${tabId}, ${videos.length} videos`);
  
  // Send message to popup informing it of updated videos
  chrome.runtime.sendMessage({
    action: 'videoStateUpdated',
    tabId: tabId,
    videos: videos
  }).catch(error => {
    // This error is expected if no popup is listening, so just log it at debug level
    console.log(`[Video Store] No receivers for video update: ${error.message}`);
  });
}

// Export the store API
export const videoStore = {
  addVideo,
  getVideo,
  getVideosForTab,
  removeVideo,
  clearTab
};

// Export the broadcast function separately
export { broadcastVideoUpdate };