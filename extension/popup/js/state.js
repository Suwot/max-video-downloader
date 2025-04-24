// extension/popup/js/state.js

// State management
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// State variables
let cachedVideos = null;
let resolutionCache = new Map();
let scrollPosition = 0;
let videoGroups = {};
let groupState = {}; 
let posterCache = new Map(); 
let currentTheme = 'dark'; 
let mediaInfoCache = new Map();
const streamMetadataCache = new Map();

// Debug logging helper
function logDebug(...args) {
    console.log('[State Debug]', new Date().toISOString(), ...args);
}

/**
 * Add stream metadata to cache with TTL
 */
export function addStreamMetadata(url, metadata) {
    streamMetadataCache.set(url, {
        data: metadata,
        timestamp: Date.now()
    });
    saveStreamMetadataCache();
}

/**
 * Get stream metadata if valid
 */
export function getStreamMetadata(url) {
    const cached = streamMetadataCache.get(url);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > CACHE_TTL) {
        streamMetadataCache.delete(url);
        return null;
    }
    
    return cached.data;
}

/**
 * Get cached videos with TTL validation
 */
export function getCachedVideos() {
    logDebug('Getting cached videos, current count:', cachedVideos?.length || 0);
    
    // Validate cache TTL
    if (cachedVideos) {
        const now = Date.now();
        const beforeCount = cachedVideos.length;
        
        // Filter out expired entries
        cachedVideos = cachedVideos.filter(video => {
            if (!video.timestamp) {
                logDebug('Video has no timestamp:', video.url);
                return true;
            }
            const age = now - video.timestamp;
            const isValid = age <= CACHE_TTL;
            if (!isValid) {
                logDebug('Video expired:', video.url, 'Age:', Math.round(age / 1000), 'seconds');
            }
            return isValid;
        });

        if (cachedVideos.length !== beforeCount) {
            logDebug('Filtered out', beforeCount - cachedVideos.length, 'expired videos');
        }
        
        if (cachedVideos.length === 0) {
            logDebug('All videos expired, clearing cache');
            cachedVideos = null;
            chrome.storage.local.remove('cachedVideos');
        }
    } else {
        logDebug('No cached videos found');
    }
    return cachedVideos;
}

/**
 * Set cached videos
 */
export function setCachedVideos(videos) {
    logDebug('Setting cached videos, count:', videos?.length || 0);
    
    // Add timestamps to videos if not present
    videos = videos.map(video => {
        const withTimestamp = {
            ...video,
            timestamp: video.timestamp || Date.now()
        };
        if (!video.timestamp) {
            logDebug('Added missing timestamp to video:', video.url);
        }
        return withTimestamp;
    });
    
    cachedVideos = videos;
    const cacheTimestamp = Date.now();
    
    logDebug('Saving to storage with timestamp:', new Date(cacheTimestamp).toISOString());
    chrome.storage.local.set({ 
        cachedVideos,
        cacheTimestamp
    });
}

// Storage management functions
function saveStreamMetadataCache() {
    const cacheData = JSON.stringify(Array.from(streamMetadataCache.entries()));
    chrome.storage.local.set({ streamMetadataCache: cacheData });
}

function savePosterCache() {
    const posterData = JSON.stringify(Array.from(posterCache.entries()));
    chrome.storage.local.set({ posterCache: posterData });
}

function saveMediaInfoCache() {
    const mediaInfoData = JSON.stringify(Array.from(mediaInfoCache.entries()));
    chrome.storage.local.set({ mediaInfoCache: mediaInfoData });
}

/**
 * Initialize state from storage
 */
export async function initializeState() {
    try {
        const result = await chrome.storage.sync.get(['theme']);
        const localData = await chrome.storage.local.get([
            'groupState', 
            'cachedVideos', 
            'currentTabId', 
            'posterCache', 
            'mediaInfoCache', 
            'streamMetadataCache'
        ]);
        
        // Set theme
        const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = result.theme || (prefersDarkMode ? 'dark' : 'light');
        
        // Set group state
        groupState = localData.groupState || { 
            hls: false, 
            dash: false, 
            direct: false, 
            blob: true,
            unknown: false 
        };
        
        // Restore caches
        if (localData.posterCache) {
            try {
                posterCache = new Map(JSON.parse(localData.posterCache));
            } catch (e) {
                console.error('Failed to restore poster cache:', e);
            }
        }

        if (localData.mediaInfoCache) {
            try {
                mediaInfoCache = new Map(JSON.parse(localData.mediaInfoCache));
            } catch (e) {
                console.error('Failed to restore media info cache:', e);
            }
        }

        if (localData.streamMetadataCache) {
            try {
                const parsedCache = JSON.parse(localData.streamMetadataCache);
                streamMetadataCache.clear();
                for (const [url, data] of parsedCache) {
                    if (Date.now() - data.timestamp <= CACHE_TTL) {
                        streamMetadataCache.set(url, data);
                    }
                }
            } catch (e) {
                console.error('Failed to restore stream metadata cache:', e);
            }
        }
        
        // Handle videos cache
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (localData.cachedVideos && localData.currentTabId === currentTab.id) {
            cachedVideos = localData.cachedVideos.map(video => {
                const mediaInfo = mediaInfoCache.get(video.url);
                return mediaInfo ? { ...video, mediaInfo } : video;
            });
        }
        
        // Store current tab ID
        chrome.storage.local.set({ currentTabId: currentTab.id });
        
        return {
            currentTheme,
            cachedVideos,
            groupState,
            posterCache,
            currentTabId: currentTab.id
        };
    } catch (error) {
        console.error('Failed to initialize state:', error);
        throw error;
    }
}

// Group state management
export function getGroupState(type) {
    return groupState[type] || false;
}

export function setGroupState(type, isCollapsed) {
    groupState[type] = isCollapsed;
    chrome.storage.local.set({ groupState });
}

export function getAllGroupStates() {
    return groupState;
}

// Video groups management
export function getVideoGroup(type) {
    return videoGroups[type] || [];
}

export function getAllVideoGroups() {
    return videoGroups;
}

export function setVideoGroups(groups) {
    videoGroups = groups;
}

// Theme management
export function getCurrentTheme() {
    return currentTheme;
}

export function setCurrentTheme(theme) {
    currentTheme = theme;
    chrome.storage.sync.set({ theme });
}

// Scroll position management
export function getScrollPosition() {
    return scrollPosition;
}

export function setScrollPosition(position) {
    scrollPosition = position;
}

// Cache management
export function hasResolutionCache(url) {
    return resolutionCache.has(url);
}

export function getResolutionFromCache(url) {
    return resolutionCache.get(url);
}

export function addResolutionToCache(url, resolution) {
    resolutionCache.set(url, resolution);
}

export function getPosterFromCache(url) {
    return posterCache.get(url);
}

export function addPosterToCache(videoUrl, posterUrl) {
    posterCache.set(videoUrl, posterUrl);
    savePosterCache();
}

export function getMediaInfoFromCache(url) {
    return mediaInfoCache.get(url);
}

export function addMediaInfoToCache(url, mediaInfo) {
    mediaInfoCache.set(url, mediaInfo);
    saveMediaInfoCache();
}