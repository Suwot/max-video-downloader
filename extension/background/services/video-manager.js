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
import { getActivePopupPortForTab } from './ui-communication.js';
import { lightParseContent, fullParseContent } from '../../js/utilities/simple-js-parser.js';
import { buildRequestHeaders } from '../../js/utilities/headers-utils.js';
import { createLogger } from '../../js/utilities/logger.js';
import { getPreview, storePreview } from '../../js/utilities/preview-cache.js';

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Track relationships between variants and their master playlists
// Map<tabId, Map<normalizedVariantUrl, masterUrl>>
const variantMasterMap = new Map();

// Expose allDetectedVideos for debugging
globalThis.allDetectedVideosInternal = allDetectedVideos;

// Temporary processing trackers (not for storage) - using a unified tracking mechanism
const processingRequests = {
    // Map to track operations by type and URL
    operations: new Map(),
    
    isProcessing(url, operation) {
        const key = `${operation}:${url}`;
        return this.operations.has(key);
    },
    
    startProcessing(url, operation) {
        const key = `${operation}:${url}`;
        this.operations.set(key, Date.now());
        return true;
    },
    
    finishProcessing(url, operation) {
        const key = `${operation}:${url}`;
        this.operations.delete(key);
    },
    
    clearAll() {
        this.operations.clear();
    }
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

// Create a logger instance for the Video Manager module
const logger = createLogger('Video Manager');

/**
 * Single entry point for all video updates with proper logging
 * @param {string} functionName - Function making the update
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Video URL
 * @param {Object} updates - Fields to update (or complete object)
 * @param {boolean} [replace=false] - If true, replace the entire object instead of merging
 * @returns {Object|null} - Updated video object or null if video not found
 */
function updateVideo(functionName, tabId, normalizedUrl, updates, replace = false) {
    const tabMap = allDetectedVideos.get(tabId);
    if (!tabMap) return null;
    
    // For replace mode, only check if tabMap exists
    // For update mode, also check if the video exists
    if (!replace && !tabMap.has(normalizedUrl)) return null;
    
    // Create updated video object
    let updatedVideo;
    if (replace) {
        updatedVideo = { ...updates };
    } else {
        const currentVideo = tabMap.get(normalizedUrl);
        updatedVideo = { ...currentVideo, ...updates };
    }
    
    // Log the update
    logger.group(functionName,
        `TabID: ${tabId}, URL: ${normalizedUrl}`,
        `HasKnownMaster: ${updatedVideo.hasKnownMaster}, IsVariant: ${updatedVideo.isVariant}`,
        ...(updatedVideo.masterUrl ? [`Master URL: ${updatedVideo.masterUrl}`] : [])
    );
    
    // Set the value in the map
    tabMap.set(normalizedUrl, updatedVideo);
    
    return updatedVideo;
}

/**
 * Track and update variant-master relationships
 * @param {number} tabId - Tab ID
 * @param {Array} variants - Array of variant objects
 * @param {string} masterUrl - The normalized master URL
 */
function handleVariantMasterRelationships(tabId, variants, masterUrl) {
    if (!variantMasterMap.has(tabId)) {
        variantMasterMap.set(tabId, new Map());
    }
    
    const tabVariantMap = variantMasterMap.get(tabId);
    const tabVideos = allDetectedVideos.get(tabId);
    
    if (!tabVideos) return;
    
    // Process each variant
    for (const variant of variants) {
        const variantUrl = variant.normalizedUrl;
        
        // Update the variant-master relationship map
        tabVariantMap.set(variantUrl, masterUrl);
        logger.debug(`Tracked variant ${variantUrl} as belonging to master ${masterUrl}`);
        
        // If this variant exists as standalone, update it
        if (tabVideos.has(variantUrl)) {
            updateVideo('handleVariantMasterRelationships', tabId, variantUrl, {
                hasKnownMaster: true,
                masterUrl: masterUrl,
                isVariant: true
            });
            logger.debug(`Updated existing standalone variant ${variantUrl} with master info`);
        }
    }
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

// Process videos for sending to popup functionality moved into getVideosForDisplay

// Broadcast videos to popup
function broadcastVideoUpdate(tabId) {
    const processedVideos = getVideosForDisplay(tabId);
    logger.info(`Broadcasting ${processedVideos.length} videos for tab ${tabId}`);

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
        logger.debug('Error sending video update message (popup may not be open):', e.message);
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
            logger.debug(`Notifying popup for tab ${tabId} about video update for ${url}`);
            
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
                logger.debug(`Error sending video update: ${error.message}`);
            }
        } else {
            // No popup is open for this tab, which is normal
            logger.debug(`No active popup for tab ${tabId}, update will be shown when popup opens`);
        }
    } catch (error) {
        logger.error(`Error: ${error.message}`);
    }
}

// Get stream qualities
async function getStreamQualities(url, tabId) {
    try {
        logger.info('🎥 Requesting media info from native host for:', url);
        
        // Get headers, using basic headers as fallback if tabId is not provided
        let headers;
        if (tabId) {
            headers = await buildRequestHeaders(tabId, url);
        } else {
            headers = await buildRequestHeaders(null, url);
        }
        
        logger.debug(`Using headers for stream qualities: ${JSON.stringify(headers)}`);
        
        const response = await nativeHostService.sendMessage({
            type: 'getQualities',
            url: url,
            headers: headers
        });
        
        return response;
    } catch (error) {
        logger.error('Error getting media info:', error);
        return { error: error.message };
    }
}

// Clean up for tab
function cleanupForTab(tabId) {
    logger.debug(`Tab removed: ${tabId}`);
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
    }
    
    // Clean up variant-master relationships
    if (variantMasterMap.has(tabId)) {
        variantMasterMap.delete(tabId);
    }
}

/**
 * Initialize video manager service
 * @returns {Promise<boolean>} Success status
 */
async function initVideoManager() {
    logger.info('Initializing video manager service');
    
    try {
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
        
        // Initialize maps for tracking videos
        globalThis.allDetectedVideosInternal = allDetectedVideos;
        
        logger.info('Video manager service initialized');
        return true;
    } catch (error) {
        logger.error('Failed to initialize video manager:', error);
        return false;
    }
}

/**
 * Clear all video caches for all tabs
 * This is used by the UI to force a complete refresh
 */
function clearVideoCache() {
    logger.debug('Clearing all video caches');
    
    allDetectedVideos.clear(); // Clear central video collection
    variantMasterMap.clear(); // Clear variant-master relationships
    processingRequests.clearAll(); // Clear processing requests
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
    logger.debug(`Video detection from source: ${sourceOfVideo} for URL: ${videoInfo.url} with timestamp: ${videoInfo.timestampDetected}`);
    
    // Skip if already in this tab's collection
    if (tabMap.has(normalizedUrl)) {
        const existingVideo = tabMap.get(normalizedUrl);
        logger.debug(`Duplicate video detection from ${sourceOfVideo}. URL: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return false;
    }
    
    // Add to tab's collection with basic info
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        tabId,
        isBeingProcessed: false
    };
    
    updateVideo('addDetectedVideo', tabId, normalizedUrl, newVideo, true);
    logger.debug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type}, source: ${sourceOfVideo})`);

    // Process the video based on its type
    processVideo(tabId, normalizedUrl, newVideo);
    
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
    if (processingRequests.isProcessing(normalizedUrl, 'lightParsing')) {
        return;
    }
    
    processingRequests.startProcessing(normalizedUrl, 'lightParsing');
    
    try {
        const tabMap = allDetectedVideos.get(tabId);
        if (!tabMap || !tabMap.has(normalizedUrl)) {
            return;
        }
        
        const video = tabMap.get(normalizedUrl);
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        
        // First do light parsing to determine content type
        logger.debug(`Running light parsing for ${video.url}`);
        const lightParseResult = await lightParseContent(video.url, type, headers);
        
        // Create light parse update fields
        let lightParseUpdates = {
            subtype: lightParseResult.subtype,
            isValid: lightParseResult.isValid,
            isLightParsed: true,
            timestampLP: Date.now(),
            ...(lightParseResult.isMaster ? { isMaster: true } : {}),
            ...(lightParseResult.isVariant ? { isVariant: true } : {})
        };
        
        // Only check variantMasterMap if the original video doesn't already have a known master
        if (lightParseResult.isVariant && !video.hasKnownMaster) {
            const tabVariantMap = variantMasterMap.get(tabId);
            if (tabVariantMap && tabVariantMap.has(normalizedUrl)) {
                // Add master info to updates
                lightParseUpdates.hasKnownMaster = true;
                lightParseUpdates.masterUrl = tabVariantMap.get(normalizedUrl);
                logger.debug(`Linked variant ${video.url} to master ${tabVariantMap.get(normalizedUrl)}`);
            }
        }
        
        // Update video with light parse results using our unified function
        const updatedVideoAfterLightParse = updateVideo('runJSParser-lightParse', tabId, normalizedUrl, lightParseUpdates);
        
        // Stop here if not a valid video
        if (!lightParseResult.isValid) {
            logger.debug(`${video.url} is not a valid ${type} video`);
            return;
        }
        
        // For master playlists, extract variants with full parsing
        if (lightParseResult.isMaster) {
            logger.debug(`Processing master playlist: ${video.url}`);
            
            // Run full parsing to extract variants
            const fullParseResult = await fullParseContent(video.url, lightParseResult.subtype, headers);
            
            if (fullParseResult.variants && fullParseResult.variants.length > 0) {
                // Update master with variants using our unified function
                const updatedVideoAfterFullParse = updateVideo('runJSParser-fullParse', tabId, normalizedUrl, {
                    variants: fullParseResult.variants,
                    duration: (fullParseResult.variants[0]?.metaJS?.duration),
                    timestampFP: Date.now()
                });
                
                // Track all variants from this master using our streamlined function
                handleVariantMasterRelationships(tabId, fullParseResult.variants, normalizedUrl);
                
                // For each variant, get FFprobe metadata
                // Preview will be generated for the best quality variant in processVariantsWithFFprobe
                await processVariantsWithFFprobe(tabId, normalizedUrl, fullParseResult.variants);
                
                // No need to generate preview for master here - it's handled in processVariantsWithFFprobe
            } else {
                // No variants found in master playlist; do not generate preview for master,
                // as master playlists are not media files and cannot have previews.
                logger.debug(`No variants found in master playlist: ${video.url} (no preview generated)`);
            }
        } else if (lightParseResult.isVariant) {
            // For standalone variants, generate preview
            logger.debug(`Detected standalone variant: ${video.url}`);
            // generateVideoPreview(tabId, normalizedUrl);
        } else {
            // For other content types, generate preview
            generateVideoPreview(tabId, normalizedUrl);
        }
        
        // Update UI
        broadcastVideoUpdate(tabId);
        
    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
    } finally {
        processingRequests.finishProcessing(normalizedUrl, 'lightParsing');
    }
}

/**
 * Process variants with FFprobe
 * @param {number} tabId - Tab ID
 * @param {string} masterUrl - Normalized master URL
 * @param {Array} variants - Array of variant objects
 */
async function processVariantsWithFFprobe(tabId, masterUrl, variants) {
    logger.debug(`Processing ${variants.length} variants with FFprobe`);
    
    // Process each variant sequentially
    for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        logger.debug(`FFPROBE Processing variant ${i+1}/${variants.length}: ${variant.url}`);
        
        try {
            // Get headers for the request
            const headers = await buildRequestHeaders(tabId, variant.url);
            logger.debug(`Using headers for FFPROBE request: ${JSON.stringify(headers)}`);
            
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
                logger.debug(`Success FFPROBE data for variant URL: ${variant.url}, ${i+1}:`, ffprobeData);
                // Update variant in master's variants array
                updateVariantWithFFprobeData(tabId, masterUrl, i, ffprobeData);
                
                // Only generate preview for the best quality variant (index 0)
                if (i === 0) {
                    logger.debug(`Generating preview for best quality variant: ${variant.url}`);
                    
                    // Skip if already being processed
                    if (!processingRequests.isProcessing(variant.url, 'previews')) {
                        processingRequests.startProcessing(variant.url, 'previews');
                        
                        try {
                            const variantNormalizedUrl = normalizeUrl(variant.url);
                            
                            // Check for cached preview first
                            const cachedPreview = await getPreview(variantNormalizedUrl);
                            if (cachedPreview) {
                                logger.debug(`Using cached preview for variant: ${variant.url}`);
                                
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
                                    previewUrl: cachedPreview,
                                    fromCache: true
                                };
                                
                                // Update master with the new variants array using our unified function
                                const updatedVideo = updateVideo('processVariantsWithFFprobe-preview', tabId, masterUrl, {
                                    variants: updatedVariants
                                });
                                
                                if (updatedVideo) {
                                    logger.debug(`Used cached preview for best quality variant`);
                                    
                                    // Update UI
                                    notifyVideoUpdated(tabId, masterUrl, updatedVideo);
                                    broadcastVideoUpdate(tabId);
                                }
                                return;
                            }
                            
                            // Generate preview if not cached
                            const response = await rateLimiter.enqueue(async () => {
                                return await nativeHostService.sendMessage({
                                    type: 'generatePreview',
                                    url: variant.url,
                                    headers: headers
                                });
                            });
                            
                            if (response && response.previewUrl) {
                                // Cache the generated preview
                                await storePreview(variantNormalizedUrl, response.previewUrl);
                                
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
                                
                                // Update master with the new variants array using our unified function
                                const updatedVideo = updateVideo('processVariantsWithFFprobe-preview', tabId, masterUrl, {
                                    variants: updatedVariants
                                });
                                
                                if (updatedVideo) {
                                    logger.debug(`Preview generated for best quality variant: ${response.previewUrl}`);
                                    
                                    // Update UI
                                    notifyVideoUpdated(tabId, masterUrl, updatedVideo);
                                    broadcastVideoUpdate(tabId);
                                }
                            }
                        } finally {
                            processingRequests.finishProcessing(variant.url, 'previews');
                        }
                    }
                }
            }
        } catch (error) {
            logger.error(`Error getting FFPROBE data for variant ${variant.url}:`, error);
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
    
    // Update master with new variants array using our unified function
    const updatedVideo = updateVideo('updateVariantWithFFprobeData', tabId, masterUrl, {
        variants: updatedVariants
    });
    
    if (updatedVideo) {
        // Update UI
        broadcastVideoUpdate(tabId);
    }
}

/**
 * Run FFprobe parser for direct videos
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function runFFProbeParser(tabId, normalizedUrl) {
    // Skip if already being processed
    if (processingRequests.isProcessing(normalizedUrl, 'metadata')) {
        return;
    }
    
    processingRequests.startProcessing(normalizedUrl, 'metadata');
    
    try {
        const tabMap = allDetectedVideos.get(tabId);
        if (!tabMap || !tabMap.has(normalizedUrl)) {
            return;
        }
        
        const video = tabMap.get(normalizedUrl);
        
        // Skip if already fully parsed
        if (video.isFullyParsed) {
            logger.debug(`Video ${video.url} is already fully parsed, skipping FFprobe`);
            return;
        }
        
        // Get metadata from FFprobe
        logger.debug(`Getting FFPROBE metadata for ${video.url}`);
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        logger.debug(`Using headers for FFPROBE request: ${JSON.stringify(headers)}`);
        
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
            
            // Update video with metadata using our unified function
            const updatedVideo = updateVideo('runFFProbeParser', tabId, normalizedUrl, {
                metaFFprobe: streamInfo,  // Store FFprobe data separately
                hasFFprobeMetadata: true,
                isFullyParsed: true,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null
            });
            
            if (updatedVideo) {
                logger.debug(`Updated map entry after FFprobe for URL ${video.url}: `, updatedVideo);
                
                // Update UI
                notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
                broadcastVideoUpdate(tabId);
            }
        }
    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
    } finally {
        processingRequests.finishProcessing(normalizedUrl, 'metadata');
    }
}

/**
 * Generate preview for a video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function generateVideoPreview(tabId, normalizedUrl) {
    // Skip if already being processed
    if (processingRequests.isProcessing(normalizedUrl, 'previews')) {
        return;
    }
    
    processingRequests.startProcessing(normalizedUrl, 'previews');
    
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
        
        // Check for cached preview first
        const cachedPreview = await getPreview(normalizedUrl);
        if (cachedPreview) {
            logger.debug(`Using cached preview for ${video.url}`);
            
            // Update video with cached preview URL
            const updatedVideo = updateVideo('generateVideoPreview', tabId, normalizedUrl, {
                previewUrl: cachedPreview,
                fromCache: true
            });
            
            if (updatedVideo) {
                // Update UI
                notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
                broadcastVideoUpdate(tabId);
            }
            return;
        }
        
        // Generate preview if not cached
        logger.debug(`Generating preview for ${video.url}`);
        
        // Get headers for the request
        const headers = await buildRequestHeaders(tabId, video.url);
        logger.debug(`Using headers for preview request: ${JSON.stringify(headers)}`);
        
        const response = await rateLimiter.enqueue(async () => {
            return await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: video.url,
                headers: headers
            });
        });
        
        if (response && response.previewUrl) {
            // Cache the generated preview
            await storePreview(normalizedUrl, response.previewUrl);
            
            // Update video with preview URL using our unified function
            const updatedVideo = updateVideo('generateVideoPreview', tabId, normalizedUrl, {
                previewUrl: response.previewUrl
            });
            
            if (updatedVideo) {
                // Update UI
                notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
                broadcastVideoUpdate(tabId);
            }
        }
    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
    } finally {
        processingRequests.finishProcessing(normalizedUrl, 'previews');
    }
}

/**
 * Process a detected video based on its type
 * @param {number} tabId - Tab ID 
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} video - The video object
 */
async function processVideo(tabId, normalizedUrl, video) {
    logger.debug(`Processing video by type: ${video.url} (type: ${video.type})`);
    
    if (video.url.startsWith('blob:')) {
        // Handle blob URLs
        const updatedVideo = updateVideo('processVideo', tabId, normalizedUrl, {
            mediaInfo: { 
                isBlob: true, 
                type: 'blob', 
                format: 'blob', 
                container: 'blob',
                hasVideo: null,
                hasAudio: null
            },
            isFullyParsed: true
        });
        
        if (updatedVideo) {
            // Update UI
            notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
        }
        
        logger.debug(`Processed blob URL: ${video.url}`);
    } else if (video.type === 'hls' || video.type === 'dash') {
        // For streaming content, run parser pipeline
        await runJSParser(tabId, normalizedUrl, video.type);
    } else {
        // For direct videos or fallback, run both operations in parallel
        await Promise.all([
            runFFProbeParser(tabId, normalizedUrl),
            generateVideoPreview(tabId, normalizedUrl)
        ]);
    }
}

/**
 * Get videos for UI display with efficient filtering
 * @param {number} tabId - Tab ID
 * @returns {Array} Filtered and processed videos
 */
function getVideosForDisplay(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    if (!tabVideosMap) return [];
    
    const tabVariantMap = variantMasterMap.get(tabId) || new Map();
    const now = Date.now();
    
    // Create array directly from values() instead of entries()
    return Array.from(tabVideosMap.values())
        .filter(video => !(video.isVariant && (video.hasKnownMaster || tabVariantMap.has(video.normalizedUrl))))
        .map(video => ({
            ...video,
            title: video.title || getFilenameFromUrl(video.url),
            timestampLastProcessed: now,
            ...(video.poster ? { poster: video.poster } : {})
        }))
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
}


export {
    addDetectedVideo,
    broadcastVideoUpdate,
    getStreamQualities,
    cleanupForTab,
    normalizeUrl,
    getAllDetectedVideos,
    getVideosForDisplay,
    clearVideoCache,
    initVideoManager
};