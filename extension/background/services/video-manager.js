/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import { normalizeUrl } from '../../js/utilities/normalize-url.js';
import nativeHostService from '../../js/native-host-service.js';
import { getActivePopupPortForTab } from './ui-communication.js';
import { parseHlsManifest } from '../../js/utilities/hls-parser.js';
import { parseDashManifest } from '../../js/utilities/dash-parser.js';
import { getSharedHeaders, clearHeaderCache, clearAllHeaderCaches } from '../../js/utilities/headers-utils.js';
import { createLogger } from '../../js/utilities/logger.js';
import { getPreview, storePreview } from '../../js/utilities/preview-cache.js';
import { getFilenameFromUrl } from '../../popup/js/utilities.js';
import { standardizeResolution } from '../../popup/js/video-list/video-utils.js';

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
      isFullyParsed: true,
      isValid: true
    });
    
    if (updatedVideo) {
      // Use the unified communication function instead of calling both
      sendVideoUpdateToUI(tabId, normalizedUrl, { ...updatedVideo, _sendFullList: true });
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
        variants: hlsResult.variants,
        duration: hlsResult.duration,
        version: hlsResult.version, 
        isEncrypted: hlsResult.isEncrypted,
        encryptionType: hlsResult.encryptionType,
        isLightParsed: true,
        isFullParsed: true,
        timestampLP: hlsResult.timestampLP,
        timestampFP: hlsResult.timestampFP
      };
      
      const updatedVideo = updateVideo('processHlsVideo', tabId, normalizedUrl, hlsUpdates);
      
      // Track variant-master relationships if this is a master playlist
      if (hlsResult.isMaster && hlsResult.variants?.length > 0) {
        handleVariantMasterRelationships(tabId, hlsResult.variants, normalizedUrl);
        
        // Generate preview for the master using the first variant as source
        const firstVariant = hlsResult.variants[0];
        // Use unified preview function with source URL from first variant
        await this.generateVideoPreview(tabId, normalizedUrl, headers, firstVariant.url);
      } else {
        // For variant playlists, generate preview directly
        await this.generateVideoPreview(tabId, normalizedUrl, headers);
      }
      
      // Notify UI of complete update using unified approach
      sendVideoUpdateToUI(tabId, normalizedUrl, { ...(updatedVideo || {}), _sendFullList: true });
    } else {
      // Update with error information
      const errorVideo = updateVideo('processHlsVideo-error', tabId, normalizedUrl, {
        isValid: false,
        isLightParsed: true,
        timestampLP: hlsResult.timestampLP || Date.now(),
        parsingStatus: hlsResult.status,
        parsingError: hlsResult.error || 'Not a valid HLS manifest'
      });
      
      // Send update with the unified approach
      sendVideoUpdateToUI(tabId, normalizedUrl, { ...(errorVideo || {}), _sendFullList: true });
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
      await this.generateVideoPreview(tabId, normalizedUrl, headers);
      
      // Notify UI of complete update using unified approach
      sendVideoUpdateToUI(tabId, normalizedUrl, { ...(updatedVideo || {}), _sendFullList: true });
    } else {
      // Update with error information
      const errorVideo = updateVideo('processDashVideo-error', tabId, normalizedUrl, {
        isValid: false,
        isLightParsed: true,
        timestampLP: dashResult.timestampLP || Date.now(),
        parsingStatus: dashResult.status,
        parsingError: dashResult.error || 'Not a valid DASH manifest'
      });
      
      // Send update with the unified approach
      sendVideoUpdateToUI(tabId, normalizedUrl, { ...(errorVideo || {}), _sendFullList: true });
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

    const isAudio = video.mediaType === 'audio';

    if (isAudio) {
      logger.debug(`Skipping processing for 'audio' mediaType: ${normalizedUrl}`);
    } else {
      logger.debug(`Processing as video content: ${normalizedUrl}`);
      
      // Get metadata first, then generate preview with that metadata
      await this.getFFprobeMetadata(tabId, normalizedUrl, headers);
      
      // Get updated video with metadata for preview generation
      const updatedVideo = getVideo(tabId, normalizedUrl);
      if (updatedVideo.metaFFprobe?.hasVideo) {
        await this.generateVideoPreview(tabId, normalizedUrl, headers);
      }
    }
    
    // Send update with unified approach
    sendVideoUpdateToUI(tabId, normalizedUrl, { _sendFullList: true });
  }
  /**
   * Unified preview generation for all video types
   * @param {number} tabId - Tab ID
   * @param {string} normalizedUrl - URL to store the preview against
   * @param {Object} headers - Request headers
   * @param {string} [sourceUrl=null] - Optional source URL to generate from (if different)
   */
  async generateVideoPreview(tabId, normalizedUrl, headers, sourceUrl = null) {
      try {
          const video = getVideo(tabId, normalizedUrl);
          if (!video) return;
          
          // Skip if already has preview
          if (video.previewUrl || video.poster) {
              return;
          }
          
          // Check for cached preview first (using destination URL for cache lookup)
          const cachedPreview = await getPreview(normalizedUrl);
          if (cachedPreview) {
              const updatedVideo = updateVideo('generateVideoPreview-cache', tabId, normalizedUrl, {
                  previewUrl: cachedPreview,
                  fromCache: true
              });
              
              if (updatedVideo) {
                  sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
              }
              return;
          }
          
          // Determine source URL for preview generation
          const urlToUse = sourceUrl || video.url;
          logger.debug(`Generating preview for ${normalizedUrl} using source: ${urlToUse}`);
          
          // Request preview from native host
          const response = await rateLimiter.enqueue(async () => {
              return await nativeHostService.sendMessage({
                  type: 'generatePreview',
                  url: urlToUse,
                  headers: headers,
                  duration: video.duration || null
              });
          });
          
          if (response && response.previewUrl) {
              // Cache the generated preview
              await storePreview(normalizedUrl, response.previewUrl);
              
              const updatedVideo = updateVideo('generateVideoPreview', tabId, normalizedUrl, {
                  previewUrl: response.previewUrl,
                  previewSourceUrl: sourceUrl || null // Track where preview came from
              });
              
              if (updatedVideo) {
                  sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
              }
          }
      } catch (error) {
          logger.error(`Error generating preview: ${error.message}`);
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
                mediaType: 'direct',
                headers: headers
            });
            return response?.streamInfo || null;
        });
        
        if (streamInfo) {
            // Add standardizedResolution if height is available
            let standardizedRes = null;
            if (streamInfo.height) {
                standardizedRes = standardizeResolution(streamInfo.height);
            }
            
            const updatedVideo = updateVideo('getFFprobeMetadata', tabId, normalizedUrl, {
                isValid: true,
                metaFFprobe: streamInfo,
                duration: streamInfo.duration,
                isFullyParsed: true,
                standardizedResolution: standardizedRes, 
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null
            });
            
            if (updatedVideo) {
                // Use unified update approach
                sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
            }
        }
    } catch (error) {
        logger.error(`Error getting FFprobe metadata: ${error.message}`);
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
    // Use the unified approach for updates
    sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
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
 * Get a video by URL from any tab
 * @param {string} url - The URL of the video to find
 * @returns {Object|null} Video object or null if not found
 */
function getVideoByUrl(url) {
    try {
        const normalizedUrl = normalizeUrl(url);
        
        // Search through all tabs
        for (const [tabId, urlMap] of allDetectedVideos.entries()) {
            if (urlMap instanceof Map && urlMap.has(normalizedUrl)) {
                return urlMap.get(normalizedUrl);
            }
        }
        
        return null;
    } catch (err) {
        logger.error(`Error in getVideoByUrl: ${err.message}`);
        return null;
    }
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
 * Prepare video object for transmission
 * Creates a clean deep copy to ensure all properties are transmitted
 * @param {Object} video - The video object
 * @returns {Object} - Cleaned video object ready for transmission
 */
function prepareVideoForTransmission(video) {
    return {
        ...video,
        // Force a deep clone of complex objects to ensure all properties are transmitted
        metaFFprobe: video.metaFFprobe ? JSON.parse(JSON.stringify(video.metaFFprobe)) : null,
        metaJS: video.metaJS ? JSON.parse(JSON.stringify(video.metaJS)) : null,
        ...(video.variants ? { variants: JSON.parse(JSON.stringify(video.variants)) } : {}),
        // Add a marker so we can track which videos have been processed
        _processedByVideoManager: true
    };
}

/**
 * Unified function to send video updates to UI
 * Will automatically use the best available method
 * @param {number} tabId - Tab ID
 * @param {string} [singleVideoUrl] - Optional URL of a specific video to update
 * @param {Object} [singleVideoObj] - Optional video object to update (if provided with URL)
 */
function sendVideoUpdateToUI(tabId, singleVideoUrl = null, singleVideoObj = null) {
    // Get the port first to see if popup is open
    const port = getActivePopupPortForTab(tabId);
    
    // If we have a specific video URL but no object, try to get it
    if (singleVideoUrl && !singleVideoObj) {
        const video = getVideo(tabId, singleVideoUrl);
        if (video) {
            singleVideoObj = video;
        }
    }
    
    // If popup is open, use direct port communication for efficient updates
    if (port) {
        try {
            // If we have a specific video object, send just that update
            if (singleVideoUrl && singleVideoObj) {
                logger.debug(`Sending single video update via port for: ${singleVideoUrl}`);
                port.postMessage({
                    type: 'videoUpdated',
                    url: singleVideoUrl,
                    video: prepareVideoForTransmission(singleVideoObj)
                });
            }
            
            // Only for specific lifecycle events (like initializing) or when requested,
            // we send the full list to ensure the popup is synchronized
            if (!singleVideoUrl || singleVideoObj?._sendFullList) {
                const processedVideos = getVideosForDisplay(tabId);
                logger.info(`Sending full video list (${processedVideos.length} videos) via port for tab ${tabId}`);
                
                if (processedVideos.length > 0) {
                    port.postMessage({
                        action: 'videoStateUpdated',
                        tabId: tabId,
                        videos: processedVideos
                    });
                }
            }
            
            // Return success if we sent via port
            return true;
        } catch (e) {
            logger.debug(`Error sending update via port: ${e.message}, falling back to runtime message`);
            // Fall through to broadcast method
        }
    } else {
        // No port means popup isn't open, so we only update the maps for when popup opens later
        logger.debug(`No active popup for tab ${tabId}, updates will be shown when popup opens`);
        return false;
    }
    
    // As fallback only for full list updates, not individual video updates
    // This ensures any future opened popup gets the latest state
    if (!singleVideoUrl || singleVideoObj?._sendFullList) {
        try {
            const processedVideos = getVideosForDisplay(tabId);
            logger.debug(`Sending full list via runtime message for tab ${tabId} (fallback)`);
            
            chrome.runtime.sendMessage({
                action: 'videoStateUpdated',
                tabId: tabId,
                videos: processedVideos
            });
            
            return true;
        } catch (e) {
            // Ignore errors for sendMessage, as the popup might not be open
            logger.debug('Error sending video update message (popup may not be open):', e.message);
            return false;
        }
    }
    
    return false;
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
 * @returns {boolean|string} - True if this is a new video, 'updated' if an existing video was updated, false otherwise
 */
function addDetectedVideo(tabId, videoInfo) {

    logger.debug(`Received video for Tab ${tabId}, with this info:`, videoInfo);
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(videoInfo.url);

    // Check if this HLS is a known variant
    if (videoInfo.type === 'hls' && variantMasterMap.has(tabId)) {
        const tabVariantMap = variantMasterMap.get(tabId);
        if (tabVariantMap.has(normalizedUrl)) {
            videoInfo.isVariant = true;
            videoInfo.hasKnownMaster = true;
            videoInfo.masterUrl = tabVariantMap.get(normalizedUrl);
            logger.debug(`HLS variant detected: ${normalizedUrl} is a variant of master ${videoInfo.masterUrl}`);
        }
    }
    
    // Initialize tab's video collection if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    
    // Get the map for this specific tab
    const tabMap = allDetectedVideos.get(tabId);
    
    // Log source of video for debugging
    const sourceOfVideo = videoInfo.source || 'unknown';
    
    // Check if this is a duplicate
    if (tabMap.has(normalizedUrl)) {
        // Special handling for direct video types to merge metadata
        if (videoInfo.type === 'direct') {
            const existingVideo = tabMap.get(normalizedUrl);
            logger.debug(`Duplicate direct video found from ${sourceOfVideo}. Checking for metadata updates...`);
            
            // Track if we made any updates
            let updatesApplied = false;
            const updates = {};
            
            // Merge metadata if present in the new detection
            if (videoInfo.metadata && Object.keys(videoInfo.metadata).length > 0) {
                logger.debug(`Updating metadata for existing direct video: ${normalizedUrl}`);
                updates.metadata = {
                    ...(existingVideo.metadata || {}),
                    ...videoInfo.metadata
                };
                updatesApplied = true;
            }

            // Update mediaType if it's set in the new detection
            if (videoInfo.mediaType) {
                updates.mediaType = videoInfo.mediaType;
                updatesApplied = true;
            }

            // Update originalContainer if it's set in the new detection but missing in the existing one
            if (videoInfo.originalContainer && 
                (!existingVideo.originalContainer || existingVideo.originalContainer === 'null')) {
                logger.debug(`Updating originalContainer for existing direct video: ${normalizedUrl}`);
                updates.originalContainer = videoInfo.originalContainer;
                updatesApplied = true;

                // NEW: If type is unknown, update to 'direct'
                if (existingVideo.type === 'unknown') {
                    logger.debug(`Updating type to 'direct' for video with known originalContainer: ${normalizedUrl}`);
                    updates.type = 'direct';
                }
            }
            
            // If we have updates to apply, update the video
            if (updatesApplied) {
                const updatedVideo = updateVideo('addDetectedVideo-update', tabId, normalizedUrl, updates);
                
                // Notify UI of the update
                if (updatedVideo) {
                    sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
                }
                
                return 'updated';
            }
        }
        
        // For non-direct videos or when no updates needed
        const existingVideo = tabMap.get(normalizedUrl);
        logger.debug(`Duplicate video detection from ${sourceOfVideo}. URL: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return false;
    }
    
    // Add to tab's collection with basic info
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        tabId,
        isBeingProcessed: false,
        title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url)
    };
    
    updateVideo('addDetectedVideo', tabId, normalizedUrl, newVideo, true);
    logger.debug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type}, source: ${sourceOfVideo})`);

    // Directly enqueue for processing with our unified pipeline
    videoProcessingPipeline.enqueue(tabId, normalizedUrl, newVideo.type);
    
    // Broadcast initial state to UI with unified approach
    sendVideoUpdateToUI(tabId);
    
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
        .filter(video => !(video.isVariant && video.hasKnownMaster) && video.isValid && video.mediaType !== 'audio')
        .map(video => ({
            ...video,
            timestampLastProcessed: now,
            ...(video.poster ? { poster: video.poster } : {})
        }))
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
}

export {
    addDetectedVideo,
    sendVideoUpdateToUI,
    cleanupForTab,
    normalizeUrl,
    getAllDetectedVideos,
    getVideosForDisplay,
    clearVideoCache,
    initVideoManager,
    getVideoByUrl
};