/**
 * State Manager Service
 * Centralized state management for the extension with performance optimizations
 */

import { createLogger } from '../../js/utilities/logger.js';

const logger = createLogger('State Manager');

// Initial state structure
const initialState = {
  videos: {
    byTab: {},      // Mapped by tabId -> url -> videoInfo
    byUrl: {},      // Quick lookup by normalized URL
    variantMap: {}  // Track variant-to-master relationships
  },
  downloads: {
    active: {},     // Active downloads
    history: {},    // Completed downloads
    byTabId: {}     // Downloads organized by tab
  },
  tabs: {
    active: null,   // Currently active tab
    tracked: {}     // All tabs being tracked
  },
  settings: {
    autoDetect: true,
    notifications: true,
  }
};

// Current state
let state = structuredClone ? structuredClone(initialState) : JSON.parse(JSON.stringify(initialState));

// Subscribers map: key = subscriberId, value = {callback, selector, lastValue}
const subscribers = new Map();

// Batch update tracking
let batchingUpdates = false;
let pendingNotification = false;
let lastNotifiedState = null;

/**
 * Get the current entire state (immutable)
 * @returns {Object} Deep copy of current state
 */
export function getState() {
  return structuredClone ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

/**
 * Get specific slice of state using a selector
 * @param {Function} selector - Function to select portion of state
 * @returns {any} Selected portion of state (deep copied)
 */
export function select(selector) {
  const selectedData = selector(state);
  
  // Only deep clone objects, return primitives directly
  if (selectedData === null || typeof selectedData !== 'object') {
    return selectedData;
  }
  
  return structuredClone ? structuredClone(selectedData) : JSON.parse(JSON.stringify(selectedData));
}

/**
 * Update state with batching support
 * @param {Function|Object} updater - Function or object with changes
 * @param {boolean} [immediate=false] - Whether to notify immediately
 */
export function setState(updater, immediate = false) {
  // Store reference without cloning
  const prevState = state;
  
  // Apply the update
  if (typeof updater === 'function') {
    const changes = updater(state);
    state = mergeDeep(state, changes);
  } else {
    state = mergeDeep(state, updater);
  }
  
  // Handle notification strategy
  if (immediate) {
    // Immediate notification requested
    notifySubscribers(prevState);
  } else if (!pendingNotification) {
    // Schedule notification via microtask
    pendingNotification = true;
    Promise.resolve().then(() => {
      pendingNotification = false;
      notifySubscribers(lastNotifiedState);
      lastNotifiedState = null;
    });
  }
  
  if (lastNotifiedState === null) {
    lastNotifiedState = prevState;
  }
}

/**
 * Batch multiple state updates together
 * @param {Function} updatesFn - Function containing multiple setState calls
 * @returns {Promise} Resolves when updates are complete
 */
export async function batch(updatesFn) {
  const wasBatching = batchingUpdates;
  batchingUpdates = true;
  const prevState = state;
  
  try {
    // Run the updates
    await updatesFn();
  } finally {
    batchingUpdates = wasBatching;
    
    // Notify once after all updates (if this is the outermost batch)
    if (!wasBatching && !pendingNotification) {
      pendingNotification = true;
      Promise.resolve().then(() => {
        pendingNotification = false;
        notifySubscribers(prevState);
      });
    }
  }
}

/**
 * Subscribe to state changes
 * @param {Function} callback - Function to call when state changes
 * @param {Function} [selector] - Optional selector to only trigger on specific changes
 * @returns {string} Subscriber ID used to unsubscribe
 */
export function subscribe(callback, selector = null) {
  const id = generateId();
  subscribers.set(id, { 
    callback,
    selector,
    lastValue: selector ? selector(state) : null
  });
  return id;
}

/**
 * Unsubscribe from state changes
 * @param {string} id - Subscriber ID returned from subscribe()
 */
export function unsubscribe(id) {
  subscribers.delete(id);
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = structuredClone ? structuredClone(initialState) : JSON.parse(JSON.stringify(initialState));
  notifySubscribers(null);
}

/**
 * Notify subscribers of state changes
 * @param {Object} prevState - Previous state before changes
 */
function notifySubscribers(prevState) {
  subscribers.forEach((subscriber, id) => {
    try {
      const { callback, selector } = subscriber;
      
      // If selector provided, only notify if that part changed
      if (selector) {
        const currentValue = selector(state);
        const prevValue = prevState ? selector(prevState) : undefined;
        
        // For primitive values, use strict equality
        if (currentValue === null || typeof currentValue !== 'object') {
          if (currentValue !== subscriber.lastValue) {
            callback(currentValue, subscriber.lastValue);
            subscriber.lastValue = currentValue;
          }
          return;
        }
        
        // For objects, use our optimized comparison
        if (!shallowEquals(currentValue, subscriber.lastValue)) {
          callback(structuredClone ? structuredClone(currentValue) : JSON.parse(JSON.stringify(currentValue)), 
                  subscriber.lastValue);
          subscriber.lastValue = structuredClone ? structuredClone(currentValue) : JSON.parse(JSON.stringify(currentValue));
        }
      } else {
        // No selector, always notify with full state
        callback(
          structuredClone ? structuredClone(state) : JSON.parse(JSON.stringify(state)),
          prevState ? (structuredClone ? structuredClone(prevState) : JSON.parse(JSON.stringify(prevState))) : undefined
        );
      }
    } catch (error) {
      logger.error(`Error in state subscriber ${id}:`, error);
    }
  });
}

/**
 * Initialize state manager
 * @returns {Promise<boolean>} Success status
 */
export async function initStateManager() {
  logger.info('Initializing state manager');
  
  try {
    // Load persisted state from storage
    const storedState = await chrome.storage.local.get('appState');
    if (storedState?.appState) {
      state = mergeDeep(state, storedState.appState);
      logger.info('Loaded state from storage');
    }
    
    // Set up persistence
    subscribe((currentState) => {
      // Only persist what's necessary between sessions
      const persistedState = {
        settings: currentState.settings
        // Add additional persistent data as needed
      };
      
      chrome.storage.local.set({ appState: persistedState });
    });
    
    logger.info('State manager initialized successfully');
    return true;
  } catch (error) {
    logger.error('Failed to initialize state manager:', error);
    return false;
  }
}

// Helper function to generate unique IDs
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Deep merge utility that creates new objects only for changed paths
function mergeDeep(target, source) {
  // Handle primitives and null
  if (source === null || typeof source !== 'object') {
    return source;
  }
  
  if (target === null || typeof target !== 'object') {
    return structuredClone ? structuredClone(source) : JSON.parse(JSON.stringify(source));
  }
  
  // Handle arrays
  if (Array.isArray(source)) {
    return structuredClone ? structuredClone(source) : JSON.parse(JSON.stringify(source));
  }
  
  // Handle objects
  const output = { ...target };
  
  Object.keys(source).forEach(key => {
    if (key in target && typeof source[key] === 'object' && source[key] !== null && 
        typeof target[key] === 'object' && target[key] !== null && !Array.isArray(source[key])) {
      // Recursively merge objects
      output[key] = mergeDeep(target[key], source[key]);
    } else {
      // Direct assignment for new keys, primitives, or arrays
      output[key] = source[key] === null || typeof source[key] !== 'object' 
        ? source[key]
        : (structuredClone ? structuredClone(source[key]) : JSON.parse(JSON.stringify(source[key])));
    }
  });
  
  return output;
}

// Optimized shallow equality check for objects
function shallowEquals(a, b) {
  if (a === b) return true;
  
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => val === b[idx]);
  }
  
  if (Array.isArray(a) || Array.isArray(b)) return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  return keysA.every(key => key in b && a[key] === b[key]);
}