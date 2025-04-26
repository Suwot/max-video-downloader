/**
 * @ai-guide-component StateManager
 * @ai-guide-description Manages application state for the extension
 * @ai-guide-responsibilities
 * - Provides centralized state management
 * - Handles video caching and storage
 * - Manages user preferences and settings
 * - Stores resolution and media info caches
 * - Maintains scroll position between UI updates
 * - Coordinates state persistence across extension sessions
 */

// popup/js/state.js

// State management
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_VERSION = "1.0"; // Version of the cache schema - increment when cache structure changes
const CACHE_VERSION_KEY = "cacheVersion"; // Single consistent key for all cache versions

// Cache size limits
const MAX_VIDEOS_CACHE_SIZE = 100;
const MAX_POSTER_CACHE_SIZE = 50;
const MAX_MEDIA_INFO_CACHE_SIZE = 100;
const MAX_RESOLUTION_CACHE_SIZE = 100;
const MAX_STREAM_METADATA_CACHE_SIZE = 50;

/**
 * Chrome Storage Usage:
 * - chrome.storage.sync: For user preferences that should sync across devices
 *   Limited to 102,400 operations per hour, 8KB per write, 100KB per item
 *   Use for: theme preferences, UI preferences, small user settings
 *
 * - chrome.storage.local: For app-specific data that should stay on device
 *   Limited to 10MB per extension
 *   Use for: caches, current session data, larger objects, non-critical data
 */

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

// Error handling helper with categorization
function handleError(category, operation, error, fallback = null) {
    console.error(`[${category}] Error during ${operation}:`, error);
    // Track errors for potential reporting
    try {
        const errors = JSON.parse(localStorage.getItem('errorLog') || '[]');
        errors.push({
            category,
            operation,
            message: error.message,
            stack: error.stack,
            timestamp: Date.now()
        });
        // Keep only the most recent 50 errors
        if (errors.length > 50) errors.splice(0, errors.length - 50);
        localStorage.setItem('errorLog', JSON.stringify(errors));
    } catch (e) {
        // Fail silently if error logging itself fails
    }
    return fallback;
}

/**
 * Add stream metadata to cache with TTL
 */
export function addStreamMetadata(url, metadata) {
    try {
        // Add access timestamp for LRU
        streamMetadataCache.set(url, {
            data: metadata,
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            version: CACHE_VERSION
        });
        
        // Enforce cache size limit (LRU eviction)
        enforceMapCacheLimit(streamMetadataCache, MAX_STREAM_METADATA_CACHE_SIZE);
        
        saveStreamMetadataCache();
    } catch (error) {
        handleError('Cache', 'adding stream metadata', error);
    }
}

/**
 * Get stream metadata if valid
 */
export function getStreamMetadata(url) {
    try {
        const cached = streamMetadataCache.get(url);
        if (!cached) return null;
        
        // Version check
        if (cached.version !== CACHE_VERSION) {
            streamMetadataCache.delete(url);
            return null;
        }
        
        // TTL check
        if (Date.now() - cached.timestamp > CACHE_TTL) {
            streamMetadataCache.delete(url);
            return null;
        }
        
        // Update last accessed time for LRU algorithm
        cached.lastAccessed = Date.now();
        streamMetadataCache.set(url, cached);
        
        return cached.data;
    } catch (error) {
        return handleError('Cache', 'getting stream metadata', error, null);
    }
}

/**
 * Helper function to enforce Map cache size limits using LRU eviction
 */
function enforceMapCacheLimit(cache, maxSize) {
    if (cache.size <= maxSize) return;
    
    // Convert to array for sorting
    const entries = Array.from(cache.entries());
    
    // Sort by last accessed (oldest first)
    entries.sort((a, b) => {
        const aAccess = a[1].lastAccessed || a[1].timestamp || 0;
        const bAccess = b[1].lastAccessed || b[1].timestamp || 0;
        return aAccess - bAccess;
    });
    
    // Remove oldest entries until we're at the limit
    const entriesToRemove = entries.slice(0, entries.length - maxSize);
    entriesToRemove.forEach(entry => {
        cache.delete(entry[0]);
    });
    
    logDebug(`Removed ${entriesToRemove.length} old entries from cache (LRU eviction)`);
}

/**
 * Get cached videos with TTL validation
 */
export function getCachedVideos() {
    logDebug('Getting cached videos, current count:', cachedVideos?.length || 0);
    
    try {
        // Validate cache TTL
        if (cachedVideos) {
            const now = Date.now();
            const beforeCount = cachedVideos.length;
            
            // Filter out expired entries
            cachedVideos = cachedVideos.filter(video => {
                // Version check
                if (video.version !== undefined && video.version !== CACHE_VERSION) {
                    logDebug('Video has outdated version:', video.url);
                    return false;
                }
                
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
                chrome.storage.local.remove('cachedVideos').catch(error => {
                    handleError('Storage', 'removing empty video cache', error);
                });
            } else if (cachedVideos.length > MAX_VIDEOS_CACHE_SIZE) {
                // Sort by timestamp (newest first)
                cachedVideos.sort((a, b) => (b.lastAccessed || b.timestamp) - (a.lastAccessed || a.timestamp));
                // Keep only the most recent MAX_VIDEOS_CACHE_SIZE
                cachedVideos = cachedVideos.slice(0, MAX_VIDEOS_CACHE_SIZE);
                logDebug(`Limited video cache to ${MAX_VIDEOS_CACHE_SIZE} most recent entries`);
                
                // Save the trimmed list
                chrome.storage.local.set({ 
                    cachedVideos,
                    cacheTimestamp: Date.now()
                }).catch(error => {
                    handleError('Storage', 'saving trimmed video cache', error);
                });
            }
        } else {
            logDebug('No cached videos found');
        }
        return cachedVideos;
    } catch (error) {
        return handleError('Cache', 'getting cached videos', error, []);
    }
}

/**
 * Set cached videos
 */
export function setCachedVideos(videos) {
    try {
        logDebug('Setting cached videos, count:', videos?.length || 0);
        
        if (!Array.isArray(videos)) {
            throw new Error('Videos must be an array');
        }
        
        // Add timestamps and version to videos if not present
        videos = videos.map(video => {
            // Add any available metadata from cache that might not be in the video object
            const mediaInfo = video.mediaInfo || getMediaInfoFromCache(video.url);
            const withMetadata = {
                ...video,
                mediaInfo,
                timestamp: video.timestamp || Date.now(),
                lastAccessed: Date.now(),
                version: CACHE_VERSION
            };
            if (!video.timestamp) {
                logDebug('Added missing timestamp to video:', video.url);
            }
            if (mediaInfo && !video.mediaInfo) {
                logDebug('Added metadata from cache to video:', video.url);
            }
            return withMetadata;
        });
        
        // Enforce size limit
        if (videos.length > MAX_VIDEOS_CACHE_SIZE) {
            videos = videos.slice(0, MAX_VIDEOS_CACHE_SIZE);
            logDebug(`Limited videos to ${MAX_VIDEOS_CACHE_SIZE} entries`);
        }
        
        cachedVideos = videos;
        const timestamp = Date.now();
        
        logDebug('Saving to storage with timestamp:', new Date(timestamp).toISOString());
        chrome.storage.local.set({ 
            cachedVideos,
            videosCacheTimestamp: timestamp,
            [CACHE_VERSION_KEY]: CACHE_VERSION // Store the current cache version
        }).catch(error => {
            handleError('Storage', 'setting cached videos', error);
        });
    } catch (error) {
        handleError('Cache', 'setting cached videos', error);
        // Try to set a minimal version to avoid losing all videos
        if (Array.isArray(videos)) {
            try {
                cachedVideos = videos;
                chrome.storage.local.set({ 
                    cachedVideos,
                    videosCacheTimestamp: Date.now(),
                    [CACHE_VERSION_KEY]: CACHE_VERSION
                }).catch(() => {});
            } catch (e) {
                // Last resort failed, give up
            }
        }
    }
}

// Storage management functions
function saveStreamMetadataCache() {
    try {
        const cacheData = JSON.stringify(Array.from(streamMetadataCache.entries()));
        chrome.storage.local.set({ 
            streamMetadataCache: cacheData,
            [CACHE_VERSION_KEY]: CACHE_VERSION // Use consistent version key
        }).catch(error => {
            handleError('Storage', 'saving stream metadata cache', error);
        });
    } catch (error) {
        handleError('Storage', 'preparing stream metadata for storage', error);
    }
}

function savePosterCache() {
    try {
        const posterData = JSON.stringify(Array.from(posterCache.entries()));
        chrome.storage.local.set({ 
            posterCache: posterData,
            [CACHE_VERSION_KEY]: CACHE_VERSION // Use consistent version key
        }).catch(error => {
            handleError('Storage', 'saving poster cache', error);
        });
    } catch (error) {
        handleError('Storage', 'preparing poster cache for storage', error);
    }
}

function saveMediaInfoCache() {
    try {
        const mediaInfoData = JSON.stringify(Array.from(mediaInfoCache.entries()));
        chrome.storage.local.set({ 
            mediaInfoCache: mediaInfoData,
            [CACHE_VERSION_KEY]: CACHE_VERSION // Use consistent version key
        }).catch(error => {
            handleError('Storage', 'saving media info cache', error);
        });
    } catch (error) {
        handleError('Storage', 'preparing media info for storage', error);
    }
}

/**
 * Initialize state from storage
 */
export async function initializeState() {
    try {
        // Get user preferences from sync storage (syncs across devices)
        const result = await chrome.storage.sync.get(['theme']);
        
        // Get app-specific data from local storage (stays on device)
        const localData = await chrome.storage.local.get([
            'groupState', 
            'cachedVideos', 
            'currentTabId', 
            'posterCache',
            'mediaInfoCache', 
            'streamMetadataCache',
            CACHE_VERSION_KEY // Use consistent version key
        ]);

        // Check if we have a version mismatch and log it
        if (localData[CACHE_VERSION_KEY] !== CACHE_VERSION) {
            logDebug('Cache version mismatch - stored:', localData[CACHE_VERSION_KEY], 'current:', CACHE_VERSION);
        } else {
            logDebug('Cache version match:', CACHE_VERSION);
        }
        
        // Set theme based on user preference or system preference
        const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        // Only use stored theme if explicitly set by user, otherwise use system preference
        currentTheme = result.theme !== undefined ? result.theme : (prefersDarkMode ? 'dark' : 'light');
        
        // Set group state
        groupState = localData.groupState || { 
            hls: false, 
            dash: false, 
            direct: false, 
            blob: true,
            unknown: false 
        };
        
        // Restore caches with version checking and size enforcement
        restorePosterCache(localData);
        restoreMediaInfoCache(localData);
        restoreStreamMetadataCache(localData);
        
        // Handle videos cache
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (localData.cachedVideos && localData.currentTabId === currentTab.id) {
            try {
                cachedVideos = localData.cachedVideos.map(video => {
                    // Add version info if missing
                    if (video.version === undefined) {
                        video.version = CACHE_VERSION;
                    }
                    
                    // If video doesn't have metadata but we have it in the cache, add it
                    if (!video.mediaInfo) {
                        const mediaInfo = mediaInfoCache.get(video.url);
                        if (mediaInfo) {
                            video.mediaInfo = typeof mediaInfo === 'object' && mediaInfo.data ? 
                                mediaInfo.data : mediaInfo;
                            logDebug('Added missing mediaInfo to video from cache:', video.url);
                        }
                    }
                    
                    return video;
                });
                
                // Apply size limit 
                if (cachedVideos.length > MAX_VIDEOS_CACHE_SIZE) {
                    cachedVideos.sort((a, b) => (b.lastAccessed || b.timestamp) - (a.lastAccessed || a.timestamp));
                    cachedVideos = cachedVideos.slice(0, MAX_VIDEOS_CACHE_SIZE);
                    logDebug(`Limited restored videos to ${MAX_VIDEOS_CACHE_SIZE} entries`);
                }
            } catch (e) {
                handleError('Cache', 'restoring cached videos', e);
                cachedVideos = []; // Fallback to empty array on error
            }
        }
        
        // Store current tab ID
        chrome.storage.local.set({ 
            currentTabId: currentTab.id,
            [CACHE_VERSION_KEY]: CACHE_VERSION // Always store the current version
        }).catch(error => {
            handleError('Storage', 'setting current tab ID', error);
        });
        
        return {
            currentTheme,
            cachedVideos,
            groupState,
            posterCache,
            currentTabId: currentTab.id
        };
    } catch (error) {
        handleError('State', 'initializing state', error);
        // Return fallback values if initialization fails
        return {
            currentTheme: 'dark',
            cachedVideos: [],
            groupState: { hls: false, dash: false, direct: false, blob: true, unknown: false },
            posterCache: new Map(),
            currentTabId: null
        };
    }
}

// Helper functions for cache restoration with version checking
function restorePosterCache(localData) {
    if (localData.posterCache) {
        try {
            // Check version - use consistent version key
            if (localData[CACHE_VERSION_KEY] !== CACHE_VERSION) {
                logDebug('Poster cache version mismatch, but will attempt to use existing data');
                // Instead of resetting, we'll try to use the existing data
            }
            
            posterCache = new Map(JSON.parse(localData.posterCache));
            enforceMapCacheLimit(posterCache, MAX_POSTER_CACHE_SIZE);
        } catch (e) {
            handleError('Cache', 'restoring poster cache', e);
            posterCache = new Map(); // Reset on error
        }
    }
}

function restoreMediaInfoCache(localData) {
    if (localData.mediaInfoCache) {
        try {
            // Check version - use consistent version key
            if (localData[CACHE_VERSION_KEY] !== CACHE_VERSION) {
                logDebug('Media info cache version mismatch, but will attempt to use existing data');
                // Instead of resetting, we'll try to use the existing data
            }
            
            mediaInfoCache = new Map(JSON.parse(localData.mediaInfoCache));
            enforceMapCacheLimit(mediaInfoCache, MAX_MEDIA_INFO_CACHE_SIZE);
        } catch (e) {
            handleError('Cache', 'restoring media info cache', e);
            mediaInfoCache = new Map(); // Reset on error
        }
    }
}

function restoreStreamMetadataCache(localData) {
    if (localData.streamMetadataCache) {
        try {
            // Check version - use consistent version key
            if (localData[CACHE_VERSION_KEY] !== CACHE_VERSION) {
                logDebug('Stream metadata cache version mismatch, but will attempt to use existing data');
                // Instead of resetting, we'll try to use the existing data
            }
            
            const parsedCache = JSON.parse(localData.streamMetadataCache);
            streamMetadataCache.clear();
            
            for (const [url, data] of parsedCache) {
                // Add lastAccessed if missing (for LRU)
                if (!data.lastAccessed) {
                    data.lastAccessed = data.timestamp;
                }
                
                // Only restore non-expired entries
                if (Date.now() - data.timestamp <= CACHE_TTL) {
                    // Update version to current
                    data.version = CACHE_VERSION;
                    streamMetadataCache.set(url, data);
                }
            }
            
            enforceMapCacheLimit(streamMetadataCache, MAX_STREAM_METADATA_CACHE_SIZE);
        } catch (e) {
            handleError('Cache', 'restoring stream metadata cache', e);
            streamMetadataCache.clear(); // Reset on error
        }
    }
}

// Group state management
export function getGroupState(type) {
    return groupState[type] || false;
}

export function setGroupState(type, isCollapsed) {
    groupState[type] = isCollapsed;
    chrome.storage.local.set({ groupState }).catch(error => {
        handleError('Storage', 'setting group state', error);
    });
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
    // Store theme in sync storage since it's a user preference that should follow across devices
    chrome.storage.sync.set({ theme }).catch(error => {
        handleError('Storage', 'setting theme', error);
    });
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
    try {
        const cacheEntry = resolutionCache.get(url);
        if (!cacheEntry) return null;
        
        // Update last accessed time for LRU
        if (typeof cacheEntry === 'object') {
            cacheEntry.lastAccessed = Date.now();
            resolutionCache.set(url, cacheEntry);
        }
        
        return cacheEntry.data || cacheEntry;
    } catch (error) {
        return handleError('Cache', 'getting resolution from cache', error, null);
    }
}

export function addResolutionToCache(url, resolution) {
    try {
        resolutionCache.set(url, {
            data: resolution,
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            version: CACHE_VERSION
        });
        
        // Enforce cache size limit
        enforceMapCacheLimit(resolutionCache, MAX_RESOLUTION_CACHE_SIZE);
    } catch (error) {
        handleError('Cache', 'adding resolution to cache', error);
    }
}

export function getPosterFromCache(url) {
    try {
        const cached = posterCache.get(url);
        if (cached) {
            // Update lastAccessed for LRU if it's an object
            if (typeof cached === 'object' && cached.data) {
                cached.lastAccessed = Date.now();
                posterCache.set(url, cached);
                return cached.data;
            }
            return cached;
        }
        return null;
    } catch (error) {
        return handleError('Cache', 'getting poster from cache', error, null);
    }
}

export function addPosterToCache(videoUrl, posterUrl) {
    try {
        posterCache.set(videoUrl, {
            data: posterUrl,
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            version: CACHE_VERSION
        });
        
        // Enforce cache size limit
        enforceMapCacheLimit(posterCache, MAX_POSTER_CACHE_SIZE);
        
        savePosterCache();
    } catch (error) {
        handleError('Cache', 'adding poster to cache', error);
    }
}

export function getMediaInfoFromCache(url) {
    try {
        const cached = mediaInfoCache.get(url);
        if (cached) {
            // Update lastAccessed for LRU if it's an object with timestamp
            if (typeof cached === 'object' && cached.timestamp) {
                cached.lastAccessed = Date.now();
                mediaInfoCache.set(url, cached);
                
                // Ensure we return the unwrapped data
                return cached.data;
            }
            // For direct objects (legacy cache format)
            return cached;
        }
        return null;
    } catch (error) {
        return handleError('Cache', 'getting media info from cache', error, null);
    }
}

export function addMediaInfoToCache(url, mediaInfo) {
    try {
        mediaInfoCache.set(url, {
            data: mediaInfo,
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            version: CACHE_VERSION
        });
        
        // Enforce cache size limit
        enforceMapCacheLimit(mediaInfoCache, MAX_MEDIA_INFO_CACHE_SIZE);
        
        saveMediaInfoCache();
    } catch (error) {
        handleError('Cache', 'adding media info to cache', error);
    }
}

/**
 * Purge expired cache entries for all caches
 * Can be called periodically or when the browser is idle
 */
export function purgeExpiredCaches() {
    const now = Date.now();
    
    try {
        // Clean videos cache
        if (cachedVideos) {
            const originalLength = cachedVideos.length;
            cachedVideos = cachedVideos.filter(video => now - video.timestamp <= CACHE_TTL);
            if (cachedVideos.length < originalLength) {
                logDebug(`Purged ${originalLength - cachedVideos.length} expired videos from cache`);
            }
        }
        
        // Helper function to clean Map caches
        const cleanMapCache = (cache, name) => {
            const originalSize = cache.size;
            for (const [key, value] of cache.entries()) {
                if (value.timestamp && now - value.timestamp > CACHE_TTL) {
                    cache.delete(key);
                }
            }
            if (cache.size < originalSize) {
                logDebug(`Purged ${originalSize - cache.size} expired entries from ${name} cache`);
            }
        };
        
        // Clean all map-based caches
        cleanMapCache(posterCache, 'poster');
        cleanMapCache(mediaInfoCache, 'media info');
        cleanMapCache(streamMetadataCache, 'stream metadata');
        cleanMapCache(resolutionCache, 'resolution');
        
        // Save cleaned caches
        saveStreamMetadataCache();
        savePosterCache();
        saveMediaInfoCache();
        
        return true;
    } catch (error) {
        handleError('Cache', 'purging expired caches', error);
        return false;
    }
}