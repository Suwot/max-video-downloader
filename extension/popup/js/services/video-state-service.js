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
      
      // Listen for video updates from background
      document.addEventListener('video-update', this.handleVideoUpdate.bind(this));
      document.addEventListener('metadata-update', this.handleMetadataUpdate.bind(this));
      document.addEventListener('preview-ready', this.handlePreviewReady.bind(this));
      
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
      action: 'getVideos',
      tabId: this.activeTabId,
      forceRefresh: forceRefresh
    });
    
    // Return existing videos while waiting for update
    return this.currentVideos;
  }

  /**
   * Update the current videos list (called when receiving updates from background)
   * @param {Array} videos - New videos list
   */
  updateVideos(videos) {
    this.currentVideos = videos;
    this.emit('videosUpdated', videos);
  }

  /**
   * Handle video update events from background
   * @param {CustomEvent} event - Video update event
   */
  handleVideoUpdate(event) {
    const { videos } = event.detail;
    this.updateVideos(videos);
  }
  
  /**
   * Handle metadata update events from background
   * @param {CustomEvent} event - Metadata update event
   */
  handleMetadataUpdate(event) {
    const { url, mediaInfo } = event.detail;
    // Just pass the event to listeners
    this.emit('metadata-update', { url, mediaInfo });
  }

  /**
   * Handle preview ready events from background
   * @param {CustomEvent} event - Preview ready event
   */
  handlePreviewReady(event) {
    const { videoUrl, previewUrl } = event.detail;
    // Just pass the event to listeners
    this.emit('preview-ready', { videoUrl, previewUrl });
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
        action: 'clearCaches'
      });
      
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
}

// Create the singleton instance
const videoStateService = new VideoStateService();

// Export singleton instance
export { videoStateService };

// Re-export common methods for convenience
export const fetchVideos = (options) => videoStateService.fetchVideos(options);
export const updateVideos = (videos) => videoStateService.updateVideos(videos);
export const refreshVideos = () => videoStateService.refreshVideos();
export const on = (event, callback) => videoStateService.on(event, callback);
export const clearCaches = () => videoStateService.clearCaches();