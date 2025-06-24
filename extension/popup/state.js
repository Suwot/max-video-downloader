/**
 * Simple popup-only state management
 * Lives only while popup is open - no persistence needed for videos
 */

import { createLogger } from '../shared/utils/logger.js';

const logger = createLogger('PopupState');

// Popup state - ephemeral, reset on each popup open
let state = {
    // Theme management
    theme: 'dark',
    
    // Group drawer states (collapsed/expanded)
    groupStates: {
        hls: false,      // expanded by default
        dash: false,     // expanded by default
        direct: false,   // expanded by default
        blob: true,      // collapsed by default
        unknown: false,  // expanded by default
    },
    
    // Scroll positions per tab
    scrollPositions: {},
    
    // Current videos (delivered from background, not persisted)
    videos: [],
    
    // Current tab ID
    tabId: null,
};

/**
 * Initialize state from storage (theme and group states only)
 */
async function initializeState() {
    try {
        // Load theme from storage
        const themeResult = await chrome.storage.sync.get(['theme']);
        if (themeResult.theme) {
            state.theme = themeResult.theme;
        } else {
            // Use system preference
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            state.theme = prefersDark ? 'dark' : 'light';
        }
        
        // Load group states from storage
        const groupResult = await chrome.storage.local.get(['groupState']);
        if (groupResult.groupState) {
            state.groupStates = { ...state.groupStates, ...groupResult.groupState };
        }
        
        logger.debug('State initialized:', { 
            theme: state.theme, 
            groupStates: state.groupStates 
        });
        
        return state;
    } catch (error) {
        logger.error('Error initializing state:', error);
        return state;
    }
}

/**
 * Set current tab ID
 */
function setTabId(tabId) {
    state.tabId = tabId;
    logger.debug('Tab ID set to:', tabId);
}

/**
 * Get current theme
 */
function getTheme() {
    return state.theme;
}

/**
 * Set theme and save to storage
 */
async function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') {
        logger.error('Invalid theme:', theme);
        return;
    }
    
    state.theme = theme;
    logger.debug('Theme set to:', theme);
    
    try {
        await chrome.storage.sync.set({ theme });
    } catch (error) {
        logger.error('Error saving theme:', error);
    }
}

/**
 * Get group state for a type
 */
function getGroupState(type) {
    return state.groupStates[type] ?? false;
}

/**
 * Set group state and save to storage
 */
async function setGroupState(type, isCollapsed) {
    state.groupStates[type] = isCollapsed;
    logger.debug(`Group ${type} state set to:`, isCollapsed ? 'collapsed' : 'expanded');
    
    try {
        await chrome.storage.local.set({ groupState: state.groupStates });
    } catch (error) {
        logger.error('Error saving group state:', error);
    }
}

/**
 * Set scroll position for current tab
 */
function setScrollPosition(position) {
    if (state.tabId) {
        state.scrollPositions[state.tabId] = position;
    }
}

/**
 * Get scroll position for current tab
 */
function getScrollPosition() {
    return state.scrollPositions[state.tabId] || 0;
}

/**
 * Set current videos (from background)
 */
function setVideos(videos) {
    state.videos = videos || [];
    logger.debug(`Videos updated: ${state.videos.length} videos`);
}

/**
 * Get current videos
 */
function getVideos() {
    return state.videos;
}

/**
 * Update a single video in the list
 */
function updateVideo(url, videoUpdate) {
    const index = state.videos.findIndex(v => v.url === url);
    if (index !== -1) {
        state.videos[index] = { ...state.videos[index], ...videoUpdate };
        logger.debug('Video updated:', url);
    }
}

/**
 * Clear videos
 */
function clearVideos() {
    state.videos = [];
    logger.debug('Videos cleared');
}

/**
 * Get complete state (for debugging)
 */
function getState() {
    return { ...state };
}

export {
    initializeState,
    setTabId,
    getTheme,
    setTheme,
    getGroupState,
    setGroupState,
    setScrollPosition,
    getScrollPosition,
    setVideos,
    getVideos,
    updateVideo,
    clearVideos,
    getState
};
