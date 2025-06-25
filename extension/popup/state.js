/**
 * Streamlined popup state management
 * Persistent data (theme, groupStates) stored directly in chrome.storage.local with tab isolation
 * Ephemeral data (videos, tabId) kept as simple variables
 */

import { createLogger } from '../shared/utils/logger.js';

const logger = createLogger('PopupState');

// Ephemeral data - only exists while popup is open
let currentVideos = [];
let currentTabId = null;

// Default group states
const DEFAULT_GROUP_STATES = {
    hls: false,      // expanded by default
    dash: false,     // expanded by default  
    direct: false,   // expanded by default
    blob: true,      // collapsed by default
    unknown: false,  // expanded by default
};



/**
 * Set current tab ID (ephemeral)
 */
function setTabId(tabId) {
    currentTabId = tabId;
    logger.debug('Tab ID set to:', tabId);
}

/**
 * Get current theme from storage
 */
async function getTheme() {
    try {
        const result = await chrome.storage.local.get(['theme']);
        if (result.theme) {
            return result.theme;
        }
        
        // Use system preference as fallback
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const systemTheme = prefersDark ? 'dark' : 'light';
        
        // Save system preference for next time
        await chrome.storage.local.set({ theme: systemTheme });
        return systemTheme;
    } catch (error) {
        logger.error('Error getting theme:', error);
        return 'dark'; // Safe fallback
    }
}

/**
 * Set theme directly to storage and apply to DOM
 */
async function setTheme(theme) {
    if (!theme) {
        logger.warn('setTheme called with undefined/null theme, using dark as fallback');
        theme = 'dark';
    }
    
    if (theme !== 'light' && theme !== 'dark') {
        logger.error('Invalid theme:', theme);
        return;
    }
    
    try {
        await chrome.storage.local.set({ theme });
        
        // Apply theme to DOM directly
        if (theme === 'dark') {
            document.body.classList.add('theme-dark');
            document.body.classList.remove('theme-light');
        } else {
            document.body.classList.add('theme-light');
            document.body.classList.remove('theme-dark');
        }
        
        logger.debug('Theme set and applied:', theme);
    } catch (error) {
        logger.error('Error saving theme:', error);
    }
}

/**
 * Get group state for a type from storage (tab-specific)
 */
async function getGroupState(type) {
    if (!currentTabId) {
        logger.warn('No tab ID set, using default group state for:', type);
        return DEFAULT_GROUP_STATES[type] ?? false;
    }
    
    try {
        const key = `groupState_${currentTabId}`;
        const result = await chrome.storage.local.get([key]);
        const tabGroupStates = result[key] || {};
        return tabGroupStates[type] ?? DEFAULT_GROUP_STATES[type] ?? false;
    } catch (error) {
        logger.error('Error getting group state:', error);
        return DEFAULT_GROUP_STATES[type] ?? false;
    }
}

/**
 * Set group state directly to storage (tab-specific)
 */
async function setGroupState(type, isCollapsed) {
    if (!currentTabId) {
        logger.warn('No tab ID set, cannot save group state for:', type);
        return;
    }
    
    try {
        const key = `groupState_${currentTabId}`;
        const result = await chrome.storage.local.get([key]);
        const tabGroupStates = result[key] || {};
        
        tabGroupStates[type] = isCollapsed;
        await chrome.storage.local.set({ [key]: tabGroupStates });
        
        logger.debug(`Group ${type} state set to:`, isCollapsed ? 'collapsed' : 'expanded');
    } catch (error) {
        logger.error('Error saving group state:', error);
    }
}

/**
 * Set current videos (ephemeral)
 */
function setVideos(videos) {
    currentVideos = videos || [];
    logger.debug(`Videos updated: ${currentVideos.length} videos`);
}

/**
 * Get current videos (ephemeral)
 */
function getVideos() {
    return currentVideos;
}

/**
 * Update a single video in the current list (ephemeral)
 */
function updateVideo(url, videoUpdate) {
    const index = currentVideos.findIndex(v => v.url === url);
    if (index !== -1) {
        currentVideos[index] = { ...currentVideos[index], ...videoUpdate };
        logger.debug('Video updated:', url);
    }
}

/**
 * Clear current videos (ephemeral)
 */
function clearVideos() {
    currentVideos = [];
    logger.debug('Videos cleared');
}

/**
 * Get current tab ID (ephemeral)
 */
function getTabId() {
    return currentTabId;
}

export {
    setTabId,
    getTabId,
    getTheme,
    setTheme,
    getGroupState,
    setGroupState,
    setVideos,
    getVideos,
    updateVideo,
    clearVideos
};
