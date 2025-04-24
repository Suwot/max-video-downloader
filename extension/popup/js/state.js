// extension/popup/js/state.js

// State variables
let cachedVideos = null;
let resolutionCache = new Map();
let scrollPosition = 0;
let videoGroups = {};
let groupState = {}; // To track collapsed state of groups
let posterCache = new Map(); // For preserving video posters
let currentTheme = 'dark'; // Default theme
let mediaInfoCache = new Map(); // Cache for full media info

/**
 * Initialize state from storage
 */
export async function initializeState() {
    try {
        // Load theme preference
        const result = await chrome.storage.sync.get(['theme']);
        const localData = await chrome.storage.local.get(['groupState', 'cachedVideos', 'currentTabId', 'posterCache', 'mediaInfoCache']);
        
        // Get system theme preference
        const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const defaultTheme = prefersDarkMode ? 'dark' : 'light';
        
        // Set theme based on stored preference or system default
        currentTheme = result.theme || defaultTheme;
        
        groupState = localData.groupState || { 
            hls: false, 
            dash: false, 
            direct: false, 
            blob: true, // Blob group collapsed by default
            unknown: false 
        };
        
        // Restore poster cache
        if (localData.posterCache) {
            try {
                posterCache = new Map(JSON.parse(localData.posterCache));
            } catch (e) {
                console.error('Failed to restore poster cache:', e);
            }
        }

        // Restore media info cache
        if (localData.mediaInfoCache) {
            try {
                mediaInfoCache = new Map(JSON.parse(localData.mediaInfoCache));
            } catch (e) {
                console.error('Failed to restore media info cache:', e);
            }
        }
        
        // Get current tab to check if we're on the same page as before
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTabId = currentTab.id;
        
        // Only use cached videos if we're on the same tab as before
        if (localData.cachedVideos && localData.currentTabId === currentTabId) {
            cachedVideos = localData.cachedVideos;
            // Restore media info for cached videos
            if (cachedVideos) {
                cachedVideos = cachedVideos.map(video => {
                    const mediaInfo = mediaInfoCache.get(video.url);
                    if (mediaInfo) {
                        return { ...video, mediaInfo };
                    }
                    return video;
                });
            }
        }
        
        // Store current tab ID
        chrome.storage.local.set({ currentTabId });
        
        return {
            currentTheme,
            cachedVideos,
            groupState,
            posterCache,
            currentTabId
        };
    } catch (error) {
        console.error('Failed to initialize state:', error);
        throw error;
    }
}

/**
 * Get the current cached videos
 * @returns {Array|null} Cached videos or null
 */
export function getCachedVideos() {
    return cachedVideos;
}

/**
 * Set cached videos
 * @param {Array} videos - Videos to cache
 */
export function setCachedVideos(videos) {
    cachedVideos = videos;
    chrome.storage.local.set({ cachedVideos });
}

/**
 * Get a specific video group
 * @param {string} type - Group type
 * @returns {Array} Videos in the group
 */
export function getVideoGroup(type) {
    return videoGroups[type] || [];
}

/**
 * Get all video groups
 * @returns {Object} All video groups
 */
export function getAllVideoGroups() {
    return videoGroups;
}

/**
 * Set video groups
 * @param {Object} groups - Video groups to set
 */
export function setVideoGroups(groups) {
    videoGroups = groups;
}

/**
 * Get group state (collapsed or expanded)
 * @param {string} type - Group type
 * @returns {boolean} True if collapsed, false if expanded
 */
export function getGroupState(type) {
    return groupState[type] || false;
}

/**
 * Set group state
 * @param {string} type - Group type
 * @param {boolean} isCollapsed - Whether the group is collapsed
 */
export function setGroupState(type, isCollapsed) {
    groupState[type] = isCollapsed;
    chrome.storage.local.set({ groupState });
}

/**
 * Get all group states
 * @returns {Object} All group states
 */
export function getAllGroupStates() {
    return groupState;
}

/**
 * Get current theme
 * @returns {string} Current theme ('dark' or 'light')
 */
export function getCurrentTheme() {
    return currentTheme;
}

/**
 * Set current theme
 * @param {string} theme - Theme to set ('dark' or 'light')
 */
export function setCurrentTheme(theme) {
    currentTheme = theme;
    chrome.storage.sync.set({ theme });
}

/**
 * Get scroll position
 * @returns {number} Scroll position
 */
export function getScrollPosition() {
    return scrollPosition;
}

/**
 * Set scroll position
 * @param {number} position - Scroll position to set
 */
export function setScrollPosition(position) {
    scrollPosition = position;
}

/**
 * Get a poster from cache
 * @param {string} url - Video URL
 * @returns {string|undefined} Poster URL or undefined
 */
export function getPosterFromCache(url) {
    return posterCache.get(url);
}

/**
 * Add a poster to cache
 * @param {string} videoUrl - Video URL
 * @param {string} posterUrl - Poster URL
 */
export function addPosterToCache(videoUrl, posterUrl) {
    posterCache.set(videoUrl, posterUrl);
    savePosterCache();
}

/**
 * Save poster cache to storage
 */
export function savePosterCache() {
    // Convert Map to array for storage
    const posterData = JSON.stringify(Array.from(posterCache.entries()));
    chrome.storage.local.set({ posterCache: posterData });
}

/**
 * Check if resolution is cached
 * @param {string} url - Video URL
 * @returns {boolean} True if resolution is cached
 */
export function hasResolutionCache(url) {
    return resolutionCache.has(url);
}

/**
 * Get resolution from cache
 * @param {string} url - Video URL
 * @returns {string|undefined} Resolution string or undefined
 */
export function getResolutionFromCache(url) {
    return resolutionCache.get(url);
}

/**
 * Add resolution to cache
 * @param {string} url - Video URL
 * @param {string} resolution - Resolution string
 */
export function addResolutionToCache(url, resolution) {
    resolutionCache.set(url, resolution);
}

/**
 * Add media info to cache
 * @param {string} url - Video URL
 * @param {Object} mediaInfo - Full media info object
 */
export function addMediaInfoToCache(url, mediaInfo) {
    mediaInfoCache.set(url, mediaInfo);
    saveMediaInfoCache();
}

/**
 * Get media info from cache
 * @param {string} url - Video URL
 * @returns {Object|undefined} Media info or undefined
 */
export function getMediaInfoFromCache(url) {
    return mediaInfoCache.get(url);
}

/**
 * Save media info cache to storage
 */
function saveMediaInfoCache() {
    const mediaInfoData = JSON.stringify(Array.from(mediaInfoCache.entries()));
    chrome.storage.local.set({ mediaInfoCache: mediaInfoData });
}