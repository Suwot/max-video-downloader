/**
 * Video Processing Pipeline
 * Manages the flow of videos from detection through processing to UI display
 */

import { normalizeUrl, generateId } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { standardizeResolution, getFilenameFromUrl } from '../../shared/utils/processing-utils.js';
import { getPreview, storePreview } from '../../shared/utils/preview-cache.js';
import { parseHlsManifest, extractHlsMediaUrls } from './hls-parser.js';
import { parseDashManifest } from './dash-parser.js';
import nativeHostService from '../messaging/native-host-service.js';
import { getVideo, updateVideo } from './video-store.js';
import { settingsManager } from '../index.js';

// Create a logger instance for the Video Processing Pipeline module
const logger = createLogger('Video Processor');

// Module-level state for video processing
const processingMap = new Map(); // Track active processing to prevent duplicates

/**
 * Add detected video to the central tracking map and start processing immediately
 * This is the main entry point for video processing orchestration
 * @param {number} tabId - The tab ID where the video was detected
 * @param {Object} videoInfo - Information about the detected video
 * @returns {boolean|string} - True if this is a new video, 'updated' if an existing video was updated, false otherwise
 */
function addDetectedVideo(videoInfo) {
    logger.debug(`Received video for Tab ${videoInfo.tabId}, with this info:`, videoInfo);
    
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(videoInfo.url);
    const tabId = videoInfo.tabId;

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
                // Skip known media items entirely - no storage or UI updates needed
                logger.debug(`Skipping known media item: ${normalizedUrl}`);
                // Note: No storage or UI updates for known media items
            }
            // Do not process or update UI
            return;
        }
    }
    
    // Initialize tab's video collection if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    
    // Get the map for this specific tab
    const tabMap = allDetectedVideos.get(tabId);
    
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

        logger.debug(`Duplicate video URL detected: ${videoInfo.url}, Existing timestamp: ${existingVideo.timestampDetected}, New timestamp: ${videoInfo.timestampDetected}`);
        return;
    }
    
    // All videos start processing immediately
    const newVideo = {
        ...videoInfo,
        normalizedUrl,
        mediaId: generateId(videoInfo.url), // Generate mediaId for UI matching
        processing: true, // Single flag for all processing states
        title: videoInfo.pageTitle || videoInfo.metadata?.filename || 'untitled',
        isValid: true, // optimistic for all types
        validForDisplay: true
    };
    
    updateVideo('structural', 'add', newVideo);
    logger.debug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type})`);

    // Start processing immediately
    processVideo(newVideo);
    
    return true;
}
    
/**
 * Process a video immediately
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {string} videoType - Type of video (hls, dash, direct)
 * @param {Object} videoData - Full video data object
 */
async function processVideo(videoData) {
    const { tabId, normalizedUrl, type } = videoData;
    
    // Skip if dismissed
    if (videoData?.timestampDismissed) {
        logger.debug(`Not processing dismissed video: ${normalizedUrl}`);
        return;
    }
    
    // Skip if already being processed
    if (processingMap.has(normalizedUrl)) {
        logger.debug(`Skipping duplicate processing: ${normalizedUrl}`);
        return;
    }
    
    // Mark as processing
    processingMap.set(normalizedUrl, Date.now());
    
    try {
        logger.debug(`Processing video: ${normalizedUrl} (${type})`);

        // Route to appropriate processor based on type
        if (type === 'hls') {
            await processHlsVideo(videoData);
        } else if (type === 'dash') {
            await processDashVideo(videoData);
        } else {
            await processDirectVideo(videoData);
        }

    } catch (error) {
        logger.error(`Error processing ${normalizedUrl}:`, error);
        // Remove failed video from UI - send only changes
        updateVideo('flag', 'remove', { 
            tabId,
            normalizedUrl,
            processing: false,
            validForDisplay: false,
            isValid: false,
            error: error.message
        });
    } finally {
        processingMap.delete(normalizedUrl);
    }
}
    
/**
 * Process an HLS video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} videoData - Full video data object
 */
async function processHlsVideo(videoData) {
    logger.debug(`Processing HLS video: ${videoData.normalizedUrl}`);

    const { tabId, normalizedUrl, headers } = videoData;
    
    // Run combined validation and parsing
    const hlsResult = await parseHlsManifest(videoData);
    
    if (hlsResult.status === 'success') {
        // Track variant-master relationships if this is a master playlist
        if (hlsResult.isMaster) {
            // First: Track ALL URLs for deduplication (including video tracks that might be filtered)
            const allVideoTracks = hlsResult.videoTracks || [];
            const allAudioTracks = hlsResult.audioTracks || [];
            const allSubtitleTracks = hlsResult.subtitleTracks || [];
            
            if (allVideoTracks.length > 0 || allAudioTracks.length > 0 || allSubtitleTracks.length > 0) {
                handleVariantMasterRelationships(
                    tabId,
                    allVideoTracks,
                    allAudioTracks,
                    allSubtitleTracks,
                    normalizedUrl
                );
            }
            
            // Second: Filter video tracks safely (only remove audio-only tracks used for embedding)
            if (allVideoTracks.length > 0) {
                const filteredVideoTracks = allVideoTracks.filter(videoTrack => {
                    // Only remove if ALL conditions are true:
                    const shouldRemove = (
                        videoTrack.isUsedForEmbeddedAudio &&           // Used for embedded audio
                        !videoTrack.videoContainer &&                  // No video container (audio-only)
                        videoTrack.audioContainer                      // Has audio container
                    );
                    return !shouldRemove;
                });
                
                // Clean up the temporary flag
                filteredVideoTracks.forEach(track => {
                    delete track.isUsedForEmbeddedAudio;
                });
                
                // Update the result with filtered tracks
                hlsResult.videoTracks = filteredVideoTracks;
                
                if (allVideoTracks.length !== filteredVideoTracks.length) {
                    logger.debug(`Filtered out ${allVideoTracks.length - filteredVideoTracks.length} audio-only video tracks used for embedded audio`);
                }
            }
        }

        // Calculate stream flags
        const streamFlags = detectStreamFlags(hlsResult);
        
        // Send only the changes from HLS processing
        updateVideo('structural', 'update', {
            ...hlsResult,
            ...streamFlags,
            tabId,
            normalizedUrl,
            processing: false
        });

        // Generate preview for the master using the first remaining video track as source (if enabled)
        if (hlsResult.isMaster && settingsManager.get('autoGeneratePreviews') && hlsResult.videoTracks?.length > 0) {
            await generateVideoPreview({ ...videoData, ...hlsResult }, hlsResult.videoTracks[0].url);
        }
    } else {
        // Remove failed HLS video from UI - send only changes
        updateVideo('flag', 'remove', {
            tabId,
            normalizedUrl,
            isValid: false,
            processing: false,
            timestampValidated: hlsResult.timestampValidated || Date.now(),
            parsingStatus: hlsResult.status,
            parsingError: hlsResult.error || 'Not a valid HLS manifest',
            validForDisplay: false
        });
    }
}
    
/**
 * Process DASH video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} videoData - Full video data object
 */
async function processDashVideo(videoData) {
    const { tabId, normalizedUrl, headers } = videoData;
    
    logger.debug(`Processing DASH video: ${normalizedUrl}`);
    
    // Run combined validation and parsing
    const dashResult = await parseDashManifest(videoData);
    
    if (dashResult.status === 'success') {
        // Send only the changes from DASH processing
        const dashUpdates = {
            tabId,
            normalizedUrl,
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
        
        // Calculate stream flags
        const streamFlags = detectStreamFlags(dashUpdates);
        
        updateVideo('structural', 'update', {
            ...dashUpdates,
            ...streamFlags
        });
        
                // Generate preview for the manifest (if enabled)
        if (settingsManager.get('autoGeneratePreviews')) {
            await generateVideoPreview({ ...videoData, ...dashUpdates });
        }
    } else {
        // Remove failed DASH video from UI - send only changes
        updateVideo('flag', 'remove', {
            tabId,
            normalizedUrl,
            isValid: false,
            processing: false,
            timestampValidated: dashResult.timestampValidated || Date.now(),
            parsingStatus: dashResult.status,
            parsingError: dashResult.error || 'Not a valid DASH manifest',
            validForDisplay: false
        });
    }
}
    
/**
 * Process direct video file
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} videoData - Full video data object
 */
async function processDirectVideo(videoData) {
    const { normalizedUrl } = videoData;
    logger.debug(`Processing direct video: ${normalizedUrl}`);

    // Get metadata (FFprobe will override containers if successful)
    const metadataResult = await getFFprobeMetadata(videoData);
    // Generate preview if enabled and video has video content
    if (settingsManager.get('autoGeneratePreviews') && metadataResult?.hasVideo) {
        await generateVideoPreview({ ...videoData, duration: metadataResult.duration });
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

    // Collect all URLs that need to be removed from UI
    const urlsToRemove = [];
    
    // Helper function to process media items with URLs
    const processMediaItems = (items, itemType) => {
        for (const item of items) {
            if (!item.normalizedUrl) continue; // Skip items without URLs
            // Update the variant-master relationship map
            tabVariantMap.set(item.normalizedUrl, masterUrl);
            logger.debug(`Tracked ${itemType} ${item.normalizedUrl} as belonging to master ${masterUrl}`);
            
            // If this item exists as standalone, mark for removal from UI
            if (tabVideos.has(item.normalizedUrl)) {
                urlsToRemove.push(item.normalizedUrl);
                logger.debug(`Marked existing standalone ${itemType} ${item.normalizedUrl} for removal`);
            }
        }
    };

    // Process video tracks
    processMediaItems(videoTracks, 'videoTrack');
    // Process audio tracks
    processMediaItems(audioTracks, 'audio');
    // Process subtitles
    processMediaItems(subtitles, 'subtitle');

    // Batch remove all variant URLs from UI if any were found
    if (urlsToRemove.length > 0) {
        updateVideo('flag', 'remove', {
            tabId,
            normalizedUrl: urlsToRemove, // Array for batch operation
            hasKnownMaster: true,
            masterUrl: masterUrl,
            isVariant: true,
			validForDisplay: false
        });

        logger.debug(`Batch removed ${urlsToRemove.length} variant items from UI:`, urlsToRemove);
    }

    return urlsToRemove;
}

/**
 * Unified preview generation for all video types
 * @param {Object} videoData - Complete video data object
 * @param {string} [sourceUrl=null] - Optional source URL to generate from (if different)
 */
async function generateVideoPreview(videoData, sourceUrl = null) {
    const { tabId, normalizedUrl, headers = {}, duration, type } = videoData;
	
    try {
        // Skip if already has preview - use videoData directly
        if (videoData.previewUrl || videoData.poster) {
            logger.debug(`[GP] Video already has preview, skipping: ${normalizedUrl}`);
            return;
        }
        
        // Check for cached preview first (using destination URL for cache lookup)
        const cachedPreview = await getPreview(normalizedUrl);
        if (cachedPreview) {
            logger.debug(`[GP] Using cached preview for: ${normalizedUrl}`);
            // Send only the preview change
            updateVideo('structural', 'update', {
                tabId,
                normalizedUrl,
                previewUrl: cachedPreview
            });
            return;
        }
        
        // Set generating flag before starting - send only the flag change
        updateVideo('flag', 'update', { 
            tabId, 
            normalizedUrl, 
            generatingPreview: true 
        });
        
        // Determine source URL for preview generation
        const urlToUse = sourceUrl || videoData.url;
        logger.debug(`[GP] Generating preview for ${normalizedUrl} using source: ${urlToUse}`);
        
        // Direct call to NHS - generates preview and expects response
        const response = await nativeHostService.sendMessage({
            command: 'generatePreview',
            url: urlToUse,
            headers,
            duration,
            type
        });
                    
        if (response && response.previewUrl) {
            logger.debug(`[GP] Generated preview successfully for: ${normalizedUrl}`);
            
            // Cache the generated preview
            await storePreview(normalizedUrl, response.previewUrl);
            
            // Send only the preview changes
            updateVideo('structural', 'update', {
                tabId,
                normalizedUrl,
                generatingPreview: false,
                previewUrl: response.previewUrl,
                previewSourceUrl: sourceUrl || null, // Track where preview came from
            });
        } else if (response && response.timeout) {
            logger.warn(`[GP] Preview generation timed out for: ${normalizedUrl} (killed after 30 seconds)`);
            updateVideo('flag', 'update', { 
                tabId, 
                normalizedUrl, 
                generatingPreview: false 
            });
        } else {
            logger.debug(`[GP] No preview URL in response for: ${normalizedUrl}`);
            updateVideo('flag', 'update', { 
                tabId, 
                normalizedUrl, 
                generatingPreview: false 
            });
        }
    } catch (error) {
        logger.error(`[GP] Error generating preview for ${normalizedUrl}: ${error.message}`);
        updateVideo('flag', 'update', { 
            tabId, 
            normalizedUrl, 
            generatingPreview: false 
        });
    }
}

/**
 * Get FFprobe metadata for direct video
 * @param {number} tabId - Tab ID
 * @param {string} normalizedUrl - Normalized video URL
 * @param {Object} headers - Request headers
 * @param {Object} videoData - Full video data object
 */
async function getFFprobeMetadata(videoData) {
	const { url, type, tabId, normalizedUrl, headers } = videoData;
	logger.debug(`Getting FFprobe metadata for ${videoData.url}`);
    try {
        // Direct call to NHS - gets ffprobe data and expects response
        const response = await nativeHostService.sendMessage({
            command: 'getQualities',
            url,
            type,
            headers
        });

        const streamInfo = response?.streamInfo || null;

        if (response && response.timeout) {
            logger.warn(`[FFprobe] Media analysis timed out for: ${normalizedUrl} (killed after 30 seconds)`);
            // Remove video from UI as analysis failed
            updateVideo('flag', 'remove', {
                tabId,
                normalizedUrl,
                processing: false,
                isValid: false,
                validForDisplay: false
            });
            return null;
        } else if (streamInfo) {
            logger.debug(`Got FFprobe stream analysis for ${normalizedUrl}`);

            // Add standardizedResolution if height is available
            let standardizedRes = null;
            if (streamInfo.height) {
                standardizedRes = standardizeResolution(streamInfo.height);
            }

            // Only set isValid: false if ffprobe confirms not a video
            const isValid = streamInfo.hasVideo === false ? false : true;

            // Preserve existing trackId if it exists, otherwise generate new one
            const existingTrackId = videoData.videoTracks?.[0]?.trackId || generateId(url);
            
            // Create videoTracks array only after successful FFprobe validation
            const videoTracks = [{
                url,
                normalizedUrl,
                trackId: existingTrackId, // Preserve or generate trackId for UI matching
                type,
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.sizeBytes,
                metaFFprobe: streamInfo,
                // Only include containers if streams are present
                ...(streamInfo.videoContainer && { videoContainer: streamInfo.videoContainer }),
                ...(streamInfo.audioContainer && { audioContainer: streamInfo.audioContainer }),
                ...(streamInfo.subtitleContainer && { subtitleContainer: streamInfo.subtitleContainer }),
                // Include multi-stream indexes if present
                ...(streamInfo.audioStreamIndexes && { audioStreamIndexes: streamInfo.audioStreamIndexes }),
                ...(streamInfo.subsStreamIndexes && { subsStreamIndexes: streamInfo.subsStreamIndexes }),
                containerDetectionReason: 'ffprobe-stream-analysis'
            }];

            // Send only the changes from FFprobe processing
            const ffprobeUpdates = {
                tabId,
                normalizedUrl,
                isValid,
                processing: false,
                metaFFprobe: streamInfo,
                duration: streamInfo.duration,
                standardizedResolution: standardizedRes,
                estimatedFileSizeBytes: streamInfo.sizeBytes,
                videoTracks: videoTracks,
				hasVideo: streamInfo.hasVideo === true,
				hasAudio: streamInfo.hasAudio === true,
				hasSubtitles: streamInfo.hasSubs === true
            };
            
            updateVideo('structural', 'update', ffprobeUpdates);
            return streamInfo;
        } else {
            logger.warn(`No stream info in ffprobe response for: ${normalizedUrl}`);
            // Remove video from UI as it failed FFprobe
            updateVideo('flag', 'remove', {
                tabId,
                normalizedUrl,
                processing: false,
                isValid: false,
                validForDisplay: false
            });
            return null;
        }
    } catch (error) {
        logger.error(`Error getting FFprobe metadata for ${normalizedUrl}: ${error.message}`);
        // Remove video from UI as FFprobe failed
        updateVideo('flag', 'remove', {
            tabId,
            normalizedUrl,
            processing: false,
            isValid: false,
            error: error.message,
            validForDisplay: false
        });
        return null;
    }
}

// Clean up processing state for a specific tab
function cleanupProcessingForTab(tabId) {
    // Clean up any active processing for this tab
    const activeProcessing = [];
    for (const [normalizedUrl] of processingMap.entries()) {
        const video = getVideo(tabId, normalizedUrl);
        if (video) {
            activeProcessing.push(normalizedUrl);
        }
    }
    
    if (activeProcessing.length > 0) {
        activeProcessing.forEach(url => processingMap.delete(url));
        logger.debug(`Cleaned up ${activeProcessing.length} active processing items for tab ${tabId}`);
    }
}

// Clear all processing state
function clearAllProcessing() {
    processingMap.clear();
}

// assigns media flags (0-3) based on existing media tracks / containers (HLS / DASH only)
function detectStreamFlags(videoData) {
    // Get all track arrays
    const videoTracksLength = videoData.videoTracks?.length || 0;
    const audioTracksLength = videoData.audioTracks?.length || 0;
    const subtitleTracksLength = videoData.subtitleTracks?.length || 0;
    
    // Count how many arrays have values
    const arraysWithValues = [
        { length: videoTracksLength, tracks: videoData.videoTracks, type: 'video' },
        { length: audioTracksLength, tracks: videoData.audioTracks, type: 'audio' },
        { length: subtitleTracksLength, tracks: videoData.subtitleTracks, type: 'subtitle' }
    ].filter(arr => arr.length > 0);
    
    // If more than 1 array has values, count flags by array presence
    if (arraysWithValues.length > 1) {
        return {
            hasVideo: videoTracksLength > 0,
            hasAudio: audioTracksLength > 0,
            hasSubtitles: subtitleTracksLength > 0
        };
    }
    
    // If only 1 array has values, count flags by first entry's containers
    if (arraysWithValues.length === 1) {
        const singleArray = arraysWithValues[0];
        const firstTrack = singleArray.tracks[0];
        
        return {
            hasVideo: !!firstTrack.videoContainer,
            hasAudio: !!firstTrack.audioContainer,
            hasSubtitles: !!firstTrack.subtitleContainer
        };
    }

    return { hasVideo: false, hasAudio: false,  hasSubtitles: false }; // no arrays have values
}

export {
    processVideo,
    addDetectedVideo,
    handleVariantMasterRelationships,
    cleanupProcessingForTab,
    clearAllProcessing,
    generateVideoPreview,
    detectStreamFlags
};
