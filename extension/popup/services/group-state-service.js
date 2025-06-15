/**
 * - Provides centralized group state management
 * - Persists group expansion/collapse states in storage
 * - Coordinates group state changes across UI components
 */

// Default group states (collapsed or expanded)
const DEFAULT_GROUP_STATES = {
  hls: false,    // expanded by default
  dash: false,   // expanded by default
  direct: false, // expanded by default
  blob: true,    // collapsed by default
  unknown: false // expanded by default
};

class GroupStateService {
  constructor() {
    this.groupState = { ...DEFAULT_GROUP_STATES };
    this.initialized = false;
    this.eventListeners = {};
    
    // Debug helper
    this.debug = (...args) => console.log('[GroupStateService]', ...args);
  }

  /**
   * Initialize group state service
   * @returns {Promise<Object>} The current group states
   */
  async initialize() {
    if (this.initialized) return this.groupState;
    
    try {
      // Get stored group states from storage
      const result = await chrome.storage.local.get(['groupState']);
      
      // Use stored states or defaults
      this.groupState = result.groupState || { ...DEFAULT_GROUP_STATES };
      
      this.initialized = true;
      this.debug('Initialized with group states:', this.groupState);
      
      return this.groupState;
    } catch (error) {
      console.error('Error initializing GroupStateService:', error);
      // Use defaults on error
      this.groupState = { ...DEFAULT_GROUP_STATES };
      return this.groupState;
    }
  }

  /**
   * Get all group states
   * @returns {Object} All group states
   */
  getAllGroupStates() {
    return { ...this.groupState };
  }

  /**
   * Get state for a specific group
   * @param {string} type - Group type (hls, dash, direct, etc.)
   * @returns {boolean} True if collapsed, false if expanded
   */
  getGroupState(type) {
    return this.groupState[type] ?? false;
  }

  /**
   * Set state for a specific group
   * @param {string} type - Group type (hls, dash, direct, etc.)
   * @param {boolean} isCollapsed - Whether the group is collapsed
   */
  async setGroupState(type, isCollapsed) {
    // Update local state
    this.groupState[type] = isCollapsed;
    this.debug(`Setting group state for ${type} to ${isCollapsed ? 'collapsed' : 'expanded'}`);
    
    // Save to storage
    try {
      await chrome.storage.local.set({ groupState: this.groupState });
    } catch (error) {
      console.error('Error saving group state:', error);
    }
    
    // Emit change event
    this.emit('groupStateChanged', { type, isCollapsed });
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
export const groupStateService = new GroupStateService();

// Re-export common methods for convenience
export const getAllGroupStates = () => groupStateService.getAllGroupStates();
export const getGroupState = (type) => groupStateService.getGroupState(type);
export const setGroupState = (type, isCollapsed) => groupStateService.setGroupState(type, isCollapsed);