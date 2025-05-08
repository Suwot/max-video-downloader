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
const STREAM_METADATA_CACHE_SIZE = 50;

// Enhanced LRU cache for efficient data storage with TTL and persistence
class LRUCache {
  constructor(name, limit, ttl = CACHE_TIMEOUT) {
    this.name = name;
    this.limit = limit;
    this.ttl = ttl;
    this.cache = new Map();
    this.order = [];
    this._saveTimeout = null;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    
    const entry = this.cache.get(key);
    // TTL check
    if (entry.timestamp && (Date.now() - entry.timestamp > this.ttl)) {
      this.delete(key);
      return null;
    }
    
    // Move to front of access order
    this.order = this.order.filter(k => k !== key);
    this.order.unshift(key);
    
    return entry.value;
  }

  set(key, value) {
    const entry = {
      value,
      timestamp: Date.now()
    };
    
    this.cache.set(key, entry);
    
    // Add to front of access order
    this.order = this.order.filter(k => k !== key);
    this.order.unshift(key);
    
    // Trim if over limit
    if (this.order.length > this.limit) {
      const oldest = this.order.pop();
      this.cache.delete(oldest);
    }
    
    // Optionally save to storage
    if (this.name) {
      this.debounceSave();
    }
    
    return true;
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    
    const entry = this.cache.get(key);
    // TTL check
    if (entry.timestamp && (Date.now() - entry.timestamp > this.ttl)) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  delete(key) {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.order = this.order.filter(k => k !== key);
      if (this.name) {
        this.debounceSave();
      }
    }
    return deleted;
  }

  clear() {
    this.cache.clear();
    this.order = [];
    if (this.name) {
      this.save();
    }
    return true;
  }
  
  // Save to Chrome storage (debounced)
  debounceSave() {
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => this.save(), 500);
  }
  
  // Save cache to storage
  async save() {
    if (!this.name) return false; // Don't save unnamed caches
    
    try {
      // Convert Map entries to array of [key, {value, timestamp}] pairs
      const dataToStore = Array.from(this.cache.entries());
      const storageObj = { [this.name]: JSON.stringify(dataToStore) };
      
      await chrome.storage.local.set(storageObj);
      return true;
    } catch (error) {
      console.error(`[LRUCache:${this.name}] Error saving cache:`, error);
      return false;
    }
  }
  
  // Load cache from storage
  async restore() {
    if (!this.name) return false;
    
    try {
      const result = await chrome.storage.local.get(this.name);
      if (!result[this.name]) return false;
      
      const parsedData = JSON.parse(result[this.name]);
      this.cache.clear();
      this.order = [];
      
      let restoredCount = 0;
      let expiredCount = 0;
      
      for (const [key, entry] of parsedData) {
        // Skip expired entries
        if (Date.now() - entry.timestamp > this.ttl) {
          expiredCount++;
          continue;
        }
        
        this.cache.set(key, entry);
        this.order.unshift(key);
        restoredCount++;
      }
      
      // Ensure we're still within limit
      if (this.order.length > this.limit) {
        this.order = this.order.slice(0, this.limit);
        // Remove any entries that don't match order
        const validKeys = new Set(this.order);
        for (const key of this.cache.keys()) {
          if (!validKeys.has(key)) {
            this.cache.delete(key);
          }
        }
      }
      
      console.log(`[LRUCache:${this.name}] Restored ${restoredCount} entries, skipped ${expiredCount} expired entries`);
      return restoredCount > 0;
    } catch (error) {
      console.error(`[LRUCache:${this.name}] Error restoring cache:`, error);
      return false;
    }
  }
}

// Singleton service that manages state
class VideoStateService {
  constructor() {
    // Local caches - minimal state needed for UI performance
    this.posterCache = new LRUCache('posterCache', POSTER_CACHE_SIZE, 10 * 60 * 1000); // 10 minutes TTL
    this.streamMetadataCache = new LRUCache('streamMetadataCache', STREAM_METADATA_CACHE_SIZE, 30 * 60 * 1000); // 30 minutes TTL
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
      
      // Restore caches from storage
      await Promise.all([
        this.posterCache.restore(),
        this.streamMetadataCache.restore()
      ]);
      
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
   * Get stream metadata from cache
   * @param {string} url - Stream URL
   * @returns {Object|null} Stream metadata or null
   */
  getStreamMetadata(url) {
    return this.streamMetadataCache.get(url);
  }
  
  /**
   * Add stream metadata to cache
   * @param {string} url - Stream URL
   * @param {Object} metadata - Stream metadata
   */
  addStreamMetadata(url, metadata) {
    this.streamMetadataCache.set(url, metadata);
  }
  
  /**
   * Check if stream metadata exists in cache
   * @param {string} url - Stream URL
   * @returns {boolean} True if metadata exists
   */
  hasStreamMetadata(url) {
    return this.streamMetadataCache.has(url);
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
   * Clear all caches
   */
  async clearCaches() {
    this.posterCache.clear();
    this.streamMetadataCache.clear();
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
    // Add to cache
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
export const getStreamMetadata = (url) => videoStateService.getStreamMetadata(url);
export const addStreamMetadata = (url, metadata) => videoStateService.addStreamMetadata(url, metadata);
export const hasStreamMetadata = (url) => videoStateService.hasStreamMetadata(url);
export const setVideoGroups = (groups) => videoStateService.setVideoGroups(groups);
export const getAllVideoGroups = () => videoStateService.getAllVideoGroups();
export const getVideoGroup = (type) => videoStateService.getVideoGroup(type);