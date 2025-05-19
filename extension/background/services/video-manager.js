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
import { buildRequestHeaders } from '../../js/utilities/headers-utils.js';

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Track relationships between variants and their master playlists
// Map<tabId, Map<normalizedVariantUrl, masterUrl>>
const variantMasterMap = new Map();

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

/**
 * Track variant-master relationships when variants are found in a master playlist
 * @param {number} tabId - Tab ID
 * @param {Array} variants - Array of variant objects
 * @param {string} masterUrl - The normalized master URL
 */
function trackVariantMasterRelationship(tabId, variants, masterUrl) {
    // Ensure the tab entry exists in the variant-master map
    if (!variantMasterMap.has(tabId)) {
        variantMasterMap.set(tabId, new Map());
    }
    
    const tabVariantMap = variantMasterMap.get(tabId);
    
    // Record all variants from this master
    for (const variant of variants) {
        const normalizedVariantUrl = variant.normalizedUrl;
        tabVariantMap.set(normalizedVariantUrl, masterUrl);
        logDebug(`Tracked variant ${normalizedVariantUrl} as belonging to master ${masterUrl}`);
        
        // Update any existing standalone variant entries
        updateExistingVariant(tabId, normalizedVariantUrl, masterUrl);
    }
}

/**
 * Update an existing standalone variant with master info
 * @param {number} tabId - Tab ID
 * @param {string} normalizedVariantUrl - Normalized variant URL
 * @param {string} masterUrl - Normalized master URL
 */
function updateExistingVariant(tabId, normalizedVariantUrl, masterUrl) {
    const tabVideos = allDetectedVideos.get(tabId);
    if (!tabVideos || !tabVideos.has(normalizedVariantUrl)) {
        return; // No standalone variant exists yet
    }
    
    // Variant exists as standalone, update it with master info
    const variant = tabVideos.get(normalizedVariantUrl);
    
    // Simpler approach: update any matching URL without checking if it's a variant
    // Since we know the URL is in the master's variant list, it must be a variant
    const updatedVariant = {
        ...variant,
        hasKnownMaster: true,
        masterUrl: masterUrl,
        // Pre-flag it as a variant since we know it's in a master's variant list
        isVariant: true
    };
    
    tabVideos.set(normalizedVariantUrl, updatedVariant);
    logDebug(`Updated existing standalone variant ${normalizedVariantUrl} with master info`);
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
    
    // Preparation for display
    const processedVideos = videos.map(video => {
        // Add additional information needed for immediate display
        return {
            ...video,
            // Add additional metadata needed by UI
            timestampLastProcessed: Date.now(),
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            ...(video.poster ? { poster: video.poster } : {}),
            // Preserve the detection timestamp for debugging duplicates
            timestampDetected: video.timestampDetected || null,
            ...(video.variants ? { variants: video.variants } : {})
        };
    });
    
    // Sort by newest first
    return processedVideos.sort((a, b) => b.timestampDetected - a.timestampDetected);
}

// Broadcast videos to popup
function broadcastVideoUpdate(tabId) {
    // Use new array-from-map function instead of videosPerTab
    const processedVideos = getVideosArrayFromMap(tabId);
    logDebug(`Broadcasting ${processedVideos.length} videos for tab ${tabId} with this content: `, processedVideos);

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
            
            // Make a clean copy of the video object for transmission
            const videoForTransmission = {
                ...updatedVideo,
                // Force a deep clone of metaFFprobe to ensure all properties are transmitted
                metaFFprobe: updatedVideo.metaFFprobe ? JSON.parse(JSON.stringify(updatedVideo.metaFFprobe)) : null,
                metaJS: updatedVideo.metaJS ? JSON.parse(JSON.stringify(updatedVideo.metaJS)) : null,
                ...(updatedVideo.variants ? { variants: JSON.parse(JSON.stringify(updatedVideo.variants)) } : {}),
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
async function getStreamQualities(url, tabId) {
    try {
        console.log('🎥 Requesting media info from native host for:', url);
        
        // Get headers, using basic headers as fallback if tabId is not provided
        let headers;
        if (tabId) {
            headers = await buildRequestHeaders(tabId, url);
        } else {
            headers = await buildRequestHeaders(null, url);
        }
        
        logDebug(`Using headers for stream qualities: ${JSON.stringify(headers)}`);
        
        const response = await nativeHostService.sendMessage({
            type: 'getQualities',
            url: url,
            headers: headers
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
    
    // Clean up variant-master relationships
    if (variantMasterMap.has(tabId)) {
        variantMasterMap.delete(tabId);
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
    
    // Clear variant-master relationships
    variantMasterMap.clear();
    
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
    const tabMap = allDetectedVideos.get(tabId);
    
    // Log source of video for debugging
    const sourceOfVideo = videoInfo.source || 'unknown';
    logDebug(`Video detection from source: ${sourceOfVideo} for URL: ${videoInfo.url} with timestamp: ${videoInfo.timestampDetected}`);
    
    // Skip if already in this tab's collection
    if (tabMap.has(normalizedUrl)) {
        const existingVideo = tabMap.get(normalizedUrl);
        logDebug(`Duplicate video detection from ${sourceOfVideo}. URL: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return false;
    }
    
    // Add to tab's collection with basic info
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        tabId,
        // Important flags for tracking processing status
        isBeingProcessed: false
    };
    
    tabMap.set(normalizedUrl, newVideo);

    logDebug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type}, source: ${sourceOfVideo})`);

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
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        
        // First do light parsing to determine content type
        logDebug(`Running light parsing for ${video.url}`);
        const lightParseResult = await lightParseContent(video.url, type, headers);
        
        // Update video with light parse results - PRESERVE relationship fields from original object
        let updatedVideoAfterLightParse = {
            ...video,
            subtype: lightParseResult.subtype,
            isValid: lightParseResult.isValid,
            isLightParsed: true,
            timestampLP: Date.now(),
            ...(lightParseResult.isMaster ? { isMaster: true } : {}),
            ...(lightParseResult.isVariant ? { isVariant: true } : {})
            // Note: We're preserving hasKnownMaster and masterUrl from original video object
        };
        
        // Only check variantMasterMap if the original video doesn't already have a known master
        if (lightParseResult.isVariant && !video.hasKnownMaster) {
            const tabVariantMap = variantMasterMap.get(tabId);
            if (tabVariantMap && tabVariantMap.has(normalizedUrl)) {
                // Update the video with master info
                updatedVideoAfterLightParse.hasKnownMaster = true;
                updatedVideoAfterLightParse.masterUrl = tabVariantMap.get(normalizedUrl);
                logDebug(`Linked variant ${video.url} to master ${tabVariantMap.get(normalizedUrl)}`);
            }
        }
        
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
            const fullParseResult = await fullParseContent(video.url, lightParseResult.subtype, headers);
            
            if (fullParseResult.variants && fullParseResult.variants.length > 0) {
                // Update master with variants
                const updatedVideoAfterFullParse = {
                    ...updatedVideoAfterLightParse,
                    variants: fullParseResult.variants,
                    duration: (fullParseResult.variants[0]?.metaJS?.duration),
                    timestampFP: Date.now()
                };
                
                tabMap.set(normalizedUrl, updatedVideoAfterFullParse);
                
                // Track all variants from this master
                trackVariantMasterRelationship(tabId, fullParseResult.variants, normalizedUrl);
                
                // For each variant, get FFprobe metadata
                // Preview will be generated for the best quality variant in processVariantsWithFFprobe
                await processVariantsWithFFprobe(tabId, normalizedUrl, fullParseResult.variants);
                
                // No need to generate preview for master here - it's handled in processVariantsWithFFprobe
            } else {
                // No variants found in master playlist; do not generate preview for master,
                // as master playlists are not media files and cannot have previews.
                logDebug(`No variants found in master playlist: ${video.url} (no preview generated)`);
            }
        } else if (lightParseResult.isVariant) {
            // For standalone variants, generate preview
            logDebug(`Detected standalone variant: ${video.url}`);
            generateVideoPreview(tabId, normalizedUrl);
        } else {
            // For other content types, generate preview
            generateVideoPreview(tabId, normalizedUrl);
        }
        
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
        logDebug(`FFPROBE Processing variant ${i+1}/${variants.length}: ${variant.url}`);
        
        try {
            // Get headers for the request
            const headers = await buildRequestHeaders(tabId, variant.url);
            logDebug(`Using headers for FFPROBE request: ${JSON.stringify(headers)}`);
            
            // Get FFprobe metadata
            const ffprobeData = await rateLimiter.enqueue(async () => {
                const response = await nativeHostService.sendMessage({
                    type: 'getQualities',
                    url: variant.url,
                    light: false,
                    headers: headers
                });
                return response?.streamInfo || null;
            });
            
            if (ffprobeData) {
                logDebug(`Success FFPROBE data for variant URL: ${variant.url}, ${i+1}:`, ffprobeData);
                // Update variant in master's variants array
                updateVariantWithFFprobeData(tabId, masterUrl, i, ffprobeData);
                
                // Only generate preview for the best quality variant (index 0)
                if (i === 0) {
                    logDebug(`Generating preview for best quality variant: ${variant.url}`);
                    
                    // Skip if already being processed
                    if (!processingRequests.previews.has(variant.url)) {
                        processingRequests.previews.add(variant.url);
                        
                        try {
                            // Generate preview
                            const response = await rateLimiter.enqueue(async () => {
                                return await nativeHostService.sendMessage({
                                    type: 'generatePreview',
                                    url: variant.url,
                                    headers: headers
                                });
                            });
                            
                            if (response && response.previewUrl) {
                                // Get the master video
                                const tabMap = allDetectedVideos.get(tabId);
                                if (!tabMap || !tabMap.has(masterUrl)) {
                                    return;
                                }
                                
                                const masterVideo = tabMap.get(masterUrl);
                                if (!masterVideo.variants || !masterVideo.variants[i]) {
                                    return;
                                }
                                
                                // Create updated variants array with the preview URL added to the first variant
                                const updatedVariants = [...masterVideo.variants];
                                updatedVariants[i] = {
                                    ...updatedVariants[i],
                                    previewUrl: response.previewUrl
                                };
                                
                                // Update master with the new variants array
                                tabMap.set(masterUrl, {
                                    ...masterVideo,
                                    variants: updatedVariants
                                });
                                
                                logDebug(`Preview generated for best quality variant: ${response.previewUrl}`);
                                
                                // Update UI
                                notifyVideoUpdated(tabId, masterUrl, {
                                    ...masterVideo,
                                    variants: updatedVariants
                                });
                                broadcastVideoUpdate(tabId);
                            }
                        } finally {
                            processingRequests.previews.delete(variant.url);
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error getting FFPROBE data for variant ${variant.url}:`, error);
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
        metaFFprobe: ffprobeData,
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
            logDebug(`Video ${video.url} is already fully parsed, skipping FFprobe`);
            return;
        }
        
        // Get metadata from FFprobe
        logDebug(`Getting FFPROBE metadata for ${video.url}`);
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        logDebug(`Using headers for FFPROBE request: ${JSON.stringify(headers)}`);
        
        const streamInfo = await rateLimiter.enqueue(async () => {
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: video.url,
                light: false,
                headers: headers
            });
            return response?.streamInfo || null;
        });
        
        if (streamInfo) {
            
            // Create updated video with metadata
            const updatedVideo = {
                ...video,
                metaFFprobe: streamInfo,  // Store FFprobe data separately
                hasFFprobeMetadata: true,
                isFullyParsed: true,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null
            };
            
            // Update in map
            tabMap.set(normalizedUrl, updatedVideo);
            logDebug(`Updated map entry after FFprobe for URL ${video.url}: `, updatedVideo);
            
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
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        logDebug(`Using headers for preview request: ${JSON.stringify(headers)}`);
        
        const response = await rateLimiter.enqueue(async () => {
            return await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: video.url,
                headers: headers
            });
        });
        
        if (response && response.previewUrl) {
            // Update video with preview URL
            const updatedVideo = {
                ...video,
                previewUrl: response.previewUrl
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
    const tabVariantMap = variantMasterMap.get(tabId);
    const resultArray = [];
    
    // Convert map to array, filtering out variants with known masters
    for (const [normalizedUrl, videoObj] of tabVideosMap.entries()) {
        // Check both the hasKnownMaster flag AND the variantMasterMap
        // This ensures we catch variants even if the flag hasn't been set yet
        const isInVariantMap = tabVariantMap && tabVariantMap.has(normalizedUrl);
        
        if (!(videoObj.isVariant && (videoObj.hasKnownMaster || isInVariantMap))) {
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