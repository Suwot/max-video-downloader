/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import { normalizeUrl } from '../../shared/utils/normalize-url.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getActivePopupPortForTab } from '../messaging/popup-communication.js';
import { parseHlsManifest } from './hls-parser.js';
import { parseDashManifest } from './dash-parser.js';
import { getRequestHeaders, applyHeaderRule } from '../../shared/utils/headers-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { getPreview, storePreview } from '../../shared/utils/preview-cache.js';
import { standardizeResolution, getFilenameFromUrl } from '../../shared/utils/video-utils.js';

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Track relationships between variants and their master playlists
// Map<tabId, Map<normalizedVariantUrl, masterUrl>>
const variantMasterMap = new Map();

// Track dismissed videos per tab
// Map<tabId, Set<normalizedUrl>>
const dismissedVideos = new Map();

// Track tabs that have valid, displayable videos for icon management
// Set<tabId> - if tab is in set, it has videos (colored icon)
const tabsWithVideos = new Set();

// Expose allDetectedVideos for debugging
globalThis.allDetectedVideosInternal = allDetectedVideos;

// Create a logger instance for the Video Manager module
const logger = createLogger('Video Manager');

/**
 * Unified video processing pipeline
 * Manages the flow of videos from detection through processing to UI display
 */
class VideoProcessingPipeline {
    constructor() {
        this.queue = [];
        this.processing = new Map();
        this.MAX_CONCURRENT = 8; // Reduced since NHS handles connection management
    }
    
    /**
     * Enqueue a video for processing
     * @param {number} tabId - Tab ID
     * @param {string} normalizedUrl - Normalized video URL
     * @param {string} videoType - Type of video (hls, dash, direct)
     */
    enqueue(tabId, normalizedUrl, videoType) {
        // Skip if dismissed
        if (isVideoDismissed(tabId, normalizedUrl)) {
            logger.debug(`Not enqueueing dismissed video: ${normalizedUrl}`);
            return;
        }
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
            if (videoType === 'hls') {
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
     * Process an HLS video
     * @param {number} tabId - Tab ID
     * @param {string} normalizedUrl - Normalized video URL
     */
    async processHlsVideo(tabId, normalizedUrl) {
        logger.debug(`Processing HLS video: ${normalizedUrl}`);
        
        const video = getVideo(tabId, normalizedUrl);
        if (!video) return;
        
        // Get headers for the request
        const headers = getRequestHeaders(tabId, video.url);
        
        // Run combined validation and parsing
        const hlsResult = await parseHlsManifest(video.url, headers, tabId);
        
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
                await this.generateVideoPreview(tabId, normalizedUrl, headers, firstVariant.url);
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
        const headers = getRequestHeaders(tabId, video.url);
        
        // Run combined validation and parsing
        const dashResult = await parseDashManifest(video.url, headers, tabId);
        
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
        const headers = getRequestHeaders(tabId, video.url);

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
            if (!video) {
                logger.debug(`No video found for preview generation: ${normalizedUrl}`);
                return;
            }
            
            // Skip if already has preview
            if (video.previewUrl || video.poster) {
                logger.debug(`Video already has preview, skipping: ${normalizedUrl}`);
                return;
            }
            
            // Check for cached preview first (using destination URL for cache lookup)
            const cachedPreview = await getPreview(normalizedUrl);
            if (cachedPreview) {
                logger.debug(`Using cached preview for: ${normalizedUrl}`);
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
            
            // Apply header rule before sending to native host
            await applyHeaderRule(tabId, urlToUse);
            
            // Direct call to NHS - generates preview and expects response
            const response = await nativeHostService.sendMessage({
                command: 'generatePreview',
                url: urlToUse,
                headers: headers,
                duration: video.duration || null
            });
                        
            if (response && response.previewUrl) {
                logger.debug(`Generated preview successfully for: ${normalizedUrl}`);
                
                // Cache the generated preview
                await storePreview(normalizedUrl, response.previewUrl);
                
                const updatedVideo = updateVideo('generateVideoPreview', tabId, normalizedUrl, {
                    previewUrl: response.previewUrl,
                    previewSourceUrl: sourceUrl || null // Track where preview came from
                });
                
                if (updatedVideo) {
                    sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
                }
            } else {
                logger.debug(`No preview URL in response for: ${normalizedUrl}`);
            }
        } catch (error) {
            logger.error(`Error generating preview for ${normalizedUrl}: ${error.message}`);
        }
    }
    
    /**
     * Determine default container for direct videos based on FFprobe data
     * @param {Object} video - Video object
     * @param {Object} streamInfo - FFprobe stream info
     * @returns {string} Default container format
     * @private
     */
    determineDirectDefaultContainer(video, streamInfo) {
        // 1. Use FFprobe container info (most reliable)
        if (streamInfo?.container) {
            const container = streamInfo.container.toLowerCase();
            if (container.includes('mp4') || container.includes('quicktime')) return 'mp4';
            if (container.includes('webm') || container.includes('matroska')) return 'webm';
            if (container.includes('mkv')) return 'mkv';
            if (container.includes('mov')) return 'mp4'; // MOV -> MP4 for compatibility
            logger.warn('Unrecognized FFprobe container:', { container, video, streamInfo });
        }
        
        // 2. Use headers content-type
        if (video.metadata?.contentType) {
            if (video.metadata.contentType.includes('mp4')) return 'mp4';
            if (video.metadata.contentType.includes('webm')) return 'webm';
            logger.warn('Unrecognized contentType for container:', { contentType: video.metadata.contentType, video });
        }
        
        // 3. URL detection fallback
        if (video.originalContainer) {
            const container = video.originalContainer.toLowerCase();
            if (['mp4', 'webm', 'mkv'].includes(container)) return container;
            if (['mov', 'm4v'].includes(container)) return 'mp4';
            logger.warn('Unrecognized originalContainer:', { originalContainer: video.originalContainer, video });
        }
        
        // 4. Final fallback
        logger.warn('Falling back to default container "mp4":', { video, streamInfo });
        return 'mp4';
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
            if (!video) {
                logger.debug(`No video found for FFprobe: ${normalizedUrl}`);
                return;
            }

            // Skip if already has metadata
            if (video.isFullyParsed) {
                logger.debug(`Video ${video.url} is already fully parsed, skipping FFprobe`);
                return;
            }

            logger.debug(`Getting FFprobe metadata for ${video.url}`);

            // Apply header rule before sending to native host
            await applyHeaderRule(tabId, video.url);

            // Direct call to NHS - gets ffprobe data and expects response
            const response = await nativeHostService.sendMessage({
                command: 'getQualities',
                url: video.url,
                mediaType: 'direct',
                headers: headers
            });

            const streamInfo = response?.streamInfo || null;

            if (streamInfo) {
                logger.debug(`Got FFprobe metadata for ${normalizedUrl}`);

                // Add standardizedResolution if height is available
                let standardizedRes = null;
                if (streamInfo.height) {
                    standardizedRes = standardizeResolution(streamInfo.height);
                }

                // Only set isValid: false if ffprobe confirms not a video
                const isValid = streamInfo.hasVideo === false ? false : true;

                // Determine default container from FFprobe data
                const defaultContainer = this.determineDirectDefaultContainer(video, streamInfo);

                const updatedVideo = updateVideo('getFFprobeMetadata', tabId, normalizedUrl, {
                    isValid,
                    metaFFprobe: streamInfo,
                    duration: streamInfo.duration,
                    isFullyParsed: true,
                    standardizedResolution: standardizedRes,
                    estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                    fileSize: streamInfo.sizeBytes || null,
                    defaultContainer: defaultContainer
                });

                if (updatedVideo) {
                    sendVideoUpdateToUI(tabId, normalizedUrl, updatedVideo);
                }
            } else {
                logger.warn(`No stream info in ffprobe response for: ${normalizedUrl}`);
                // Do NOT set isValid: false here, just log
            }
        } catch (error) {
            logger.error(`Error getting FFprobe metadata for ${normalizedUrl}: ${error.message}`);
            // Do NOT set isValid: false here, just log
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
    // Always recalculate validForDisplay
    updatedVideo.validForDisplay = calculateValidForDisplay(updatedVideo);
    // Set the value in the map
    tabMap.set(normalizedUrl, updatedVideo);
    logger.debug(`Video updated by ${functionName}: ${normalizedUrl}`, updatedVideo);
    return updatedVideo;
}

/**
 * Calculate if a video is valid for display in the UI
 * @param {Object} video - Video object
 * @returns {boolean}
 */
function calculateValidForDisplay(video) {
    if (!video || !video.isValid) return false;
    if (video.type === 'hls') {
        // Only standalone variants without known masters, or master playlists
        if (video.isVariant && video.hasKnownMaster) return false;
        return true;
    }
    // For dash and direct, only if isValid
    return true;
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
    
    // Update tab icon when videos change
    updateTabIcon(tabId);
    
    // If popup is open, use direct port communication for efficient updates
    if (port) {
        try {
            // If we have a specific video object, send just that update
            if (singleVideoUrl && singleVideoObj) {
                logger.debug(`Sending single video update via port for: ${singleVideoUrl}`);
                port.postMessage({
                    command: 'videoUpdated',
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
                        command: 'videoStateUpdated',
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
                command: 'videoStateUpdated',
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

/**
 * Update extension icon for a specific tab based on video availability
 * @param {number} tabId - Tab ID to update icon for
 */
function updateTabIcon(tabId) {
    if (!tabId || tabId < 0) return;
    
    // Check if tab has any valid, displayable videos
    const hasValidVideos = getVideosForDisplay(tabId).length > 0;
    const wasInSet = tabsWithVideos.has(tabId);
    
    // Only update if state changed
    if (hasValidVideos === wasInSet) return;
    
    // Update set state
    if (hasValidVideos) {
        tabsWithVideos.add(tabId);
    } else {
        tabsWithVideos.delete(tabId);
    }
    
    try {
        if (hasValidVideos) {
            // Set colored icon
            chrome.action.setIcon({
                tabId,
                path: {
                    "16": "../icons/16.png",
                    "32": "../icons/32.png", 
                    "48": "../icons/48.png",
                    "128": "../icons/128.png"
                }
            });
        } else {
            // Set B&W icon
            chrome.action.setIcon({
                tabId,
                path: {
                    "16": "../icons/16-bw.png",
                    "32": "../icons/32-bw.png",
                    "48": "../icons/48-bw.png", 
                    "128": "../icons/128-bw.png"
                }
            });
        }
        
        logger.debug(`Tab ${tabId} icon updated: ${hasValidVideos ? 'colored' : 'B&W'}`);
    } catch (error) {
        logger.warn(`Failed to update icon for tab ${tabId}:`, error);
    }
}

// Clean up for tab
function cleanupVideosForTab(tabId, resetIcon = true) {
    logger.debug(`Cleaning up videos for tab ${tabId}`);

    if (videoProcessingPipeline.queue.length > 0) {
        const originalCount = videoProcessingPipeline.queue.length;
        videoProcessingPipeline.queue = videoProcessingPipeline.queue.filter(
        item => item.tabId !== tabId
        );
        const removedCount = originalCount - videoProcessingPipeline.queue.length;
        if (removedCount > 0) {
        logger.debug(`Removed ${removedCount} queued items for tab ${tabId}`);
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
    
    // Clean up dismissed videos
    if (dismissedVideos.has(tabId)) {
        dismissedVideos.delete(tabId);
    }
    
    // Clean up icon state and reset to B&W
    if (tabsWithVideos.has(tabId)) {
        tabsWithVideos.delete(tabId);

        if (resetIcon) {
            try {
                chrome.action.setIcon({
                    tabId,
                    path: {
                        "16": "../icons/16-bw.png",
                        "32": "../icons/32-bw.png",
                        "48": "../icons/48-bw.png",
                        "128": "../icons/128-bw.png"
                    }
                });
            } catch (error) {
                // Tab might already be closed, ignore error
            }
        }
    }
}

/**
 * Initialize video manager service
 * @returns {Promise<boolean>} Success status
 */
async function initVideoManager() {
    logger.info('Initializing video manager service');
    
    try {        
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

    // Check if this HLS is a known variant and don't process it, just store in a map with enriched info about its master
    if (videoInfo.type === 'hls' && variantMasterMap.has(tabId)) {
        const tabVariantMap = variantMasterMap.get(tabId);
        if (tabVariantMap.has(normalizedUrl)) {
            logger.debug(`Known HLS variant detected: ${normalizedUrl}. Master ${videoInfo.masterUrl} (stored in map, skipping processing and UI update)`);

            // Initialize tab's video collection if it doesn't exist
            if (!allDetectedVideos.has(tabId)) {
                allDetectedVideos.set(tabId, new Map());
            }
            const tabMap = allDetectedVideos.get(tabId);
            // Only add if not already present
            if (!tabMap.has(normalizedUrl)) {
                const newVideo = {
                    ...videoInfo,
                    isVariant: true,
                    hasKnownMaster: true,
                    masterUrl: tabVariantMap.get(normalizedUrl),
                    normalizedUrl,
                    isBeingProcessed: false,
                    title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url),
                    isValid: true // it's a known variant, so we consider it valid
                };
                // validForDisplay will be set by updateVideo
                updateVideo('addDetectedVideo-knownVariant', tabId, normalizedUrl, newVideo, true);
            }
            // Do not enqueue for processing or update UI
            return;
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
        // For non-direct videos or when no updates needed
        const existingVideo = tabMap.get(normalizedUrl);
        logger.debug(`Duplicate video detection from ${sourceOfVideo}. URL: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return;
    }
    
    // Add to tab's collection with basic info
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        isBeingProcessed: false,
        title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url),
        // Set isValid: true for direct videos immediately
        ...(videoInfo.type === 'direct' ? { isValid: true } : {})
    };
    // validForDisplay will be set by updateVideo
    updateVideo('addDetectedVideo', tabId, normalizedUrl, newVideo, true);
    logger.debug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type}, source: ${sourceOfVideo})`);

    // Directly enqueue for processing with our unified pipeline
    videoProcessingPipeline.enqueue(tabId, normalizedUrl, newVideo.type);

    // Broadcast initial state to UI with unified approach
    sendVideoUpdateToUI(tabId);

    return;
}

// Dismiss a video for a tab (hide from UI, skip processing)
function dismissVideoFromTab(tabId, url) {
    if (!dismissedVideos.has(tabId)) {
        dismissedVideos.set(tabId, new Set());
    }
    dismissedVideos.get(tabId).add(url);
    logger.info(`Dismissed video ${url} for tab ${tabId}`);
    
    // Update icon after dismissing video
    updateTabIcon(tabId);
}

// Restore a dismissed video for a tab (show in UI, allow processing)
function restoreVideoInTab(tabId, url) {
    if (dismissedVideos.has(tabId)) {
        dismissedVideos.get(tabId).delete(url);
        logger.info(`Restored video ${url} for tab ${tabId}`);
        sendVideoUpdateToUI(tabId); // Refresh UI
    }
}

// Checks if a video is dismissed for a tab
function isVideoDismissed(tabId, url) {
    return dismissedVideos.has(tabId) && dismissedVideos.get(tabId).has(url);
}

/**
 * Get videos for UI display with efficient filtering
 * @param {number} tabId - Tab ID
 * @returns {Array} Filtered and processed videos
 */
function getVideosForDisplay(tabId) {
    const tabVideosMap = allDetectedVideos.get(tabId);
    if (!tabVideosMap) return [];

    return Array.from(tabVideosMap.values())
        .filter(video => video.validForDisplay && !isVideoDismissed(tabId, video.normalizedUrl))
        .sort((a, b) => b.timestampDetected - a.timestampDetected);
}

// function to cleanup both video maps: allDetectedVideos variantMasterMap – in global scope
function cleanupAllVideos() {
    logger.debug('Cleaning up all detected videos');
    
    // Reset all tab icons to B&W before clearing
    for (const tabId of tabsWithVideos) {
        try {
            chrome.action.setIcon({
                tabId,
                path: {
                    "16": "../icons/16-bw.png",
                    "32": "../icons/32-bw.png",
                    "48": "../icons/48-bw.png",
                    "128": "../icons/128-bw.png"
                }
            });
        } catch (error) {
            // Tab might be closed, ignore error
        }
    }
    
    allDetectedVideos.clear();
    variantMasterMap.clear();
    videoProcessingPipeline.queue = [];
    videoProcessingPipeline.processing.clear();
    dismissedVideos.clear();
    tabsWithVideos.clear();
    logger.info('All detected videos cleared');
}


export {
    addDetectedVideo,
    sendVideoUpdateToUI,
    cleanupVideosForTab,
    cleanupAllVideos,
    normalizeUrl,
    getVideosForDisplay,
    initVideoManager,
    getVideoByUrl,
    dismissVideoFromTab,
    restoreVideoInTab,
    updateTabIcon
};