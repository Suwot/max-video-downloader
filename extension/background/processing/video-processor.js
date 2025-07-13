/**
 * Video Processing Pipeline
 * Manages the flow of videos from detection through processing to UI display
 */

import { normalizeUrl } from '../../shared/utils/normalize-url.js';
import { createLogger } from '../../shared/utils/logger.js';
import { getFilenameFromUrl,standardizeResolution } from '../../shared/utils/video-utils.js';
import { getRequestHeaders, applyHeaderRule } from '../../shared/utils/headers-utils.js';
import { getPreview, storePreview } from '../../shared/utils/preview-cache.js';
import { parseHlsManifest, extractHlsVariantUrls } from './hls-parser.js';
import { parseDashManifest } from './dash-parser.js';
import nativeHostService from '../messaging/native-host-service.js';
import { 
    getVideo, 
    getVideoByUrl, 
    updateVideo, 
    handleVariantMasterRelationships,
    getVideosForDisplay
} from './video-store.js';

// Create a logger instance for the Video Processing Pipeline module
const logger = createLogger('Video Processor');

// Module-level state for video processing
const processingQueue = [];
const processingMap = new Map();
const MAX_CONCURRENT = 8; // Reduced since NHS handles connection management
    
/**
 * Enqueue a video for processing
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} videoType - Type of video (hls, dash, direct)
 */
function enqueue(tabId, normalizedUrl, videoType) {
    // Skip if dismissed
    const video = getVideo(tabId, normalizedUrl);
    if (video?.timestampDismissed) {
        logger.debug(`Not enqueueing dismissed video: ${normalizedUrl}`);
        return;
    }
    // Don't add duplicates to the queue
    if (processingQueue.some(item => item.normalizedUrl === normalizedUrl) || 
        processingMap.has(normalizedUrl)) {
        logger.debug(`Skipping duplicate: ${normalizedUrl} (in queue or processing)`);
        return;
    }
    
    processingQueue.push({ tabId, normalizedUrl, videoType });
    processNext();
    
    logger.debug(`Video queued for processing: ${normalizedUrl} (${videoType})`);
}
    
/**
 * Process next video in queue
 */
async function processNext() {
    // Skip if nothing to process or already at capacity
    if (processingQueue.length === 0 || processingMap.size >= MAX_CONCURRENT) {
        return;
    }
    
    const { tabId, normalizedUrl, videoType } = processingQueue.shift();
    
    // Skip if already processed or being processed
    if (processingMap.has(normalizedUrl)) {
        processNext(); // Try processing next item
        return;
    }
    
    // Mark as processing
    processingMap.set(normalizedUrl, Date.now());
    
    try {
        // Mark video as being processed in store
        updateVideo(`updateVideoStatus-processing`, tabId, normalizedUrl, { isBeingProcessed: true });

        // Route to appropriate processor based on type
        if (videoType === 'hls') {
            await processHlsVideo(tabId, normalizedUrl);
        } else if (videoType === 'dash') {
            await processDashVideo(tabId, normalizedUrl);
        } else {
            await processDirectVideo(tabId, normalizedUrl);
        }

        // Mark as complete
        updateVideo(`updateVideoStatus-complete`, tabId, normalizedUrl, { isBeingProcessed: false });
    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
        // Update video with error status
        updateVideo(`updateVideoStatus-error`, tabId, normalizedUrl, { isBeingProcessed: false, error: error.message });
    } finally {
        processingMap.delete(normalizedUrl);
        // Process next item in queue
        processNext();
    }
}
    
/**
 * Process an HLS video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processHlsVideo(tabId, normalizedUrl) {
    logger.debug(`Processing HLS video: ${normalizedUrl}`);
    
    const video = getVideo(tabId, normalizedUrl);
    if (!video) return;
    
    // Get headers for the request
    const headers = getRequestHeaders(tabId, video.url);
    
    // Run combined validation and parsing
    const hlsResult = await parseHlsManifest(video.url, headers, tabId);
    
    if (hlsResult.status === 'success') {
        let hlsUpdates;
        if (hlsResult.isMaster) {
            hlsUpdates = {
                isValid: true,
                type: 'hls',
                isMaster: true,
                isVariant: false,
                variants: hlsResult.variants,
                duration: hlsResult.duration,
                version: hlsResult.version,
                isEncrypted: hlsResult.isEncrypted,
                encryptionType: hlsResult.encryptionType,
                audioTracks: hlsResult.audioTracks || [],
                subtitles: hlsResult.subtitles || [],
                closedCaptions: hlsResult.closedCaptions || [],
                hasMediaGroups: hlsResult.hasMediaGroups || false,
                isLightParsed: true,
                isFullParsed: true,
                timestampLP: hlsResult.timestampLP,
                timestampFP: hlsResult.timestampFP
            };
        } else {
            hlsUpdates = {
                isValid: true,
                type: 'hls',
                isMaster: false,
                isVariant: true,
                duration: hlsResult.duration,
                version: hlsResult.version,
                isEncrypted: hlsResult.isEncrypted,
                encryptionType: hlsResult.encryptionType,
                isLightParsed: true,
                isFullParsed: true,
                timestampLP: hlsResult.timestampLP,
                timestampFP: hlsResult.timestampFP
            };
        }

        updateVideo('processHlsVideo', tabId, normalizedUrl, hlsUpdates);

        // Track variant-master relationships if this is a master playlist
        if (hlsResult.isMaster && hlsResult.variants?.length > 0) {
            handleVariantMasterRelationships(tabId, hlsResult.variants, normalizedUrl);

            // Generate preview for the master using the first variant as source
            const firstVariant = hlsResult.variants[0];
            await generateVideoPreview(tabId, normalizedUrl, headers, firstVariant.url);
        }
    } else {
        // Update with error information
        updateVideo('processHlsVideo-error', tabId, normalizedUrl, {
            isValid: false,
            isLightParsed: true,
            timestampLP: hlsResult.timestampLP || Date.now(),
            parsingStatus: hlsResult.status,
            parsingError: hlsResult.error || 'Not a valid HLS manifest'
        });
    }
}
    
/**
 * Process DASH video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processDashVideo(tabId, normalizedUrl) {
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
        
        updateVideo('processDashVideo', tabId, normalizedUrl, dashUpdates);
        
        // Generate preview for the manifest
        await generateVideoPreview(tabId, normalizedUrl, headers);
    } else {
        // Update with error information
        updateVideo('processDashVideo-error', tabId, normalizedUrl, {
            isValid: false,
            isLightParsed: true,
            timestampLP: dashResult.timestampLP || Date.now(),
            parsingStatus: dashResult.status,
            parsingError: dashResult.error || 'Not a valid DASH manifest'
        });
    }
}
    
/**
 * Process direct video file
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processDirectVideo(tabId, normalizedUrl) {
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
        await getFFprobeMetadata(tabId, normalizedUrl, headers);
        
        // Get updated video with metadata for preview generation
        const updatedVideo = getVideo(tabId, normalizedUrl);
        if (updatedVideo.metaFFprobe?.hasVideo) {
            await generateVideoPreview(tabId, normalizedUrl, headers);
        }
    }
}

/**
 * Unified preview generation for all video types
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - URL to store the preview against
 * @param {Object} headers - Request headers
 * @param {string} [sourceUrl=null] - Optional source URL to generate from (if different)
 */
async function generateVideoPreview(tabId, normalizedUrl, headers, sourceUrl = null) {
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
            updateVideo('generateVideoPreview-cache', tabId, normalizedUrl, { previewUrl: cachedPreview });
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
            
            updateVideo('generateVideoPreview', tabId, normalizedUrl, {
                previewUrl: response.previewUrl,
                previewSourceUrl: sourceUrl || null // Track where preview came from
            });
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
function determineDirectDefaultContainer(video, streamInfo) {
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
async function getFFprobeMetadata(tabId, normalizedUrl, headers) {
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
            const defaultContainer = determineDirectDefaultContainer(video, streamInfo);

            updateVideo('getFFprobeMetadata', tabId, normalizedUrl, {
                isValid,
                metaFFprobe: streamInfo,
                duration: streamInfo.duration,
                isFullyParsed: true,
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null,
                defaultContainer: defaultContainer
            });
        } else {
            logger.warn(`No stream info in ffprobe response for: ${normalizedUrl}`);
            // Do NOT set isValid: false here, just log
        }
    } catch (error) {
        logger.error(`Error getting FFprobe metadata for ${normalizedUrl}: ${error.message}`);
        // Do NOT set isValid: false here, just log
    }
}

/**
 * Clean up processing queue for a specific tab
 * @param {number} tabId - Tab ID
 */
function cleanupProcessingQueueForTab(tabId) {
    if (processingQueue.length > 0) {
        const originalCount = processingQueue.length;
        const filteredQueue = processingQueue.filter(item => item.tabId !== tabId);
        const removedCount = originalCount - filteredQueue.length;
        if (removedCount > 0) {
            logger.debug(`Removed ${removedCount} queued items for tab ${tabId}`);
        }
        // Replace array contents to maintain reference
        processingQueue.length = 0;
        processingQueue.push(...filteredQueue);
    }
}

/**
 * Clear all processing queues
 */
function clearAll() {
    processingQueue.length = 0;
    processingMap.clear();
}

/**
 * Add detected video to the central tracking map and enqueue for processing
 * This is the main entry point for video processing orchestration
 * @param {number} tabId - The tab ID where the video was detected
 * @param {Object} videoInfo - Information about the detected video
 * @returns {boolean|string} - True if this is a new video, 'updated' if an existing video was updated, false otherwise
 */
function addDetectedVideo(tabId, videoInfo) {
    logger.debug(`Received video for Tab ${tabId}, with this info:`, videoInfo);
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(videoInfo.url);

    // Get access to internal maps via globalThis
    const allDetectedVideos = globalThis.allDetectedVideosInternal;
    const variantMasterMap = globalThis.variantMasterMapInternal;
    
    // Check if this HLS is a known variant and don't process it, just store in a map with enriched info about its master
    if (videoInfo.type === 'hls' && variantMasterMap?.has(tabId)) {
        const tabVariantMap = variantMasterMap.get(tabId);
        if (tabVariantMap.has(normalizedUrl)) {
            logger.debug(`Known HLS variant detected: ${normalizedUrl}. Master ${tabVariantMap.get(normalizedUrl)} (stored in map, skipping processing and UI update)`);

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
                updateVideo('addDetectedVideo-knownVariant', tabId, normalizedUrl, newVideo, true, false);
                // Note: No UI update for known variants as they're filtered out from display
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
        const existingVideo = tabMap.get(normalizedUrl);
        
        // Special handling for HLS master playlists: extract new variant URLs for deduplication
        if (videoInfo.type === 'hls' && existingVideo.isMaster) {
            logger.debug(`Duplicate HLS master detected: ${normalizedUrl}. Extracting new variant URLs for deduplication.`);
            
            // Extract variant URLs asynchronously without blocking the main flow
            extractHlsVariantUrls(videoInfo.url, getRequestHeaders(tabId, videoInfo.url), tabId)
                .then(variantUrls => {
                    if (variantUrls.length > 0) {
                        // Update variant-master map with new URLs
                        if (!variantMasterMap.has(tabId)) {
                            variantMasterMap.set(tabId, new Map());
                        }
                        const tabVariantMap = variantMasterMap.get(tabId);
                        
                        for (const variantUrl of variantUrls) {
                            tabVariantMap.set(variantUrl, normalizedUrl);
                            logger.debug(`Updated variant-master mapping: ${variantUrl} -> ${normalizedUrl}`);
                        }
                        
                        logger.debug(`Updated ${variantUrls.length} variant URLs for duplicate master ${normalizedUrl}`);
                    }
                })
                .catch(error => {
                    logger.warn(`Failed to extract variant URLs for duplicate master ${normalizedUrl}:`, error.message);
                });
        }
        
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

    // Enqueue for processing
    enqueue(tabId, normalizedUrl, newVideo.type);
    
    return true;
}

export {
    enqueue,
    cleanupProcessingQueueForTab,
    clearAll,
    addDetectedVideo
};
