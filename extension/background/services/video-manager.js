/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 * 
 * VARIANT HANDLING APPROACH:
 * - Master playlists store their variants as nested objects within their `variants` array
 * - Variants from a master playlist are NOT added as standalone entries in the main collection
 * - Variants are only visible in the UI when viewing their parent master playlist
 * - When a variant needs metadata, we update it both as a standalone entity (if it exists)
 *   and within its master playlist
 */

// Add static imports at the top
import { normalizeUrl, getBaseDirectory } from '../../js/utilities/normalize-url.js';
import nativeHostService from '../../js/native-host-service.js';
import { validateAndFilterVideos } from '../../js/utilities/video-validator.js';
import { getActivePopupPortForTab } from './popup-ports.js';
import { lightParseContent, fullParseContent } from '../../js/utilities/simple-js-parser.js';

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Expose allDetectedVideos for debugging
globalThis.allDetectedVideosInternal = allDetectedVideos;

// Temporary processing trackers (not for storage)
const processingRequests = {
  previews: new Set(), // Track URLs currently being processed for previews
  metadata: new Set(),  // Track URLs currently being processed for metadata
  lightParsing: new Set(), // Track URLs currently being light parsed
  playlist: new Set() // Track URLs currently being processed for playlist info
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
      if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
        return;
      }
      
      // Get the next request
      const nextItem = this.queue.shift();
      if (!nextItem) {
        return; // Handle case where queue became empty
      }
      const { fn, resolve, reject } = nextItem;
      
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
    
    // Third pass: final preparation for display
    const processedVideos = videos.map(video => {
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
            // Preserve source information or default to null
            source: video.source || null,
            // Preserve the detection timestamp for debugging duplicates
            detectionTimestamp: video.detectionTimestamp || null,
            // Ensure variants are properly preserved
            variants: video.variants || [],
            // Preserve parsing state flags
            isLightParsed: video.isLightParsed || false,
            isFullyParsed: video.isFullyParsed || false,
            isMaster: video.isMaster || false,
            isVariant: video.isVariant || false,
            // File size information
            fileSize: video.fileSize || video.mediaInfo?.sizeBytes || video.mediaInfo?.estimatedSize || null
        };
    });
    
    // Sort by newest first
    return processedVideos.sort((a, b) => b.timestamp - a.timestamp);
}

// Broadcast videos to popup
function broadcastVideoUpdate(tabId) {
    // Use new array-from-map function instead of videosPerTab
    const processedVideos = getVideosArrayFromMap(tabId);
    
    if (processedVideos.length === 0) {
        return [];
    }
    
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

// Enrich video with metadata - only for direct videos
async function enrichWithMetadata(video, tabId) {
    const normalizedUrl = normalizeUrl(video.url);
    
    // Skip if already parsed or being processed
    if (video.isFullyParsed || processingRequests.metadata.has(normalizedUrl)) {
        return;
    }
    
    // Skip all non-direct videos
    if (video.isVariant || video.isMaster || video.url.startsWith('blob:')) {
        return;
    }
    
    // Mark as being processed
    processingRequests.metadata.add(normalizedUrl);
    
    try {
        // Get metadata only for direct videos
        logDebug(`Getting metadata for direct video: ${video.url}`);
        
        const streamInfo = await rateLimiter.enqueue(async () => {
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: video.url,
                light: false
            });
            return response?.streamInfo || null;
        });
        
        if (streamInfo && streamInfo.totalBitrate && video.duration) {
            streamInfo.estimatedSize = estimateFileSize(streamInfo.totalBitrate, video.duration);
        }
        
        if (streamInfo) {
            applyMetadataToVideo(tabId, normalizedUrl, streamInfo);
        }
    } catch (error) {
        console.error(`Failed to get metadata for ${video.url}:`, error);
    } finally {
        processingRequests.metadata.delete(normalizedUrl);
    }
}

// Apply metadata to a video and notify popup
function applyMetadataToVideo(tabId, normalizedUrl, mediaInfo) {
    if (!allDetectedVideos.has(tabId)) return;
    
    const tabMap = allDetectedVideos.get(tabId);
    
    if (tabMap && tabMap.has(normalizedUrl)) {
        const video = tabMap.get(normalizedUrl);
        
        // Special logging for variants
        if (video.isVariant) {
            logDebug(`Applying metadata to variant video: ${video.url}`);
            
            // If this is a variant with partial media info from its master,
            // ensure we merge all properties properly
            if (video.partialMediaInfo) {
                logDebug(`Merging partial variant info with full metadata`);
                // Combine the full media info with any partial info we've already gathered
                mediaInfo = {
                    ...video.partialMediaInfo,
                    ...mediaInfo,
                };
            }
        }
        
        // Create a merged mediaInfo object with proper priority
        const mergedMediaInfo = {
            // Start with any existing mediaInfo
            ...(video.mediaInfo || {}),
            // Then apply new mediaInfo, which takes precedence
            ...mediaInfo,
        };
        
        // Check if this is ffprobe metadata that should be stored separately
        const isFFprobeData = mediaInfo.source === 'ffprobe' || (video.isVariant && video.hasFFprobeMetadata);
        
        // Create updated video with stream info
        const updatedVideo = {
            ...video,
            mediaInfo: mergedMediaInfo,
            needsMetadata: false,  // Mark as processed
            isFullyParsed: true,   // Mark as fully parsed
            // Update resolution data from the mediaInfo
            resolution: mediaInfo.width && mediaInfo.height ? {
                width: mediaInfo.width,
                height: mediaInfo.height,
                fps: mediaInfo.fps,
                bitrate: mediaInfo.videoBitrate || mediaInfo.totalBitrate
            } : video.resolution,
            fileSize: mediaInfo.estimatedSize || video.fileSize
        };
        
        // If this is FFprobe data, store it separately as well
        if (isFFprobeData && !updatedVideo.ffprobeMeta) {
            updatedVideo.ffprobeMeta = mediaInfo;
            updatedVideo.hasFFprobeMetadata = true;
        }
        
        // Special handling for variants - ensure they have proper flag set
        if (updatedVideo.isVariant) {
            updatedVideo.isVariantFullyProcessed = true;
            
            // If this is a variant with a known master, update the variant in the master playlist too
            if (updatedVideo.hasKnownMaster && updatedVideo.masterUrl) {
                const masterUrl = normalizeUrl(updatedVideo.masterUrl);
                
                if (tabMap.has(masterUrl)) {
                    const masterVideo = tabMap.get(masterUrl);
                    
                    if (masterVideo && masterVideo.variants) {
                        const variantIndex = masterVideo.variants.findIndex(
                            v => normalizeUrl(v.url) === normalizedUrl
                        );
                        
                        if (variantIndex !== -1) {
                            logDebug(`Updating variant in master playlist: ${normalizedUrl}`);
                            
                            // Create updated variants array
                            const updatedVariants = [...masterVideo.variants];
                            
                            // Update the variant in the master playlist with the new metadata
                            updatedVariants[variantIndex] = {
                                ...updatedVariants[variantIndex],
                                mediaInfo: mergedMediaInfo,
                                isFullyParsed: true,
                                isVariantFullyProcessed: true,
                                resolution: updatedVideo.resolution,
                                fileSize: updatedVideo.fileSize
                            };
                            
                            // If this is FFprobe data, also update the ffprobeMeta field
                            if (isFFprobeData && !updatedVariants[variantIndex].ffprobeMeta) {
                                updatedVariants[variantIndex].ffprobeMeta = mediaInfo;
                                updatedVariants[variantIndex].hasFFprobeMetadata = true;
                            }
                            
                            // Update master with updated variants
                            tabMap.set(masterUrl, {
                                ...masterVideo,
                                variants: updatedVariants
                            });
                        }
                    }
                }
            }
        }
        
        // Update the video in the map
        tabMap.set(normalizedUrl, updatedVideo);
        
        // Use the unified notification method to update UI
        notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
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
            
            // Special handling for variants - include more detailed logging
            if (updatedVideo.isVariant) {
                const mediaInfoFieldCount = updatedVideo.mediaInfo ? Object.keys(updatedVideo.mediaInfo).length : 0;
                logDebug(`Sending variant update with ${mediaInfoFieldCount} mediaInfo fields: ${url}`);
                
                // Add detailed logging of available fields for debugging
                if (updatedVideo.mediaInfo) {
                    logDebug(`Variant mediaInfo fields: ${Object.keys(updatedVideo.mediaInfo).join(', ')}`);
                }
                
                // Check if we need to update this variant in its master playlist
                if (updatedVideo.masterUrl && updatedVideo.hasKnownMaster) {
                    logDebug(`This variant belongs to master: ${updatedVideo.masterUrl}`);
                }
            }
            
            // Make a clean copy of the video object for transmission
            const videoForTransmission = {
                ...updatedVideo,
                // Force a deep clone of mediaInfo to ensure all properties are transmitted
                mediaInfo: updatedVideo.mediaInfo ? JSON.parse(JSON.stringify(updatedVideo.mediaInfo)) : null,
                // Also deep clone any variants
                variants: updatedVideo.variants ? JSON.parse(JSON.stringify(updatedVideo.variants)) : [],
                // Add a marker so we can track which videos have been processed
                _processedByVideoManager: true
            };
            
            try {
                port.postMessage({
                    type: 'videoUpdated',
                    url: url,
                    video: videoForTransmission
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

// Clean up for tab
function cleanupForTab(tabId) {
    logDebug('Tab removed:', tabId);
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
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
 * Clear all video caches for all tabs
 * This is used by the UI to force a complete refresh
 */
function clearVideoCache() {
    logDebug('Clearing all video caches');
    
    // Clear central video collection
    allDetectedVideos.clear();
    
    // Clear processing requests
    processingRequests.previews.clear();
    processingRequests.metadata.clear();
    processingRequests.lightParsing.clear();
    processingRequests.playlist.clear();
}

/**
 * Estimate file size based on bitrate and duration
 * @param {number} bitrate - Bitrate in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number} Estimated file size in bytes
 */
function estimateFileSize(bitrate, duration) {
    if (!bitrate || !duration) return null;
    
    // Formula: (bitrate in bps * duration in seconds) / 8 = bytes
    return Math.round((bitrate * duration) / 8);
}


/**
 * Get all detected videos, optionally filtered by tab
 * @param {number} [tabId] - Optional tab ID to filter by
 * @returns {Map} Map of videos
 */
function getAllDetectedVideos(tabId) {
    if (tabId === undefined) {
        // Return a flattened map of all videos across all tabs (for debugging)
        const allVideos = new Map();
        for (const [currentTabId, tabVideos] of allDetectedVideos.entries()) {
            for (const [url, video] of tabVideos.entries()) {
                allVideos.set(url, { ...video, tabId: currentTabId });
            }
        }
        return allVideos;
    }
    
    // Return videos for specific tab or empty map if tab doesn't exist
    return allDetectedVideos.get(tabId) || new Map();
}

// addition of all new suggested logic

/**
 * Add detected video to the central tracking map
 * This is the first step in the video processing pipeline
 * @param {number} tabId - The tab ID where the video was detected
 * @param {Object} videoInfo - Information about the detected video
 * @returns {boolean} - True if this is a new video, false if it's a duplicate
 */
function addDetectedVideo(tabId, videoInfo) {
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Initialize tab's video collection if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    
    // Get the map for this specific tab
    const tabDetectedVideos = allDetectedVideos.get(tabId);
    
    // Skip if already in this tab's collection
    if (tabDetectedVideos.has(normalizedUrl)) {
        return false;
    }
    
    // Add to tab's collection with basic info
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        tabId,
        timestamp: Date.now(),
        // Important flags for tracking processing status
        isBeingProcessed: false,
        needsMetadata: true,
        needsPreview: !videoInfo.poster && !videoInfo.previewUrl
    };
    
    tabDetectedVideos.set(normalizedUrl, newVideo);
    
    logDebug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type})`);
    
    // Notify any open popup about the new video
    notifyNewVideoDetected(tabId);
    
    // Now process based on video type
    if (videoInfo.url.startsWith('blob:')) {
        // Handle blob URLs differently - they need special metadata
        handleBlobVideo(tabId, normalizedUrl);
    } else if (videoInfo.type === 'hls' || videoInfo.type === 'dash') {
        // For streaming content, first run JS parser
        runJSParser(tabId, normalizedUrl, videoInfo.type);
    } else if (videoInfo.type === 'direct') {
        // For direct videos, get FFprobe metadata
        runFFProbeParser(tabId, normalizedUrl);
        // Also generate preview
        generateVideoPreview(tabId, normalizedUrl);
    } else {
        // Unknown types - try FFprobe anyway as fallback
        runFFProbeParser(tabId, normalizedUrl);
        // Also generate preview
        generateVideoPreview(tabId, normalizedUrl);
    }
    
    // Broadcast initial state to UI
    broadcastVideoUpdate(tabId);
    
    return true;
}

/**
 * Run JS parser for streaming content (both light and full parsing)
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} type - Content type (hls/dash)
 */
async function runJSParser(tabId, normalizedUrl, type) {
    // Skip if already being processed
    if (processingRequests.lightParsing.has(normalizedUrl)) {
        return;
    }
    
    processingRequests.lightParsing.add(normalizedUrl);
    
    try {
        const tabMap = allDetectedVideos.get(tabId);
        if (!tabMap || !tabMap.has(normalizedUrl)) {
            return;
        }
        
        const video = tabMap.get(normalizedUrl);
        
        // First do light parsing to determine content type
        logDebug(`Running light parsing for ${video.url}`);
        const lightParseResult = await lightParseContent(video.url, type);
        
        // Update video with light parse results
        const updatedVideoAfterLightParse = {
            ...video,
            subtype: lightParseResult.subtype,
            isValid: lightParseResult.isValid,
            isLightParsed: true,
            timestampLP: Date.now(),
            ...(lightParseResult.isMaster ? { isMaster: true } : {}),
            ...(lightParseResult.isVariant ? { isVariant: true } : {})
        };
        
        tabMap.set(normalizedUrl, updatedVideoAfterLightParse);
        
        // Stop here if not a valid video
        if (!lightParseResult.isValid) {
            logDebug(`${video.url} is not a valid ${type} video`);
            return;
        }
        
        // For master playlists, extract variants with full parsing
        if (lightParseResult.isMaster) {
            logDebug(`Processing master playlist: ${video.url}`);
            
            // Run full parsing to extract variants
            const fullParseResult = await fullParseContent(video.url, lightParseResult.subtype);
            
            if (fullParseResult.variants && fullParseResult.variants.length > 0) {
                // Update master with variants
                const updatedVideoAfterFullParse = {
                    ...updatedVideoAfterLightParse,
                    variants: fullParseResult.variants,
                    duration: (fullParseResult.variants[0]?.jsMeta?.duration) || 7777777,
                    timestampFP: Date.now()
                };
                
                tabMap.set(normalizedUrl, updatedVideoAfterFullParse);
                
                // For each variant, get FFprobe metadata
                // Process sequentially to avoid overwhelming the system
                await processVariantsWithFFprobe(tabId, normalizedUrl, fullParseResult.variants);
            }
        } else if (lightParseResult.isVariant) {
            // For variants, just update basic info
            // (variants are usually managed through their master playlist)
            logDebug(`Detected variant: ${video.url}`);
        }
        
        // Always generate a preview
        generateVideoPreview(tabId, normalizedUrl);
        
        // Update UI
        broadcastVideoUpdate(tabId);
        
    } catch (error) {
        console.error(`Error in runJSParser for ${normalizedUrl}:`, error);
    } finally {
        processingRequests.lightParsing.delete(normalizedUrl);
    }
}

/**
 * Process variants with FFprobe
 * @param {number} tabId - Tab ID
 * @param {string} masterUrl - Normalized master URL
 * @param {Array} variants - Array of variant objects
 */
async function processVariantsWithFFprobe(tabId, masterUrl, variants) {
    logDebug(`Processing ${variants.length} variants with FFprobe`);
    
    // Process each variant sequentially
    for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        logDebug(`Processing variant ${i+1}/${variants.length}: ${variant.url}`);
        
        try {
            // Get FFprobe metadata
            const ffprobeData = await rateLimiter.enqueue(async () => {
                const response = await nativeHostService.sendMessage({
                    type: 'getQualities',
                    url: variant.url,
                    light: false
                });
                return response?.streamInfo || null;
            });
            
            if (ffprobeData) {
                 logDebug(`Success FFprobe data for variant URL: ${variant.url}, ${i+1}:`, ffprobeData);
                // Update variant in master's variants array
                updateVariantWithFFprobeData(tabId, masterUrl, i, ffprobeData);
            }
        } catch (error) {
            console.error(`Error getting FFprobe data for variant ${variant.url}:`, error);
        }
    }
}

/**
 * Update variant with FFprobe data
 * @param {number} tabId - Tab ID
 * @param {string} masterUrl - Normalized master URL
 * @param {number} variantIndex - Index of variant in master's variants array
 * @param {Object} ffprobeData - FFprobe metadata
 */
function updateVariantWithFFprobeData(tabId, masterUrl, variantIndex, ffprobeData) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap || !tabMap.has(masterUrl)) {
        return;
    }
    
    const masterVideo = tabMap.get(masterUrl);
    if (!masterVideo.variants || variantIndex >= masterVideo.variants.length) {
        return;
    }
    
    // Create updated variants array
    const updatedVariants = [...masterVideo.variants];
    updatedVariants[variantIndex] = {
        ...updatedVariants[variantIndex],
        ffprobeMeta: ffprobeData,
        hasFFprobeMetadata: true,
        isFullyParsed: true,
        timestampFFProbe: Date.now()
    };
    
    // Update master with new variants array
    tabMap.set(masterUrl, {
        ...masterVideo,
        variants: updatedVariants
    });
    
    // Update UI
    broadcastVideoUpdate(tabId);
}

/**
 * Run FFprobe parser for direct videos
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function runFFProbeParser(tabId, normalizedUrl) {
    // Skip if already being processed
    if (processingRequests.metadata.has(normalizedUrl)) {
        return;
    }
    
    processingRequests.metadata.add(normalizedUrl);
    
    try {
        const tabMap = allDetectedVideos.get(tabId);
        if (!tabMap || !tabMap.has(normalizedUrl)) {
            return;
        }
        
        const video = tabMap.get(normalizedUrl);
        
        // Skip if already fully parsed
        if (video.isFullyParsed) {
            return;
        }
        
        // Get metadata from FFprobe
        logDebug(`Getting FFprobe metadata for ${video.url}`);
        
        const streamInfo = await rateLimiter.enqueue(async () => {
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: video.url,
                light: false
            });
            return response?.streamInfo || null;
        });
        
        if (streamInfo) {
            // Calculate estimated size if possible
            if (streamInfo.totalBitrate && video.duration) {
                streamInfo.estimatedSize = estimateFileSize(streamInfo.totalBitrate, video.duration);
            }
            
            // Create updated video with metadata
            const updatedVideo = {
                ...video,
                mediaInfo: streamInfo,
                ffprobeMeta: streamInfo,  // Store FFprobe data separately
                hasFFprobeMetadata: true,
                needsMetadata: false,
                isFullyParsed: true,
                // Update resolution data from the mediaInfo
                resolution: streamInfo.width && streamInfo.height ? {
                    width: streamInfo.width,
                    height: streamInfo.height,
                    fps: streamInfo.fps,
                    bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                } : video.resolution,
                fileSize: streamInfo.sizeBytes || streamInfo.estimatedSize || video.fileSize
            };
            
            // Update in map
            tabMap.set(normalizedUrl, updatedVideo);
            
            // Update UI
            notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
            broadcastVideoUpdate(tabId);
        }
    } catch (error) {
        console.error(`Error in runFFProbeParser for ${normalizedUrl}:`, error);
    } finally {
        processingRequests.metadata.delete(normalizedUrl);
    }
}

/**
 * Generate preview for a video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function generateVideoPreview(tabId, normalizedUrl) {
    // Skip if already being processed
    if (processingRequests.previews.has(normalizedUrl)) {
        return;
    }
    
    processingRequests.previews.add(normalizedUrl);
    
    try {
        const tabMap = allDetectedVideos.get(tabId);
        if (!tabMap || !tabMap.has(normalizedUrl)) {
            return;
        }
        
        const video = tabMap.get(normalizedUrl);
        
        // Skip if already has preview or is a blob
        if (video.previewUrl || video.poster || video.url.startsWith('blob:')) {
            return;
        }
        
        // Generate preview
        logDebug(`Generating preview for ${video.url}`);
        
        const response = await rateLimiter.enqueue(async () => {
            return await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: video.url
            });
        });
        
        if (response && response.previewUrl) {
            // Update video with preview URL
            const updatedVideo = {
                ...video,
                previewUrl: response.previewUrl,
                needsPreview: false
            };
            
            // Update in map
            tabMap.set(normalizedUrl, updatedVideo);
            
            // Update UI
            notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
            broadcastVideoUpdate(tabId);
        }
    } catch (error) {
        console.error(`Error in generateVideoPreview for ${normalizedUrl}:`, error);
    } finally {
        processingRequests.previews.delete(normalizedUrl);
    }
}

/**
 * Handle blob URLs (which need special treatment)
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
function handleBlobVideo(tabId, normalizedUrl) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap || !tabMap.has(normalizedUrl)) {
        return;
    }
    
    const video = tabMap.get(normalizedUrl);
    
    // Set placeholder metadata for blob URLs
    const updatedVideo = {
        ...video,
        mediaInfo: {
            isBlob: true,
            type: 'blob',
            format: 'blob',
            container: 'blob',
            hasVideo: null,
            hasAudio: null
        },
        needsMetadata: false,
        needsPreview: false,
        isFullyParsed: true
    };
    
    // Update in map
    tabMap.set(normalizedUrl, updatedVideo);
    
    // Update UI
    notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
    broadcastVideoUpdate(tabId);
}


// experimental function as alternative to getVideosForTab
// This function returns an array of videos for a specific tab ID
// It filters out variants with known masters and processes the videos for broadcast
function getVideosArrayFromMap(tabId) {
    if (!allDetectedVideos.has(tabId)) {
        return [];
    }
    
    const tabVideosMap = allDetectedVideos.get(tabId);
    const resultArray = [];
    
    // Convert map to array, filtering out variants with known masters
    for (const [normalizedUrl, videoObj] of tabVideosMap.entries()) {
        if (!(videoObj.isVariant && videoObj.hasKnownMaster)) {
            resultArray.push({
                ...videoObj,
                fromArrayMap: true // Mark as coming from map
            });
        }
    }
    
    return processVideosForBroadcast(resultArray);
}


export {
    addDetectedVideo,
    broadcastVideoUpdate,
    getStreamQualities,
    cleanupForTab,
    normalizeUrl,
    getAllDetectedVideos,
    getVideosArrayFromMap,
    clearVideoCache
};