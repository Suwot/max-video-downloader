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
                if (!video.resolution) {
                    console.log('Fetching resolution for:', video.url);
                    const resolution = await getStreamResolution(video.url, video.type, tabId);
                    console.log('Resolution result:', resolution);
                    
                    if (resolution !== 'Resolution unknown' && resolution !== 'Resolution unavailable for blob') {
                        // Parse resolution into width/height/fps
                        const match = resolution.match(/(\d+)x(\d+)(?:\s+\(.*?\))?(?:\s+@\s+(\d+)fps)?/);
                        if (match) {
                            video.resolution = {
                                width: parseInt(match[1]),
                                height: parseInt(match[2]),
                                fps: match[3] ? parseInt(match[3]) : null
                            };
                            
                            // Update the resolution display in UI
                            updateVideoResolution(video.url, video.resolution);
                            
                            // Update cached videos with new resolution
                            if (getCachedVideos()) {
                                const cachedVideo = getCachedVideos().find(v => v.url === video.url);
                                if (cachedVideo) {
                                    cachedVideo.resolution = video.resolution;
                                    setCachedVideos(getCachedVideos());
                                }
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
export function updateVideoResolution(url, resolution) {
    const videoElement = document.querySelector(`.video-item[data-url="${url}"]`);
    if (videoElement) {
        const resolutionInfo = videoElement.querySelector('.resolution-info');
        if (resolutionInfo) {
            console.log('Updating resolution for', url, resolution);
            const { width, height, fps, bitrate } = resolution;
            resolutionInfo.textContent = formatResolution(width, height, fps, bitrate);
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
            tabId: tabId // Pass tabId for caching
        });
        
        if (response && response.streamInfo) {
            const { width, height, fps, bitrate, hasVideo, hasAudio } = response.streamInfo;
            if (width && height) {
                const resolution = formatResolution(width, height, fps, bitrate);
                addResolutionToCache(url, resolution);
                
                // Update cached video with media type info
                if (getCachedVideos()) {
                    const cachedVideo = getCachedVideos().find(v => v.url === url);
                    if (cachedVideo) {
                        cachedVideo.resolution = { width, height, fps, bitrate };
                        cachedVideo.mediaInfo = { hasVideo, hasAudio };
                        setCachedVideos(getCachedVideos());
                        
                        // Immediately update the UI
                        updateVideoResolution(url, { width, height, fps, bitrate });
                    }
                }
                
                return resolution;
            }
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
    
    // Tell content script to start detecting
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { 
                action: 'startBackgroundDetection',
                enabled: true
            }).catch(err => console.log('Content script not ready yet'));
        }
    });
} 