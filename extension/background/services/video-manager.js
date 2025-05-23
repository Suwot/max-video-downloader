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
import { getActivePopupPortForTab } from './ui-communication.js';
import { parseHlsManifest } from '../../js/utilities/hls-parser.js';
import { parseDashManifest } from '../../js/utilities/dash-parser.js';
import { getSharedHeaders, clearHeaderCache, clearAllHeaderCaches } from '../../js/utilities/headers-utils.js';
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

// Create a logger instance for the Video Manager module
const logger = createLogger('Video Manager');

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

/**
 * Unified video processing pipeline
 * Manages the flow of videos from detection through processing to UI display
 */
class VideoProcessingPipeline {
  constructor() {
    this.queue = [];
    this.processing = new Map();
    this.MAX_CONCURRENT = 15;
  }
  
  /**
   * Enqueue a video for processing
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   * @param {string} videoType - Type of video (hls, dash, direct, blob)
   */
  enqueue(tabId, normalizedUrl, videoType) {
    // Don't add duplicates to the queue
    if (this.queue.some(item => item.normalizedUrl === normalizedUrl) || 
      this.processing.has(normalizedUrl)) {
    logger.debug(`Skipping duplicate: ${normalizedUrl} (in queue or processing)`);
    return;
  }
    
    this.queue.push({ tabId, normalizedUrl, videoType });
    this.processNext();
    
    logger.debug(`Video queued for processing: ${normalizedUrl} (${videoType})`);
  }
  
  /**
   * Process next video in queue
   */
  async processNext() {
    // Skip if nothing to process or already at capacity
    if (this.queue.length === 0 || this.processing.size >= this.MAX_CONCURRENT) {
      return;
    }
    
    const { tabId, normalizedUrl, videoType } = this.queue.shift();
    
    // Skip if already processed or being processed
    if (this.processing.has(normalizedUrl)) {
      this.processNext(); // Try processing next item
      return;
    }
    
    // Mark as processing
    this.processing.set(normalizedUrl, Date.now());
    
    try {
      // Mark video as being processed in store
      updateVideoStatus(tabId, normalizedUrl, 'processing');
      
      // Route to appropriate processor based on type
      if (videoType === 'blob') {
        await this.processBlobVideo(tabId, normalizedUrl);
      } else if (videoType === 'hls') {
        await this.processHlsVideo(tabId, normalizedUrl);
      } else if (videoType === 'dash') {
        await this.processDashVideo(tabId, normalizedUrl);
      } else {
        await this.processDirectVideo(tabId, normalizedUrl);
      }
      
      // Mark as complete
      updateVideoStatus(tabId, normalizedUrl, 'complete');
    } catch (error) {
      logger.error(`Error processing ${normalizedUrl}:`, error);
      // Update video with error status
      updateVideoStatus(tabId, normalizedUrl, 'error', error.message);
    } finally {
      this.processing.delete(normalizedUrl);
      // Process next item in queue
      this.processNext();
    }
  }
  
  /**
   * Process a blob video (simple status update)
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   */
  async processBlobVideo(tabId, normalizedUrl) {
    logger.debug(`Processing blob video: ${normalizedUrl}`);
    
    const updatedVideo = updateVideo('processBlobVideo', tabId, normalizedUrl, {
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
      notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
      broadcastVideoUpdate(tabId);
    }
  }
  
  /**
   * Process an HLS video
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   */
  async processHlsVideo(tabId, normalizedUrl) {
    logger.debug(`Processing HLS video: ${normalizedUrl}`);
    
    const video = getVideo(tabId, normalizedUrl);
    if (!video) return;
    
    // Get headers for the request
    const headers = await getSharedHeaders(tabId, video.url);
    
    // Run combined validation and parsing
    const hlsResult = await parseHlsManifest(video.url, headers);
    
    if (hlsResult.status === 'success') {
      // Update video with all HLS parsing results at once
      const hlsUpdates = {
        isValid: true,
        type: 'hls',
        isMaster: hlsResult.isMaster,
        isVariant: hlsResult.isVariant,
        subtype: hlsResult.isMaster ? 'hls-master' : 'hls-variant',
        variants: hlsResult.variants,
        duration: hlsResult.duration,
        isEncrypted: hlsResult.isEncrypted,
        encryptionType: hlsResult.encryptionType,
        isLightParsed: true,
        isFullParsed: true,
        timestampLP: hlsResult.timestampLP,
        timestampFP: hlsResult.timestampFP
      };
      
      const updatedVideo = updateVideo('processHlsVideo', tabId, normalizedUrl, hlsUpdates);
      
      // Track variant-master relationships if this is a master playlist
      if (hlsResult.isMaster && hlsResult.variants && hlsResult.variants.length > 0) {
        handleVariantMasterRelationships(tabId, hlsResult.variants, normalizedUrl);
        
        // Process variants for detailed metadata and preview
        await this.processHlsVariants(tabId, normalizedUrl, hlsResult.variants);
      } 
    //   else if (hlsResult.isVariant) {
    //     // For standalone variants, generate preview directly
    //     await this.generatePreview(tabId, normalizedUrl, headers);
    //   }
      
      // Notify UI of complete update
      notifyVideoUpdated(tabId, normalizedUrl, updatedVideo || {});
      broadcastVideoUpdate(tabId);
    } else {
      // Update with error information
      updateVideo('processHlsVideo-error', tabId, normalizedUrl, {
        isValid: false,
        isLightParsed: true,
        timestampLP: hlsResult.timestampLP || Date.now(),
        parsingStatus: hlsResult.status,
        parsingError: hlsResult.error || 'Not a valid HLS manifest'
      });
      
      broadcastVideoUpdate(tabId);
    }
  }
  
  /**
   * Process DASH video
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   */
  async processDashVideo(tabId, normalizedUrl) {
    logger.debug(`Processing DASH video: ${normalizedUrl}`);
    
    const video = getVideo(tabId, normalizedUrl);
    if (!video) return;
    
    // Get headers for the request
    const headers = await getSharedHeaders(tabId, video.url);
    
    // Run combined validation and parsing
    const dashResult = await parseDashManifest(video.url, headers);
    
    if (dashResult.status === 'success') {
      // Update video with all DASH parsing results at once
      const dashUpdates = {
        isValid: true,
        type: 'dash',
        videoTracks: dashResult.videoTracks,
        audioTracks: dashResult.audioTracks,
        subtitleTracks: dashResult.subtitleTracks,
        variants: dashResult.variants, // For backward compatibility
        duration: dashResult.duration,
        isLive: dashResult.isLive,
        isEncrypted: dashResult.isEncrypted,
        encryptionType: dashResult.encryptionType,
        isLightParsed: true,
        isFullParsed: true,
        timestampLP: dashResult.timestampLP,
        timestampFP: dashResult.timestampFP
      };
      
      const updatedVideo = updateVideo('processDashVideo', tabId, normalizedUrl, dashUpdates);
      
      // Generate preview for the manifest
      await this.generatePreview(tabId, normalizedUrl, headers);
      
      // Notify UI of complete update
      notifyVideoUpdated(tabId, normalizedUrl, updatedVideo || {});
      broadcastVideoUpdate(tabId);
    } else {
      // Update with error information
      updateVideo('processDashVideo-error', tabId, normalizedUrl, {
        isValid: false,
        isLightParsed: true,
        timestampLP: dashResult.timestampLP || Date.now(),
        parsingStatus: dashResult.status,
        parsingError: dashResult.error || 'Not a valid DASH manifest'
      });
      
      broadcastVideoUpdate(tabId);
    }
  }
  
  /**
   * Process direct video file
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   */
  async processDirectVideo(tabId, normalizedUrl) {
    logger.debug(`Processing direct video: ${normalizedUrl}`);
    
    const video = getVideo(tabId, normalizedUrl);
    if (!video) return;
    
    // Get headers for the request
    const headers = await getSharedHeaders(tabId, video.url);
    
    // Run both operations in parallel
    await Promise.all([
      this.getFFprobeMetadata(tabId, normalizedUrl, headers),
      this.generatePreview(tabId, normalizedUrl, headers)
    ]);
    
    broadcastVideoUpdate(tabId);
  }
  
  /**
   * Process HLS variants (get FFprobe metadata and generate preview for best quality)
   * @param {number} tabId - Tab ID
   * @param {string} masterUrl - Normalized master URL
   * @param {Array} variants - Array of variant objects
   */
  async processHlsVariants(tabId, masterUrl, variants) {
    logger.debug(`Processing ${variants.length} HLS variants`);
    
    if (variants.length === 0) return;
    
    // Process best quality variant first for preview
    try {
      const bestVariant = variants[0];
      const headers = await getSharedHeaders(tabId, bestVariant.url);
      
      // Get FFprobe metadata and generate preview in parallel
      await Promise.all([
        this.getVariantFFprobeMetadata(tabId, masterUrl, bestVariant, 0, headers),
        this.generateVariantPreview(tabId, masterUrl, bestVariant, 0, headers)
      ]);
      
      // Process remaining variants for metadata only (skip preview)
      for (let i = 1; i < variants.length; i++) {
        const variant = variants[i];
        const variantHeaders = await getSharedHeaders(tabId, variant.url);
        await this.getVariantFFprobeMetadata(tabId, masterUrl, variant, i, variantHeaders);
      }
    } catch (error) {
      logger.error(`Error processing HLS variants: ${error.message}`);
    }
  }
  
  /**
   * Get FFprobe metadata for a variant
   * @param {number} tabId - Tab ID
   * @param {string} masterUrl - Normalized master URL
   * @param {Object} variant - Variant object
   * @param {number} index - Index of variant in master's variants array
   * @param {Object} headers - Request headers
   */
  async getVariantFFprobeMetadata(tabId, masterUrl, variant, index, headers) {
    try {
      logger.debug(`Getting FFprobe metadata for variant[${index}]: ${variant.url}`);
      
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
        updateVariantWithFFprobeData(tabId, masterUrl, index, ffprobeData);
      }
    } catch (error) {
      logger.error(`Error getting FFprobe data for variant: ${error.message}`);
    }
  }
  
  /**
   * Generate preview for a variant
   * @param {number} tabId - Tab ID
   * @param {string} masterUrl - Normalized master URL
   * @param {Object} variant - Variant object
   * @param {number} index - Index of variant in master's variants array
   * @param {Object} headers - Request headers
   */
  async generateVariantPreview(tabId, masterUrl, variant, index, headers) {
    try {
      const variantNormalizedUrl = normalizeUrl(variant.url);
      
      // Check for cached preview first
      const cachedPreview = await getPreview(variantNormalizedUrl);
      if (cachedPreview) {
        this.updateVariantWithPreview(tabId, masterUrl, index, cachedPreview, true);
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
        this.updateVariantWithPreview(tabId, masterUrl, index, response.previewUrl, false);
      }
    } catch (error) {
      logger.error(`Error generating preview for variant: ${error.message}`);
    }
  }
  
  /**
   * Update variant with preview URL
   * @param {number} tabId - Tab ID
   * @param {string} masterUrl - Normalized master URL
   * @param {number} index - Index of variant in master's variants array
   * @param {string} previewUrl - Preview URL
   * @param {boolean} fromCache - Whether preview was from cache
   */
  updateVariantWithPreview(tabId, masterUrl, index, previewUrl, fromCache) {
    const masterVideo = getVideo(tabId, masterUrl);
    if (!masterVideo || !masterVideo.variants || index >= masterVideo.variants.length) {
      return;
    }
    
    // Create updated variants array with the preview URL
    const updatedVariants = [...masterVideo.variants];
    updatedVariants[index] = {
      ...updatedVariants[index],
      previewUrl: previewUrl,
      fromCache: fromCache
    };
    
    // Update master with the new variants array
    const updatedVideo = updateVideo('updateVariantWithPreview', tabId, masterUrl, {
      variants: updatedVariants
    });
    
    if (updatedVideo) {
      logger.debug(`Updated variant[${index}] with preview: ${previewUrl}`);
      notifyVideoUpdated(tabId, masterUrl, updatedVideo);
      broadcastVideoUpdate(tabId);
    }
  }
  
  /**
   * Get FFprobe metadata for direct video
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   * @param {Object} headers - Request headers
   */
  async getFFprobeMetadata(tabId, normalizedUrl, headers) {
    try {
      const video = getVideo(tabId, normalizedUrl);
      if (!video) return;
      
      // Skip if already has metadata
      if (video.isFullyParsed) {
        logger.debug(`Video ${video.url} is already fully parsed, skipping FFprobe`);
        return;
      }
      
      logger.debug(`Getting FFprobe metadata for ${video.url}`);
      
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
        const updatedVideo = updateVideo('getFFprobeMetadata', tabId, normalizedUrl, {
          metaFFprobe: streamInfo,
          hasFFprobeMetadata: true,
          isFullyParsed: true,
          estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
          fileSize: streamInfo.sizeBytes || null
        });
        
        if (updatedVideo) {
          notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
        }
      }
    } catch (error) {
      logger.error(`Error getting FFprobe metadata: ${error.message}`);
    }
  }
  
  /**
   * Generate preview for video
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - Normalized video URL
   * @param {Object} headers - Request headers
   */
  async generatePreview(tabId, normalizedUrl, headers) {
    try {
      const video = getVideo(tabId, normalizedUrl);
      if (!video) return;
      
      // Skip if already has preview or is a blob
      if (video.previewUrl || video.poster || video.url.startsWith('blob:')) {
        return;
      }
      
      // Check for cached preview first
      const cachedPreview = await getPreview(normalizedUrl);
      if (cachedPreview) {
        const updatedVideo = updateVideo('generatePreview-cache', tabId, normalizedUrl, {
          previewUrl: cachedPreview,
          fromCache: true
        });
        
        if (updatedVideo) {
          notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
        }
        return;
      }
      
      // Generate preview if not cached
      logger.debug(`Generating preview for ${video.url}`);
      
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
        
        const updatedVideo = updateVideo('generatePreview', tabId, normalizedUrl, {
          previewUrl: response.previewUrl
        });
        
        if (updatedVideo) {
          notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
        }
      }
    } catch (error) {
      logger.error(`Error generating preview: ${error.message}`);
    }
  }
}

// Create the singleton instance
const videoProcessingPipeline = new VideoProcessingPipeline();

/**
 * Helper function to update video processing status
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} status - Processing status ('processing', 'complete', 'error')
 * @param {string} [errorMessage] - Optional error message
 */
function updateVideoStatus(tabId, normalizedUrl, status, errorMessage = null) {
  const updates = { isBeingProcessed: status === 'processing' };
  
  if (status === 'error' && errorMessage) {
    updates.error = errorMessage;
  }
  
  const updatedVideo = updateVideo(`updateVideoStatus-${status}`, tabId, normalizedUrl, updates);
  
  if (updatedVideo) {
    notifyVideoUpdated(tabId, normalizedUrl, updatedVideo);
  }
}

/**
 * Helper function to get a video from store
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @returns {Object|null} Video object or null if not found
 */
function getVideo(tabId, normalizedUrl) {
  const tabMap = allDetectedVideos.get(tabId);
  return tabMap ? tabMap.get(normalizedUrl) : null;
}

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
            headers = await getSharedHeaders(tabId, url);
        } else {
            headers = await getSharedHeaders(null, url);
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

    if (videoProcessingPipeline.queue.length > 0) {
        const originalCount = videoProcessingPipeline.queue.length;
        videoProcessingPipeline.queue = videoProcessingPipeline.queue.filter(
        item => item.tabId !== tabId
        );
        const removedCount = originalCount - videoProcessingPipeline.queue.length;
        if (removedCount > 0) {
        logger.debug(`Removed ${removedCount} queued items for closed tab ${tabId}`);
        }
    }
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
    }
    
    // Clean up variant-master relationships
    if (variantMasterMap.has(tabId)) {
        variantMasterMap.delete(tabId);
    }
    
    // Clear header cache for this tab
    clearHeaderCache(tabId);
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
            // And only for actual navigation events, not history state updates or other non-navigation events
            if (details.frameId === 0 && 
                details.transitionType !== 'auto_subframe' && 
                details.transitionQualifiers.indexOf('from_address_bar') !== -1) {
                
                logger.debug(`Navigation with transitionType: ${details.transitionType}, clearing tab ${details.tabId}`);
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
    
    allDetectedVideos.clear();
    variantMasterMap.clear();
    clearAllHeaderCaches();
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

    // Directly enqueue for processing with our unified pipeline
    videoProcessingPipeline.enqueue(tabId, normalizedUrl, newVideo.type);
    
    // Broadcast initial state to UI
    broadcastVideoUpdate(tabId);
    
    return true;
}

/**
 * Get videos for UI display with efficient filtering
 * @param {number} tabId - Tab ID
 * @returns {Array} Filtered and processed videos
 */
function getVideosForDisplay(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    if (!tabVideosMap) return [];
    
    const now = Date.now();
    
    // Create array directly from values() instead of entries()
    return Array.from(tabVideosMap.values())
        .filter(video => !(video.isVariant && video.hasKnownMaster))
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