/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import { normalizeUrl, getBaseDirectory } from '../../js/utilities/normalize-url.js';
import nativeHostService from '../../js/native-host-service.js';
import { validateAndFilterVideos, filterRedundantVariants } from '../../js/utilities/video-validator.js';
import { processVideoRelationships } from '../../js/manifest-service.js';
import { getActivePopupPortForTab } from './popup-ports.js';

// The primary data structure: Map<tabId, Array<VideoEntry>>
// Each VideoEntry now contains all necessary information including metadata, preview, etc.
const videosPerTab = new Map();

// Temporary processing trackers (not for storage)
const processingRequests = {
  previews: new Set(), // Track URLs currently being processed for previews
  metadata: new Set()  // Track URLs currently being processed for metadata
};

// Rate limiter for API requests
const rateLimiter = {
  activeRequests: 0,
  maxConcurrent: 2, // Maximum concurrent requests allowed
  queue: [], // Queue of pending requests
  lastRequestTime: 0,
  minDelayBetweenRequests: 500, // Minimum 500ms between requests
  
  // Add a request to the queue and process if possible
  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  },
  
  // Process the next item in the queue if rate limits allow
  async processQueue() {
    // If queue is empty or we're at max concurrent requests, stop
    if (this.queue.length === 0 || this.activeRequests >= this.maxConcurrent) {
      return;
    }
    
    // Calculate delay needed before next request
    const now = Date.now();
    const timeElapsed = now - this.lastRequestTime;
    const delayNeeded = Math.max(0, this.minDelayBetweenRequests - timeElapsed);
    
    // Wait if needed then process
    setTimeout(() => {
      // Check again if we can process (in case max concurrent changed)
      if (this.activeRequests >= this.maxConcurrent) {
        return;
      }
      
      // Get the next request
      const { fn, resolve, reject } = this.queue.shift();
      
      // Update state and tracking
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      
      // Execute the request
      fn()
        .then(result => {
          resolve(result);
          // After request completes, decrease count and check queue
          this.activeRequests--;
          this.processQueue();
        })
        .catch(error => {
          reject(error);
          // After request fails, decrease count and check queue
          this.activeRequests--;
          this.processQueue();
        });
    }, delayNeeded);
  }
};

// Debug logging helper
function logDebug(...args) {
    console.log('[Video Manager]', new Date().toISOString(), ...args);
}

// Extract filename from URL
function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        if (filename && filename.length > 0) {
            return filename;
        }
    } catch {}
    
    return 'video';
}

// Process videos for sending to popup - fully prepare videos for instant display
function processVideosForBroadcast(videos) {
    // First apply validation filter to remove unwanted videos
    const validatedVideos = validateAndFilterVideos ? validateAndFilterVideos(videos) : videos;
    
    // No separate video filtering, just prepare for display
    const processedVideos = validatedVideos.map(video => {
        // Add additional information needed for immediate display
        return {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || Date.now(),
            processed: true,
            lastProcessedAt: Date.now(),
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            poster: video.poster || video.previewUrl || null,
            downloadable: true,
            // Preserve source information or default to 'background'
            source: video.source || 'background',
            // Preserve the detection timestamp for debugging duplicates
            detectionTimestamp: video.detectionTimestamp || null,
            // Make sure quality variants are preserved
            qualityVariants: video.qualityVariants || video.variants || [],
            variants: video.variants || video.qualityVariants || [],
            isMasterPlaylist: video.isMasterPlaylist || false
        };
    });
    
    // Sort by newest first
    return processedVideos.sort((a, b) => b.timestamp - a.timestamp);
}

// Broadcast videos to popup
function broadcastVideoUpdate(tabId) {
    if (!videosPerTab.has(tabId) || videosPerTab.get(tabId).length === 0) {
        return [];
    }
    
    // Get videos for tab and process them
    const videos = videosPerTab.get(tabId);
    const processedVideos = processVideosForBroadcast(videos);
    
    // Send with chrome.runtime.sendMessage for compatibility
    try {
        chrome.runtime.sendMessage({
            action: 'videoStateUpdated',
            tabId: tabId,
            videos: processedVideos
        });
    } catch (e) {
        // Ignore errors for sendMessage, as the popup might not be open
        logDebug('Error sending video update message (popup may not be open):', e.message);
    }
    
    return processedVideos;
}

// Add video to tab's collection
function addVideoToTab(tabId, videoInfo) {
    // Create array for tab if it doesn't exist
    if (!videosPerTab.has(tabId)) {
        videosPerTab.set(tabId, []);
    }
    
    const tabVideos = videosPerTab.get(tabId);
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Check if video already exists
    const existingIndex = tabVideos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
    
    let video; // The video object to work with
    
    if (existingIndex !== -1) {
        // Update existing video
        tabVideos[existingIndex] = {
            ...tabVideos[existingIndex],
            ...videoInfo,
            timestamp: tabVideos[existingIndex].timestamp || Date.now(),
            // Preserve existing fields if new data doesn't have them
            poster: videoInfo.poster || tabVideos[existingIndex].poster,
            title: videoInfo.title || tabVideos[existingIndex].title,
            detectionTimestamp: tabVideos[existingIndex].detectionTimestamp || videoInfo.detectionTimestamp,
            // Preserve variants information
            qualityVariants: videoInfo.qualityVariants || tabVideos[existingIndex].qualityVariants,
            variants: videoInfo.variants || tabVideos[existingIndex].variants,
            isMasterPlaylist: videoInfo.isMasterPlaylist || tabVideos[existingIndex].isMasterPlaylist
        };
        video = tabVideos[existingIndex];
    } else {
        // Add new video
        video = {
            ...videoInfo,
            timestamp: Date.now(),
            detectionTimestamp: videoInfo.detectionTimestamp || new Date().toISOString(),
            // Important flags for tracking processing status
            isBeingProcessed: false,
            needsMetadata: true,
            needsPreview: !videoInfo.poster && !videoInfo.previewUrl
        };
        
        tabVideos.push(video);
        
        // Notify any open popup about the new video
        notifyNewVideoDetected(tabId);
    }
    
    // For HLS/DASH playlists, process to detect master-variant relationships
    if ((video.type === 'hls' || video.type === 'dash') && 
        !video.isVariant && !video.qualityVariants && !video.variants) {
        enrichWithPlaylistInfo(video, tabId);
    }
    
    // Enrich with metadata if needed
    if (!video.streamInfo && !video.mediaInfo && !processingRequests.metadata.has(normalizedUrl)) {
        enrichWithMetadata(video, tabId);
    }
    
    // Generate preview if needed
    if (!video.previewUrl && !video.poster && !processingRequests.previews.has(normalizedUrl)) {
        enrichWithPreview(video, tabId);
    }
    
    // Broadcast update
    broadcastVideoUpdate(tabId);
}

// Enrich video with playlist information (for HLS/DASH)
async function enrichWithPlaylistInfo(video, tabId) {
    try {
        // Use the manifest service to process the video
        const processedVideo = await processVideoRelationships(video);
        
        if (processedVideo && processedVideo !== video) {
            // Update video with new information
            const normalizedUrl = normalizeUrl(video.url);
            const videos = videosPerTab.get(tabId);
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            
            if (index !== -1) {
                // Update the video with new information
                videos[index] = {
                    ...videos[index],
                    ...processedVideo,
                    // Preserve original fields
                    timestamp: videos[index].timestamp,
                    detectionTimestamp: videos[index].detectionTimestamp 
                };
                
                // If this is a master playlist with variants, broadcast update 
                if (processedVideo.isMasterPlaylist && 
                    (processedVideo.variants || processedVideo.qualityVariants)) {
                    logDebug(`Found master playlist with ${(processedVideo.variants || processedVideo.qualityVariants).length} variants`);
                    broadcastVideoUpdate(tabId);
                }
            }
        }
    } catch (error) {
        console.error('Error processing playlist relationships:', error);
    }
}

// Enrich video with metadata
async function enrichWithMetadata(video, tabId) {
    const normalizedUrl = normalizeUrl(video.url);
    
    // Mark as being processed
    processingRequests.metadata.add(normalizedUrl);
    
    try {
        // Skip blob URLs as they can't be analyzed
        if (video.url.startsWith('blob:')) {
            // For blob URLs, set placeholder media info
            applyMetadataToVideo(tabId, normalizedUrl, {
                isBlob: true,
                type: 'blob',
                format: 'blob',
                container: 'blob',
                hasVideo: true,
                hasAudio: true
            });
            return;
        }
        
        // Use our rate limiter to prevent too many concurrent requests
        const streamInfo = await rateLimiter.enqueue(async () => {
            logDebug(`Getting stream metadata for ${video.url}`);
            
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: video.url
            });

            return response?.streamInfo || null;
        });
        
        if (streamInfo) {
            applyMetadataToVideo(tabId, normalizedUrl, streamInfo);
        }
    } catch (error) {
        console.error(`Failed to get metadata for ${video.url}:`, error);
    } finally {
        // Remove from processing set
        processingRequests.metadata.delete(normalizedUrl);
    }
}

// Apply metadata to a video and notify popup
function applyMetadataToVideo(tabId, normalizedUrl, streamInfo) {
    if (!videosPerTab.has(tabId)) return;
    
    const videos = videosPerTab.get(tabId);
    const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
    
    if (index !== -1) {
        // Update video with stream info
        videos[index] = {
            ...videos[index],
            streamInfo,
            mediaInfo: streamInfo, // Add direct mediaInfo reference
            needsMetadata: false,  // Mark as processed
            resolution: streamInfo.width && streamInfo.height ? {
                width: streamInfo.width,
                height: streamInfo.height,
                fps: streamInfo.fps,
                bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
            } : null
        };
        
        // Use the unified notification method instead
        notifyVideoUpdated(tabId, normalizedUrl, videos[index]);
    }
}

// Enrich video with preview image
async function enrichWithPreview(video, tabId) {
    const normalizedUrl = normalizeUrl(video.url);
    
    // Mark as being processed
    processingRequests.previews.add(normalizedUrl);
    
    try {
        // Use rate limiter to prevent too many concurrent requests
        const response = await rateLimiter.enqueue(async () => {
            logDebug(`Generating preview for ${video.url}`);
            return await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: video.url
            });
        });
        
        // If we successfully generated a preview, update the video
        if (response && response.previewUrl && videosPerTab.has(tabId)) {
            const videos = videosPerTab.get(tabId);
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            
            if (index !== -1) {
                // Update video with preview
                videos[index].previewUrl = response.previewUrl;
                videos[index].needsPreview = false;
                
                // Use the unified notification method instead
                notifyVideoUpdated(tabId, normalizedUrl, videos[index]);
            }
        }
    } catch (error) {
        console.error(`Error generating preview for ${video.url}:`, error);
    } finally {
        // Always remove from processing set when done
        processingRequests.previews.delete(normalizedUrl);
    }
}

/**
 * Notify any open popup about a video update (for any property)
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @param {Object} updatedVideo - The complete updated video object
 */
function notifyVideoUpdated(tabId, url, updatedVideo) {
    try {
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about video update for ${url}`);
            
            try {
                port.postMessage({
                    type: 'videoUpdated',
                    url: url,
                    video: updatedVideo
                });
            } catch (error) {
                logDebug(`Error sending video update: ${error.message}`);
            }
        } else {
            // No popup is open for this tab, which is normal
            logDebug(`No active popup for tab ${tabId}, update will be shown when popup opens`);
        }
    } catch (error) {
        logDebug(`Error in notifyVideoUpdated: ${error.message}`);
    }
}

/**
 * Notify any open popup about a newly generated preview
 */
function notifyPreviewReady(tabId, videoUrl, previewUrl, videoInfo) {
    try {
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about new preview for ${videoUrl}`);
            
            try {
                port.postMessage({
                    type: 'previewReady',
                    videoUrl: videoUrl,
                    previewUrl: previewUrl,
                    videoId: videoInfo.id || videoUrl
                });
            } catch (error) {
                logDebug(`Error sending preview notification: ${error.message}`);
            }
        }
    } catch (error) {
        logDebug(`Error in notifyPreviewReady: ${error.message}`);
    }
}

// Get stream qualities
async function getStreamQualities(url) {
    try {
        console.log('🎥 Requesting media info from native host for:', url);
        
        const response = await nativeHostService.sendMessage({
            type: 'getQualities',
            url: url
        });
        
        return response;
    } catch (error) {
        console.error('Error getting media info:', error);
        return { error: error.message };
    }
}

// Get videos for tab
function getVideosForTab(tabId) {
    if (!videosPerTab.has(tabId)) {
        return [];
    }
    
    return processVideosForBroadcast(videosPerTab.get(tabId));
}

// Get playlists for tab - compatibility function
function getPlaylistsForTab(tabId) {
    if (!videosPerTab.has(tabId)) {
        return [];
    }
    
    // Extract playlists from the videos array
    const videos = videosPerTab.get(tabId);
    const playlists = videos
        .filter(v => v.type === 'hls' && v.url.includes('.m3u8') && !v.isVariant)
        .map(v => normalizeUrl(v.url));
    
    return Array.from(new Set(playlists));
}

// Fetch manifest content
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.statusText}`);
        }
        const content = await response.text();
        return content;
    } catch (error) {
        console.error('Error fetching manifest:', error);
        if (error instanceof TypeError && error.message === 'Failed to fetch') {
            console.error('This might be due to CORS restrictions or the server being unavailable');
        }
        return null;
    }
}

// Store manifest relationship - for compatibility
function storeManifestRelationship(playlistUrl, variants) {
    // Find all videos that match this playlist
    for (const [tabId, videos] of videosPerTab.entries()) {
        const playlistIndex = videos.findIndex(v => normalizeUrl(v.url) === normalizeUrl(playlistUrl));
        
        if (playlistIndex !== -1) {
            // Update the video with variants
            videos[playlistIndex].variants = variants;
            videos[playlistIndex].qualityVariants = variants;
            videos[playlistIndex].isMasterPlaylist = true;
            
            // Also update any existing variants to point to their master
            for (const variant of variants) {
                const variantIndex = videos.findIndex(v => normalizeUrl(v.url) === normalizeUrl(variant.url));
                if (variantIndex !== -1) {
                    videos[variantIndex].isMasterPlaylist = false;
                    videos[variantIndex].isVariant = true;
                    videos[variantIndex].masterPlaylistUrl = playlistUrl;
                }
            }
            
            // Broadcast update
            broadcastVideoUpdate(tabId);
        }
    }
    
    return true;
}

// Get manifest relationship - for compatibility
function getManifestRelationship(variantUrl) {
    // Find the variant in our videos collection
    for (const videos of videosPerTab.values()) {
        for (const video of videos) {
            if (video.isVariant && normalizeUrl(video.url) === normalizeUrl(variantUrl)) {
                return {
                    playlistUrl: video.masterPlaylistUrl,
                    bandwidth: video.bandwidth,
                    resolution: video.resolution,
                    codecs: video.codecs,
                    fps: video.fps
                };
            }
            
            // Also check variants list
            if (video.variants) {
                const variant = video.variants.find(v => normalizeUrl(v.url) === normalizeUrl(variantUrl));
                if (variant) {
                    return {
                        playlistUrl: video.url,
                        bandwidth: variant.bandwidth,
                        resolution: variant.resolution,
                        codecs: variant.codecs,
                        fps: variant.fps
                    };
                }
            }
        }
    }
    
    return null;
}

// Clean up for tab
function cleanupForTab(tabId) {
    logDebug('Tab removed:', tabId);
    if (videosPerTab.has(tabId)) {
        logDebug('Cleaning up videos for tab:', tabId);
        videosPerTab.delete(tabId);
    }
}

/**
 * Notify any open popup that new videos have been detected
 */
function notifyNewVideoDetected(tabId) {
    try {
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about new video detection`);
            
            try {
                port.postMessage({
                    action: 'newVideoDetected',
                    tabId: tabId
                });
            } catch (error) {
                logDebug(`Error sending new video notification: ${error.message}`);
            }
        }
    } catch (error) {
        logDebug(`Error in notifyNewVideoDetected: ${error.message}`);
    }
}

// Set up event listeners to clear videos when tabs are closed or navigated
chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupForTab(tabId);
});

// Listen for page navigation to clear videos
chrome.webNavigation.onCommitted.addListener((details) => {
    // Only clear for main frame navigation (not iframes)
    if (details.frameId === 0) {
        cleanupForTab(details.tabId);
    }
});

/**
 * Notify any open popup about updated metadata for a video
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @param {Object} mediaInfo - Updated media information
 */
function notifyMetadataUpdate(tabId, url, mediaInfo) {
    try {
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about metadata update for ${url}`);
            
            try {
                port.postMessage({
                    type: 'metadataUpdate',
                    url: url,
                    mediaInfo: mediaInfo
                });
            } catch (error) {
                logDebug(`Error sending metadata update: ${error.message}`);
            }
        } else {
            // No popup is open for this tab, which is normal
            logDebug(`No active popup for tab ${tabId}, metadata update will be shown when popup opens`);
        }
    } catch (error) {
        logDebug(`Error in notifyMetadataUpdate: ${error.message}`);
    }
}

// Get stream metadata for a URL
async function getStreamMetadata(url) {
    try {
        // Check if we already have this video's metadata
        for (const videos of videosPerTab.values()) {
            const video = videos.find(v => normalizeUrl(v.url) === normalizeUrl(url));
            if (video && (video.streamInfo || video.mediaInfo)) {
                return video.streamInfo || video.mediaInfo;
            }
        }
        
        // Skip blob URLs as they can't be analyzed
        if (url.startsWith('blob:')) {
            logDebug(`Skipping metadata request for blob URL: ${url}`);
            return {
                isBlob: true,
                type: 'blob',
                format: 'blob',
                container: 'blob',
                hasVideo: true,
                hasAudio: true
            };
        }
        
        // Use our rate limiter to prevent too many concurrent requests
        return await rateLimiter.enqueue(async () => {
            logDebug(`Getting stream metadata for ${url}`);
            
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: url
            });

            if (response?.streamInfo) {
                return response.streamInfo;
            }
            return null;
        });
    } catch (error) {
        console.error('Failed to get stream metadata:', error);
        return null;
    }
}

/**
 * Clear all video caches for all tabs
 * This is used by the UI to force a complete refresh
 */
function clearVideoCache() {
    logDebug('Clearing all video caches');
    
    // Clear all videos for all tabs
    videosPerTab.clear();
    
    // Clear all processing trackers
    processingRequests.previews.clear();
    processingRequests.metadata.clear();
    
    // Reset rate limiter queues
    rateLimiter.queue = [];
    rateLimiter.activeRequests = 0;
    
    return true;
}

export {
    addVideoToTab,
    broadcastVideoUpdate,
    getStreamQualities,
    getVideosForTab,
    getPlaylistsForTab,
    cleanupForTab,
    normalizeUrl,
    fetchManifestContent,
    storeManifestRelationship,
    getManifestRelationship,
    getStreamMetadata,
    clearVideoCache
};