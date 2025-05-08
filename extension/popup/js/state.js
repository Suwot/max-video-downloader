/**
 * @ai-guide-component StateManager (DEPRECATED)
 * @ai-guide-description Legacy state management - now redirects to service modules
 * @ai-guide-responsibilities
 * - Provides backward compatibility for old imports
 * - Redirects to the appropriate service implementations
 * - Should be considered deprecated
 */

// popup/js/state.js - DEPRECATED, use services instead

// Import from our new services
import { getTheme, setTheme } from './services/theme-service.js';
import { getAllGroupStates, getGroupState, setGroupState } from './services/group-state-service.js';
import { 
    getPoster as getPosterFromService,
    addPoster,
    getStreamMetadata,
    addStreamMetadata,
    getAllVideoGroups,
    setVideoGroups,
    clearCaches
} from './services/video-state-service.js';

// Legacy re-exports - use the service imports directly in new code
export const initializeState = async () => {
    console.warn("state.js is deprecated - use service modules directly");
    // Initialize our services through service-initializer.js
    const { initializeServices } = await import('./services/service-initializer.js');
    await initializeServices();
    // Return mock data for backward compatibility
    return {
        currentTheme: getTheme(),
        cachedVideos: [],
        groupState: getAllGroupStates()
    };
};

// Theme management (redirects to theme-service.js)
export const getCurrentTheme = () => getTheme();
export const setCurrentTheme = (theme) => setTheme(theme);

// Group state management (redirects to group-state-service.js)
export { getAllGroupStates, getGroupState, setGroupState };

// Video group management (redirects to video-state-service.js)
export const getVideoGroup = (type) => (getAllVideoGroups()[type] || []);
export { getAllVideoGroups, setVideoGroups };

// Cache management (redirects to video-state-service.js)
export const getCachedVideos = () => [];  // Return empty array, background is now source of truth
export const setCachedVideos = () => {}; // No-op, background is now source of truth

export const getPosterFromCache = (url) => getPosterFromService(url);
export const addPosterToCache = (videoUrl, posterUrl) => addPoster(videoUrl, posterUrl);

// Stream metadata (redirects to video-state-service.js)
export { getStreamMetadata, addStreamMetadata };

// Resolution and media info cache (merged into video-state-service)
export const hasResolutionCache = () => false; // No-op, handled by background
export const getResolutionFromCache = () => null; // No-op, handled by background
export const addResolutionToCache = () => {}; // No-op, handled by background
export const getMediaInfoFromCache = () => null; // No-op, handled by background
export const addMediaInfoToCache = () => {}; // No-op, handled by background

// Master playlist functions (handled by background now)
export const addMasterPlaylist = () => {}; // No-op, handled by background
export const getMasterPlaylist = () => null; // No-op, handled by background
export const getMasterPlaylistForVariant = () => null; // No-op, handled by background
export const getAllMasterPlaylists = () => new Map(); // No-op, handled by background
export const clearMasterPlaylists = () => {}; // No-op, handled by background

// Cache maintenance - just forward to our new service
export const purgeExpiredCaches = () => false; // No-op, handled automatically now
export const clearAllCaches = () => clearCaches();