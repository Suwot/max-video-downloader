/**
 * @ai-guide-component VideoFetcherWithStore
 * @ai-guide-description Updated video fetcher that works with the new VideoStore
 * @ai-guide-responsibilities
 * - Retrieves videos from new centralized video store
 * - Simplifies deduplication logic by leveraging the store
 * - Preserves compatibility with existing UI components
 * - Fetches and displays video metadata
 */

// Extend the existing video-fetcher.js to support our new VideoStore
// This modification demonstrates the new simpler architecture without replacing the entire file

// Imports from the original file
import {
    getCachedVideos,
    setCachedVideos,
    hasResolutionCache, 
    getResolutionFromCache,
    addResolutionToCache,
    getMediaInfoFromCache, 
    addMediaInfoToCache,
    addPosterToCache,
    getPosterFromCache,
} from './state.js';
import { showLoadingState as showLoader, hideLoadingState as hideLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, formatDuration } from './utilities.js';
import { sendPortMessage } from './index.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Store-Based Fetcher]', new Date().toISOString(), ...args);
}

/**
 * Fetch videos directly from the new video store
 * @param {number} tabId - Tab ID
 * @returns {Promise<Array>} Array of videos
 */
async function fetchVideosFromStore(tabId) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            { action: 'getVideosFromStore', tabId },
            (response) => {
                if (chrome.runtime.lastError) {
                    logDebug('Error fetching videos from store:', chrome.runtime.lastError);
                    reject(chrome.runtime.lastError);
                    return;
                }
                
                if (response && response.videos) {
                    logDebug(`Received ${response.videos.length} videos from store`);
                    resolve(response.videos);
                } else {
                    logDebug('No videos received from store');
                    resolve([]);
                }
            }
        );
    });
}

/**
 * Update video list using the new video store
 * @param {boolean} forceRefresh - Whether to force a refresh
 * @param {number} tabId - Tab ID
 * @returns {Promise<Array>} Array of videos
 */
export async function updateVideoListFromStore(forceRefresh = false, tabId = null) {
    logDebug('Updating videos from store, force refresh:', forceRefresh);
    
    // Only show loader if this isn't a background refresh
    if (forceRefresh) {
        showLoader('Loading videos...');
    }
    
    try {
        // Get current tab if not provided
        if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab.id;
            logDebug('Using tab ID:', tabId);
        }
        
        // Get videos directly from our new store
        const videos = await fetchVideosFromStore(tabId);
        
        if (videos && videos.length > 0) {
            // Cache the results - important: set cache BEFORE rendering to avoid stale data
            setCachedVideos(videos);
            
            // Show the videos - no additional filtering needed
            // All the filtering, deduplication, and grouping already happens in the background video store
            renderVideos(videos);
        } else {
            // No videos found, render empty state
            renderVideos([]);
        }
        
        if (forceRefresh) {
            hideLoader();
            restoreScrollPosition();
        }
        return videos;
    } catch (error) {
        logDebug('Error updating videos from store:', error);
        if (forceRefresh) {
            hideLoader();
            showErrorMessage('Failed to load videos', error);
        }
        return [];
    }
}

/**
 * Fetch metadata for videos from new store
 * @param {Array} videos - Array of videos
 * @param {number} tabId - Tab ID
 */
async function fetchVideoInfoForNewStore(videos, tabId) {
    // Process videos with missing mediaInfo in parallel
    const videosNeedingInfo = videos.filter(video => {
        // Skip blob URLs
        if (video.url.startsWith('blob:')) return false;
        
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
            console.error('Error fetching info for video:', video.url, error);
        }
    })).catch(error => {
        console.error('Error in parallel video info fetching:', error);
    });
}

/**
 * Update resolution display for a specific video - copied from original
 * @param {string} url - Video URL
 * @param {Object} streamInfo - Stream information
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
 * Start a video update listener for the store
 * @param {number} tabId - Current tab ID
 */
export function startStoreUpdateListener(tabId = null) {
    logDebug('Starting video update listener');
    
    // The old interval-based approach is removed
    // Instead, we'll listen for messages from the background service
    
    if (!tabId) {
        // Get the tab ID if not provided
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id) {
                const currentTabId = tabs[0].id;
                logDebug(`Setting up listener for tab ${currentTabId}`);
                
                // Let the background know the popup is open for this tab
                chrome.runtime.sendMessage({
                    action: 'popupOpened',
                    tabId: currentTabId
                });
            }
        });
    } else {
        // Let the background know the popup is open for this tab
        chrome.runtime.sendMessage({
            action: 'popupOpened',
            tabId: tabId
        });
    }
    
    return true;
}

// Export functions from this enhanced fetcher
export {
    fetchVideosFromStore,
    updateVideoListFromStore as updateVideoList
};