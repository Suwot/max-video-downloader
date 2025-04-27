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
    getMasterPlaylistForVariant,
    clearMasterPlaylists
} from './state.js';
import { showLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { groupVideos, processVideos, clearHLSRelationships } from './video-processor.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, formatDuration, getFilenameFromUrl } from './utilities.js';
import { parseHLSManifest } from './manifest-parser.js';
// Import centralized validation logic
import { validateAndFilterVideos, isValidVideo, isValidVideoUrl } from '../../js/utilities/video-validator.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Video Fetcher]', new Date().toISOString(), ...args);
}

// Remove the local knownMasterPlaylists Map as we're now using the centralized one in state.js

/**
 * Fetch and process HLS manifest content
 * @param {string} url - Manifest URL
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object>} Manifest info with variants
 */
async function fetchHLSManifest(url, tabId) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'fetchManifest',
            url: url,
            tabId: tabId
        });
        
        if (response?.content) {
            const manifestInfo = parseHLSManifest(response.content, url);
            if (manifestInfo.isPlaylist) {
                // Store the relationship between playlist and variants
                await chrome.runtime.sendMessage({
                    type: 'storeManifestRelationship',
                    playlistUrl: url,
                    variants: manifestInfo.variants
                });
            }
            return manifestInfo;
        }
    } catch (error) {
        console.error('Failed to fetch HLS manifest:', error);
    }
    return null;
}

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
    
    // Skip non-HLS videos for manifest parsing
    if (video.type !== 'hls') return video;

    // First check if this URL is a known variant of a master playlist using the centralized cache
    const masterPlaylist = getMasterPlaylistForVariant(video.url);
    
    if (masterPlaylist) {
        // Skip this video as it will be handled by its master playlist
        logDebug('Skipping variant URL that belongs to master playlist:', video.url);
        return null;
    }

    // Check if this URL is already a known master playlist
    const existingMaster = getMasterPlaylist(video.url);
    if (existingMaster) {
        logDebug('Found existing master playlist in cache:', video.url);
        return existingMaster;
    }

    // Fetch and check the manifest content
    const manifestInfo = await fetchHLSManifest(video.url, tabId);
    if (!manifestInfo) return video;

    // Update video with manifest info
    video.isPlaylist = manifestInfo.isPlaylist;
    
    // If this is a master playlist, store it and add its variants
    if (manifestInfo.isPlaylist && manifestInfo.variants?.length > 0) {
        const enhancedVideo = {
            ...video,
            qualityVariants: manifestInfo.variants.map(v => ({
                url: v.url,
                width: v.width,
                height: v.height,
                fps: v.fps,
                bandwidth: v.bandwidth,
                codecs: v.codecs
            }))
        };
        
        // Store in our centralized master playlist cache
        logDebug('Adding master playlist to centralized cache:', video.url);
        addMasterPlaylist(video.url, enhancedVideo);
        
        return enhancedVideo;
    }
    
    return video;
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
    }
    
    // Save current scroll position
    if (container.scrollTop) {
        setScrollPosition(container.scrollTop);
    }
    
    // Check if cached videos are still valid
    const cachedVideos = getCachedVideos();
    logDebug('Got cached videos:', cachedVideos?.length || 0);
    
    // Define a reasonable cache freshness threshold - 2 minutes
    const CACHE_FRESHNESS_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
    
    // Get the cache timestamp if available
    let cacheTimestamp = 0;
    try {
        const storageData = await chrome.storage.local.get(['videosCacheTimestamp']);
        cacheTimestamp = storageData.videosCacheTimestamp || 0;
    } catch (e) {
        logDebug('Error getting cache timestamp:', e);
    }
    
    const cacheAge = Date.now() - cacheTimestamp;
    const isCacheFresh = cacheAge < CACHE_FRESHNESS_THRESHOLD_MS;
    logDebug('Cache age:', cacheAge, 'ms, is fresh:', isCacheFresh);
    
    if (!forceRefresh && cachedVideos && isCacheFresh) {
        // Apply additional validation to cached videos
        const filteredCachedVideos = validateAndFilterVideos(cachedVideos);
        logDebug('Using fresh cached videos:', filteredCachedVideos.length);
        
        renderVideos(filteredCachedVideos);
        
        // Update cache if filtering removed videos
        if (filteredCachedVideos.length !== cachedVideos.length) {
            setCachedVideos(filteredCachedVideos);
        }
        
        return filteredCachedVideos;
    }
    
    // If cache exists but is stale, render it first while we fetch fresh data
    if (!forceRefresh && cachedVideos) {
        logDebug('Using stale cached videos while refreshing');
        renderVideos(validateAndFilterVideos(cachedVideos));
    } 
    // Only show loader if there are no videos currently displayed
    else if (!cachedVideos) {
        showLoader(container);
    }
    
    try {
        // Get current tab if tab ID not provided
        if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab.id;
        }
        logDebug('Current tab:', tabId);
        
        const videos = [];
        let contentScriptError = null;
        let backgroundScriptError = null;
        
        // Set a timeout for video searching
        const searchTimeout = setTimeout(() => {
            if (container.querySelector('.initial-loader')) {
                container.innerHTML = `
                    <div class="initial-message">
                        Search is taking too long. Try refreshing the page or extension.
                    </div>
                `;
            }
        }, 10000);

        // Get videos from content script
        try {
            logDebug('Requesting videos from content script');
            const response = await chrome.tabs.sendMessage(tabId, { action: 'findVideos' });
            if (response && response.length) {
                logDebug('Got videos from content script:', response.length);
                // Add additional filtering here before merging
                const filteredResponse = validateAndFilterVideos(response);
                logDebug('After filtering content script videos:', filteredResponse.length);
                videos.push(...filteredResponse);
            }
        } catch (error) {
            logDebug('Content script error:', error);
            contentScriptError = error;
        }

        // Get videos from background script
        try {
            logDebug('Requesting videos from background script');
            const backgroundVideos = await chrome.runtime.sendMessage({ 
                action: 'getVideos', 
                tabId: tabId 
            });
            
            if (backgroundVideos && backgroundVideos.length) {
                logDebug('Got videos from background script:', backgroundVideos.length);
                // Apply filtering to background videos before merging
                const filteredBackgroundVideos = validateAndFilterVideos(backgroundVideos);
                logDebug('After filtering background videos:', filteredBackgroundVideos.length);
                mergeVideos(videos, filteredBackgroundVideos);
            }
        } catch (error) {
            logDebug('Background script error:', error);
            backgroundScriptError = error;
        }

        clearTimeout(searchTimeout);
        
        logDebug('Total videos after merge and filtering:', videos.length);
        
        // No videos found after filtering
        if (videos.length === 0) {
            // If we have cached videos, keep showing those instead of an error message
            if (cachedVideos && cachedVideos.length > 0) {
                logDebug('No new videos found, keeping cached videos');
                return cachedVideos;
            }
            
            logDebug('No valid videos found after filtering');
            // Use the dedicated no videos message function instead of setting HTML directly
            // This ensures proper theming and icon display
            const { showNoVideosMessage } = await import('./ui.js');
            showNoVideosMessage();
            return [];
        }
        
        // Process all videos first to establish relationships
        const processedVideos = [];
        for (const video of videos) {
            const processed = await processHLSRelationships(video, tabId);
            if (processed) {
                processedVideos.push(processed);
            }
        }
        
        logDebug('Videos after processing:', processedVideos.length);

        // Small delay to allow any late-arriving masters to be processed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Group and cache the videos
        const groupedVideos = processVideos(processedVideos);
        logDebug('Videos after grouping:', groupedVideos.length);
        
        // Store current timestamp with the cache
        try {
            await chrome.storage.local.set({ 'videosCacheTimestamp': Date.now() });
        } catch (e) {
            logDebug('Error setting cache timestamp:', e);
        }
        
        setCachedVideos(groupedVideos);
        
        // Render and start fetching details
        renderVideos(groupedVideos);
        
        // Only fetch video info for videos that need it
        const videosNeedingInfo = processedVideos.filter(video => {
            // Check if we already have media info in the cache
            const cachedMediaInfo = getMediaInfoFromCache(video.url);
            return !cachedMediaInfo;
        });
        
        if (videosNeedingInfo.length > 0) {
            logDebug('Fetching media info for', videosNeedingInfo.length, 'videos');
            fetchVideoInfo(videosNeedingInfo, tabId);
        }
        
        return groupedVideos;
        
    } catch (error) {
        logDebug('Failed to get videos:', error);
        if (!getCachedVideos()) {
            showErrorMessage(container, error.message);
        }
        return [];
    }
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
        return !video.mediaInfo;
    });
    
    if (videosNeedingInfo.length === 0) {
        logDebug('All videos already have mediaInfo, skipping fetch');
        return;
    }
    
    logDebug(`Fetching media info for ${videosNeedingInfo.length} videos without metadata`);
    
    Promise.all(videosNeedingInfo.map(async (video) => {
        try {
            // Check if we already have this video's media info in the cache
            const cachedMediaInfo = getMediaInfoFromCache(video.url);
            if (cachedMediaInfo) {
                // Use cached media info
                const updatedVideo = {
                    ...video,
                    mediaInfo: cachedMediaInfo
                };
                
                // Update UI with cached info
                updateVideoResolution(video.url, cachedMediaInfo);
                
                // Update video in cached videos
                const cachedVideos = getCachedVideos();
                if (cachedVideos) {
                    const index = cachedVideos.findIndex(v => v.url === video.url);
                    if (index !== -1) {
                        cachedVideos[index] = updatedVideo;
                        setCachedVideos(cachedVideos);
                    }
                }
                return;
            }

            // No cached info, fetch from native host
            logDebug('Fetching info for:', video.url);
            const response = await chrome.runtime.sendMessage({
                type: 'getHLSQualities',
                url: video.url,
                tabId: tabId
            });

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
                mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
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
            codecInfo.textContent = details.join(' • ');
        }
    }
}

/**
 * Get stream resolution from background script
 * @param {string} url - Video URL
 * @param {string} type - Video type
 * @param {number} tabId - Tab ID
 * @returns {string} Resolution string
 */
export async function getStreamResolution(url, type, tabId = null) {
    // Check cache first
    if (hasResolutionCache(url)) {
        return getResolutionFromCache(url);
    }
    
    if (type === 'blob') {
        return 'Resolution unavailable for blob';
    }
    
    try {
        // Get current tab ID if not provided
        if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
        }
        
        const response = await chrome.runtime.sendMessage({
            type: 'getHLSQualities',
            url: url,
            tabId: tabId
        });
        
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
            // Just request videos from the background to trigger an update
            await chrome.runtime.sendMessage({
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