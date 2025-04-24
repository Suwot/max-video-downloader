import { getCachedVideos, setCachedVideos, getScrollPosition, setScrollPosition, hasResolutionCache, getResolutionFromCache, addResolutionToCache, getMediaInfoFromCache, addMediaInfoToCache } from './state.js';
import { showLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { groupVideos } from './video-processor.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, formatDuration, getFilenameFromUrl } from './utilities.js';
import { parseHLSManifest } from './manifest-parser.js';
import { processVideos, clearHLSRelationships } from './video-processor.js';

// Keep track of master playlists we've seen
const knownMasterPlaylists = new Map();

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
    if (video.type !== 'hls') return video;

    // First check if this URL is a known variant of a master playlist
    const masterPlaylist = Array.from(knownMasterPlaylists.values())
        .find(master => master.qualityVariants?.some(v => v.url === video.url));
    
    if (masterPlaylist) {
        // Skip this video as it will be handled by its master playlist
        return null;
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
        
        // Store in our known master playlists map
        knownMasterPlaylists.set(video.url, enhancedVideo);
        
        return enhancedVideo;
    }
    
    return video;
}

/**
 * Update the video list, either from cache or by fetching new videos
 * @param {boolean} forceRefresh - Whether to force refresh even if cached videos exist
 */
export async function updateVideoList(forceRefresh = false) {
    const container = document.getElementById('videos');
    
    // Clear relationships if forcing refresh
    if (forceRefresh) {
        clearHLSRelationships();
    }
    
    // Save current scroll position
    if (container.scrollTop) {
        setScrollPosition(container.scrollTop);
    }
    
    // Use cached videos if available and not forcing refresh
    if (!forceRefresh && getCachedVideos()) {
        renderVideos(getCachedVideos());
        return;
    }
    
    // Only show loader if there are no videos currently displayed
    if (!getCachedVideos()) {
        showLoader(container);
    }
    
    try {
        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
        
        // Collect all videos first
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'findVideos' });
            if (response && response.length) {
                videos.push(...response);
            }
        } catch (error) {
            console.error('Content script error:', error);
            contentScriptError = error;
        }
        
        try {
            const backgroundVideos = await chrome.runtime.sendMessage({ 
                action: 'getVideos', 
                tabId: tab.id 
            });
            
            if (backgroundVideos && backgroundVideos.length) {
                const existingUrls = new Set(videos.map(v => v.url));
                backgroundVideos.forEach(video => {
                    if (!existingUrls.has(video.url)) {
                        videos.push(video);
                        existingUrls.add(video.url);
                    }
                });
            }
        } catch (error) {
            console.error('Background script error:', error);
            backgroundScriptError = error;
        }
        
        // Clear timeout since we've completed the search
        clearTimeout(searchTimeout);
        
        if (videos.length === 0 && (contentScriptError || backgroundScriptError)) {
            let errorMessage = 'Failed to find videos. ';
            if (contentScriptError) errorMessage += 'Page scanning failed. ';
            if (backgroundScriptError) errorMessage += 'Video detection failed. ';
            throw new Error(errorMessage);
        }
        
        // Process all videos first to establish relationships
        const processedVideos = [];
        for (const video of videos) {
            const processed = await processHLSRelationships(video, tab.id);
            if (processed) {
                processedVideos.push(processed);
            }
        }

        // Small delay to allow any late-arriving masters to be processed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Use two-pass processing to properly handle relationships
        const groupedVideos = processVideos(processedVideos);
        setCachedVideos(groupedVideos);
        
        renderVideos(groupedVideos);
        
        // Start fetching resolution info in the background
        fetchVideoInfo(processedVideos, tab.id);
        
    } catch (error) {
        console.error('Failed to get videos:', error);
        if (!getCachedVideos() || container.querySelector('.initial-loader')) {
            showErrorMessage(container, error.message);
        }
    }
}

/**
 * Fetch resolution information for videos in the background
 * @param {Array} videos - Videos to fetch information for
 * @param {number} tabId - Tab ID
 */
export async function fetchVideoInfo(videos, tabId) {
    // Process all videos in parallel
    Promise.all(videos.map(async (video) => {
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
            console.log('Fetching info for:', video.url);
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
            console.error('Error fetching info for video:', video.url, error);
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
 * Sets up communication for automatic detection of new videos
 */
export function setupAutoDetection() {
    // Listen for messages from background script about new videos
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'newVideoDetected') {
            // Always update when new videos detected
            updateVideoList(true);
            sendResponse({ received: true });
        }
        return true;
    });
    
    // Try to connect to content script with retries
    function connectToContentScript(retries = 3) {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { 
                    action: 'startBackgroundDetection',
                    enabled: true
                }).then(response => {
                    console.log('Content script connected successfully');
                }).catch(err => {
                    console.log('Content script connection attempt failed:', err);
                    if (retries > 0) {
                        // Retry after a short delay
                        setTimeout(() => connectToContentScript(retries - 1), 500);
                    }
                });
            }
        });
    }
    
    connectToContentScript();
}