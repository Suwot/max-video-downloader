/**
 * State Manager Service
 * Centralized state management for the extension with performance optimizations
 */

import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('State Manager');

// State version for potential migrations
const STATE_VERSION = 2;

// Initial state structure - Comprehensive design for all extension needs
const initialState = {
    _meta: {
        version: STATE_VERSION,
        lastUpdated: Date.now()
    },
    videos: {
        byTab: {},      // Mapped by tabId -> url -> videoInfo
        byUrl: {},      // Quick lookup by normalized URL
        processing: {}, // Videos being processed
        masterVariantRelationships: {},   // Master-variant relationships tracking
        stats: {
            detected: 0,
            processed: 0,
            byType: { hls: 0, dash: 0, direct: 0, blob: 0 },
            lastDetection: null
        },
        extraction: {
            dashSegments: {}, // tabId -> segment paths
            mpdContexts: {},  // tabId -> timestamp
            headers: {}       // tabId -> url -> headers
        }
    },
    downloads: {
        active: [],     // List of active download ids
        queue: [],      // Ordered queue of pending downloads
        history: [],    // List of completed download ids (limited size)
        stats: {
            completed: 0, // total
            failed: 0, // total
            lastDownload: null // timestamp of last download
        }
    },
    tabs: {
        active: null,   // Currently active tab
        tracked: {}     // All tabs being tracked
    },
    nativeHost: {
        connected: false,
        connectionTime: null,
        lastHeartbeat: null,
        stats: {
            messagesReceived: 0,
            messagesSent: 0,
            reconnections: 0,
            errors: 0
        },
        pendingRequests: 0
    },
    settings: {
        notifications: true,
        downloadPath: '',
        defaultFormat: 'mp4',
        maxConcurrentDownloads: 2,
        keepHistory: true,
        historyLimit: 100,
        theme: null, // system, light, dark
        autoDetect: true,
        preferredQuality: null, // e.g. 1080p, 720p
        audioFormat: 'mp3'
    },
    ui: {
        selectedTab: 'videos',        // don't use it yet, not implemented
        filters: {},                  // don't use it yet, not implemented
        sortOrder: 'detectedTime',    // don't use it yet, not implemented
        groupState: {
            hls: false,
            dash: false,
            direct: false,
            blob: true,
            unknown: false
        },
        lastRefresh: null
    }
};

// Persistence configuration - what gets stored and where
const persistenceConfig = {
    settings: {
        storage: 'sync', // Use sync for settings
        ttl: null  // Never expires
    },
    downloads: {
        storage: 'local',
        subset: ['history', 'stats'],  // Only store history and stats (no items)
        ttl: 30 * 24 * 60 * 60 * 1000  // 30 days
    },
    nativeHost: {
        storage: 'local',
        subset: ['capabilities'], // Only store capabilities
        ttl: 7 * 24 * 60 * 60 * 1000  // 7 days
    },
    ui: {
        storage: 'local',
        subset: ['groupState', 'expanded', 'sortOrder'], // UI preferences
        ttl: 90 * 24 * 60 * 60 * 1000  // 90 days
    },
    _meta: {
        storage: 'local',
        ttl: null
    }
};

// Current state
let state = structuredClone ? structuredClone(initialState) : JSON.parse(JSON.stringify(initialState));

// State initialization tracking
let stateInitialized = false;

// Subscribers map: key = subscriberId, value = {callback, selector, lastValue, options}
const subscribers = new Map();

// Batch update tracking
let batchingUpdates = false;
let pendingNotification = false;
let lastNotifiedState = null;

// Scheduled cleanup timer
let cleanupTimer = null;
const CLEANUP_INTERVAL = 15 * 60 * 1000;  // 15 minutes

/**
 * Get the current entire state (immutable)
 * @returns {Object} Deep copy of current state
 */
function getState() {
    return cloneData(state);
}

/**
 * Get specific slice of state using a selector
 * @param {Function} selector - Function to select portion of state
 * @returns {any} Selected portion of state (deep copied)
 */
function select(selector) {
    const selectedData = selector(state);
    return cloneData(selectedData);
}

/**
 * Update state with batching support
 * @param {Function|Object} updater - Function or object with changes
 * @param {boolean} [immediate=false] - Whether to notify immediately
 */
function setState(updater, immediate = false) {
    // Store reference without cloning
    const prevState = state;
    
    try {
        // Apply the update
        if (typeof updater === 'function') {
            const changes = updater(state);
            if (!changes) return; // No changes to apply
            state = mergeDeep(state, changes);
        } else if (updater) {
            state = mergeDeep(state, updater);
        } else {
            logger.warn('setState called with null/undefined updater');
            return;
        }
        
        // Update metadata
        state._meta.lastUpdated = Date.now();
        
        // Handle notification strategy
        if (immediate) {
            // Immediate notification requested
            notifySubscribers(prevState);
        } else if (!pendingNotification) {
            // Schedule notification via microtask
            pendingNotification = true;
            Promise.resolve().then(() => {
                pendingNotification = false;
                const stateToNotify = lastNotifiedState || prevState;
                notifySubscribers(stateToNotify);
                lastNotifiedState = null;
            });
        }
        
        if (lastNotifiedState === null) {
            lastNotifiedState = prevState;
        }
        
        // Schedule persistence
        schedulePersistence();
        
    } catch (error) {
        logger.error('Error updating state:', error);
        // Revert to previous state on error
        state = prevState;
        throw error;
    }
}

/**
 * Batch multiple state updates together
 * @param {Function} updatesFn - Function containing multiple setState calls
 * @returns {Promise} Resolves when updates are complete
 */
async function batch(updatesFn) {
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
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.immediate] - If true, immediately call with current state
 * @returns {string} Subscriber ID used to unsubscribe
 */
function subscribe(callback, selector = null, options = {}) {
    const id = generateId();
    const currentSelectedValue = selector ? selector(state) : null;
    
    subscribers.set(id, { 
        callback,
        selector,
        lastValue: selector ? cloneData(currentSelectedValue) : null,
        options
    });
    
    // Call immediately if requested
    if (options.immediate && callback) {
        try {
            if (selector) {
                callback(cloneData(currentSelectedValue), undefined);
            } else {
                callback(cloneData(state), undefined);
            }
        } catch (error) {
            logger.error(`Error in immediate callback for subscriber ${id}:`, error);
        }
    }
    
    return id;
}

/**
 * Unsubscribe from state changes
 * @param {string} id - Subscriber ID returned from subscribe()
 */
function unsubscribe(id) {
    subscribers.delete(id);
}

/**
 * Reset state to initial values
 * @param {boolean} [preserveSettings=true] - Whether to preserve user settings
 */
function resetState(preserveSettings = true) {
    const userSettings = preserveSettings ? state.settings : null;
    
    state = cloneData(initialState);
    
    if (preserveSettings && userSettings) {
        state.settings = { ...state.settings, ...userSettings };
    }
    
    state._meta.lastUpdated = Date.now();
    notifySubscribers(null);
    schedulePersistence();
}

/**
 * Get the download by id
 * @param {string} downloadId - Download identifier
 * @returns {Object|null} Download object or null if not found
 */
function getDownloadById(downloadId) {
    // Downloads are now just URLs in active/history lists
    // Return basic object if found in any list
    const isActive = state.downloads.active.includes(downloadId);
    const isInHistory = state.downloads.history.includes(downloadId);
    
    if (isActive || isInHistory) {
        return {
            id: downloadId,
            downloadUrl: downloadId,
            status: isActive ? 'downloading' : 'completed'
        };
    }
    
    return null;
}

/**
 * Get active downloads
 * @returns {Array} Array of active download objects
 */
function getActiveDownloads() {
    return state.downloads.active.slice(); // Return copy of URL array
}

/**
 * Get download history
 * @param {number} [limit] - Optional limit on number of items
 * @returns {Array} Array of download history objects
 */
function getDownloadHistory(limit) {
    let historyIds = state.downloads.history;
    if (limit && historyIds.length > limit) {
        historyIds = historyIds.slice(0, limit);
    }
    
    return historyIds.slice(); // Return copy of URL array
}

/**
 * Initialize state manager
 * @returns {Promise<boolean>} Success status
 */
async function initStateManager() {
    logger.info('Initializing state manager');
    
    try {
        // Load persisted state from storage BEFORE allowing subscriptions
        await loadPersistedState();
        
        // Mark as initialized - now subscriptions can receive notifications
        stateInitialized = true;
        logger.debug('State fully initialized - subscribers can now receive notifications');
        
        // Set up cleanup interval
        setupCleanupInterval();
        
        logger.info('State manager initialized successfully');
        return true;
    } catch (error) {
        logger.error('Failed to initialize state manager:', error);
        return false;
    }
}

/**
 * Load persisted state from storage
 * @private
 */
async function loadPersistedState() {
    try {
        // Load settings
        const { appState } = await chrome.storage.local.get('appState');
        if (appState) {
            logger.debug('Loaded persisted state');
            
            // Check version and handle migrations if needed
            if (appState._meta && appState._meta.version !== STATE_VERSION) {
                logger.info(`State version mismatch: ${appState._meta.version} vs ${STATE_VERSION}`);
                // TODO: Implement migration logic here if needed
            }
            
            // Merge with initial state
            state = mergeDeep(state, appState);
        }
    } catch (error) {
        logger.error('Error loading persisted state:', error);
        // Continue with default state on error
    }
}

/**
 * Schedule persistence to storage
 * @private
 */
function schedulePersistence() {
    if (batchingUpdates) return;
    
    // In Chrome extension background context, use setTimeout instead of requestIdleCallback
    setTimeout(() => persistState(), 100);
}

/**
 * Persist state to storage based on configuration
 * @private
 */
function persistState() {
    const persistData = {};
    
    // Build persistence object based on config
    Object.keys(persistenceConfig).forEach(key => {
        const config = persistenceConfig[key];
        if (!state[key]) return;
        
        let dataToStore;
        
        if (config.subset && Array.isArray(config.subset)) {
            // Only store specific sub-properties
            dataToStore = {};
            config.subset.forEach(subKey => {
                if (state[key][subKey] !== undefined) {
                    dataToStore[subKey] = state[key][subKey];
                }
            });
        } else {
            // Store the whole section
            dataToStore = state[key];
        }
        
        persistData[key] = cloneData(dataToStore);
    });
    
    // Store appState
    chrome.storage.local.set({ appState: persistData }).catch(error => {
        logger.error('Failed to persist state:', error);
    });
}

/**
 * Set up automatic cleanup interval
 * @private
 */
function setupCleanupInterval() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    
    cleanupTimer = setInterval(() => {
        performStateCleanup();
    }, CLEANUP_INTERVAL);
}

/**
 * Perform cleanup of old state data
 * @private
 */
function performStateCleanup() {
    logger.debug('Performing state cleanup');
    
    setState(state => {
        // Clean up completed downloads beyond history limit
        const historyLimit = state.settings.historyLimit || 100;
        const downloadHistory = state.downloads.history;
        
        if (downloadHistory.length > historyLimit) {
            return {
                downloads: {
                    history: downloadHistory.slice(0, historyLimit)
                }
            };
        }
        
        return null; // No changes needed
    });
    
    // Check for inactive tabs and clean up if necessary
    chrome.tabs.query({}, tabs => {
        const activeTabIds = new Set(tabs.map(tab => tab.id));
        const trackedTabIds = Object.keys(state.tabs.tracked).map(Number);
        
        const inactiveTabIds = trackedTabIds.filter(id => !activeTabIds.has(id));
        
        if (inactiveTabIds.length > 0) {
            logger.debug(`Cleaning up ${inactiveTabIds.length} inactive tabs`);
            
            setState(state => {
                const newTracked = { ...state.tabs.tracked };
                const newVideosByTab = { ...state.videos.byTab };
                
                inactiveTabIds.forEach(tabId => {
                    delete newTracked[tabId];
                    delete newVideosByTab[tabId];
                });
                
                return {
                    tabs: { tracked: newTracked },
                    videos: { byTab: newVideosByTab }
                };
            });
        }
    });
}

/**
 * Notify subscribers of state changes
 * @param {Object} prevState - Previous state before changes
 * @private
 */
function notifySubscribers(prevState) {
    // Only notify if state is fully initialized
    if (!stateInitialized) {
        return;
    }
    
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
                
                // For objects, use optimized comparison
                if (!shallowEquals(currentValue, subscriber.lastValue)) {
                    callback(cloneData(currentValue), subscriber.lastValue);
                    subscriber.lastValue = cloneData(currentValue);
                }
            } else {
                // No selector, always notify with full state
                callback(cloneData(state), prevState ? cloneData(prevState) : undefined);
            }
        } catch (error) {
            logger.error(`Error in state subscriber ${id}:`, error);
        }
    });
}

/**
 * Optimized clone function that only deep clones objects and arrays
 * @param {any} data - Data to clone
 * @returns {any} Cloned data
 * @private
 */
function cloneData(data) {
    if (data === null || data === undefined || typeof data !== 'object') {
        return data;
    }
    
    return structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
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
        return cloneData(source);
    }
    
    // Handle arrays
    if (Array.isArray(source)) {
        return cloneData(source);
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
                : cloneData(source[key]);
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

export {
    getState,
    select,
    setState,
    initStateManager,
    batch,
    subscribe,
    unsubscribe,
    resetState,
    getDownloadById,
    getActiveDownloads,
    getDownloadHistory
};