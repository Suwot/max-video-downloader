/**
 * Settings Manager - Centralized settings management for background service worker
 * Maintains in-memory state and handles storage synchronization
 */

import nativeHostService from '../messaging/native-host-service.js';

const SETTINGS_DEFAULTS = {
  // Download settings
  maxConcurrentDownloads: 1,
  defaultSavePath: null, // Will be set when user first downloads or manually selects

  // Detection settings  
  minFileSizeFilter: 102400, // 100KB minimum for direct videos
  autoGeneratePreviews: true,

  // History settings
  maxHistorySize: 50,
  historyAutoRemoveInterval: 30, // days
};

const SETTINGS_CONSTRAINTS = {
  maxConcurrentDownloads: { min: 1, max: 10 },
  minFileSizeFilter: { min: 0, max: 100 * 1024 * 1024 }, // 100MB max
  maxHistorySize: { min: 0, max: 1000 },
  historyAutoRemoveInterval: { min: 1, max: 365 }
};

class SettingsManager {
  constructor() {
    this.settings = { ...SETTINGS_DEFAULTS };
    this.initialized = false;
  }

  /**
   * Initialize settings from storage.local or create defaults
   * Must be called during service worker startup
   */
  async initialize() {
    try {
      const result = await chrome.storage.local.get('settings');

      if (result.settings) {
        // Merge stored settings with defaults to handle new settings
        this.settings = { ...SETTINGS_DEFAULTS, ...result.settings };

        // Validate and fix any invalid values
        this._validateAndFixSettings();

        // Save corrected settings back to storage if needed
        await chrome.storage.local.set({ settings: this.settings });
      } else {
        // No existing settings, save defaults
        await chrome.storage.local.set({ settings: this.settings });
      }

      this.initialized = true;
      console.log('Settings Manager initialized:', this.settings);
    } catch (error) {
      console.error('Settings Manager initialization failed, using defaults:', error);
      this.settings = { ...SETTINGS_DEFAULTS };
      this.initialized = true;
    }
  }

  /**
   * Get single setting value for background components
   * @param {string} key - Setting key
   * @returns {*} Setting value or undefined if key doesn't exist
   */
  get(key) {
    if (!this.initialized) {
      console.warn('Settings Manager not initialized, returning default for:', key);
      return SETTINGS_DEFAULTS[key];
    }
    return this.settings[key];
  }

  /**
   * Get all settings for popup
   * @returns {Object} Complete settings object
   */
  getAll() {
    if (!this.initialized) {
      console.warn('Settings Manager not initialized, returning defaults');
      return { ...SETTINGS_DEFAULTS };
    }
    return { ...this.settings };
  }

  /**
   * Update all settings from popup
   * @param {Object} newSettings - Complete settings object
   * @returns {Promise<boolean>} Success status
   */
  async updateAll(newSettings) {
    try {
      // Validate incoming settings
      const validatedSettings = this._validateSettings(newSettings);

      // Update in-memory state
      this.settings = validatedSettings;

      // Update storage
      await chrome.storage.local.set({ settings: this.settings });

      console.log('Settings updated:', this.settings);
      return true;
    } catch (error) {
      console.error('Failed to update settings:', error);
      return false;
    }
  }

  /**
   * Validate settings object and apply constraints
   * @param {Object} settings - Settings to validate
   * @returns {Object} Validated settings object
   * @private
   */
  _validateSettings(settings) {
    const validated = { ...SETTINGS_DEFAULTS };

    // Handle null, undefined, or non-object inputs
    if (!settings || typeof settings !== 'object') {
      return validated;
    }

    for (const [key, value] of Object.entries(settings)) {
      if (key in SETTINGS_DEFAULTS) {
        if (key in SETTINGS_CONSTRAINTS) {
          const constraint = SETTINGS_CONSTRAINTS[key];
          if (typeof value === 'number') {
            validated[key] = Math.max(constraint.min, Math.min(constraint.max, value));
          } else {
            validated[key] = value;
          }
        } else {
          validated[key] = value;
        }
      }
    }

    return validated;
  }

  /**
   * Choose save path using native host dialog
   * @returns {Promise<{success: boolean, path?: string}>} Result with success status and path
   */
  async chooseSavePath() {
    try {
      const result = await nativeHostService.sendMessage({
        command: 'fileSystem',
        operation: 'chooseDirectory',
        params: { title: 'Choose Default Save Folder' }
      });

      if (result.success && result.selectedPath) {
        // Update settings with the new path
        const updatedSettings = {
          ...this.settings,
          defaultSavePath: result.selectedPath
        };

        const success = await this.updateAll(updatedSettings);
        if (success) {
          console.log('Updated default save path:', result.selectedPath);
          return { success: true, path: result.selectedPath };
        }
      }

      return { success: false };
    } catch (error) {
      console.error('Failed to choose save path:', error);
      return { success: false };
    }
  }

  /**
   * Validate and fix current settings in memory
   * @private
   */
  _validateAndFixSettings() {
    this.settings = this._validateSettings(this.settings);
  }
}

export { SettingsManager };