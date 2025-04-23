import { getCachedVideos, setCachedVideos, getScrollPosition, setScrollPosition, hasResolutionCache, getResolutionFromCache, addResolutionToCache } from './state.js';
import { showLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { groupVideos } from './video-processor.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, getFilenameFromUrl } from './utilities.js';

/**
 * Update the video list, either from cache or by fetching new videos
 * @param {boolean} forceRefresh - Whether to force refresh even if cached videos exist
 */
export async function updateVideoList(forceRefresh = false) {
    const container = document.getElementById('videos');
    
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
        }, 10000); // 10 second timeout
        
        // Get videos from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'findVideos' });
            if (response && response.length) {
                videos.push(...response);
            }
        } catch (error) {
            console.error('Content script error:', error);
            contentScriptError = error;
        }
        
        // Get videos from background script
        try {
            const backgroundVideos = await chrome.runtime.sendMessage({ 
                action: 'getVideos', 
                tabId: tab.id 
            });
            
            if (backgroundVideos && backgroundVideos.length) {
                // Merge with videos from content script, avoiding duplicates
                const existingUrls = new Set(videos.map(v => v.url));
                for (const video of backgroundVideos) {
                    if (!existingUrls.has(video.url)) {
                        videos.push(video);
                        existingUrls.add(video.url);
                    }
                }
            }
        } catch (error) {
            console.error('Background script error:', error);
            backgroundScriptError = error;
        }
        
        // Legacy support: Get HLS playlists from background script
        try {
            const playlists = await chrome.runtime.sendMessage({ 
                action: 'getStoredPlaylists', 
                tabId: tab.id 
            });
            
            if (playlists && playlists.length) {
                // Add HLS playlists that aren't already in the list
                const existingUrls = new Set(videos.map(v => v.url));
                for (const url of playlists) {
                    if (!existingUrls.has(url)) {
                        videos.push({ 
                            url, 
                            type: 'hls',
                            title: getFilenameFromUrl(url),
                            source: 'legacy' 
                        });
                        existingUrls.add(url);
                    }
                }
            }
        } catch (error) {
            console.error('Legacy HLS error:', error);
            // Not critical, so don't update backgroundScriptError
        }
        
        // Clear the timeout since we've completed the search
        clearTimeout(searchTimeout);
        
        if (videos.length === 0 && (contentScriptError || backgroundScriptError)) {
            let errorMessage = 'Failed to find videos. ';
            if (contentScriptError) errorMessage += 'Page scanning failed. ';
            if (backgroundScriptError) errorMessage += 'Video detection failed. ';
            throw new Error(errorMessage);
        }
        
        // Group videos immediately and render
        const groupedVideos = groupVideos(videos);
        setCachedVideos(groupedVideos);
        
        renderVideos(groupedVideos);
        
        // Start fetching resolution info in the background
        fetchVideoInfo(videos, tab.id);
        
    } catch (error) {
        console.error('Failed to get videos:', error);
        // Only show error if we don't have cached videos already rendered
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
    // Process videos in parallel batches to improve performance
    const batchSize = 5; // Process 5 videos at a time
    const batches = [];

    // Create batches of videos
    for (let i = 0; i < videos.length; i += batchSize) {
        batches.push(videos.slice(i, i + batchSize));
    }

    // Process each batch in parallel
    for (const batch of batches) {
        await Promise.all(batch.map(async (video) => {
            try {
                if (!video.resolution || !video.mediaInfo) {
                    console.log('Fetching info for:', video.url);
                    const response = await chrome.runtime.sendMessage({
                        type: 'getHLSQualities',
                        url: video.url,
                        tabId: tabId
                    });

                    if (response?.streamInfo) {
                        const streamInfo = response.streamInfo;
                        
                        // Update video object with full stream info
                        video.mediaInfo = {
                            hasVideo: streamInfo.hasVideo,
                            hasAudio: streamInfo.hasAudio,
                            videoCodec: streamInfo.videoCodec,
                            audioCodec: streamInfo.audioCodec,
                            format: streamInfo.format,
                            container: streamInfo.container,
                            duration: streamInfo.duration,
                            sizeBytes: streamInfo.sizeBytes
                        };
                        
                        video.resolution = {
                            width: streamInfo.width,
                            height: streamInfo.height,
                            fps: streamInfo.fps,
                            bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                        };

                        // Update UI
                        updateVideoResolution(video.url, streamInfo);
                        
                        // Update cached videos
                        if (getCachedVideos()) {
                            const cachedVideo = getCachedVideos().find(v => v.url === video.url);
                            if (cachedVideo) {
                                cachedVideo.resolution = video.resolution;
                                cachedVideo.mediaInfo = video.mediaInfo;
                                setCachedVideos(getCachedVideos());
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Error fetching info for video:', video.url, error);
            }
        }));
    }
}

/**
 * Update resolution display for a specific video
 * @param {string} url - Video URL
 * @param {Object} resolution - Resolution information
 */
export function updateVideoResolution(url, streamInfo) {
    const videoElement = document.querySelector(`.video-item[data-url="${url}"]`);
    if (videoElement) {
        const resolutionInfo = videoElement.querySelector('.resolution-info');
        if (resolutionInfo) {
            const resolution = {
                width: streamInfo.width,
                height: streamInfo.height,
                fps: streamInfo.fps,
                bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
            };
            
            // Update the resolution text with enhanced codec info
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
        
        // Update media type info if present
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
            
            // Update icon based on media type
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
        
        // Update format info if available
        if (streamInfo.container) {
            const formatInfo = videoElement.querySelector('.format-info');
            if (formatInfo) {
                formatInfo.textContent = streamInfo.container;
            }
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