/**
 * @ai-guide-component VideoFetcher
 * @ai-guide-description Video source detection and metadata retrieval
 * @ai-guide-responsibilities
 * - Retrieves detected videos from background script
 * - Manages video source prioritization and filtering
 * - Handles video metadata enrichment and formatting
 * - Implements cache and refresh mechanisms for video sources
 * - Supports various video source types (direct, HLS, DASH)
 * - Coordinates with background script for cross-tab operation
 * - Provides normalized video objects to the UI components
 * - Properly handles URLs extracted from query parameters
 * - Filters tracking pixels while preserving embedded video URLs
 * - Applies consistent validation for video sources
 * - Processes HLS relationships while respecting extracted URLs
 */

// Import all from single source
import {
    getCachedVideos,
    setCachedVideos,
    getScrollPosition,
    setScrollPosition,
    hasResolutionCache, 
    getResolutionFromCache,
    addResolutionToCache,
    getMediaInfoFromCache, 
    addMediaInfoToCache,
    addPosterToCache,
    getPosterFromCache,
    // Import master playlist cache functions
    getMasterPlaylist,
    addMasterPlaylist,
    clearMasterPlaylists
} from './state.js';
import { showLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { groupVideos, processVideos, clearHLSRelationships } from './video-processor.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, formatDuration, getFilenameFromUrl } from './utilities.js';
import { parseHLSManifest } from './manifest-parser.js';
// Import centralized validation logic
import { validateAndFilterVideos, isValidVideo, isValidVideoUrl } from '../../js/utilities/video-validator.js';
import { sendPortMessage } from './index.js';

// Import the manifest service
import {
    processVideoRelationships,
    isVariantOfMasterPlaylist,
    getMasterPlaylistForVariant,
    clearCaches as clearManifestCaches
} from '../../js/manifest-service.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Video Fetcher]', new Date().toISOString(), ...args);
}

// Remove the local knownMasterPlaylists Map as we're now using the centralized one in state.js

/**
 * Process video for HLS relationships
 * @param {Object} video - Video object
 * @param {number} tabId - Tab ID
 */
async function processHLSRelationships(video, tabId) {
    // Early rejection check for null or missing URL
    if (!video || !video.url) return null;
    
    // Always keep videos that were found in query parameters - 
    // they've already been validated and the URL is the extracted one
    if (video.foundFromQueryParam) {
        return video;
    }
    
    // For non-HLS/DASH videos, validate using the shared validation function
    if (video.type !== 'hls' && video.type !== 'dash') {
        // Use the centralized validation utility instead of duplicating logic
        if (!isValidVideoUrl(video.url)) {
            logDebug('Rejecting invalid URL in processHLSRelationships:', video.url);
            return null;
        }
        // Non-HLS videos don't need relationship processing
        return video;
    }
    
    // Use the centralized manifest service to check relationships and enhance the video
    try {
        // This will check if the video is a variant, master playlist, or standalone video
        // It will also fetch and parse the manifest if needed
        const processedVideo = await processVideoRelationships(video);
        return processedVideo;
    } catch (error) {
        console.error('Error processing video relationships:', error);
        return video;
    }
}

/**
 * Update the video list, either from cache or by fetching new videos
 * @param {boolean} forceRefresh - Whether to force refresh even if cached videos exist
 * @param {number} tabId - Optional tab ID for the active tab
 * @returns {Array} The current videos list
 */
export async function updateVideoList(forceRefresh = false, tabId = null) {
    const container = document.getElementById('videos');
    logDebug('Updating video list, force refresh:', forceRefresh);
    
    // Clear relationships if forcing refresh
    if (forceRefresh) {
        logDebug('Clearing HLS relationships');
        clearHLSRelationships();
        clearMasterPlaylists(); // Clear the centralized master playlist cache
        clearManifestCaches(); // Clear manifest service caches
    }
    
    // Save current scroll position
    if (container.scrollTop) {
        setScrollPosition(container.scrollTop);
    }
    
    // Check if we already have a tab ID, otherwise get the current tab
    if (!tabId) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab.id;
        } catch (e) {
            logDebug('Error getting current tab:', e);
        }
    }
    logDebug('Using tab ID:', tabId);
    
    // SIMPLIFIED APPROACH:
    // 1. Request videos via port connection only
    // 2. Let the port handler in index.js update the UI
    logDebug('Requesting videos via port connection');
    sendPortMessage({
        action: 'getVideos',
        tabId,
        forceRefresh
    });
    
    // Return the current cached videos (UI will be updated via port response)
    return getCachedVideos();
}

/**
 * Merge new videos with existing ones, avoiding duplicates
 * @param {Array} existing - Existing videos array
 * @param {Array} newVideos - New videos to merge
 */
function mergeVideos(existing, newVideos) {
    const existingUrls = new Set(existing.map(v => v.url));
    for (const video of newVideos) {
        if (!existingUrls.has(video.url)) {
            existing.push(video);
            existingUrls.add(video.url);
        } else {
            // Update existing video with any new information
            const index = existing.findIndex(v => v.url === video.url);
            if (index !== -1) {
                existing[index] = { ...existing[index], ...video };
            }
        }
    }
}

/**
 * Refresh video information in the background
 * @param {Array} videos - Currently displayed videos
 */
export async function refreshInBackground(videos) {
    if (!videos || videos.length === 0) return;
    logDebug('Starting background refresh for', videos.length, 'videos');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab.id;
        logDebug('Background refresh on tab:', tabId);

        // Update video info in the background
        fetchVideoInfo(videos, tabId);

        // Check for new videos
        const response = await chrome.tabs.sendMessage(tabId, { action: 'findVideos' });
        if (response && response.length) {
            logDebug('Found new videos in background:', response.length);
            
            // Filter response first with our enhanced validation
            const filteredResponse = validateAndFilterVideos(response);
            logDebug('After filtering new videos:', filteredResponse.length);
            
            // Then check for videos we don't already have
            const newVideos = filteredResponse.filter(newVideo => 
                !videos.some(existing => existing.url === newVideo.url)
            );

            if (newVideos.length > 0) {
                logDebug('Processing', newVideos.length, 'new videos');
                const processedVideos = [...videos];
                for (const video of newVideos) {
                    const processed = await processHLSRelationships(video, tabId);
                    if (processed) {
                        processedVideos.push(processed);
                    }
                }

                const groupedVideos = processVideos(processedVideos);
                logDebug('Updating with new videos, total:', groupedVideos.length);
                setCachedVideos(groupedVideos);
                renderVideos(groupedVideos);
                fetchVideoInfo(newVideos, tabId);
            }
        }
    } catch (error) {
        logDebug('Background refresh failed:', error);
    }
}

/**
 * Fetch resolution information for videos in the background
 * Only fetch for videos that don't already have mediaInfo
 * @param {Array} videos - Videos to fetch information for
 * @param {number} tabId - Tab ID
 */
export async function fetchVideoInfo(videos, tabId) {
    // Process videos with missing mediaInfo in parallel - but skip blob URLs
    const videosNeedingInfo = videos.filter(video => {
        // Skip blob URLs as they can't be analyzed by the native host
        if (video.url.startsWith('blob:')) {
            // For blob URLs, set placeholder media info to prevent repeated fetch attempts
            const placeholderInfo = {
                hasVideo: true,
                hasAudio: true,
                format: 'blob',
                container: 'blob',
                width: 0,
                height: 0,
                fps: 0,
                bitrate: 0
            };
            
            // Cache the placeholder info
            addMediaInfoToCache(video.url, placeholderInfo);
            
            // Update UI with blob-specific message
            updateVideoResolution(video.url, {
                ...placeholderInfo,
                width: null,
                height: null,
                duration: null,
                videoCodec: { name: 'N/A for blob URL' },
                audioCodec: { name: 'N/A for blob URL' }
            });
            
            return false; // Skip this video
        }
        
        // Include video if it doesn't have mediaInfo
        return !video.mediaInfo && !getMediaInfoFromCache(video.url);
    });
    
    if (videosNeedingInfo.length === 0) {
        logDebug('All videos already have mediaInfo, skipping fetch');
        return;
    }
    
    logDebug(`Fetching media info for ${videosNeedingInfo.length} videos without metadata`);
    
    Promise.all(videosNeedingInfo.map(async (video) => {
        try {
            // No cached info, fetch using port connection
            logDebug('Fetching info for:', video.url);
            
            // Use port connection for quality requests
            sendPortMessage({
                type: 'getHLSQualities',
                url: video.url,
                tabId: tabId
            });
            
            // Listen for the response
            const qualitiesPromise = new Promise((resolve) => {
                const listener = (event) => {
                    const response = event.detail;
                    
                    if (response.url === video.url) {
                        document.removeEventListener('qualities-response', listener);
                        resolve(response);
                    }
                };
                
                document.addEventListener('qualities-response', listener);
                
                // Set a timeout
                setTimeout(() => {
                    document.removeEventListener('qualities-response', listener);
                    resolve({ url: video.url });
                }, 15000);
            });
            
            const response = await qualitiesPromise;
            
            if (response?.streamInfo) {
                const streamInfo = response.streamInfo;
                
                // Create media info object
                const mediaInfo = {
                    hasVideo: streamInfo.hasVideo,
                    hasAudio: streamInfo.hasAudio,
                    videoCodec: streamInfo.videoCodec,
                    audioCodec: streamInfo.audioCodec,
                    format: streamInfo.format,
                    container: streamInfo.container,
                    duration: streamInfo.duration,
                    sizeBytes: streamInfo.sizeBytes,
                    width: streamInfo.width,
                    height: streamInfo.height,
                    fps: streamInfo.fps,
                    bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                };

                // Cache the media info
                addMediaInfoToCache(video.url, mediaInfo);

                // Update video object with media info
                const updatedVideo = {
                    ...video,
                    mediaInfo
                };

                // Update UI immediately
                updateVideoResolution(video.url, mediaInfo);
                
                // Update this video in the cache
                const cachedVideos = getCachedVideos();
                if (cachedVideos) {
                    const index = cachedVideos.findIndex(v => v.url === video.url);
                    if (index !== -1) {
                        cachedVideos[index] = updatedVideo;
                        setCachedVideos(cachedVideos);
                    }
                }
            }
        } catch (error) {
            // Don't show errors for blob URLs - they're expected to fail
            if (!video.url.startsWith('blob:')) {
                console.error('Error fetching info for video:', video.url, error);
            }
            
            // For any failed fetches, add placeholder info to prevent repeated attempts
            const placeholderInfo = {
                hasVideo: true,
                hasAudio: true,
                format: 'unknown',
                container: 'unknown',
                width: null,
                height: null,
                fps: null,
                bitrate: null
            };
            
            addMediaInfoToCache(video.url, placeholderInfo);
            
            // Update UI to show we're done trying
            const resolutionInfo = document.querySelector(`.video-item[data-url="${video.url}"] .resolution-info`);
            if (resolutionInfo && resolutionInfo.classList.contains('loading')) {
                resolutionInfo.classList.remove('loading');
                resolutionInfo.textContent = 'Resolution unavailable';
            }
            
            const codecInfo = document.querySelector(`.video-item[data-url="${video.url}"] .codec-info`);
            if (codecInfo && codecInfo.classList.contains('loading')) {
                codecInfo.classList.remove('loading');
                codecInfo.textContent = 'Codec information unavailable';
            }
        }
    })).catch(error => {
        console.error('Error in parallel video info fetching:', error);
    });
}

/**
 * Update resolution display for a specific video
 * @param {string} url - Video URL
 * @param {Object} resolution - Resolution information
 */
export function updateVideoResolution(url, streamInfo) {
    const videoElement = document.querySelector(`.video-item[data-url="${url}"]`);
    if (videoElement) {
        // Update duration display
        if (streamInfo.duration) {
            let durationElement = videoElement.querySelector('.video-duration');
            if (!durationElement) {
                durationElement = document.createElement('div');
                durationElement.className = 'video-duration';
                const previewContainer = videoElement.querySelector('.preview-container');
                if (previewContainer) {
                    previewContainer.appendChild(durationElement);
                }
            }
            durationElement.textContent = formatDuration(streamInfo.duration);
        }

        // Update resolution info
        const resolutionInfo = videoElement.querySelector('.resolution-info');
        if (resolutionInfo) {
            const resolution = {
                width: streamInfo.width,
                height: streamInfo.height,
                fps: streamInfo.fps,
                bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
            };
            
            resolutionInfo.textContent = formatResolution(
                resolution.width,
                resolution.height,
                resolution.fps,
                resolution.bitrate,
                {
                    videoCodec: streamInfo.videoCodec,
                    audioCodec: streamInfo.audioCodec
                }
            );
            
            // Remove loading class if present
            if (resolutionInfo.classList.contains('loading')) {
                resolutionInfo.classList.remove('loading');
            }
        }
        
        // Update media type info
        const mediaTypeInfo = videoElement.querySelector('.media-type-info');
        if (mediaTypeInfo) {
            let mediaContentType = "Unknown";
            if (streamInfo.hasVideo && streamInfo.hasAudio) {
                mediaContentType = "Video & Audio";
            } else if (streamInfo.hasVideo) {
                mediaContentType = "Video Only";
            } else if (streamInfo.hasAudio) {
                mediaContentType = "Audio Only";
            }
            
            let mediaIcon = '';
            if (mediaContentType === "Audio Only") {
                mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4s4-1.79 4-4V7h4V3h-6z"/>';
            } else if (mediaContentType === "Video Only") {
                mediaIcon = '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>';
            } else {
                mediaIcon = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/><path d="M9 8h2v8H9zm4 0h2v8h-2z"/>';
            }
            
            mediaTypeInfo.innerHTML = `
                <svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
                    ${mediaIcon}
                </svg>
                <span>${mediaContentType}</span>
            `;
        }
        
        // Update codec info
        const codecInfo = videoElement.querySelector('.codec-info');
        if (codecInfo) {
            const details = [];
            if (streamInfo.videoCodec) {
                details.push(`Video: ${streamInfo.videoCodec.name}`);
            }
            if (streamInfo.audioCodec) {
                details.push(`Audio: ${streamInfo.audioCodec.name}`);
                if (streamInfo.audioCodec.channels) {
                    details.push(`${streamInfo.audioCodec.channels} channels`);
                }
            }
            
            codecInfo.textContent = details.length > 0 
                ? details.join(' • ') 
                : 'Codec information unavailable';
                
            // Remove loading class if present
            if (codecInfo.classList.contains('loading')) {
                codecInfo.classList.remove('loading');
            }
        }
    }
}

/**
 * Get stream resolution from background script using port communication
 * @param {string} url - Video URL
 * @param {number} tabId - Tab ID
 * @returns {Promise<string>} Resolution string
 */
export async function getStreamResolution(url, tabId = null) {
    // Check cache first
    if (hasResolutionCache(url)) {
        return getResolutionFromCache(url);
    }
    
    if (url.startsWith('blob:')) {
        return 'Resolution unavailable for blob';
    }
    
    try {
        // Get current tab ID if not provided
        if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
        }
        
        // Use port connection for the request
        sendPortMessage({
            type: 'getHLSQualities',
            url: url,
            tabId: tabId
        });
        
        // Create a promise that will be resolved when we get the response
        const responsePromise = new Promise((resolve) => {
            const listener = (event) => {
                const response = event.detail;
                
                if (response.url === url) {
                    document.removeEventListener('qualities-response', listener);
                    resolve(response);
                }
            };
            
            document.addEventListener('qualities-response', listener);
            
            // Set a timeout
            setTimeout(() => {
                document.removeEventListener('qualities-response', listener);
                resolve({ url });
            }, 10000);
        });
        
        const response = await responsePromise;
        
        if (response?.streamInfo) {
            const streamInfo = response.streamInfo;
            const resolution = formatResolution(
                streamInfo.width,
                streamInfo.height,
                streamInfo.fps,
                streamInfo.videoBitrate || streamInfo.totalBitrate,
                {
                    videoCodec: streamInfo.videoCodec,
                    audioCodec: streamInfo.audioCodec
                }
            );
            
            addResolutionToCache(url, resolution);
            
            // Update UI immediately with full stream info
            updateVideoResolution(url, streamInfo);
            
            return resolution;
        }
    } catch (error) {
        console.error('Failed to get resolution:', error);
    }
    return 'Resolution unknown';
}

/**
 * Preserve metadata from current videos before refresh
 * This ensures metadata is not lost during a refresh operation
 * @returns {Promise<boolean>} True if metadata was preserved
 */
export async function preserveMetadata() {
    const videos = getCachedVideos();
    if (!videos || videos.length === 0) {
        return false;
    }
    
    logDebug('Preserving metadata for', videos.length, 'videos before refresh');
    
    // For each video with metadata, ensure it's properly stored in the cache
    let metadataCount = 0;
    for (const video of videos) {
        if (video.mediaInfo) {
            addMediaInfoToCache(video.url, video.mediaInfo);
            metadataCount++;
        }
        
        if (video.resolution) {
            addResolutionToCache(video.url, formatResolution(
                video.resolution.width,
                video.resolution.height,
                video.resolution.fps,
                video.resolution.bitrate,
                video.mediaInfo
            ));
        }
        
        if (video.previewUrl) {
            addPosterToCache(video.url, video.previewUrl);
        } else if (video.poster) {
            addPosterToCache(video.url, video.poster);
        }
    }
    
    logDebug('Preserved metadata for', metadataCount, 'videos');
    return metadataCount > 0;
}

// Track the background refresh interval
let backgroundRefreshInterval = null;

/**
 * Start a periodic background refresh loop
 * @param {number} intervalMs - Refresh interval in milliseconds
 * @param {number} tabId - Current tab ID
 */
export function startBackgroundRefreshLoop(intervalMs = 3000, tabId = null) {
    // Clear any existing interval
    stopBackgroundRefreshLoop();
    
    // Set up a new interval - check every 3 seconds by default
    backgroundRefreshInterval = setInterval(async () => {
        // Get the tab ID if not provided
        if (!tabId) {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                tabId = tab?.id;
            } catch (e) {
                console.error('Error getting current tab:', e);
                return;
            }
        }
        
        if (tabId) {
            // Request videos via port connection
            sendPortMessage({ 
                action: 'getVideos', 
                tabId: tabId
            });
        }
    }, intervalMs);
    
    return backgroundRefreshInterval;
}

/**
 * Stop background refresh loop
 */
export function stopBackgroundRefreshLoop() {
    if (backgroundRefreshInterval) {
        clearInterval(backgroundRefreshInterval);
        backgroundRefreshInterval = null;
    }
}