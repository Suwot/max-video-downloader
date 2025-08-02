/**
 * Video Processing Pipeline
 * Manages the flow of videos from detection through processing to UI display
 */

import { normalizeUrl, standardizeResolution, getFilenameFromUrl, calculateValidForDisplay } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { detectAllContainers } from './container-detector.js';

import { getPreview, storePreview } from '../../shared/utils/preview-cache.js';
import { parseHlsManifest, extractHlsMediaUrls } from './hls-parser.js';
import { parseDashManifest } from './dash-parser.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getVideo, storeAndNotifyUI } from './video-store.js';
import { settingsManager } from '../index.js';

// Create a logger instance for the Video Processing Pipeline module
const logger = createLogger('Video Processor');

// Module-level state for video processing
const processingMap = new Map(); // Track active processing to prevent duplicates

/**
 * Add detected video to the central tracking map and enqueue for processing
 * This is the main entry point for video processing orchestration
 * @param {number} tabId - The tab ID where the video was detected
 * @param {Object} videoInfo - Information about the detected video
 * @returns {boolean|string} - True if this is a new video, 'updated' if an existing video was updated, false otherwise
 */
function addDetectedVideo(tabId, videoInfo) {
    logger.info(`[DETECT] Tab ${tabId}: ${videoInfo.url} (${videoInfo.type})`);
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
                    tabId,
                    title: videoInfo.metadata?.filename || getFilenameFromUrl(videoInfo.url),
                    isValid: true, // it's a known media item, so we consider it valid
                    validForDisplay: false // Known media items are not displayed
                };
                // Store directly without UI update (known media items are filtered out)
                tabMap.set(normalizedUrl, newVideo);
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
    
    // Add to tab's collection with basic info and processing flags (processing starts immediately)
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        // Set processing flags - processing starts immediately on detection
        processing: true,
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
    // Store and send to UI (structural update with processing flag)
    storeAndNotifyUI(newVideo, 'structural', 'add');
    logger.info(`[DETECT] Added: ${videoInfo.url} (${videoInfo.type})`);

    // Start processing immediately
    processVideo(tabId, normalizedUrl, newVideo.type, newVideo);
    
    return true;
}
    
/**
 * Enqueue a video for processing
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} videoType - Type of video (hls, dash, direct)
 */
/**
 * Process video immediately (no queue)
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} videoType - Type of video (hls, dash, direct)
 * @param {Object} videoData - Video data object
 */
async function processVideo(tabId, normalizedUrl, videoType, videoData) {
    // Skip if already being processed
    if (processingMap.has(normalizedUrl)) {
        logger.debug(`Skipping duplicate processing: ${normalizedUrl}`);
        return;
    }
    
    // Skip if dismissed
    if (videoData?.timestampDismissed) {
        logger.debug(`Not processing dismissed video: ${normalizedUrl}`);
        return;
    }
    
    // Mark as processing
    processingMap.set(normalizedUrl, Date.now());
    
    try {
        // Route to appropriate processor based on type
        if (videoType === 'hls') {
            await processHlsVideo(tabId, normalizedUrl, videoData);
        } else if (videoType === 'dash') {
            await processDashVideo(tabId, normalizedUrl, videoData);
        } else {
            await processDirectVideo(tabId, normalizedUrl, videoData);
        }

    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
        // Send flags-only update to clear processing flags and show error
        const flagData = {
            ...videoData,
            processing: false,
            processingError: error.message 
        };
        storeAndNotifyUI(flagData, 'flags');
    } finally {
        processingMap.delete(normalizedUrl);
    }
}
    
/**
 * Process next video in queue
 */

    
/**
 * Process an HLS video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processHlsVideo(tabId, normalizedUrl, videoData) {
    logger.debug(`Processing HLS video: ${normalizedUrl}`);
    
    // Get headers for the request
    const headers = videoData.headers || {};
    
    // Run combined validation and parsing
    const hlsResult = await parseHlsManifest(videoData.url);
    
    if (hlsResult.status === 'success') {
        // Merge HLS results with original video data
        const mergedData = {
            ...videoData,
            ...hlsResult,
            processing: false,
            validForDisplay: calculateValidForDisplay({ ...videoData, ...hlsResult })
        };
        storeAndNotifyUI(mergedData, 'structural', 'update');

        // Track variant-master relationships if this is a master playlist
        if (hlsResult.isMaster && hlsResult.videoTracks?.length > 0) {
            handleVariantMasterRelationships(
                tabId, 
                hlsResult.videoTracks, 
                hlsResult.audioTracks, 
                hlsResult.subtitleTracks, 
                normalizedUrl
            );

            // Generate preview for the master using the first video track as source (if enabled and has video codecs)
            if (settingsManager.get('autoGeneratePreviews') && hlsResult.videoTracks?.length > 0) {
                const firstVideoTrack = hlsResult.videoTracks[0];
                await generateVideoPreview(tabId, normalizedUrl, headers, firstVideoTrack.url);
            }
        }
    } else {
        // Parsing failed - remove from UI as it's not a valid HLS manifest
        const failedData = {
            ...videoData,
            processing: false,
            processingError: hlsResult.error || 'Not a valid HLS manifest',
            validForDisplay: false
        };
        storeAndNotifyUI(failedData, 'structural', 'remove');
    }
}
    
/**
 * Process DASH video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processDashVideo(tabId, normalizedUrl, videoData) {
    logger.debug(`Processing DASH video: ${normalizedUrl}`);
    
    // Get headers for the request
    const headers = videoData.headers || {};
    
    // Run combined validation and parsing
    const dashResult = await parseDashManifest(videoData.url);
    
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
            processing: false
        };
        
        // Merge DASH results with original video data
        const mergedData = {
            ...videoData,
            ...dashUpdates,
            validForDisplay: calculateValidForDisplay({ ...videoData, ...dashUpdates })
        };
        storeAndNotifyUI(mergedData, 'structural', 'update');
        
        // Generate preview for the manifest (if enabled and has video codecs)
        if (settingsManager.get('autoGeneratePreviews') && dashResult.videoTracks?.length > 0) {
            await generateVideoPreview(tabId, normalizedUrl, headers);
        }
    } else {
        // Parsing failed - remove from UI as we couldn't verify it's a valid DASH manifest
        const failedData = {
            ...videoData,
            processing: false,
            processingError: dashResult.error || 'Not a valid DASH manifest',
            validForDisplay: false
        };
        storeAndNotifyUI(failedData, 'structural', 'remove');
    }
}
    
/**
 * Process direct video file
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 */
async function processDirectVideo(tabId, normalizedUrl, videoData) {
    logger.debug(`Processing direct video: ${normalizedUrl}`);
    
    // Get headers for the request
    const headers = videoData.headers || {};

    const isAudio = videoData.mediaType === 'audio';

    if (isAudio) {
        logger.debug(`Skipping processing for 'audio' mediaType: ${normalizedUrl}`);
        // Send flags-only update to clear processing flags for audio files
        const flagData = {
            ...videoData,
            processing: false
        };
        storeAndNotifyUI(flagData, 'flags');
    } else {
        logger.debug(`Processing as video content: ${normalizedUrl}`);
        
        // Get metadata (FFprobe will override containers if successful)
        await getFFprobeMetadata(tabId, normalizedUrl, headers, videoData);
        
        // Preview generation will be handled by getFFprobeMetadata on success
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
                const existingVideo = tabVideos.get(item.normalizedUrl);
                const wasValidForDisplay = existingVideo.validForDisplay;
                
                const updatedVideo = {
                    ...existingVideo,
                    hasKnownMaster: true,
                    masterUrl: masterUrl,
                    isVariant: itemType === 'videoTrack', // Only video tracks are marked as isVariant
                    isAudioTrack: itemType === 'audio',
                    isSubtitleTrack: itemType === 'subtitle',
                    validForDisplay: false // Variants should not be displayed individually
                };
                
                // Determine action based on validForDisplay state change
                let action = 'update';
                if (wasValidForDisplay && !updatedVideo.validForDisplay) {
                    action = 'remove'; // Remove from UI since it's now a known variant
                }
                
                // Store and notify UI with appropriate action
                storeAndNotifyUI(updatedVideo, 'structural', action);
                logger.debug(`Updated existing standalone ${itemType} ${item.normalizedUrl} with master info (action: ${action})`);
                updatedVideos.push({ url: item.normalizedUrl, updatedVideo, type: itemType });
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
            const mergedData = { ...video, previewUrl: cachedPreview };
            storeAndNotifyUI(mergedData, 'structural');
            return;
        }
        
        // Set generating flag before starting
        const flagData = { ...video, generatingPreview: true };
        storeAndNotifyUI(flagData, 'flags');
        
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
            
            // Get current video data and merge preview results
            const currentVideo = getVideo(tabId, normalizedUrl);
            const mergedData = {
                ...currentVideo,
                generatingPreview: false,
                previewUrl: response.previewUrl,
                previewSourceUrl: sourceUrl || null // Track where preview came from
            };
            storeAndNotifyUI(mergedData, 'structural');
        } else {
            logger.debug(`No preview URL in response for: ${normalizedUrl}`);
            const currentVideo = getVideo(tabId, normalizedUrl);
            const flagData = { ...currentVideo, generatingPreview: false };
            storeAndNotifyUI(flagData, 'flags');
        }
    } catch (error) {
        logger.error(`Error generating preview for ${normalizedUrl}: ${error.message}`);
        const currentVideo = getVideo(tabId, normalizedUrl);
        const flagData = { ...currentVideo, generatingPreview: false };
        storeAndNotifyUI(flagData, 'flags');
    }
}

/**
 * Get FFprobe metadata for direct video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} headers - Request headers
 */
async function getFFprobeMetadata(tabId, normalizedUrl, headers, videoData) {
    try {
        logger.debug(`Getting FFprobe metadata for ${videoData.url}`);

        // Direct call to NHS - gets ffprobe data and expects response
        const response = await nativeHostService.sendMessage({
            command: 'getQualities',
            url: videoData.url,
            type: videoData.type || 'direct',
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
                mimeType: videoData.metadata?.contentType,
                url: videoData.url,
                mediaType: videoData.mediaType || 'video',
                videoType: 'direct'
            });

            // Update the videoTracks[0] with FFprobe metadata
            const updatedVideoTracks = [{
                url: videoData.url,
                normalizedUrl: normalizedUrl,
                type: 'direct',
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || videoData.fileSize,
                fileSize: streamInfo.sizeBytes || null,
                metaFFprobe: streamInfo,
                videoContainer: containerDetection.container,
                audioContainer: containerDetection.container === 'webm' ? 'webm' : 'mp3',
                containerDetectionReason: `ffprobe-${containerDetection.reason}`
            }];

            // Merge FFprobe results with original video data
            const mergedData = {
                ...videoData,
                isValid,
                processing: false,
                metaFFprobe: streamInfo,
                duration: streamInfo.duration,
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.estimatedFileSizeBytes || videoData.fileSize,
                fileSize: streamInfo.sizeBytes || null,
                // Use new unified container detection (FFprobe override)
                defaultContainer: containerDetection.container,
                containerDetectionReason: `ffprobe-${containerDetection.reason}`,
                // Add separate containers for audio-only downloads
                videoContainer: containerDetection.container,
                audioContainer: containerDetection.container === 'webm' ? 'webm' : 'mp3',
                // Update standardized videoTracks
                videoTracks: updatedVideoTracks,
                validForDisplay: calculateValidForDisplay({ ...videoData, isValid })
            };
            
            // If FFprobe failed (not a valid video), remove from UI
            if (!isValid) {
                mergedData.validForDisplay = false;
                storeAndNotifyUI(mergedData, 'structural', 'remove');
            } else {
                storeAndNotifyUI(mergedData, 'structural', 'update');
                
                // Generate preview if enabled and has video
                if (settingsManager.get('autoGeneratePreviews') && streamInfo.hasVideo) {
                    await generateVideoPreview(tabId, normalizedUrl, headers);
                }
            }
        } else {
            logger.warn(`No stream info in ffprobe response for: ${normalizedUrl} - removing from UI`);
            // FFprobe failed - remove from UI as it means video is not valid
            const failedData = {
                ...videoData,
                processing: false,
                isValid: false,
                validForDisplay: false
            };
            storeAndNotifyUI(failedData, 'structural', 'remove');
        }
    } catch (error) {
        logger.error(`Error getting FFprobe metadata for ${normalizedUrl}: ${error.message}`);
        // Send flags-only update to clear processing flags
        const flagData = {
            ...videoData,
            processing: false
        };
        storeAndNotifyUI(flagData, 'flags');
    }
}

/**
 * Clean up processing queue for a specific tab
 * @param {number} tabId - Tab ID
 */
/**
 * Clear all processing state
 */
function clearAll() {
    processingMap.clear();
}

export {
    addDetectedVideo,
    handleVariantMasterRelationships,
    clearAll,
    generateVideoPreview
};
