/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import { normalizeUrl, getBaseDirectory } from '../../js/utilities/normalize-url.js';
import nativeHostService from '../../js/native-host-service.js';
import { validateAndFilterVideos, filterRedundantVariants } from '../../js/utilities/video-validator.js';
import { processVideoRelationships } from '../../js/manifest-service.js';
import { getActivePopupPortForTab } from './popup-ports.js';

// Track masters and their variants across all tabs
// Key: normalized master URL, Value: array of normalized variant URLs
const knownMasters = new Map();

// Track which variants are linked to which masters
// Key: normalized variant URL, Value: normalized master URL
const variantToMaster = new Map();

const videosPerTab = {};
const playlistsPerTab = {};
const metadataProcessingQueue = new Map();
const manifestRelationships = new Map();
const previewGenerationQueue = new Map();

// Global blacklist for URLs that have failed or reached max processing attempts
// This prevents repeated console spam for problematic URLs
const processedUrlBlacklist = new Set();

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
    // First apply validation filter to remove unwanted videos
    const validatedVideos = validateAndFilterVideos ? validateAndFilterVideos(videos) : videos;
    
    // Apply our variant filtering to reduce redundant quality options
    // This will keep only distinct quality levels, removing nearly identical variants
    const filteredVideos = filterRedundantVariants(validatedVideos, {
        removeNeighboringQualities: true,
        qualityThreshold: 15 // 15% difference threshold
    });
    
    // Create sets to track master and variant URLs
    const processedVideos = [];
    const variantUrls = new Set();
    const masterUrls = new Set();
    const unclassifiedVariants = new Set();
    
    // Create source-based deduplication set
    const processedUrls = new Set();
    
    // Add a processing timestamp for version tracking
    const processingTimestamp = Date.now();

    // Step 1: First pass - Identify all master playlists and their variants
    filteredVideos.forEach(video => {
        if (video.isMasterPlaylist || video.isPlaylist) {
            masterUrls.add(normalizeUrl(video.url));
            
            // Collect all variants regardless of which property they're in
            const variants = video.variants || video.qualityVariants || [];
            if (Array.isArray(variants)) {
                variants.forEach(variant => {
                    const variantUrl = typeof variant === 'string' ? variant : variant.url;
                    if (variantUrl) {
                        variantUrls.add(normalizeUrl(variantUrl));
                    }
                });
            }
        }
        
        // Check if this video might be an unclassified variant (HLS/DASH but not a master)
        if ((video.type === 'hls' || video.type === 'dash') && 
            !video.isMasterPlaylist && !video.isPlaylist && 
            !video.groupedUnderMaster && 
            (video.source === 'page' || video.source === 'content_script')) {
            
            // Store it as an unclassified variant - will check in next phase
            unclassifiedVariants.add(normalizeUrl(video.url));
            
            // Also add it to the import unclassifiedVariantsPool for future reference
            import('../../js/manifest-service.js').then(manifestService => {
                manifestService.addUnclassifiedVariant(video);
            }).catch(err => {
                console.error('Error adding to unclassified variants pool:', err);
            });
        }
    });

    // Step 2: Build final list - ONLY include non-variant videos and master playlists
    // Sort by source priority: 'manifest' > 'network' > 'page' > 'background'
    // This ensures we prefer master playlists over variants, and network-detected over page-detected
    filteredVideos.sort((a, b) => {
        const sourcePriority = { 'manifest': 4, 'network': 3, 'page': 2, 'background': 1 };
        const aPriority = sourcePriority[a.source] || 0;
        const bPriority = sourcePriority[b.source] || 0;
        return bPriority - aPriority; // Higher priority first
    });
    
    // Now process videos with priority
    filteredVideos.forEach(video => {
        const normalizedUrl = normalizeUrl(video.url);
        
        // Skip if we've already processed this URL in this batch
        if (processedUrls.has(normalizedUrl)) {
            logDebug(`Skipping duplicate URL in batch: ${video.url}`);
            return;
        }
        
        // SKIP if it's explicitly marked as a variant
        if (video.isVariant) {
            logDebug(`Skipping explicitly marked variant ${video.url}`);
            return;
        }
        
        // SKIP if it's a variant URL that was listed under a master playlist
        if (variantUrls.has(normalizedUrl)) {
            logDebug(`Skipping variant ${video.url} because it's a known variant of a master`);
            return;
        }
        
        // SKIP if it's in our global variant registry and the master is in this batch
        if (variantToMaster.has(normalizedUrl)) {
            const masterUrl = variantToMaster.get(normalizedUrl);
            if (masterUrls.has(masterUrl)) {
                logDebug(`Skipping variant ${video.url} (matched to master ${masterUrl})`);
                return;
            }
        }
        
        // Add to our processed URLs set to avoid duplicates
        processedUrls.add(normalizedUrl);
        
        // Mark as unclassified if needed
        if (unclassifiedVariants.has(normalizedUrl) && 
            (video.source === 'page' || video.source === 'content_script')) {
            logDebug(`Marking as unclassified variant: ${video.url} (source: ${video.source})`);
            video.isUnclassifiedVariant = true;
        }
        
        // Add additional information needed for immediate display
        const enhancedVideo = {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || processingTimestamp,
            processed: true,
            lastProcessedAt: processingTimestamp,
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            poster: video.poster || video.previewUrl || null,
            downloadable: true,
            // Preserve source information
            source: video.source || 'background',
            // Track if this was added via background processing while popup was closed
            detectedWhilePopupClosed: true,
            // Preserve the detection timestamp for debugging duplicates
            detectionTimestamp: video.detectionTimestamp || null
        };
        
        // If we have stream info, ensure it's mapped to mediaInfo for the popup
        if (video.streamInfo && !video.mediaInfo) {
            enhancedVideo.mediaInfo = {
                hasVideo: video.streamInfo.hasVideo,
                hasAudio: video.streamInfo.hasAudio,
                videoCodec: video.streamInfo.videoCodec,
                audioCodec: video.streamInfo.audioCodec,
                format: video.streamInfo.format,
                container: video.streamInfo.container,
                duration: video.streamInfo.duration,
                sizeBytes: video.streamInfo.sizeBytes,
                width: video.streamInfo.width,
                height: video.streamInfo.height,
                fps: video.streamInfo.fps,
                bitrate: video.streamInfo.videoBitrate || video.streamInfo.totalBitrate
            };
        }
        
        // If we have resolution info from the stream but not as a separate field,
        // add it for immediate display in the popup
        if (!video.resolution && video.streamInfo) {
            enhancedVideo.resolution = {
                width: video.streamInfo.width,
                height: video.streamInfo.height,
                fps: video.streamInfo.fps,
                bitrate: video.streamInfo.videoBitrate || video.streamInfo.totalBitrate
            };
        }
        
        // Ensure we have a preview URL for rendering in the UI
        if (!enhancedVideo.previewUrl && enhancedVideo.poster) {
            enhancedVideo.previewUrl = enhancedVideo.poster;
        }
        
        // If this is an HLS video, pre-compute some indicators for the UI
        if (video.type === 'hls' && video.url.includes('.m3u8')) {
            enhancedVideo.isHLS = true;
            
            // If this is a master playlist with variants, mark it as such
            if (video.qualityVariants && video.qualityVariants.length > 0) {
                enhancedVideo.isMasterPlaylist = true;
                enhancedVideo.qualityCount = video.qualityVariants.length;
                
                // Find the highest quality variant for preview
                const highestQuality = [...video.qualityVariants].sort((a, b) => {
                    return (b.bandwidth || 0) - (a.bandwidth || 0);
                })[0];
                
                if (highestQuality) {
                    enhancedVideo.highestQualityInfo = {
                        width: highestQuality.width,
                        height: highestQuality.height,
                        bandwidth: highestQuality.bandwidth,
                        fps: highestQuality.fps
                    };
                }
            }
        }
        
        // If this video has a detection timestamp, add debugging log
        if (enhancedVideo.detectionTimestamp) {
            logDebug(`Preserving detection timestamp for video: ${enhancedVideo.url}, detected at: ${enhancedVideo.detectionTimestamp}`);
        }
        
        // Include this video in the final output
        processedVideos.push(enhancedVideo);
    });
    
    // Log filtering stats with more detail
    const variantCount = variantUrls.size + variantToMaster.size;
    const unclassifiedCount = unclassifiedVariants.size;
    logDebug(`Filtered videos: ${validatedVideos.length} input → ${processedVideos.length} output ` +
             `(${masterUrls.size} masters, ${variantCount} variants, ${unclassifiedCount} unclassified variants)`);
    
    return processedVideos;
}

// Store the filtered videos in storage for persistence
function broadcastVideoUpdate(tabId) {
    if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
        return;
    }
    
    // Convert Map to array
    const videosArray = Array.from(videosPerTab[tabId].values());
    videosArray.sort((a, b) => b.timestamp - a.timestamp);
    
    // Process before broadcasting - this includes variant filtering
    const processedVideos = processVideosForBroadcast(videosArray);
    
    // Store in local storage for persistence between sessions
    chrome.storage.local.set({
        [`processedVideos_${tabId}`]: processedVideos,
        [`processedVideosTimestamp_${tabId}`]: Date.now(),
        lastVideoUpdate: Date.now(),
        lastActiveTab: tabId
    }).then(() => {
        logDebug(`Stored ${processedVideos.length} processed videos for tab ${tabId} in storage`);
    }).catch(err => {
        console.error('Error storing videos:', err);
    });
    
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

// Helper function to extract stream metadata
async function getStreamMetadata(url) {
    try {
        // Using imported nativeHostService instead of dynamic import
        const response = await nativeHostService.sendMessage({
            type: 'getQualities',
            url: url
        });

        if (response?.streamInfo) {
            return response.streamInfo;
        }
        return null;
    } catch (error) {
        console.error('Failed to get stream metadata:', error);
        return null;
    }
}

// Process metadata queue with retry mechanism
async function processMetadataQueue(maxConcurrent = 3, maxRetries = 2) {
    if (metadataProcessingQueue.size === 0) return;
    
    const entries = Array.from(metadataProcessingQueue.entries()).slice(0, maxConcurrent);
    const processPromises = entries.map(async ([url, info]) => {
        let retries = 0;
        while (retries < maxRetries) {
            try {
                metadataProcessingQueue.delete(url);
                const streamInfo = await getStreamMetadata(url);
                
                if (streamInfo) {
                    if (info.tabId && videosPerTab[info.tabId]) {
                        const normalizedUrl = normalizeUrl(url);
                        const existingVideo = videosPerTab[info.tabId].get(normalizedUrl);
                        if (existingVideo) {
                            // Update video with stream info
                            const updatedVideo = {
                                ...existingVideo,
                                streamInfo,
                                mediaInfo: streamInfo, // Add direct mediaInfo reference
                                qualities: streamInfo.variants || [],
                                resolution: {
                                    width: streamInfo.width,
                                    height: streamInfo.height,
                                    fps: streamInfo.fps,
                                    bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                                }
                            };
                            
                            // Store updated video
                            videosPerTab[info.tabId].set(normalizedUrl, updatedVideo);
                            
                            // Broadcast update to popup if open
                            broadcastVideoUpdate(info.tabId);
                        }
                    }
                    break;
                }
                retries++;
            } catch (error) {
                console.error(`Failed to process metadata for ${url} (attempt ${retries + 1}):`, error);
                if (retries >= maxRetries - 1) break;
                await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
            }
        }
    });

    await Promise.all(processPromises);
    
    if (metadataProcessingQueue.size > 0) {
        setTimeout(() => processMetadataQueue(maxConcurrent, maxRetries), 100);
    }
}

// Add video to tab's collection with enhanced metadata handling
async function addVideoToTab(tabId, videoInfo) {
    if (!videosPerTab[tabId]) {
        logDebug('Creating new video collection for tab:', tabId);
        videosPerTab[tabId] = new Map();
    }
    
    // Skip known ping/tracking URLs that don't have extracted video URLs
    if ((videoInfo.url.includes('ping.gif') || videoInfo.url.includes('jwpltx.com')) && !videoInfo.foundFromQueryParam) {
        return;
    }

    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Check global blacklist - completely ignore URLs that have failed or reached max attempts
    const blacklistKey = `${tabId}:${normalizedUrl}`;
    if (processedUrlBlacklist.has(blacklistKey)) {
        return; // Silently ignore without logging to prevent console spam
    }
    
    // Preserve the detailed detection timestamp if available
    if (videoInfo.detectionTimestamp) {
        logDebug(`Processing video with detection timestamp: ${videoInfo.detectionTimestamp}, URL: ${videoInfo.url}`);
    }
    
    // STEP 1: Check if this is a variant of an already known master
    const knownRelationship = checkIfVariantOfKnownMaster(videoInfo.url);
    if (knownRelationship && knownRelationship.isVariant) {
        // Still record it in videosPerTab to track all videos, but mark as variant
        const existingVideo = videosPerTab[tabId].get(normalizedUrl);
        
        if (existingVideo) {
            // Update existing entry, keeping its properties but marking as variant
            existingVideo.isVariant = true;
            existingVideo.masterPlaylistUrl = knownRelationship.masterUrl;
            // Preserve the detection timestamp if available
            if (videoInfo.detectionTimestamp && !existingVideo.detectionTimestamp) {
                existingVideo.detectionTimestamp = videoInfo.detectionTimestamp;
            }
            videosPerTab[tabId].set(normalizedUrl, existingVideo);
        } else {
            // Add new entry but marked as variant
            videoInfo.isVariant = true;
            videoInfo.masterPlaylistUrl = knownRelationship.masterUrl;
            videoInfo.timestamp = Date.now();
            videosPerTab[tabId].set(normalizedUrl, videoInfo);
        }
        
        broadcastVideoUpdate(tabId);
        return;
    }
    
    // Get existing video info if any
    const existingVideo = videosPerTab[tabId].get(normalizedUrl);
    
    // Check if this video is already fully processed, nothing to do
    if (existingVideo && existingVideo.alreadyProcessed) {
        return;
    }
    
    // Check if this is actually a new video
    const isNewVideo = !existingVideo;
    
    // Merge with existing data if present
    if (existingVideo) {
        videoInfo = {
            ...existingVideo,
            ...videoInfo,
            // Preserve important existing fields
            timestamp: existingVideo.timestamp || Date.now(),
            streamInfo: existingVideo.streamInfo || null,
            qualities: existingVideo.qualities || [],
            // Update only if new data is present
            poster: videoInfo.poster || existingVideo.poster,
            title: videoInfo.title || existingVideo.title,
            // Preserve or update foundFromQueryParam flag
            foundFromQueryParam: videoInfo.foundFromQueryParam || existingVideo.foundFromQueryParam,
            // Preserve variant/master status if it was set already
            isVariant: existingVideo.isVariant || videoInfo.isVariant,
            isMasterPlaylist: existingVideo.isMasterPlaylist || videoInfo.isMasterPlaylist,
            variants: existingVideo.variants || videoInfo.variants,
            // Preserve the detection timestamp if available
            detectionTimestamp: existingVideo.detectionTimestamp || videoInfo.detectionTimestamp
        };
    } else {
        videoInfo.timestamp = Date.now();
        // If no detection timestamp is available (unlikely), create one now
        if (!videoInfo.detectionTimestamp) {
            videoInfo.detectionTimestamp = new Date().toISOString();
            logDebug(`Added missing detection timestamp for newly found video: ${videoInfo.url}`);
        }
    }
    
    // Mark as processed now to avoid race conditions with async operations
    videoInfo.alreadyProcessed = true;
    videosPerTab[tabId].set(normalizedUrl, videoInfo);
    
    // STEP 2: Process HLS/DASH playlists to identify master-variant relationships
    if ((videoInfo.type === 'hls' || videoInfo.type === 'dash') && 
        !videoInfo.isVariant && !videoInfo.isMasterPlaylist) {
        
        try {
            // Process this video to check for master-variant relationships
            const processedVideo = await processVideoRelationships(videoInfo);
            
            // If the video was enhanced with relationship info, update it
            if (processedVideo !== videoInfo) {
                // Preserve the detection timestamp when updating
                if (videoInfo.detectionTimestamp) {
                    processedVideo.detectionTimestamp = videoInfo.detectionTimestamp;
                }
                
                // Update in our collection
                videosPerTab[tabId].set(normalizedUrl, processedVideo);
                videoInfo = processedVideo;
                
                // STEP 3: If this is a master playlist, register its relationships globally
                if (processedVideo.isMasterPlaylist && processedVideo.variants && 
                    processedVideo.variants.length > 0) {
                    
                    registerMasterVariantRelationship(
                        processedVideo.url, 
                        processedVideo.variants
                    );
                    
                    // Re-evaluate other videos to check if any are actually variants of this master
                    reevaluateStandaloneVideos(tabId, processedVideo.url, processedVideo.variants);
                }
            }
        } catch (error) {
            console.error('Error processing video relationships:', error);
            // For DASH manifests that fail, add to blacklist to prevent repeated processing
            if (videoInfo.type === 'dash' && videoInfo.url.includes('.mpd')) {
                processedUrlBlacklist.add(blacklistKey);
            }
        }
    }
    
    // Add to metadata processing queue if it's not a variant
    if (!videoInfo.isVariant && !metadataProcessingQueue.has(normalizedUrl)) {
        metadataProcessingQueue.set(normalizedUrl, {
            ...videoInfo,
            tabId,
            timestamp: videoInfo.timestamp
        });
        processMetadataQueue();
    }
    
    // For HLS playlists, also add to that specific collection if it's not a variant
    if (!videoInfo.isVariant && videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
    
    // After processing relationships, group videos and broadcast update
    if (isNewVideo) {
        // Apply automatic grouping and filtering before broadcasting
        broadcastVideoUpdate(tabId);
        
        // Only generate previews for videos that:
        // 1. Don't already have a preview
        // 2. Aren't variants of a master playlist 
        // 3. Don't have a poster image already
        if (!videoInfo.isVariant && !videoInfo.previewUrl && !videoInfo.poster) {
            logDebug('Proactively generating preview for newly detected video:', normalizedUrl);
            generatePreview(videoInfo.url, tabId).catch(error => {
                console.error('Error generating preview:', error);
            });
        } else if (videoInfo.isVariant) {
            logDebug('Skipping preview generation for variant video:', normalizedUrl);
        } else if (videoInfo.previewUrl || videoInfo.poster) {
            logDebug('Skipping preview generation, video already has preview/poster:', normalizedUrl);
        }
    }
}

// Generate preview for a video
async function generatePreview(url, tabId) {
    // Check if we're already generating this preview
    const cacheKey = url;
    if (previewGenerationQueue.has(cacheKey)) {
        // If we are, wait for the existing promise
        return await previewGenerationQueue.get(cacheKey);
    }

    // Create new preview generation promise
    const previewPromise = new Promise(resolve => {
        nativeHostService.sendMessage({
            type: 'generatePreview',
            url: url
        }).then(response => {
            previewGenerationQueue.delete(cacheKey);
            
            // If we successfully generated a preview, cache it with the video
            if (response && response.previewUrl && tabId && videosPerTab[tabId]) {
                const normalizedUrl = normalizeUrl(url);
                const videoInfo = videosPerTab[tabId].get(normalizedUrl);
                if (videoInfo) {
                    videoInfo.previewUrl = response.previewUrl;
                    videosPerTab[tabId].set(normalizedUrl, videoInfo);
                    
                    // Notify any open popup about the new preview
                    notifyPreviewReady(tabId, normalizedUrl, response.previewUrl, videoInfo);
                }
            }
            
            resolve(response);
        }).catch(error => {
            previewGenerationQueue.delete(cacheKey);
            resolve({ error: error.message });
        });
    });

    // Store the promise
    previewGenerationQueue.set(cacheKey, previewPromise);
    
    // Wait for the preview and return it
    return await previewPromise;
}

/**
 * Notify any open popup about a newly generated preview
 * @param {number} tabId - Tab ID
 * @param {string} videoUrl - Video URL (normalized)
 * @param {string} previewUrl - Preview image URL or data URL
 * @param {Object} videoInfo - Video information object
 */
function notifyPreviewReady(tabId, videoUrl, previewUrl, videoInfo) {
    try {
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about new preview for ${videoUrl}`);
            
            try {
                port.postMessage({
                    type: 'previewReady',
                    videoUrl: videoUrl,
                    previewUrl: previewUrl,
                    videoId: videoInfo.id || videoUrl // Use ID if available, otherwise URL as ID
                });
            } catch (error) {
                logDebug(`Error sending preview notification: ${error.message}`);
            }
        } else {
            // No popup is open for this tab, which is normal - just log it
            logDebug(`No active popup for tab ${tabId}, preview update will be shown when popup opens`);
        }
    } catch (error) {
        logDebug(`Error in notifyPreviewReady: ${error.message}`);
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

// Get videos for tab
function getVideosForTab(tabId) {
    if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
        return [];
    }
    
    // Convert Map to Array for processing
    const allVideos = Array.from(videosPerTab[tabId].values());
    
    // Filter out variants that have a known master in this tab
    const filteredVideos = allVideos.filter(video => {
        // If this is already marked as a variant, check if its master exists in this tab
        if (video.isVariant && video.masterPlaylistUrl) {
            const normalizedMasterUrl = normalizeUrl(video.masterPlaylistUrl);
            // Only include if no master exists in this tab
            const masterExists = allVideos.some(v => normalizeUrl(v.url) === normalizedMasterUrl);
            return !masterExists; // Skip if master exists
        }
        
        // Check against our global registry
        const normalizedUrl = normalizeUrl(video.url);
        if (variantToMaster.has(normalizedUrl)) {
            const masterUrl = variantToMaster.get(normalizedUrl);
            // Check if this master exists in current tab
            const masterExistsInTab = allVideos.some(v => normalizeUrl(v.url) === masterUrl);
            return !masterExistsInTab; // Skip if master exists
        }
        
        // Include all non-variant videos
        return true;
    });
    
    // Sort by newest first
    const sortedVideos = filteredVideos.sort((a, b) => b.timestamp - a.timestamp);
    
    logDebug(`Filtered videos for tab ${tabId}: ${allVideos.length} → ${filteredVideos.length}`);
    return sortedVideos;
}

// Get playlists for tab
function getPlaylistsForTab(tabId) {
    if (!playlistsPerTab[tabId] || playlistsPerTab[tabId].size === 0) {
        return [];
    }
    
    return Array.from(playlistsPerTab[tabId]);
}

// Fetch manifest content
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.statusText}`);
        }
        const content = await response.text();
        return content;
    } catch (error) {
        console.error('Error fetching manifest:', error);
        if (error instanceof TypeError && error.message === 'Failed to fetch') {
            console.error('This might be due to CORS restrictions or the server being unavailable');
        }
        return null;
    }
}

// Store manifest relationship
function storeManifestRelationship(playlistUrl, variants) {
    variants.forEach(variant => {
        manifestRelationships.set(variant.url, {
            playlistUrl: playlistUrl,
            bandwidth: variant.bandwidth,
            resolution: variant.resolution,
            codecs: variant.codecs,
            fps: variant.fps
        });
    });
    return true;
}

// Get manifest relationship
function getManifestRelationship(variantUrl) {
    return manifestRelationships.get(variantUrl) || null;
}

// Clean up for tab
function cleanupForTab(tabId) {
    logDebug('Tab removed:', tabId);
    if (videosPerTab[tabId]) {
        logDebug('Cleaning up videos for tab:', tabId, 'Count:', videosPerTab[tabId].size);
        delete videosPerTab[tabId];
    }

    delete playlistsPerTab[tabId];
    
    // Clear manifest relationships for this tab's URLs
    for (const [url, info] of manifestRelationships.entries()) {
        if (url.includes(tabId.toString())) {
            manifestRelationships.delete(url);
        }
    }
}

/**
 * Register a relationship between a master playlist and its variants
 * @param {string} masterUrl - URL of the master playlist
 * @param {Array} variants - Array of variant URLs or objects with url property
 */
function registerMasterVariantRelationship(masterUrl, variants) {
    const normalizedMasterUrl = normalizeUrl(masterUrl);
    
    // Normalize variant URLs
    const normalizedVariants = variants.map(variant => {
        if (typeof variant === 'string') {
            return normalizeUrl(variant);
        } else if (variant && variant.url) {
            return normalizeUrl(variant.url);
        }
        return null;
    }).filter(Boolean); // Remove null values
    
    // Enhanced logging - show master and all of its variants
    console.log(`🎮 MASTER PLAYLIST FOUND: ${masterUrl}`);
    console.log(`🎮 Normalized master URL: ${normalizedMasterUrl}`);
    console.log(`🎮 Found ${normalizedVariants.length} variants:`);
    normalizedVariants.forEach((variantUrl, index) => {
        console.log(`🎮   [${index + 1}] ${variantUrl}`);
        
        // Also log original URL if available
        const originalUrl = variants[index];
        if (typeof originalUrl === 'object' && originalUrl.url) {
            console.log(`🎮       Original: ${originalUrl.url}`);
            if (originalUrl.height) {
                console.log(`🎮       Quality: ${originalUrl.height}p${originalUrl.fps ? ` ${originalUrl.fps}fps` : ''}`);
            }
        }
    });
    
    // Store in knownMasters map
    knownMasters.set(normalizedMasterUrl, normalizedVariants);
    
    // Update reverse lookup
    normalizedVariants.forEach(variantUrl => {
        variantToMaster.set(variantUrl, normalizedMasterUrl);
    });
    
    logDebug(`Registered master playlist ${normalizedMasterUrl} with ${normalizedVariants.length} variants`);
    
    return normalizedVariants;
}

/**
 * Check if a URL is a variant of any known master playlist
 * @param {string} url - URL to check
 * @returns {Object|null} Master relationship info or null if not a variant
 */
function checkIfVariantOfKnownMaster(url) {
    const normalizedUrl = normalizeUrl(url);
    
    // Check direct lookup first (fastest)
    if (variantToMaster.has(normalizedUrl)) {
        const masterUrl = variantToMaster.get(normalizedUrl);
        return { 
            isVariant: true, 
            masterUrl 
        };
    }
    
    // No known relationship
    return null;
}

/**
 * Re-evaluate all standalone videos to check if any are variants of the newly added master
 * @param {number} tabId - Tab ID
 * @param {string} masterUrl - Master playlist URL
 * @param {Array} variants - Array of variant URLs
 */
function reevaluateStandaloneVideos(tabId, masterUrl, variants) {
    if (!videosPerTab[tabId]) return;
    
    const normalizedMasterUrl = normalizeUrl(masterUrl);
    const normalizedVariants = variants.map(v => 
        typeof v === 'string' ? normalizeUrl(v) : normalizeUrl(v.url)
    ).filter(Boolean);
    
    // Check each video in this tab
    let updatedRelationships = false;
    videosPerTab[tabId].forEach((video, videoUrl) => {
        // Skip the master itself
        if (normalizeUrl(videoUrl) === normalizedMasterUrl) return;
        
        // Skip already known variants
        if (video.isVariant) return;
        
        // Check if this video is a variant of the new master
        const normalizedVideoUrl = normalizeUrl(videoUrl);
        if (normalizedVariants.includes(normalizedVideoUrl)) {
            // Mark this video as a variant
            video.isVariant = true;
            video.masterPlaylistUrl = masterUrl;
            videosPerTab[tabId].set(videoUrl, video);
            
            logDebug(`Re-evaluated: ${videoUrl} is now marked as a variant of ${masterUrl}`);
            updatedRelationships = true;
        }
    });
    
    // Broadcast update if any relationships were updated
    if (updatedRelationships) {
        broadcastVideoUpdate(tabId);
    }
}

export {
    addVideoToTab,
    broadcastVideoUpdate,
    generatePreview,
    getStreamQualities,
    getVideosForTab,
    getPlaylistsForTab,
    fetchManifestContent,
    storeManifestRelationship,
    getManifestRelationship,
    cleanupForTab,
    normalizeUrl,
    registerMasterVariantRelationship,
    checkIfVariantOfKnownMaster,
    reevaluateStandaloneVideos
};