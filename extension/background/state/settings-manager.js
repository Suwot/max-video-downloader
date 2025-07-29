/**
 * Settings Manager - Centralized settings management for background service worker
 */

import nativeHostService from '../messaging/native-host-service.js';
import { broadcastToPopups } from '../messaging/popup-communication.js';

const SETTINGS_DEFAULTS = {
  maxConcurrentDownloads: 1,
  defaultSavePath: null,
  showDownloadNotifications: true,
  minFileSizeFilter: 102400, // 100KB in bytes (for video-detector.js)
  minFileSizeFilterUnit: 1024, // KB multiplier (user's preferred unit)
  autoGeneratePreviews: true,
  saveDownloadsInHistory: true,
  maxHistorySize: 50,
  historyAutoRemoveInterval: 30
};

// Simplified validation - just clamp numbers to valid ranges
const clampValue = (value, min, max) => Math.max(min, Math.min(max, value));

class SettingsManager {
  constructor() {
    this.settings = { ...SETTINGS_DEFAULTS };
    this.initialized = false;
  }

  async initialize() {
    try {
      const result = await chrome.storage.local.get('settings');
      this.settings = { ...SETTINGS_DEFAULTS, ...result.settings };
      this._clampNumericSettings();
      
      if (!result.settings) {
        await chrome.storage.local.set({ settings: this.settings });
      }
      
      this.initialized = true;
      console.log('Settings Manager initialized:', this.settings);
    } catch (error) {
      console.error('Settings Manager initialization failed:', error);
      this.initialized = true;
    }
  }

  get(key) {
    return this.initialized ? this.settings[key] : SETTINGS_DEFAULTS[key];
  }

  getAll() {
    return this.initialized ? { ...this.settings } : { ...SETTINGS_DEFAULTS };
  }

  async updateAll(newSettings) {
    try {
      const previousMaxHistorySize = this.settings.maxHistorySize;
      
      // Merge and clamp in one step
      this.settings = { ...SETTINGS_DEFAULTS, ...newSettings };
      this._clampNumericSettings();

      // Handle history trimming if needed
      let removedCount = 0;
      if (this.settings.maxHistorySize < previousMaxHistorySize) {
        removedCount = await this._trimHistoryToNewLimit(this.settings.maxHistorySize);
      }

      await chrome.storage.local.set({ settings: this.settings });
      
      broadcastToPopups({
        command: 'settingsState',
        settings: this.settings,
        historyTrimmed: removedCount || null
      });

      return true;
    } catch (error) {
      console.error('Failed to update settings:', error);
      return false;
    }
  }

  async chooseSavePath() {
    try {
      const result = await nativeHostService.sendMessage({
        command: 'fileSystem',
        operation: 'chooseDirectory',
        params: { title: 'Choose Default Save Folder' }
      });

      if (result.success && result.selectedPath) {
        await this.updateAll({ ...this.settings, defaultSavePath: result.selectedPath });
        return { success: true, path: result.selectedPath };
      }
      return { success: false };
    } catch (error) {
      console.error('Failed to choose save path:', error);
      return { success: false };
    }
  }

  _clampNumericSettings() {
    this.settings.maxConcurrentDownloads = clampValue(this.settings.maxConcurrentDownloads, 1, 10);
    this.settings.minFileSizeFilter = clampValue(this.settings.minFileSizeFilter, 0, 100 * 1024 * 1024);
    
    // Validate unit preference (KB or MB only)
    if (![1024, 1048576].includes(this.settings.minFileSizeFilterUnit)) {
      this.settings.minFileSizeFilterUnit = 1024; // Default to KB
    }
    
    this.settings.maxHistorySize = clampValue(this.settings.maxHistorySize, 0, 200);
    this.settings.historyAutoRemoveInterval = clampValue(this.settings.historyAutoRemoveInterval, 1, 365);
  }

  async _trimHistoryToNewLimit(newLimit) {
    try {
      const result = await chrome.storage.local.get(['downloads_history']);
      const history = result.downloads_history || [];

      if (history.length > newLimit) {
        const trimmedHistory = history.slice(0, newLimit);
        await chrome.storage.local.set({ downloads_history: trimmedHistory });
        
        const removedCount = history.length - newLimit;
        console.log(`Trimmed ${removedCount} history entries (${history.length} → ${newLimit})`);
        return removedCount;
      }
      return 0;
    } catch (error) {
      console.error('Failed to trim history:', error);
      return 0;
    }
  }
}

export { SettingsManager };