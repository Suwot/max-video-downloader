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
 * - Manages HLS master playlist relationships
 * - Uses factory pattern for consistent cache management
 */

// popup/js/state.js

// Import cache management system
import { CacheFactory, CACHE_TTL, CACHE_VERSION, CACHE_VERSION_KEY } from './cache-factory.js';

// Cache size limits
const MAX_VIDEOS_CACHE_SIZE = 100;
const MAX_POSTER_CACHE_SIZE = 50;
const MAX_MEDIA_INFO_CACHE_SIZE = 100;
const MAX_RESOLUTION_CACHE_SIZE = 100;
const MAX_STREAM_METADATA_CACHE_SIZE = 50;
const MAX_MASTER_PLAYLISTS_CACHE_SIZE = 50;

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

// Cache instances using the factory
const mediaInfoCache = CacheFactory.createMediaInfoCache(MAX_MEDIA_INFO_CACHE_SIZE);
const posterCache = CacheFactory.createPosterCache(MAX_POSTER_CACHE_SIZE);
const streamMetadataCache = CacheFactory.createStreamMetadataCache(MAX_STREAM_METADATA_CACHE_SIZE);
const resolutionCache = CacheFactory.createCache('resolutionCache', MAX_RESOLUTION_CACHE_SIZE);
const masterPlaylistCache = CacheFactory.createMasterPlaylistCache(MAX_MASTER_PLAYLISTS_CACHE_SIZE);

// State variables
let cachedVideos = null;
let videoGroups = {};
let groupState = {}; 
let currentTheme = 'dark';
let currentUrl = null; // Track current URL to detect page navigation

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
        streamMetadataCache.set(url, metadata);
    } catch (error) {
        handleError('Cache', 'adding stream metadata', error);
    }
}

/**
 * Get stream metadata if valid
 */
export function getStreamMetadata(url) {
    try {
        return streamMetadataCache.get(url);
    } catch (error) {
        return handleError('Cache', 'getting stream metadata', error, null);
    }
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

/**
 * Add a master playlist to the cache
 * @param {string} playlistUrl - URL of the master playlist 
 * @param {Object} playlistData - Playlist information including variants
 */
export function addMasterPlaylist(playlistUrl, playlistData) {
    try {
        masterPlaylistCache.set(playlistUrl, playlistData);
    } catch (error) {
        handleError('Cache', 'adding master playlist', error);
    }
}

/**
 * Get a master playlist from the cache if it exists and is valid
 * @param {string} playlistUrl - URL of the master playlist
 * @returns {Object|null} The master playlist data or null if not found/valid
 */
export function getMasterPlaylist(playlistUrl) {
    try {
        return masterPlaylistCache.get(playlistUrl);
    } catch (error) {
        return handleError('Cache', 'getting master playlist', error, null);
    }
}

/**
 * Check if a URL is a known variant of a master playlist
 * @param {string} variantUrl - The variant URL to check
 * @returns {Object|null} The master playlist containing this variant, or null if not found
 */
export function getMasterPlaylistForVariant(variantUrl) {
    try {
        // Get all valid master playlists
        const allPlaylists = masterPlaylistCache.getAllValid();
        
        // Check each playlist for the variant
        for (const [url, masterData] of allPlaylists.entries()) {
            // Skip invalid entries
            if (!masterData || !masterData.qualityVariants) {
                continue;
            }
            
            // Check if this variant URL is in the master's quality variants
            if (masterData.qualityVariants.some(variant => variant.url === variantUrl)) {
                return masterData;
            }
        }
        return null;
    } catch (error) {
        return handleError('Cache', 'finding master playlist for variant', error, null);
    }
}

/**
 * Get all known master playlists
 * @returns {Map} Map of all valid master playlists
 */
export function getAllMasterPlaylists() {
    try {
        return masterPlaylistCache.getAllValid();
    } catch (error) {
        return handleError('Cache', 'getting all master playlists', error, new Map());
    }
}

/**
 * Clear all master playlist relationships
 */
export function clearMasterPlaylists() {
    try {
        masterPlaylistCache.clear();
        logDebug('Cleared master playlist cache');
    } catch (error) {
        handleError('Cache', 'clearing master playlists', error);
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
            'currentTabUrl', // Add URL tracking
            'posterCache',
            'mediaInfoCache', 
            'streamMetadataCache',
            'masterPlaylistCache', 
            CACHE_VERSION_KEY
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
        
        // Restore caches with the new cache system
        posterCache.restore(localData);
        mediaInfoCache.restore(localData);
        streamMetadataCache.restore(localData);
        masterPlaylistCache.restore(localData);
        resolutionCache.restore(localData);
        
        // Handle videos cache
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        // Get the current tab's URL
        currentUrl = currentTab.url;
        logDebug('Current tab URL:', currentUrl);
        
        // Only use cached videos if we're on the same tab AND same URL
        if (localData.cachedVideos && 
            localData.currentTabId === currentTab.id && 
            localData.currentTabUrl === currentTab.url) {
            
            logDebug('Using cached videos - same tab and URL');
            try {
                cachedVideos = localData.cachedVideos.map(video => {
                    // Add version info if missing
                    if (video.version === undefined) {
                        video.version = CACHE_VERSION;
                    }
                    
                    // If video doesn't have metadata but we have it in the cache, add it
                    if (!video.mediaInfo) {
                        const mediaInfo = getMediaInfoFromCache(video.url);
                        if (mediaInfo) {
                            video.mediaInfo = mediaInfo;
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
        } else {
            // Different tab or URL, don't use cached videos
            if (localData.currentTabUrl !== currentTab.url) {
                logDebug('URL changed, not using cached videos. Old:', localData.currentTabUrl, 'New:', currentTab.url);
            } else {
                logDebug('Tab changed, not using cached videos');
            }
            cachedVideos = null;
        }
        
        // Store current tab ID and URL
        chrome.storage.local.set({ 
            currentTabId: currentTab.id,
            currentTabUrl: currentTab.url, // Store the current URL
            [CACHE_VERSION_KEY]: CACHE_VERSION // Always store the current version
        }).catch(error => {
            handleError('Storage', 'setting current tab ID and URL', error);
        });
        
        return {
            currentTheme,
            cachedVideos,
            groupState,
            currentTabId: currentTab.id,
            currentTabUrl: currentTab.url
        };
    } catch (error) {
        handleError('State', 'initializing state', error);
        // Return fallback values if initialization fails
        return {
            currentTheme: 'dark',
            cachedVideos: [],
            groupState: { hls: false, dash: false, direct: false, blob: true, unknown: false },
            currentTabId: null,
            currentTabUrl: null
        };
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

// Cache management
export function hasResolutionCache(url) {
    return resolutionCache.has(url);
}

export function getResolutionFromCache(url) {
    try {
        return resolutionCache.get(url);
    } catch (error) {
        return handleError('Cache', 'getting resolution from cache', error, null);
    }
}

export function addResolutionToCache(url, resolution) {
    try {
        resolutionCache.set(url, resolution);
    } catch (error) {
        handleError('Cache', 'adding resolution to cache', error);
    }
}

export function getPosterFromCache(url) {
    try {
        return posterCache.get(url);
    } catch (error) {
        return handleError('Cache', 'getting poster from cache', error, null);
    }
}

export function addPosterToCache(videoUrl, posterUrl) {
    try {
        posterCache.set(videoUrl, posterUrl);
    } catch (error) {
        handleError('Cache', 'adding poster to cache', error);
    }
}

export function getMediaInfoFromCache(url) {
    try {
        return mediaInfoCache.get(url);
    } catch (error) {
        return handleError('Cache', 'getting media info from cache', error, null);
    }
}

export function addMediaInfoToCache(url, mediaInfo) {
    try {
        mediaInfoCache.set(url, mediaInfo);
    } catch (error) {
        handleError('Cache', 'adding media info to cache', error);
    }
}

/**
 * Purge expired cache entries for all caches
 * Can be called periodically or when the browser is idle
 */
export function purgeExpiredCaches() {
    try {
        // Clean videos cache using direct TTL filtering
        if (cachedVideos) {
            const now = Date.now();
            const originalLength = cachedVideos.length;
            cachedVideos = cachedVideos.filter(video => now - video.timestamp <= CACHE_TTL);
            if (cachedVideos.length < originalLength) {
                logDebug(`Purged ${originalLength - cachedVideos.length} expired videos from cache`);
            }
        }
        
        // Clean all map-based caches using cache system's purgeExpired method
        const caches = [
            { cache: posterCache, name: 'poster' },
            { cache: mediaInfoCache, name: 'media info' },
            { cache: streamMetadataCache, name: 'stream metadata' },
            { cache: resolutionCache, name: 'resolution' },
            { cache: masterPlaylistCache, name: 'master playlist' }
        ];
        
        // Purge all caches
        for (const { cache, name } of caches) {
            const count = cache.purgeExpired();
            if (count > 0) {
                logDebug(`Purged ${count} expired entries from ${name} cache`);
            }
        }
        
        return true;
    } catch (error) {
        handleError('Cache', 'purging expired caches', error);
        return false;
    }
}

/**
 * Clear all caches for a fresh start
 * This completely resets all cached data for testing purposes
 * @returns {Promise<boolean>} True if caches were cleared successfully
 */
export async function clearAllCaches() {
    try {
        logDebug('Clearing all extension caches for fresh testing');
        
        // Reset all in-memory caches
        cachedVideos = null;
        resolutionCache.clear();
        posterCache.clear();
        mediaInfoCache.clear();
        streamMetadataCache.clear();
        masterPlaylistCache.clear();
        
        // Clear all storage caches
        await chrome.storage.local.remove([
            'cachedVideos',
            'videosCacheTimestamp',
            'posterCache',
            'mediaInfoCache',
            'streamMetadataCache',
            'resolutionCache',
            'masterPlaylistCache',
            CACHE_VERSION_KEY
        ]);
        
        // Set fresh cache version marker
        await chrome.storage.local.set({ [CACHE_VERSION_KEY]: CACHE_VERSION });
        
        logDebug('All caches cleared successfully');
        return true;
    } catch (error) {
        handleError('Cache', 'clearing all caches', error);
        return false;
    }
}