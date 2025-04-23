import { getCachedVideos, setCachedVideos, getScrollPosition, setScrollPosition, hasResolutionCache, getResolutionFromCache, addResolutionToCache } from './state.js';
import { showLoader, showErrorMessage, restoreScrollPosition } from './ui.js';
import { groupVideos } from './video-processor.js';
import { renderVideos } from './video-renderer.js';
import { formatResolution, getFilenameFromUrl } from './utilities.js';
import { getMediaInfo, initializeNativeConnection } from './native-connection.js';
import nativeConnection from './native-connection.js';

// Initialize native connection early
initializeNativeConnection().catch(err => console.warn('Initial native connection failed:', err));

/**
 * Check if the content script is ready
 * @param {number} tabId - Tab ID to check
 * @returns {Promise<boolean>} True if content script is ready
 */
async function isContentScriptReady(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Try to inject the content script if not already injected
 * @param {number} tabId - Tab ID to inject into
 * @returns {Promise<boolean>} True if successful
 */
async function injectContentScriptIfNeeded(tabId) {
    try {
        // Check if we can already communicate with the content script
        if (await isContentScriptReady(tabId)) {
            return true;
        }
        
        // Try to inject the content script
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content_script.js"]
        });
        
        // Wait a moment for the script to initialize
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check if it's now ready
        return await isContentScriptReady(tabId);
    } catch (error) {
        console.warn('Failed to inject content script:', error);
        return false;
    }
}

/**
 * Get videos from content script with retry
 * @param {number} tabId - Tab ID
 * @param {number} retries - Number of retries
 * @returns {Promise<Array>} Videos found
 */
async function getVideosFromContentScript(tabId, retries = 2) {
    try {
        // Try to make sure content script is ready
        const isReady = await injectContentScriptIfNeeded(tabId);
        if (!isReady && retries <= 0) {
            throw new Error('Content script not ready');
        }
        
        // Send the message to find videos
        const response = await chrome.tabs.sendMessage(tabId, { action: 'findVideos' });
        return response && response.length ? response : [];
    } catch (error) {
        if (retries > 0) {
            // Wait a bit and retry
            await new Promise(resolve => setTimeout(resolve, 500));
            return getVideosFromContentScript(tabId, retries - 1);
        }
        throw error;
    }
}

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
        console.log('Using cached videos:', getCachedVideos());
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
        console.log('Current tab ID:', tab.id);
        
        const videos = [];
        let contentScriptError = null;
        let backgroundScriptError = null;
        let timeoutOccurred = false;
        
        // Set a timeout for video searching, but don't immediately clear the UI
        const searchTimeout = setTimeout(() => {
            timeoutOccurred = true;
            console.log('Search timeout reached - continuing with any videos found so far');
            
            // If we have some videos already, don't show the error
            if (videos.length > 0) {
                // Process the videos we have so far
                const groupedVideos = groupVideos(videos);
                setCachedVideos(groupedVideos);
                renderVideos(groupedVideos);
                
                // Start fetching resolution info in the background
                fetchVideoInfo(videos, tab.id);
            } else if (container.querySelector('.initial-loader')) {
                // Only show timeout message if we have no videos and still showing the loader
                container.innerHTML = `
                    <div class="initial-message">
                        Search is taking too long. Try refreshing the page or extension.
                    </div>
                `;
            }
        }, 5000);
        
        // Run video gathering in parallel
        const results = await Promise.allSettled([
            // Get videos from content script
            (async () => {
                try {
                    console.log('Getting videos from content script');
                    const contentVideos = await getVideosFromContentScript(tab.id);
                    console.log('Content script returned videos:', contentVideos.length);
                    
                    // Add these videos regardless of timeout
                    if (contentVideos.length > 0) {
                        videos.push(...contentVideos);
                        console.log(`Added ${contentVideos.length} videos from content script`);
                        
                        // Process content videos immediately for better UX
                        const groupedVideos = groupVideos([...videos]);
                        setCachedVideos(groupedVideos);
                        renderVideos(groupedVideos);
                    }
                    return contentVideos;
                } catch (error) {
                    console.error('Content script error:', error);
                    contentScriptError = error;
                    return [];
                }
            })(),
            
            // Get videos from background script
            (async () => {
                try {
                    console.log('Getting videos from background script');
                    const backgroundVideos = await chrome.runtime.sendMessage({ 
                        action: 'getVideos', 
                        tabId: tab.id 
                    });
                    
                    console.log('Background script returned videos:', backgroundVideos?.length);
                    
                    if (backgroundVideos && backgroundVideos.length) {
                        // Merge with videos from content script, avoiding duplicates
                        const existingUrls = new Set(videos.map(v => v.url));
                        const newVideos = [];
                        
                        for (const video of backgroundVideos) {
                            if (!existingUrls.has(video.url)) {
                                videos.push(video);
                                newVideos.push(video);
                                existingUrls.add(video.url);
                                console.log('Added video from background:', video.type, video.url.substring(0, 50));
                            }
                        }
                        
                        // Process immediately if we found new videos
                        if (newVideos.length > 0) {
                            const groupedVideos = groupVideos([...videos]);
                            setCachedVideos(groupedVideos);
                            renderVideos(groupedVideos);
                        }
                    }
                    return backgroundVideos || [];
                } catch (error) {
                    console.error('Background script error:', error);
                    backgroundScriptError = error;
                    return [];
                }
            })(),
            
            // Get HLS playlists for backward compatibility
            (async () => {
                try {
                    console.log('Getting HLS playlists');
                    const playlists = await chrome.runtime.sendMessage({ 
                        action: 'getStoredPlaylists', 
                        tabId: tab.id 
                    });
                    
                    console.log('HLS playlists returned:', playlists?.length);
                    
                    if (playlists && playlists.length) {
                        // Add HLS playlists that aren't already in the list
                        const existingUrls = new Set(videos.map(v => v.url));
                        const newHlsVideos = [];
                        
                        for (const url of playlists) {
                            if (!existingUrls.has(url)) {
                                const videoObj = { 
                                    url, 
                                    type: 'hls',
                                    title: getFilenameFromUrl(url),
                                    source: 'legacy' 
                                };
                                videos.push(videoObj);
                                newHlsVideos.push(videoObj);
                                existingUrls.add(url);
                                console.log('Added hls video:', url.substring(0, 50));
                            }
                        }
                        
                        // Process immediately if we found HLS videos
                        if (newHlsVideos.length > 0) {
                            const groupedVideos = groupVideos([...videos]);
                            setCachedVideos(groupedVideos);
                            renderVideos(groupedVideos);
                        }
                    }
                    return playlists || [];
                } catch (error) {
                    console.error('Legacy HLS error:', error);
                    return [];
                }
            })()
        ]);
        
        // If we didn't timeout, clear the timeout now
        if (!timeoutOccurred) {
            clearTimeout(searchTimeout);
        }
        
        console.log('Total videos found:', videos.length);
        
        // Always show the videos we found, even after timeout
        if (videos.length > 0) {
            // Group videos and render
            const groupedVideos = groupVideos(videos);
            setCachedVideos(groupedVideos);
            
            console.log('Rendering videos, grouped by type:', Object.keys(groupedVideos).map(key => `${key}: ${groupedVideos[key]?.length || 0}`));
            renderVideos(groupedVideos);
            
            // Start fetching resolution info in the background
            fetchVideoInfo(videos, tab.id);
        } else if (!timeoutOccurred || (timeoutOccurred && container.querySelector('.initial-loader'))) {
            // Show error message if we couldn't find any videos
            let errorMessage = 'No videos found. ';
            if (contentScriptError) errorMessage += 'Page scanning failed. ';
            if (backgroundScriptError) errorMessage += 'Video detection failed. ';
            
            // Only show error if we're still showing the loader
            if (container.querySelector('.initial-loader')) {
                showErrorMessage(container, errorMessage);
            }
        }
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
                    
                    // Try to get enriched media info from native host first
                    const mediaInfo = await getMediaInfo(video.url, video.type);
                    
                    if (mediaInfo) {
                        // Use the enriched media information from FFprobe
                        console.log('Got enriched media info:', mediaInfo);
                        
                        // Extract resolution, codec, and other info
                        video.resolution = {
                            width: mediaInfo.width || 0,
                            height: mediaInfo.height || 0,
                            fps: mediaInfo.fps || null,
                            bitrate: mediaInfo.bitrate || null
                        };
                        
                        // Add additional media info
                        video.mediaInfo = {
                            hasVideo: mediaInfo.hasVideo,
                            hasAudio: mediaInfo.hasAudio,
                            videoCodec: mediaInfo.videoCodec,
                            audioCodec: mediaInfo.audioCodec,
                            duration: mediaInfo.duration,
                            fileSize: mediaInfo.fileSize
                        };
                        
                        // Format filesize for display
                        if (mediaInfo.fileSize) {
                            video.mediaInfo.formattedSize = formatFileSize(mediaInfo.fileSize);
                        }
                        
                        // Update the resolution display in UI
                        updateVideoMetadata(video.url, video);
                        
                        // Update cached videos with new info
                        if (getCachedVideos()) {
                            const cachedVideo = getCachedVideos().find(v => v.url === video.url);
                            if (cachedVideo) {
                                cachedVideo.resolution = video.resolution;
                                cachedVideo.mediaInfo = video.mediaInfo;
                                setCachedVideos(getCachedVideos());
                            }
                        }
                    } else {
                        // Fallback to the legacy method if native host fails
                        const resolution = await getStreamResolution(video.url, video.type, tabId);
                        console.log('Resolution result (legacy):', resolution);
                        
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
                }
            } catch (error) {
                console.error('Error fetching info for video:', video.url, error);
            }
        }));
    }
}

/**
 * Format file size for display
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown size';
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Update video resolution display for a specific video
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
 * Update full metadata display for a video
 * @param {string} url - Video URL
 * @param {Object} video - Video with metadata
 */
export function updateVideoMetadata(url, video) {
    const videoElement = document.querySelector(`.video-item[data-url="${url}"]`);
    if (!videoElement) return;
    
    // Update resolution info
    const resolutionInfo = videoElement.querySelector('.resolution-info');
    if (resolutionInfo && video.resolution) {
        const { width, height, fps, bitrate } = video.resolution;
        resolutionInfo.textContent = formatResolution(width, height, fps, bitrate);
    }
    
    // Update media type info (audio/video)
    if (video.mediaInfo) {
        const mediaTypeInfo = videoElement.querySelector('.media-type-info span');
        if (mediaTypeInfo) {
            if (!video.mediaInfo.hasVideo && video.mediaInfo.hasAudio) {
                mediaTypeInfo.textContent = "Audio Only";
            } else if (video.mediaInfo.hasVideo && !video.mediaInfo.hasAudio) {
                mediaTypeInfo.textContent = "Video Only";
            } else {
                mediaTypeInfo.textContent = "Video & Audio";
            }
        }
        
        // Create or update codec info
        const fileInfo = videoElement.querySelector('.file-info');
        if (fileInfo) {
            // Look for existing codec container or create one
            let codecContainer = videoElement.querySelector('.codec-container');
            if (!codecContainer) {
                codecContainer = document.createElement('div');
                codecContainer.className = 'codec-container';
                fileInfo.appendChild(codecContainer);
            }
            
            // Format codec string
            let codecInfo = '';
            if (video.mediaInfo.videoCodec) {
                codecInfo += `Video: ${video.mediaInfo.videoCodec}`;
            }
            if (video.mediaInfo.audioCodec) {
                if (codecInfo) codecInfo += ' • ';
                codecInfo += `Audio: ${video.mediaInfo.audioCodec}`;
            }
            
            codecContainer.textContent = codecInfo;
            
            // Add file size and duration info
            let detailsContainer = videoElement.querySelector('.details-container');
            if (!detailsContainer) {
                detailsContainer = document.createElement('div');
                detailsContainer.className = 'details-container';
                fileInfo.appendChild(detailsContainer);
            }
            
            let detailsContent = '';
            
            if (video.mediaInfo.formattedSize) {
                detailsContent += video.mediaInfo.formattedSize;
            }
            
            if (video.mediaInfo.duration) {
                if (detailsContent) detailsContent += ' • ';
                const minutes = Math.floor(video.mediaInfo.duration / 60);
                const seconds = Math.floor(video.mediaInfo.duration % 60);
                detailsContent += `${minutes}:${seconds.toString().padStart(2, '0')}`;
            }
            
            if (detailsContent) {
                detailsContainer.textContent = detailsContent;
            }
        }
    }
}

/**
 * Get stream resolution for a video
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
        
        // Use native connection to get video qualities
        const response = await nativeConnection.sendMessage({
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
export async function setupAutoDetection() {
    // Listen for messages from background script about new videos
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'newVideoDetected') {
            // Always update when new videos detected
            updateVideoList(true);
            sendResponse({ received: true });
        }
        return true;
    });
    
    // Tell content script to start detecting with error handling
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            // First check if content script is ready
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
                // If we get here, content script is ready, so send the command
                chrome.tabs.sendMessage(tab.id, { 
                    action: 'startBackgroundDetection',
                    enabled: true
                }).catch(err => console.warn('Error enabling detection:', err));
            } catch (err) {
                console.warn('Content script not ready, will retry once');
                // Wait a bit and try one more time
                setTimeout(() => {
                    chrome.tabs.sendMessage(tab.id, { 
                        action: 'startBackgroundDetection',
                        enabled: true
                    }).catch(err => console.warn('Content script still not ready'));
                }, 2000);
            }
        }
    } catch (err) {
        console.warn('Error setting up auto detection:', err);
    }
} 