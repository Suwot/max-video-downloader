/**
 * @ai-guide-component VideoStateService
 * @ai-guide-description Simple state management bridge between background and popup
 * @ai-guide-responsibilities
 * - Provides a unified interface to access video state
 * - Handles communication with background script
 * - Manages local UI state for the current popup session
 */

// popup/js/services/video-state-service.js

import { sendPortMessage } from '../index.js';
import { updateVideoElement } from '../video-list/video-renderer.js';

// Singleton service that manages state
class VideoStateService {
  constructor() {
    // Simple local state for current popup session only - minimal storage
    this.currentVideos = [];
    
    // UI state for the current popup session
    this.activeTabId = null;
    this.lastFetchTime = 0;
    this.isInitialized = false;
    
    // Event system
    this.eventListeners = {};
    
    // Debug helper
    this.debug = (...args) => console.log('[VideoStateService]', ...args);
  }

  /**
   * Initialize the service
   */
  async initialize() {
    if (this.isInitialized) return;
    
    try {
      // Get the active tab ID
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        this.activeTabId = tab.id;
        this.debug('Initialized with active tab ID:', this.activeTabId);
      }

      // Setup video update listeners
      document.addEventListener('video-updated', (event) => {
        const { url, video } = event.detail;
        videoStateService.handleVideoUpdated(event);
        
        // Use the unified updater to update the UI
        updateVideoElement(url, video);
      });
      
      this.isInitialized = true;
      
      // Trigger a videos fetch if we have a tab
      if (this.activeTabId) {
        this.fetchVideos({ forceRefresh: false });
      }
      
      return true;
    } catch (error) {
      console.error('Failed to initialize VideoStateService:', error);
      return false;
    }
  }

  /**
   * Fetch videos from the background script
   * @param {Object} options - Options for the fetch
   * @param {boolean} options.forceRefresh - Whether to force a refresh from background
   * @returns {Promise<Array>} The fetched videos
   */
  async fetchVideos({ forceRefresh = false } = {}) {
    if (!this.activeTabId) {
      await this.initialize();
    }
    
    const now = Date.now();
    
    // Only fetch if forced or it's been a while since last fetch
    if (!forceRefresh && now - this.lastFetchTime < 2000) {
      this.debug('Skipping fetch, too soon since last request');
      return this.currentVideos;
    }
    
    this.lastFetchTime = now;
    this.debug('Fetching videos for tab:', this.activeTabId, forceRefresh ? '(forced)' : '');
    
    // Request videos via port message - background script is the source of truth
    sendPortMessage({
      command: 'getVideos',
      tabId: this.activeTabId,
      forceRefresh: forceRefresh
    });
    
    // Return existing videos while waiting for update
    return this.currentVideos;
  }

  /**
   * Handle unified video updates from background
   * @param {CustomEvent} event - Video update event
   */
  handleVideoUpdated(event) {
    const { url, video } = event.detail;
    
    // Find the video in our current list and update it
    if (this.currentVideos && this.currentVideos.length > 0) {
      const index = this.currentVideos.findIndex(v => v.url === url);
      
      if (index !== -1) {          // Special handling for variants - log when receiving variant updates
          if (video.isVariant) {
            const mediaInfoFieldCount = video.mediaInfo ? Object.keys(video.mediaInfo).length : 0;
            this.debug(`Received variant update with ${mediaInfoFieldCount} mediaInfo fields: ${url}`);
            
            // Add detailed logging of available fields for debugging
            if (video.mediaInfo) {
              this.debug(`Variant mediaInfo fields: ${Object.keys(video.mediaInfo).join(', ')}`);
            }
          }
          
          // Deep clone the incoming mediaInfo to ensure we don't lose any fields
          const incomingMediaInfo = video.mediaInfo ? JSON.parse(JSON.stringify(video.mediaInfo)) : {};
          const existingMediaInfo = this.currentVideos[index].mediaInfo ? 
              JSON.parse(JSON.stringify(this.currentVideos[index].mediaInfo)) : {};
        
        // Properly merge the video with new data, preserving structure
        this.currentVideos[index] = {
          ...this.currentVideos[index],
          ...video,
          // Ensure mediaInfo is properly merged with deep cloned objects
          mediaInfo: {
            ...existingMediaInfo,
            ...incomingMediaInfo
          }
        };
        
        // For variants, also update the master playlist if exists
        if (video.isVariant && video.masterUrl) {
          const masterIndex = this.currentVideos.findIndex(v => v.url === video.masterUrl);
          if (masterIndex !== -1 && this.currentVideos[masterIndex].variants) {
            // Update the variant in the master's variant list too
            const variantIndex = this.currentVideos[masterIndex].variants.findIndex(
              v => v.url === url
            );
            
            if (variantIndex !== -1) {
              this.debug(`Updating variant ${url} in master playlist ${video.masterUrl} (fields: ${Object.keys(video.mediaInfo || {}).length})`);
              
              // Create a deep clone of the variant's mediaInfo to ensure all fields are preserved
              const variantMediaInfo = this.currentVideos[index].mediaInfo ? 
                JSON.parse(JSON.stringify(this.currentVideos[index].mediaInfo)) : {};
                
              // Ensure this variant in the master has all the fields from the full variant
              this.currentVideos[masterIndex].variants[variantIndex] = {
                ...this.currentVideos[masterIndex].variants[variantIndex],
                ...video,
                // Always use the full mediaInfo from the standalone variant
                mediaInfo: variantMediaInfo,
                isFullyParsed: true
              };
            }
          }
        }
        
        // Emit the event for UI updates
        this.emit('video-updated', { url, video: this.currentVideos[index] });
      }
    }
  }

  /**
   * Subscribe to events
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    if (!this.eventListeners[event]) return;
    for (const callback of this.eventListeners[event]) {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in ${event} event listener:`, error);
      }
    }
  }

  /**
   * Refresh videos
   * This is a convenience method that forces a refresh
   */
  async refreshVideos() {
    return this.fetchVideos({ forceRefresh: true });
  }

  /**
   * Clear all caches and video data
   * @returns {Promise<boolean>} Success status
   */
  async clearCaches() {
    this.debug('Clearing caches');
    try {
      // Clear local cache
      this.currentVideos = [];
      
      // Request background to clear its caches
      sendPortMessage({
        command: 'clearCaches'
      });
      
      // Clear preview cache
      try {
        await chrome.runtime.sendMessage({
          command: 'clearPreviewCache'
        });
      } catch (e) {
        this.debug('Error clearing preview cache:', e);
      }
      
      // Reset last fetch time to force refresh next time
      this.lastFetchTime = 0;
      
      // Emit event so UI can update
      this.emit('caches-cleared', true);
      
      return true;
    } catch (error) {
      console.error('Failed to clear caches:', error);
      return false;
    }
  }
  
  /**
   * Get preview cache statistics
   * @returns {Promise<{count: number, size: number}>} Cache stats
   */
  async getPreviewCacheStats() {
    try {
      return await chrome.runtime.sendMessage({
        command: 'getPreviewCacheStats'
      });
    } catch (error) {
      this.debug('Error getting preview cache stats:', error);
      return { count: 0, size: 0 };
    }
  }
}

// Create the singleton instance
const videoStateService = new VideoStateService();

// Export singleton instance
export { videoStateService };

// Re-export common methods for convenience
export const fetchVideos = (options) => videoStateService.fetchVideos(options);
export const refreshVideos = () => videoStateService.refreshVideos();
export const on = (event, callback) => videoStateService.on(event, callback);
export const clearCaches = () => videoStateService.clearCaches();
export const getPreviewCacheStats = () => videoStateService.getPreviewCacheStats();