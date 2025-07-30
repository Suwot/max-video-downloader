/**
 * Video Processing Pipeline
 * Manages the flow of videos from detection through processing to UI display
 */

import { normalizeUrl } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { standardizeResolution, getFilenameFromUrl } from '../../shared/utils/processing-utils.js';
import { detectAllContainers } from './container-detector.js';

import { getPreview, storePreview } from '../../shared/utils/preview-cache.js';
import { parseHlsManifest, extractHlsMediaUrls } from './hls-parser.js';
import { parseDashManifest } from './dash-parser.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getVideo, updateVideo } from './video-store.js';
import { settingsManager } from '../index.js';

// Create a logger instance for the Video Processing Pipeline module
const logger = createLogger('Video Processor');

// Module-level state for video processing
const processingQueue = [];
const processingMap = new Map();
const MAX_CONCURRENT = 8; // Reduced since NHS handles connection management


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
    
    // Check if this HLS is a known media item (variant, audio track, or subtitle) and don't process it, just store in a map with enriched info about its master
    if (videoInfo.type === 'hls' && variantMasterMap?.has(tabId)) {
        const tabVariantMap = variantMasterMap.get(tabId);
        if (tabVariantMap.has(normalizedUrl)) {
            logger.debug(`Known HLS media item detected: ${normalizedUrl}. Master ${tabVariantMap.get(normalizedUrl)} (stored in map, skipping processing and UI update)`);

            // Initialize tab's video collection if it doesn't exist
            if (!allDetectedVideos.has(tabId)) {
                allDetectedVideos.set(tabId, new Map());
            }
            const tabMap = allDetectedVideos.get(tabId);
            // Only add if not already present
            if (!tabMap.has(normalizedUrl)) {
                const newVideo = {
                    ...videoInfo,
                    isVariant: true, // Generic flag for any media item from a master
                    hasKnownMaster: true,
                    masterUrl: tabVariantMap.get(normalizedUrl),
                    normalizedUrl,
                    isBeingProcessed: false,
                    title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url),
                    isValid: true // it's a known media item, so we consider it valid
                };
                // validForDisplay will be set by updateVideo
                updateVideo('addDetectedVideo-knownMediaItem', tabId, normalizedUrl, newVideo, true, false);
                // Note: No UI update for known media items as they're filtered out from display
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
        
        // Special handling for HLS master playlists: extract all media URLs for comprehensive deduplication
        if (videoInfo.type === 'hls' && existingVideo.isMaster) {
            logger.debug(`Duplicate HLS master detected: ${normalizedUrl}. Extracting all media URLs for comprehensive deduplication.`);
            
            // Extract all media URLs (video tracks, audio tracks, subtitle tracks) asynchronously without blocking the main flow
            extractHlsMediaUrls(videoInfo.url, videoInfo.headers || {}, tabId)
                .then(mediaUrls => {
                    const totalUrls = mediaUrls.videoTracks.length + mediaUrls.audioTracks.length + mediaUrls.subtitleTracks.length;
                    if (totalUrls > 0) {
                        // Convert URL arrays to objects format expected by handleVariantMasterRelationships
                        const videoTracks = mediaUrls.videoTracks.map(url => ({ normalizedUrl: url }));
                        const audioTracks = mediaUrls.audioTracks.map(url => ({ normalizedUrl: url }));
                        const subtitleTracks = mediaUrls.subtitleTracks.map(url => ({ normalizedUrl: url }));
                        
                        // Use existing handleVariantMasterRelationships function for consistent processing
                        handleVariantMasterRelationships(tabId, videoTracks, audioTracks, subtitleTracks, normalizedUrl);

                        logger.debug(`Updated ${totalUrls} media URLs for duplicate master ${normalizedUrl} (${mediaUrls.videoTracks.length} video tracks, ${mediaUrls.audioTracks.length} audio tracks, ${mediaUrls.subtitleTracks.length} subtitle tracks)`);
                    }
                })
                .catch(error => {
                    logger.warn(`Failed to extract media URLs for duplicate master ${normalizedUrl}:`, error.message);
                });
        }
        
        logger.debug(`Duplicate video detection from ${sourceOfVideo}. URL: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return;
    }
    
    // Determine initial processing state based on queue capacity
    const willProcessImmediately = processingMap.size < MAX_CONCURRENT;
    
    // Add to tab's collection with basic info and initial processing state
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        isBeingProcessed: willProcessImmediately,
        // Set parsing flags based on type and immediate processing
        ...(willProcessImmediately && (videoInfo.type === 'hls' || videoInfo.type === 'dash') ? { parsing: true } : {}),
        ...(willProcessImmediately && videoInfo.type === 'direct' ? { runningFFprobe: true } : {}),
        title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url),
        // Set isValid: true optimistically for all video types
        isValid: true,
        // Include containers at video level if set during detection
        ...(videoInfo.videoContainer && { videoContainer: videoInfo.videoContainer }),
        ...(videoInfo.audioContainer && { audioContainer: videoInfo.audioContainer }),
        ...(videoInfo.containerDetectionReason && { containerDetectionReason: videoInfo.containerDetectionReason }),
        // Standardize all video types to have track arrays
        ...(videoInfo.type === 'direct' ? {
            videoTracks: [{
                url: videoInfo.url,
                normalizedUrl: normalizedUrl,
                type: 'direct',
                // Include containers if they were set during detection
                ...(videoInfo.videoContainer && { videoContainer: videoInfo.videoContainer }),
                ...(videoInfo.audioContainer && { audioContainer: videoInfo.audioContainer }),
                ...(videoInfo.containerDetectionReason && { containerDetectionReason: videoInfo.containerDetectionReason })
            }],
            audioTracks: [],
            subtitleTracks: []
        } : {})
    };
    
    // validForDisplay will be set by updateVideo
    updateVideo('addDetectedVideo', tabId, normalizedUrl, newVideo, true);
    logger.debug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type}, source: ${sourceOfVideo}, immediate processing: ${willProcessImmediately})`);

    // Enqueue for processing
    enqueue(tabId, normalizedUrl, newVideo.type);
    
    return true;
}
    
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
        // Only update processing status if video was queued (not immediately processed)
        const video = getVideo(tabId, normalizedUrl);
        if (video && !video.isBeingProcessed) {
            const processingFlags = {
                isBeingProcessed: true,
                ...(videoType === 'hls' || videoType === 'dash' ? { parsing: true } : {}),
                ...(videoType === 'direct' ? { runningFFprobe: true } : {})
            };
            updateVideo(`processNext-dequeued`, tabId, normalizedUrl, processingFlags);
        }

        // Route to appropriate processor based on type
        if (videoType === 'hls') {
            await processHlsVideo(tabId, normalizedUrl);
        } else if (videoType === 'dash') {
            await processDashVideo(tabId, normalizedUrl);
        } else {
            await processDirectVideo(tabId, normalizedUrl);
        }

    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
        // Update video with error status and clear all processing flags
        updateVideo(`processNext-error`, tabId, normalizedUrl, { 
            isBeingProcessed: false, 
            parsing: false,
            runningFFprobe: false,
            error: error.message 
        });
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
    const headers = video.headers || {};
    
    // Run combined validation and parsing
    const hlsResult = await parseHlsManifest(video.url);
    
    if (hlsResult.status === 'success') {
        // HLS parser now outputs standardized structure with videoTracks[]
        const hlsUpdates = {
            ...hlsResult,
            isBeingProcessed: false,
            parsing: false
        };
        updateVideo('processHlsVideo', tabId, normalizedUrl, hlsUpdates);

        // Track variant-master relationships if this is a master playlist
        if (hlsResult.isMaster && hlsResult.videoTracks?.length > 0) {
            handleVariantMasterRelationships(
                tabId, 
                hlsResult.videoTracks, 
                hlsResult.audioTracks, 
                hlsResult.subtitleTracks, 
                normalizedUrl
            );

            // Generate preview for the master using the first video track as source (if enabled)
            if (settingsManager.get('autoGeneratePreviews')) {
                const firstVideoTrack = hlsResult.videoTracks[0];
                await generateVideoPreview(tabId, normalizedUrl, headers, firstVideoTrack.url);
            }
        }
    } else {
        // Update with error information and clear processing flags
        updateVideo('processHlsVideo-error', tabId, normalizedUrl, {
            isValid: false,
            isBeingProcessed: false,
            parsing: false,
            timestampValidated: hlsResult.timestampValidated || Date.now(),
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
    const headers = video.headers || {};
    
    // Run combined validation and parsing
    const dashResult = await parseDashManifest(video.url);
    
    if (dashResult.status === 'success') {
        // DASH already has standardized structure with videoTracks[]
        const dashUpdates = {
            isValid: true,
            type: 'dash',
            videoTracks: dashResult.videoTracks,
            audioTracks: dashResult.audioTracks,
            subtitleTracks: dashResult.subtitleTracks,
            duration: dashResult.duration,
            isLive: dashResult.isLive,
            isEncrypted: dashResult.isEncrypted,
            encryptionType: dashResult.encryptionType,
            timestampValidated: dashResult.timestampValidated,
            timestampParsed: dashResult.timestampParsed,
            isBeingProcessed: false,
            parsing: false
        };
        
        updateVideo('processDashVideo', tabId, normalizedUrl, dashUpdates);
        
        // Generate preview for the manifest (if enabled)
        if (settingsManager.get('autoGeneratePreviews')) {
            await generateVideoPreview(tabId, normalizedUrl, headers);
        }
    } else {
        // Update with error information and clear processing flags
        updateVideo('processDashVideo-error', tabId, normalizedUrl, {
            isValid: false,
            isBeingProcessed: false,
            parsing: false,
            timestampValidated: dashResult.timestampValidated || Date.now(),
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
    const headers = video.headers || {};

    const isAudio = video.mediaType === 'audio';

    if (isAudio) {
        logger.debug(`Skipping processing for 'audio' mediaType: ${normalizedUrl}`);
        // Clear processing flags for audio files
        updateVideo('processDirectVideo-audio', tabId, normalizedUrl, {
            isBeingProcessed: false,
            runningFFprobe: false
        });
    } else {
        logger.debug(`Processing as video content: ${normalizedUrl}`);
        
        // Get metadata (FFprobe will override containers if successful)
        await getFFprobeMetadata(tabId, normalizedUrl, headers);
        
        // Get updated video with metadata for preview generation (if enabled)
        if (settingsManager.get('autoGeneratePreviews')) {
            const updatedVideo = getVideo(tabId, normalizedUrl);
            if (updatedVideo.metaFFprobe?.hasVideo) {
                await generateVideoPreview(tabId, normalizedUrl, headers);
            }
        }
    }
}

/**
 * Track and update variant-master relationships for video tracks, audio tracks, and subtitles
 * @param {number} tabId - Tab ID
 * @param {Array} videoTracks - Array of video track objects
 * @param {Array} audioTracks - Array of audio track objects
 * @param {Array} subtitles - Array of subtitle track objects
 * @param {string} masterUrl - The normalized master URL
 * @returns {Array} Array of updated video objects for items that were changed
 */
function handleVariantMasterRelationships(tabId, videoTracks, audioTracks, subtitles, masterUrl) {
    // Use global maps for pipeline access
    const variantMasterMap = globalThis.variantMasterMapInternal;
    const allDetectedVideos = globalThis.allDetectedVideosInternal;

    if (!variantMasterMap.has(tabId)) {
        variantMasterMap.set(tabId, new Map());
    }
    const tabVariantMap = variantMasterMap.get(tabId);
    const tabVideos = allDetectedVideos.get(tabId);
    if (!tabVideos) return [];

    const updatedVideos = [];

    // Helper function to process media items with URLs
    const processMediaItems = (items, itemType) => {
        for (const item of items) {
            if (!item.normalizedUrl) continue; // Skip items without URLs
            // Update the variant-master relationship map
            tabVariantMap.set(item.normalizedUrl, masterUrl);
            logger.debug(`Tracked ${itemType} ${item.normalizedUrl} as belonging to master ${masterUrl}`);
            // If this item exists as standalone, update it
            if (tabVideos.has(item.normalizedUrl)) {
                const updatedVideo = updateVideo('handleVariantMasterRelationships', tabId, item.normalizedUrl, {
                    hasKnownMaster: true,
                    masterUrl: masterUrl,
                    isVariant: itemType === 'videoTrack', // Only video tracks are marked as isVariant
                    isAudioTrack: itemType === 'audio',
                    isSubtitleTrack: itemType === 'subtitle'
                });
                if (updatedVideo) {
                    logger.debug(`Updated existing standalone ${itemType} ${item.normalizedUrl} with master info`);
                    updatedVideos.push({ url: item.normalizedUrl, updatedVideo, type: itemType });
                }
            }
        }
    };

    // Process video tracks
    processMediaItems(videoTracks, 'videoTrack');
    // Process audio tracks
    processMediaItems(audioTracks, 'audio');
    // Process subtitles
    processMediaItems(subtitles, 'subtitle');

    return updatedVideos;
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
        
        // Set generating flag before starting
        updateVideo('generateVideoPreview-start', tabId, normalizedUrl, { generatingPreview: true });
        
        // Determine source URL for preview generation
        const urlToUse = sourceUrl || video.url;
        logger.debug(`Generating preview for ${normalizedUrl} using source: ${urlToUse}`);
        
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
            
            updateVideo('generateVideoPreview-success', tabId, normalizedUrl, {
                generatingPreview: false,
                previewUrl: response.previewUrl,
                previewSourceUrl: sourceUrl || null // Track where preview came from
            });
        } else {
            logger.debug(`No preview URL in response for: ${normalizedUrl}`);
            updateVideo('generateVideoPreview-no-response', tabId, normalizedUrl, { generatingPreview: false });
        }
    } catch (error) {
        logger.error(`Error generating preview for ${normalizedUrl}: ${error.message}`);
        updateVideo('generateVideoPreview-error', tabId, normalizedUrl, { generatingPreview: false });
    }
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

        logger.debug(`Getting FFprobe metadata for ${video.url}`);

        // Direct call to NHS - gets ffprobe data and expects response
        const response = await nativeHostService.sendMessage({
            command: 'getQualities',
            url: video.url,
            type: video.type || 'direct',
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

            // Determine container using unified detection system (FFprobe override)
            const containerDetection = detectAllContainers({
                ffprobeContainer: streamInfo.container,
                mimeType: video.metadata?.contentType,
                url: video.url,
                mediaType: video.mediaType || 'video',
                videoType: 'direct'
            });

            // Update the videoTracks[0] with FFprobe metadata
            const updatedVideoTracks = [{
                url: video.url,
                normalizedUrl: normalizedUrl,
                type: 'direct',
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null,
                metaFFprobe: streamInfo,
                videoContainer: containerDetection.container,
                audioContainer: containerDetection.container === 'webm' ? 'webm' : 'mp3',
                containerDetectionReason: `ffprobe-${containerDetection.reason}`
            }];

            updateVideo('getFFprobeMetadata', tabId, normalizedUrl, {
                isValid,
                isBeingProcessed: false,
                runningFFprobe: false,
                metaFFprobe: streamInfo,
                duration: streamInfo.duration,
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || video.fileSize,
                fileSize: streamInfo.sizeBytes || null,
                // Use new unified container detection (FFprobe override)
                defaultContainer: containerDetection.container,
                containerDetectionReason: `ffprobe-${containerDetection.reason}`,
                // Add separate containers for audio-only downloads
                videoContainer: containerDetection.container,
                audioContainer: containerDetection.container === 'webm' ? 'webm' : 'mp3',
                // Update standardized videoTracks
                videoTracks: updatedVideoTracks
            });
        } else {
            logger.warn(`No stream info in ffprobe response for: ${normalizedUrl}`);
            // Clear processing flags but keep fallback containers
            updateVideo('getFFprobeMetadata-no-stream', tabId, normalizedUrl, {
                isBeingProcessed: false,
                runningFFprobe: false
            });
        }
    } catch (error) {
        logger.error(`Error getting FFprobe metadata for ${normalizedUrl}: ${error.message}`);
        // Clear processing flags but keep fallback containers
        updateVideo('getFFprobeMetadata-error', tabId, normalizedUrl, {
            isBeingProcessed: false,
            runningFFprobe: false
        });
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

export {
    enqueue,
    addDetectedVideo,
    handleVariantMasterRelationships,
    cleanupProcessingQueueForTab,
    clearAll,
    generateVideoPreview
};
