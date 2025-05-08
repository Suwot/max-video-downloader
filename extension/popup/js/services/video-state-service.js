/**
 * @ai-guide-component VideoStateService
 * @ai-guide-description Centralized state management bridge between background and popup
 * @ai-guide-responsibilities
 * - Provides a unified interface to access video state
 * - Handles communication with background script
 * - Manages local caching of background state
 * - Coordinates efficient updates between background and UI
 * - Eliminates redundant state management
 * - Maintains minimal local state needed for UI rendering
 */

// popup/js/services/video-state-service.js

import { sendPortMessage } from '../index.js';

// Constants for storage
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const POSTER_CACHE_SIZE = 50;

// Simple LRU cache for posters to prevent re-fetching
class LRUCache {
  constructor(limit) {
    this.limit = limit;
    this.cache = new Map();
    this.order = [];
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    // Move to front of access order
    this.order = this.order.filter(k => k !== key);
    this.order.unshift(key);
    return this.cache.get(key);
  }

  set(key, value) {
    this.cache.set(key, value);
    // Add to front of access order
    this.order = this.order.filter(k => k !== key);
    this.order.unshift(key);
    // Trim if over limit
    if (this.order.length > this.limit) {
      const oldest = this.order.pop();
      this.cache.delete(oldest);
    }
  }

  clear() {
    this.cache.clear();
    this.order = [];
  }
}

// Singleton service that manages state
class VideoStateService {
  constructor() {
    // Local caches - minimal state needed for UI performance
    this.posterCache = new LRUCache(POSTER_CACHE_SIZE);
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
      // Return from storage if available
      const cachedVideos = await this.getVideosFromStorage();
      if (cachedVideos && cachedVideos.length > 0) {
        return cachedVideos;
      }
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
    return this.getVideosFromStorage();
  }

  /**
   * Get videos from local storage
   * @returns {Promise<Array>} Videos from storage
   */
  async getVideosFromStorage() {
    if (!this.activeTabId) return [];
    
    try {
      const storageKey = `processedVideos_${this.activeTabId}`;
      const result = await chrome.storage.local.get(storageKey);
      return result[storageKey] || [];
    } catch (error) {
      console.error('Error retrieving videos from storage:', error);
      return [];
    }
  }

  /**
   * Get a poster image from cache
   * @param {string} url - Video URL
   * @returns {string|null} Poster URL or null
   */
  getPoster(url) {
    return this.posterCache.get(url);
  }

  /**
   * Add a poster to cache
   * @param {string} videoUrl - Video URL
   * @param {string} posterUrl - Poster image URL
   */
  addPoster(videoUrl, posterUrl) {
    this.posterCache.set(videoUrl, posterUrl);
  }

  /**
   * Clear all caches
   */
  async clearCaches() {
    this.posterCache.clear();
    this.lastFetchTime = 0;
    
    // Request a refresh from background
    return this.fetchVideos({ forceRefresh: true });
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
    this.emit('metadata-update', { url, mediaInfo });
  }

  /**
   * Handle preview ready events
   * @param {CustomEvent} event - Preview ready event
   */
  handlePreviewReady(event) {
    const { videoUrl, previewUrl } = event.detail;
    // Cache the poster locally
    this.addPoster(videoUrl, previewUrl);
    // Emit event for UI to update
    this.emit('preview-ready', { videoUrl, previewUrl });
  }
}

// Export singleton instance
export const videoStateService = new VideoStateService();

// Re-export common methods for convenience
export const fetchVideos = (options) => videoStateService.fetchVideos(options);
export const getPoster = (url) => videoStateService.getPoster(url);
export const addPoster = (videoUrl, posterUrl) => videoStateService.addPoster(videoUrl, posterUrl);
export const clearCaches = () => videoStateService.clearCaches();