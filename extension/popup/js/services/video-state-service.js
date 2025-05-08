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
    // Simple local state for current popup session only
    this.currentVideos = [];
    this.posters = new Map(); // Simple Map for posters during current popup session
    this.streamMetadata = new Map(); // Simple Map for stream metadata during current popup session
    this.videoGroups = {}; // Groups of videos by type (hls, dash, direct, etc.)
    
    this.activeTabId = null;
    this.lastFetchTime = 0;
    this.isInitialized = false;
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
      
      // Listen for video metadata updates 
      document.addEventListener('metadata-update', this.handleMetadataUpdate.bind(this));
      document.addEventListener('preview-ready', this.handlePreviewReady.bind(this));
      
      this.isInitialized = true;
      
      // Trigger a videos fetch if we have a tab
      if (this.activeTabId) {
        this.fetchVideos({ forceRefresh: true }); // Force refresh to ensure metadata is processed
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
    
    // Request videos via port message
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
    
    // Request metadata for any videos without it
    this.requestMissingMetadata(videos);
    
    this.emit('videosUpdated', videos);
  }
  
  /**
   * Request metadata for videos that don't have it
   * @param {Array} videos - Videos to check
   */
  requestMissingMetadata(videos) {
    if (!videos || !videos.length) return;
    
    // Find videos without metadata
    const videosNeedingMetadata = videos.filter(video => 
      !video.mediaInfo && !this.streamMetadata.has(video.url)
    );
    
    if (videosNeedingMetadata.length > 0) {
      this.debug(`Requesting metadata for ${videosNeedingMetadata.length} videos`);
      
      // Request metadata for each video
      videosNeedingMetadata.forEach(video => {
        sendPortMessage({
          action: 'getStreamMetadata',
          url: video.url,
          tabId: this.activeTabId
        });
      });
    }
  }

  /**
   * Get a poster image 
   * @param {string} url - Video URL
   * @returns {string|null} Poster URL or null
   */
  getPoster(url) {
    return this.posters.get(url);
  }

  /**
   * Add a poster
   * @param {string} videoUrl - Video URL
   * @param {string} posterUrl - Poster image URL
   */
  addPoster(videoUrl, posterUrl) {
    this.posters.set(videoUrl, posterUrl);
  }
  
  /**
   * Get stream metadata
   * @param {string} url - Stream URL
   * @returns {Object|null} Stream metadata or null
   */
  getStreamMetadata(url) {
    return this.streamMetadata.get(url);
  }
  
  /**
   * Add stream metadata
   * @param {string} url - Stream URL
   * @param {Object} metadata - Stream metadata
   */
  addStreamMetadata(url, metadata) {
    this.streamMetadata.set(url, metadata);
  }
  
  /**
   * Check if stream metadata exists
   * @param {string} url - Stream URL
   * @returns {boolean} True if metadata exists
   */
  hasStreamMetadata(url) {
    return this.streamMetadata.has(url);
  }
  
  /**
   * Store video groups by type
   * @param {Object} groups - Video groups by type
   */
  setVideoGroups(groups) {
    this.videoGroups = groups;
    this.emit('videoGroupsChanged', groups);
  }
  
  /**
   * Get all video groups
   * @returns {Object} Video groups by type
   */
  getAllVideoGroups() {
    return this.videoGroups;
  }
  
  /**
   * Get videos of a specific type
   * @param {string} type - Video type (hls, dash, direct, etc.)
   * @returns {Array} Videos of the specified type
   */
  getVideoGroup(type) {
    return this.videoGroups[type] || [];
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
   * Handle metadata update events
   * @param {CustomEvent} event - Metadata update event
   */
  handleMetadataUpdate(event) {
    const { url, mediaInfo } = event.detail;
    // Store metadata for this popup session
    this.addStreamMetadata(url, mediaInfo);
    // Emit event for UI to update
    this.emit('metadata-update', { url, mediaInfo });
  }

  /**
   * Handle preview ready events
   * @param {CustomEvent} event - Preview ready event
   */
  handlePreviewReady(event) {
    const { videoUrl, previewUrl } = event.detail;
    // Cache the poster locally for this popup session
    this.addPoster(videoUrl, previewUrl);
    // Emit event for UI to update
    this.emit('preview-ready', { videoUrl, previewUrl });
  }

  /**
   * Clear all caches and fetch fresh videos
   * This is a simplified version that just refreshes videos
   */
  async clearCaches() {
    this.posters = new Map();
    this.streamMetadata = new Map();
    this.lastFetchTime = 0;
    this.debug('Caches cleared, requesting fresh videos');
    
    // Return the result of fetchVideos with forceRefresh=true
    return this.fetchVideos({ forceRefresh: true });
  }
}

// Export singleton instance
export const videoStateService = new VideoStateService();

// Re-export common methods for convenience
export const fetchVideos = (options) => videoStateService.fetchVideos(options);
export const getPoster = (url) => videoStateService.getPoster(url);
export const addPoster = (videoUrl, posterUrl) => videoStateService.addPoster(videoUrl, posterUrl);
export const setVideoGroups = (groups) => videoStateService.setVideoGroups(groups);
export const getAllVideoGroups = () => videoStateService.getAllVideoGroups();
export const getVideoGroup = (type) => videoStateService.getVideoGroup(type);
export const updateVideos = (videos) => videoStateService.updateVideos(videos);
export const getStreamMetadata = (url) => videoStateService.getStreamMetadata(url);
export const addStreamMetadata = (url, metadata) => videoStateService.addStreamMetadata(url, metadata);
export const hasStreamMetadata = (url) => videoStateService.hasStreamMetadata(url);
export const clearCaches = () => videoStateService.clearCaches();