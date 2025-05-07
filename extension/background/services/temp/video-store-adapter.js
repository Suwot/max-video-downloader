/**
 * @ai-guide-component VideoStoreAdapter
 * @ai-guide-description Adapter between old video manager and new centralized store
 * @ai-guide-responsibilities
 * - Provides backwards compatibility for existing API calls
 * - Bridges between the old video handling approach and new centralized store
 * - Maps between different data formats
 * - Provides a migration path to the new architecture
 */

import { videoStore, broadcastVideoUpdate } from './video-store.js';
import { normalizeUrl } from '../../../js/utilities/normalize-url.js';

// Track popup open state by tab
const activePopups = new Set();

/**
 * Register a popup as active for a specific tab
 * @param {number} tabId - Tab ID
 */
function registerActivePopup(tabId) {
  if (!tabId) return;
  
  console.log(`[Store Adapter] Registered active popup for tab ${tabId}`);
  activePopups.add(tabId);
  
  // Immediately send current videos to newly opened popup
  broadcastVideoUpdate(tabId);
}

/**
 * Unregister a popup for a specific tab
 * @param {number} tabId - Tab ID
 */
function unregisterActivePopup(tabId) {
  if (!tabId) return;
  
  console.log(`[Store Adapter] Unregistered popup for tab ${tabId}`);
  activePopups.delete(tabId);
}

/**
 * Check if a popup is open for a specific tab
 * @param {number} tabId - Tab ID
 * @returns {boolean} Whether a popup is open
 */
function hasActivePopup(tabId) {
  return activePopups.has(tabId);
}

/**
 * Add a video to the store
 * @param {number} tabId - Tab ID
 * @param {Object} videoInfo - Video information
 */
function addVideoToStore(tabId, videoInfo) {
  // Add to our new store
  const addedVideo = videoStore.addVideo(tabId, videoInfo);
  
  // If successful addition and popup is open for this tab, notify it
  if (addedVideo && hasActivePopup(tabId)) {
    console.log(`[Store Adapter] Notifying active popup for tab ${tabId} about video update`);
    broadcastVideoUpdate(tabId);
  }
  
  return addedVideo;
}

/**
 * Get videos for a tab from the store
 * @param {number} tabId - Tab ID
 * @returns {Array} Array of videos
 */
function getVideosForTab(tabId) {
  return videoStore.getVideosForTab(tabId);
}

/**
 * Find a video by URL in a specific tab
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @returns {Object|null} Video object or null if not found
 */
function findVideoByUrl(tabId, url) {
  return videoStore.getVideo(tabId, url);
}

/**
 * Check if a video exists in a tab
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @returns {boolean} Whether the video exists
 */
function hasVideo(tabId, url) {
  return !!findVideoByUrl(tabId, url);
}

/**
 * Clean up videos for a tab
 * @param {number} tabId - Tab ID
 */
function cleanupForTab(tabId) {
  videoStore.clearTab(tabId);
  activePopups.delete(tabId);
}

// Listen for tab updates to track popup state
chrome.tabs.onRemoved.addListener((tabId) => {
  // Clean up when a tab is closed
  cleanupForTab(tabId);
});

// Expose the video store adapter API
export default {
  addVideoToStore,
  getVideosForTab,
  findVideoByUrl,
  hasVideo,
  cleanupForTab,
  registerActivePopup,
  unregisterActivePopup,
  hasActivePopup
};