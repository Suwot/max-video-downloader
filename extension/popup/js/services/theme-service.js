/**
 * @ai-guide-component ThemeService
 * @ai-guide-description Manages theme preferences
 * @ai-guide-responsibilities
 * - Provides centralized theme management
 * - Persists theme preferences in chrome.storage.sync
 * - Handles system theme detection and application
 * - Coordinates theme changes across UI components
 */

// popup/js/services/theme-service.js

// Default theme values
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';

class ThemeService {
  constructor() {
    this.currentTheme = null;
    this.initialized = false;
    this.eventListeners = {};
    
    // Debug helper
    this.debug = (...args) => console.log('[ThemeService]', ...args);
  }

  /**
   * Initialize theme service
   * @returns {Promise<string>} The current theme
   */
  async initialize() {
    if (this.initialized) return this.currentTheme;
    
    try {
      // Get user preference from storage
      const result = await chrome.storage.sync.get(['theme']);
      
      // Determine theme - use stored preference or system preference
      const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.currentTheme = result.theme !== undefined ? result.theme : (prefersDarkMode ? DARK_THEME : LIGHT_THEME);
      
      // Set up system theme change listener
      const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      darkModeMediaQuery.addEventListener('change', this.handleSystemThemeChange.bind(this));
      
      this.initialized = true;
      this.debug('Initialized with theme:', this.currentTheme);
      
      // Apply the theme immediately
      this.applyTheme(this.currentTheme);
      
      return this.currentTheme;
    } catch (error) {
      console.error('Error initializing ThemeService:', error);
      // Default to dark theme on error
      this.currentTheme = DARK_THEME;
      return this.currentTheme;
    }
  }

  /**
   * Handle system theme change
   * @param {MediaQueryListEvent} event - Media query change event
   */
  async handleSystemThemeChange(event) {
    // Only update if theme was not explicitly set by user
    try {
      const result = await chrome.storage.sync.get(['theme']);
      
      // If theme was not explicitly set by the user, follow system preference
      if (result.theme === undefined) {
        const newTheme = event.matches ? DARK_THEME : LIGHT_THEME;
        this.setTheme(newTheme);
      }
    } catch (error) {
      console.error('Error handling system theme change:', error);
    }
  }

  /**
   * Get the current theme
   * @returns {string} The current theme
   */
  getTheme() {
    return this.currentTheme;
  }

  /**
   * Set the theme and persist to storage
   * @param {string} theme - The theme to set ('light' or 'dark')
   */
  async setTheme(theme) {
    if (theme !== LIGHT_THEME && theme !== DARK_THEME) {
      console.error('Invalid theme:', theme);
      return;
    }
    
    this.currentTheme = theme;
    this.debug('Setting theme to:', theme);
    
    // Store in sync storage (user preference)
    try {
      await chrome.storage.sync.set({ theme });
    } catch (error) {
      console.error('Error saving theme preference:', error);
    }
    
    // Apply the theme to the document
    this.applyTheme(theme);
    
    // Emit theme change event
    this.emit('themeChanged', theme);
  }

  /**
   * Apply the theme to the document
   * @param {string} theme - The theme to apply
   */
  applyTheme(theme) {
    // Fix: Use 'theme-dark' and 'theme-light' classes to match CSS selectors
    if (theme === DARK_THEME) {
      document.body.classList.add('theme-dark');
      document.body.classList.remove('theme-light');
      // Keep the old classes for backward compatibility
      document.documentElement.classList.add('dark-theme');
      document.documentElement.classList.remove('light-theme');
    } else {
      document.body.classList.add('theme-light');
      document.body.classList.remove('theme-dark');
      // Keep the old classes for backward compatibility
      document.documentElement.classList.add('light-theme');
      document.documentElement.classList.remove('dark-theme');
    }
    
    this.debug('Applied theme:', theme);
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
}

// Export singleton instance
export const themeService = new ThemeService();

// Re-export common methods for convenience
export const getTheme = () => themeService.getTheme();
export const setTheme = (theme) => themeService.setTheme(theme);
export const applyTheme = (theme) => themeService.applyTheme(theme);