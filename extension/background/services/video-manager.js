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

// Simple in-memory storage: Map<tabId, Array<VideoEntry>>
const videosPerTab = new Map();
// Track playlists per tab
const playlistsPerTab = new Map();

// Track manifest relationships
const manifestRelationships = new Map();

// Track preview generation to avoid duplicate requests
const previewGenerationQueue = new Map();
// Track metadata processing
const metadataProcessingQueue = new Map();

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
    
    // Apply our variant filtering to reduce redundant quality options
    const filteredVideos = filterRedundantVariants(validatedVideos, {
        removeNeighboringQualities: true,
        qualityThreshold: 15 // 15% difference threshold
    });
    
    // Add a processing timestamp for version tracking
    const processingTimestamp = Date.now();

    // Build final list with enhanced information for display
    const processedVideos = filteredVideos.map(video => {
        // Add additional information needed for immediate display
        return {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || processingTimestamp,
            processed: true,
            lastProcessedAt: processingTimestamp,
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
    } else {
        // Add new video
        videoInfo.timestamp = Date.now();
        if (!videoInfo.detectionTimestamp) {
            videoInfo.detectionTimestamp = new Date().toISOString();
        }
        
        tabVideos.push(videoInfo);
        
        // Notify any open popup about the new video
        notifyNewVideoDetected(tabId);
    }
    
    // For HLS/DASH playlists, process to detect master-variant relationships
    const video = existingIndex !== -1 ? tabVideos[existingIndex] : videoInfo;
    if ((video.type === 'hls' || video.type === 'dash') && 
        !video.isVariant && !video.qualityVariants && !video.variants) {
        processPlaylistRelationships(video, tabId);
    }
    
    // For HLS playlists, add to playlistsPerTab collection if it's not a variant
    if (videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8') && !videoInfo.isVariant) {
        if (!playlistsPerTab.has(tabId)) {
            playlistsPerTab.set(tabId, new Set());
        }
        playlistsPerTab.get(tabId).add(normalizedUrl);
    }
    
    // Add to metadata processing queue if not already processed
    if (!video.mediaInfo && !video.streamInfo && !metadataProcessingQueue.has(normalizedUrl)) {
        metadataProcessingQueue.set(normalizedUrl, {
            url: video.url,
            tabId,
            timestamp: Date.now()
        });
        processMetadataQueue();
    }
    
    // Generate preview if needed - but don't if we already have more than 3 pending
    if (!video.previewUrl && !video.poster && rateLimiter.activeRequests + rateLimiter.queue.length < 5) {
        generatePreview(video.url, tabId).catch(error => {
            console.error('Error generating preview:', error);
        });
    }
    
    // Broadcast update
    broadcastVideoUpdate(tabId);
}

// Generate preview for a video
async function generatePreview(url, tabId) {
    // Check if we're already generating this preview
    const cacheKey = url;
    if (previewGenerationQueue.has(cacheKey)) {
        // If we are, wait for the existing promise
        return await previewGenerationQueue.get(cacheKey);
    }

    // Create new preview generation promise with rate limiting
    const previewPromise = rateLimiter.enqueue(async () => {
        try {
            logDebug(`Generating preview for ${url}`);
            const response = await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: url
            });
            
            // If we successfully generated a preview, cache it with the video
            if (response && response.previewUrl && videosPerTab.has(tabId)) {
                const normalizedUrl = normalizeUrl(url);
                const videos = videosPerTab.get(tabId);
                const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
                if (index !== -1) {
                    videos[index].previewUrl = response.previewUrl;
                    
                    // Notify any open popup about the new preview
                    notifyPreviewReady(tabId, normalizedUrl, response.previewUrl, videos[index]);
                }
            }
            
            return response;
        } catch (error) {
            console.error(`Error generating preview for ${url}:`, error);
            return { error: error.message };
        } finally {
            // Always remove from queue when done, regardless of success/failure
            setTimeout(() => {
                previewGenerationQueue.delete(cacheKey);
            }, 200);
        }
    });

    // Store the promise
    previewGenerationQueue.set(cacheKey, previewPromise);
    
    // Return the promise
    return previewPromise;
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

// Get playlists for tab
function getPlaylistsForTab(tabId) {
    if (!playlistsPerTab.has(tabId)) {
        return [];
    }
    
    return Array.from(playlistsPerTab.get(tabId));
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

// Store manifest relationship
function storeManifestRelationship(playlistUrl, variants) {
    variants.forEach(variant => {
        manifestRelationships.set(variant.url, {
            playlistUrl: playlistUrl,
            bandwidth: variant.bandwidth,
            resolution: variant.resolution,
            codecs: variant.codecs,
            fps: variant.fps
        });
    });
    return true;
}

// Get manifest relationship
function getManifestRelationship(variantUrl) {
    return manifestRelationships.get(variantUrl) || null;
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

// Helper function to extract stream metadata
async function getStreamMetadata(url) {
    try {
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

// Process metadata queue to get stream info for videos
async function processMetadataQueue(maxRetries = 2) {
    // If no items in the queue, nothing to do
    if (metadataProcessingQueue.size === 0) return;
    
    // Process a limited number of items at once
    const entries = Array.from(metadataProcessingQueue.entries()).slice(0, 3);
    logDebug(`Processing ${entries.length} metadata items`);
    
    for (const [url, info] of entries) {
        // Remove from queue immediately to prevent duplicate processing
        metadataProcessingQueue.delete(url);
        
        try {
            // Use our rate-limited getStreamMetadata function
            const streamInfo = await getStreamMetadata(info.url);
            
            // If we got stream info, update the video
            if (streamInfo && info.tabId && videosPerTab.has(info.tabId)) {
                const normalizedUrl = normalizeUrl(info.url);
                const videos = videosPerTab.get(info.tabId);
                const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
                
                if (index !== -1) {
                    // Update video with stream info
                    videos[index] = {
                        ...videos[index],
                        streamInfo,
                        mediaInfo: streamInfo, // Add direct mediaInfo reference
                        resolution: {
                            width: streamInfo.width,
                            height: streamInfo.height,
                            fps: streamInfo.fps,
                            bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                        }
                    };
                    
                    // Notify any open popup about the metadata update
                    notifyMetadataUpdate(info.tabId, info.url, streamInfo);
                }
            }
        } catch (error) {
            console.error(`Failed to process metadata for ${url}:`, error);
            
            // Only requeue if not too many retries
            if (!info.retryCount || info.retryCount < maxRetries) {
                // Put back in queue with incremented retry count
                setTimeout(() => {
                    metadataProcessingQueue.set(url, {
                        ...info,
                        retryCount: (info.retryCount || 0) + 1
                    });
                    // Try processing the queue again after a delay
                    processMetadataQueue(maxRetries);
                }, 1000);
            }
        }
    }
    
    // If there are more items, schedule processing the next batch
    if (metadataProcessingQueue.size > 0) {
        setTimeout(() => processMetadataQueue(maxRetries), 500);
    }
}

// Process HLS/DASH playlists to detect master-variant relationships
async function processPlaylistRelationships(videoInfo, tabId) {
    try {
        // Use the manifest service to process the video
        const processedVideo = await processVideoRelationships(videoInfo);
        
        if (processedVideo && processedVideo !== videoInfo) {
            // Update video with new information
            const normalizedUrl = normalizeUrl(videoInfo.url);
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

export {
    addVideoToTab,
    broadcastVideoUpdate,
    generatePreview,
    getStreamQualities,
    getVideosForTab,
    getPlaylistsForTab,
    cleanupForTab,
    normalizeUrl,
    fetchManifestContent,
    storeManifestRelationship,
    getManifestRelationship,
    getStreamMetadata
};