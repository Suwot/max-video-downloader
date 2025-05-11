/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import { normalizeUrl, getBaseDirectory } from '../../js/utilities/normalize-url.js';
import nativeHostService from '../../js/native-host-service.js';
import { validateAndFilterVideos } from '../../js/utilities/video-validator.js';
import { processVideoRelationships } from '../../js/manifest-service.js';
import { getActivePopupPortForTab } from './popup-ports.js';

// The primary data structure: Map<tabId, Array<VideoEntry>>
// Each VideoEntry now contains all necessary information including metadata, preview, etc.
const videosPerTab = new Map();

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Expose allDetectedVideos for debugging
globalThis.allDetectedVideosInternal = allDetectedVideos;

// Temporary processing trackers (not for storage)
const processingRequests = {
  previews: new Set(), // Track URLs currently being processed for previews
  metadata: new Set()  // Track URLs currently being processed for metadata
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
    
    // Second pass: process each variant to ensure it has full metadata
    const processedWithVariants = validatedVideos.map(video => {
        // If this is a master playlist with variants, ensure each variant has full metadata
        if (video.isMasterPlaylist && video.variants && video.variants.length > 0) {
            const processedVariants = video.variants.map(variant => {
                // Find if this variant exists directly in the videos list
                const fullVariant = validatedVideos.find(v => 
                    v.isVariant && normalizeUrl(v.url) === normalizeUrl(variant.url) && v.isFullyParsed);
                
                if (fullVariant) {
                    // Use the fully parsed variant data instead of the limited variant data
                    logDebug(`Using fully parsed data for variant: ${variant.url}`);
                    
                    // Deep clone the mediaInfo to ensure all properties are transmitted
                    const clonedMediaInfo = fullVariant.mediaInfo ? 
                        JSON.parse(JSON.stringify(fullVariant.mediaInfo)) : null;
                    
                    // Count the mediaInfo fields for verification
                    const mediaInfoFieldCount = clonedMediaInfo ? Object.keys(clonedMediaInfo).length : 0;
                    logDebug(`Variant ${variant.url} has ${mediaInfoFieldCount} mediaInfo fields after clone`);
                    
                    // Merge the variant data with the full variant data
                    return {
                        ...variant,
                        ...fullVariant,
                        mediaInfo: clonedMediaInfo,
                        isFullyParsed: true,
                        // Add this flag to indicate it's using complete data
                        hasCompleteMetadata: true
                    };
                }
                
                return variant;
            });
            
            // Replace the variants array with the processed variants
            return {
                ...video,
                variants: processedVariants
            };
        }
        
        return video;
    });
    
    // Third pass: final preparation for display
    const processedVideos = processedWithVariants.map(video => {
        // Add additional information needed for immediate display
        return {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || Date.now(),
            processed: true,
            lastProcessedAt: Date.now(),
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            poster: video.poster || video.previewUrl || null,
            downloadable: true,
            // Preserve source information or default to 'background'
            source: video.source || 'background',
            // Preserve the detection timestamp for debugging duplicates
            detectionTimestamp: video.detectionTimestamp || null,
            // Ensure variants are properly preserved
            variants: video.variants || [],
            // Preserve parsing state flags
            isLightParsed: video.isLightParsed || false,
            isFullyParsed: video.isFullyParsed || false,
            isMasterPlaylist: video.isMasterPlaylist || false,
            isVariant: video.isVariant || false,
            // File size information
            fileSize: video.fileSize || video.mediaInfo?.sizeBytes || video.mediaInfo?.estimatedSize || null
        };
    });
    
    // Sort by newest first
    return processedVideos.sort((a, b) => b.timestamp - a.timestamp);
}

// Broadcast videos to popup
function broadcastVideoUpdate(tabId) {
    if (!videosPerTab.has(tabId) || videosPerTab.get(tabId).length === 0) {
        return [];
    }
    
    // Get videos for tab and process them
    const videos = videosPerTab.get(tabId);
    const processedVideos = processVideosForBroadcast(videos);
    
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

// Add a new temporary map to track standalone variants before we know if they belong to a master
const pendingVariantsMap = new Map(); // key = tabId, value = Map<normalizedUrl, variantInfo>

// Add video to tab's collection
function addVideoToTab(tabId, videoInfo) {
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Initialize tab's video collection if it doesn't exist
    if (!allDetectedVideos.has(tabId)) {
        allDetectedVideos.set(tabId, new Map());
    }
    
    // Get the map for this specific tab
    const tabDetectedVideos = allDetectedVideos.get(tabId);
    
    // Skip if already in this tab's collection
    if (tabDetectedVideos.has(normalizedUrl)) {
        return false;
    }
    
    // Add to tab's collection
    tabDetectedVideos.set(normalizedUrl, {
        ...videoInfo,
        normalizedUrl,
        timestamp: Date.now()
    });
    
    // Create array for tab if it doesn't exist
    if (!videosPerTab.has(tabId)) {
        videosPerTab.set(tabId, []);
    }
    
    const tabVideos = videosPerTab.get(tabId);
    
    // Special handling for variants - store in pending map first
    if (videoInfo.isVariant && !videoInfo.masterUrl) {
        // This looks like a variant that was detected standalone (not via a master)
        // Store it in pending map for potential later processing
        if (!pendingVariantsMap.has(tabId)) {
            pendingVariantsMap.set(tabId, new Map());
        }
        
        // Check if we already have this variant in pending map
        const tabPendingVariants = pendingVariantsMap.get(tabId);
        if (!tabPendingVariants.has(normalizedUrl)) {
            logDebug(`Storing potential standalone variant in pending map: ${videoInfo.url}`);
            tabPendingVariants.set(normalizedUrl, {
                ...videoInfo,
                timestamp: Date.now(),
                detectionTimestamp: Date.now()
            });
        }
        
        // Don't add to main videos collection yet
        return;
    }
    
    // Check if video already exists in main collection
    const existingIndex = tabVideos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
    
    let video; // The video object to work with
    
    if (existingIndex !== -1) {
        // Update existing video
        tabVideos[existingIndex] = {
            ...tabVideos[existingIndex],
            ...videoInfo,
            timestamp: tabVideos[existingIndex].timestamp || Date.now(),
            // Preserve existing fields if new data doesn't have them
            poster: videoInfo.poster || tabVideos[existingIndex].poster,
            title: videoInfo.title || tabVideos[existingIndex].title,
            // Preserve parsing states if they exist
            isLightParsed: videoInfo.isLightParsed || tabVideos[existingIndex].isLightParsed || false, 
            isFullyParsed: videoInfo.isFullyParsed || tabVideos[existingIndex].isFullyParsed || false,
            // Preserve variants information
            variants: videoInfo.variants || tabVideos[existingIndex].variants || [],
            isMasterPlaylist: videoInfo.isMasterPlaylist || tabVideos[existingIndex].isMasterPlaylist, 
            isVariant: videoInfo.isVariant || tabVideos[existingIndex].isVariant || false
        };
        video = tabVideos[existingIndex];
    } else {
        // Add new video
        video = {
            ...videoInfo,
            timestamp: Date.now(),
            // Important flags for tracking processing status
            isBeingProcessed: false,
            needsMetadata: true,
            needsPreview: !videoInfo.poster && !videoInfo.previewUrl,
            // Add parsing state flags
            isLightParsed: videoInfo.isLightParsed || false,
            isFullyParsed: videoInfo.isFullyParsed || false,
            // Master/variant status
            isMasterPlaylist: videoInfo.isMasterPlaylist || false,
            isVariant: videoInfo.isVariant || false
        };
        
        tabVideos.push(video);
        
        // Notify any open popup about the new video
        notifyNewVideoDetected(tabId);
    }
    
    // Check if this is a blob URL - skip enrichment completely for blobs
    const isBlob = video.url.startsWith('blob:');
    
    // For blob URLs, add placeholder metadata immediately and skip enrichment
    if (isBlob) {
        if (!video.mediaInfo) {
            // Set basic blob metadata if not already present
            video.mediaInfo = {
                isBlob: true,
                type: 'blob',
                format: 'blob',
                container: 'blob',
                hasVideo: true,
                hasAudio: true
            };
            video.needsMetadata = false;
            video.needsPreview = false;
            video.isFullyParsed = true; // Mark blob URLs as fully parsed
        }
    } else {
        // For HLS/DASH playlists, process to detect master-variant relationships
        if ((video.type === 'hls' || video.type === 'dash') && 
            !video.isLightParsed && !video.isVariant && !video.variants) {
            enrichWithPlaylistInfo(video, tabId);
        }
        
        // Enrich with metadata if needed, only if not fully parsed already
        if (!video.isFullyParsed && !video.mediaInfo && !processingRequests.metadata.has(normalizedUrl)) {
            enrichWithMetadata(video, tabId);
        }
        
        // Generate preview if needed
        if (!video.previewUrl && !video.poster && !processingRequests.previews.has(normalizedUrl)) {
            enrichWithPreview(video, tabId);
        }
    }
    
    // Broadcast update
    broadcastVideoUpdate(tabId);
}

// Enrich video with playlist information (for HLS/DASH)
async function enrichWithPlaylistInfo(video, tabId) {
    try {
        // Skip if already light parsed and we know its type
        if (video.isLightParsed && (video.isMasterPlaylist || video.isVariant)) {
            logDebug(`Skipping playlist info enrichment for already parsed video: ${video.url}`);
            return;
        }
        
        // Use the manifest service to process the video
        const processedVideo = await processVideoRelationships(video);
        
        if (processedVideo && processedVideo !== video) {
            // Update video with new information
            const normalizedUrl = normalizeUrl(video.url);
            const videos = videosPerTab.get(tabId);
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            
            if (index !== -1) {
                // Update the video with new information
                // Save previous variants count for comparison
                const previousVariantsCount = videos[index].variants?.length || 0;
                
                videos[index] = {
                    ...videos[index],
                    ...processedVideo,
                    // Preserve original fields
                    timestamp: videos[index].timestamp,
                    detectionTimestamp: videos[index].detectionTimestamp,
                    // Ensure variants array is populated
                    variants: processedVideo.variants || videos[index].variants || []
                };
                
                // Log variants info for debugging
                const currentVariantsCount = videos[index].variants?.length || 0;
                
                // If this is a master playlist with variants, handle variant deduplication
                if (processedVideo.isMasterPlaylist && processedVideo.variants && processedVideo.variants.length > 0) {
                    logDebug(`Found master playlist with ${currentVariantsCount} variants (was ${previousVariantsCount})`);
                    
                    // Get the pending variants map for this tab
                    const pendingVariants = pendingVariantsMap.get(tabId) || new Map();
                    
                    // Instead of adding variants directly, store their relation to this master
                    // in the pending map. This way they can all be processed in one place.
                    processedVideo.variants.forEach(variant => {
                        const variantNormalizedUrl = normalizeUrl(variant.url);
                        
                        // If this variant already exists in pending map, update it with master info
                        if (pendingVariants.has(variantNormalizedUrl)) {
                            const existingVariant = pendingVariants.get(variantNormalizedUrl);
                            pendingVariants.set(variantNormalizedUrl, {
                                ...existingVariant,
                                ...variant,
                                isVariant: true,
                                masterUrl: video.url, 
                                isMasterPlaylist: false,
                                // Set a flag to indicate this variant has a known master
                                hasKnownMaster: true
                            });
                            logDebug(`Updated pending variant with master info: ${variant.url}`);
                        } else {
                            // Add new entry to pending map
                            pendingVariants.set(variantNormalizedUrl, {
                                ...variant,
                                url: variant.url,
                                type: video.type,
                                source: 'variantExtraction',
                                isVariant: true,
                                masterUrl: video.url,
                                isMasterPlaylist: false,
                                isFullyParsed: false,
                                needsMetadata: true,
                                hasKnownMaster: true, 
                                timestamp: Date.now(),
                                detectionTimestamp: Date.now()
                            });
                            logDebug(`Added new variant to pending map: ${variant.url}`);
                        }
                    });
                    
                    // Update the pending variants map
                    pendingVariantsMap.set(tabId, pendingVariants);
                    
                    // Trigger processing of pending variants sooner since we found new ones
                    schedulePendingVariantsProcessing(tabId);
                    
                    // Broadcast update with the new information about the master
                    broadcastVideoUpdate(tabId);
                } else if (currentVariantsCount === 0) {
                    logDebug(`⚠️ Master playlist has no variants: ${videos[index].url}`);
                }
            }
        }
    } catch (error) {
        console.error('Error processing playlist relationships:', error);
    }
}

// Enrich video with metadata
async function enrichWithMetadata(video, tabId) {
    const normalizedUrl = normalizeUrl(video.url);
    
    // Skip if already fully parsed or being processed
    if (video.isFullyParsed || processingRequests.metadata.has(normalizedUrl)) {
        logDebug(`[DEBUG] ⏭️ Skipping metadata enrichment for ${video.url} - already ${video.isFullyParsed ? 'fully parsed' : 'in progress'}`);
        return;
    }
    
    // Mark as being processed
    processingRequests.metadata.add(normalizedUrl);
    
    try {
        // Skip blob URLs as they can't be analyzed
        if (video.url.startsWith('blob:')) {
            // For blob URLs, set placeholder media info
            applyMetadataToVideo(tabId, normalizedUrl, {
                isBlob: true,
                type: 'blob',
                format: 'blob',
                container: 'blob',
                hasVideo: true,
                hasAudio: true
            });
            return;
        }
        
        // For master playlists, we might not need detailed metadata
        // since we'll get that from the variants
        if (video.isLightParsed && video.isMasterPlaylist) {
            // If we have variants, apply basic metadata and mark as processed
            if (video.variants && video.variants.length > 0) {
                logDebug(`[DEBUG] ⚡ OPTIMIZATION: Using variant info for master playlist ${video.url}`);
                
                // Calculate basic info from variants if available
                const highestQuality = [...video.variants].sort((a, b) => 
                    (b.bandwidth || 0) - (a.bandwidth || 0)
                )[0];
                
                if (highestQuality) {
                    // Create basic metadata from variant info
                    applyMetadataToVideo(tabId, normalizedUrl, {
                        type: video.type,
                        format: video.type,
                        container: video.type,
                        isMasterPlaylist: true,
                        hasVideo: true,
                        hasAudio: true,
                        width: highestQuality.width,
                        height: highestQuality.height,
                        fps: highestQuality.fps || highestQuality.frameRate,
                        videoBitrate: highestQuality.bandwidth,
                        totalBitrate: highestQuality.bandwidth,
                        estimatedSize: estimateFileSize(highestQuality.bandwidth, video.duration)
                    });
                    return;
                }
            }
        }
        
        // For variant streams with a known master, we might already have some basic metadata,
        // but we want to ensure we get full metadata for all variants
        if (video.isVariant && video.masterUrl) {
            const videos = videosPerTab.get(tabId);
            const masterVideo = videos.find(v => normalizeUrl(v.url) === normalizeUrl(video.masterUrl));
            
            if (masterVideo && masterVideo.variants) {
                const matchingVariant = masterVideo.variants.find(
                    v => normalizeUrl(v.url) === normalizedUrl
                );
                
                if (matchingVariant) {
                    // Get the variant's base info from the master, but always continue to full metadata fetch
                    logDebug(`Variant ${video.url} found in master ${video.masterUrl}`);
                    
                    // Extract basic info from the matching variant in the master playlist
                    const variantBaseInfo = {
                        type: video.type,
                        format: video.type,
                        container: video.type,
                        isVariant: true,
                        hasVideo: true,
                        hasAudio: true,
                        width: matchingVariant.width,
                        height: matchingVariant.height,
                        fps: matchingVariant.fps || matchingVariant.frameRate,
                        videoBitrate: matchingVariant.bandwidth,
                        totalBitrate: matchingVariant.bandwidth,
                        estimatedSize: estimateFileSize(matchingVariant.bandwidth, video.duration)
                    };
                    
                    // Store this info, but don't return - continue to get full metadata below
                    video.partialMediaInfo = variantBaseInfo;
                    
                    // If this is just for partial metadata and we don't want full parsing, return now
                    if (!video.isFullyParsed && video.isLightParsed) {
                        applyMetadataToVideo(tabId, normalizedUrl, variantBaseInfo);
                        return;
                    }
                    
                    // Otherwise continue to full metadata fetch below
                    logDebug(`Getting full metadata for variant: ${video.url}`);
                }
            }
        }
        
        // If we made it here, get the full metadata from the native host
        // Use our rate limiter to prevent too many concurrent requests
        const streamInfo = await rateLimiter.enqueue(async () => {
            logDebug(`Getting stream metadata for ${video.url}`);
            
            // Always get full metadata for variants - this is the key to fixing the issue
            const useLight = false; // Force full parsing for all HLS/DASH content
            
            // Detailed logging for debugging
            if (video.isVariant) {
                logDebug(`🔍 Getting FULL metadata for variant: ${video.url} (from master: ${video.masterUrl})`);
            } else if (video.isMasterPlaylist) {
                logDebug(`🔍 Getting FULL metadata for master playlist: ${video.url}`);
            } else {
                logDebug(`🔍 Getting FULL metadata for: ${video.url}`);
            }
            
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: video.url,
                light: useLight
            });

            return response?.streamInfo || null;
        });
        
        if (streamInfo) {
            // Add file size estimation for normal (non-adaptive) streams
            if (streamInfo.totalBitrate && video.duration) {
                streamInfo.estimatedSize = estimateFileSize(streamInfo.totalBitrate, video.duration);
            }
            
            applyMetadataToVideo(tabId, normalizedUrl, streamInfo);
        }
    } catch (error) {
        console.error(`Failed to get metadata for ${video.url}:`, error);
    } finally {
        // Remove from processing set
        processingRequests.metadata.delete(normalizedUrl);
    }
}

// Apply metadata to a video and notify popup
function applyMetadataToVideo(tabId, normalizedUrl, mediaInfo) {
    if (!videosPerTab.has(tabId)) return;
    
    const videos = videosPerTab.get(tabId);
    const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
    
    if (index !== -1) {
        // Special logging for variants
        if (videos[index].isVariant) {
            logDebug(`Applying metadata to variant video: ${videos[index].url}`);
            
            // If this is a variant with partial media info from its master,
            // ensure we merge all properties properly
            if (videos[index].partialMediaInfo) {
                logDebug(`Merging partial variant info with full metadata`);
                // Combine the full media info with any partial info we've already gathered
                mediaInfo = {
                    ...videos[index].partialMediaInfo,
                    ...mediaInfo,
                };
            }
        }
        
        // Create a merged mediaInfo object with proper priority
        const mergedMediaInfo = {
            // Start with any existing mediaInfo
            ...(videos[index].mediaInfo || {}),
            // Then apply new mediaInfo, which takes precedence
            ...mediaInfo,
        };
        
        // Update video with stream info
        videos[index] = {
            ...videos[index],
            mediaInfo: mergedMediaInfo,
            needsMetadata: false,  // Mark as processed
            isFullyParsed: true,   // Mark as fully parsed
            // Update resolution data from the mediaInfo
            resolution: mediaInfo.width && mediaInfo.height ? {
                width: mediaInfo.width,
                height: mediaInfo.height,
                fps: mediaInfo.fps,
                bitrate: mediaInfo.videoBitrate || mediaInfo.totalBitrate
            } : videos[index].resolution,
            fileSize: mediaInfo.estimatedSize || videos[index].fileSize
        };
        
        // Special handling for variants - ensure they have proper flag set
        if (videos[index].isVariant) {
            videos[index].isVariantFullyProcessed = true;
        }
        
        // Use the unified notification method instead
        notifyVideoUpdated(tabId, normalizedUrl, videos[index]);
    }
}

// Enrich video with preview image
async function enrichWithPreview(video, tabId) {
    const normalizedUrl = normalizeUrl(video.url);
    
    // Skip blob URLs early - they can't generate previews
    if (video.url.startsWith('blob:')) {
        // Mark as processed to avoid repeated attempts
        const videos = videosPerTab.get(tabId);
        if (videos) {
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            if (index !== -1) {
                videos[index].needsPreview = false;
                logDebug(`Skipping preview generation for blob URL: ${video.url}`);
            }
        }
        return;
    }
    
    // Mark as being processed
    processingRequests.previews.add(normalizedUrl);
    
    try {
        // Use rate limiter to prevent too many concurrent requests
        const response = await rateLimiter.enqueue(async () => {
            logDebug(`Generating preview for ${video.url}`);
            return await nativeHostService.sendMessage({
                type: 'generatePreview',
                url: video.url
            });
        });
        
        // If we successfully generated a preview, update the video
        if (response && response.previewUrl && videosPerTab.has(tabId)) {
            const videos = videosPerTab.get(tabId);
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            
            if (index !== -1) {
                // Update video with preview
                videos[index].previewUrl = response.previewUrl;
                videos[index].needsPreview = false;
                
                // Use the unified notification method instead
                notifyVideoUpdated(tabId, normalizedUrl, videos[index]);
            }
        }
    } catch (error) {
        console.error(`Error generating preview for ${video.url}:`, error);
    } finally {
        // Always remove from processing set when done
        processingRequests.previews.delete(normalizedUrl);
    }
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
            
            // Special handling for variants - include more detailed logging
            if (updatedVideo.isVariant) {
                const mediaInfoFieldCount = updatedVideo.mediaInfo ? Object.keys(updatedVideo.mediaInfo).length : 0;
                logDebug(`Sending variant update with ${mediaInfoFieldCount} mediaInfo fields: ${url}`);
                
                // Add detailed logging of available fields for debugging
                if (updatedVideo.mediaInfo) {
                    logDebug(`Variant mediaInfo fields: ${Object.keys(updatedVideo.mediaInfo).join(', ')}`);
                }
            }
            
            // Make a clean copy of the video object for transmission
            const videoForTransmission = {
                ...updatedVideo,
                // Force a deep clone of mediaInfo to ensure all properties are transmitted
                mediaInfo: updatedVideo.mediaInfo ? JSON.parse(JSON.stringify(updatedVideo.mediaInfo)) : null,
                // Also deep clone any variants
                variants: updatedVideo.variants ? JSON.parse(JSON.stringify(updatedVideo.variants)) : [],
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
    if (!videosPerTab.has(tabId)) {
        return [];
    }
    
    return processVideosForBroadcast(videosPerTab.get(tabId));
}

// Get playlists for tab - compatibility function
function getPlaylistsForTab(tabId) {
    if (!videosPerTab.has(tabId)) {
        return [];
    }
    
    // Extract playlists from the videos array
    const videos = videosPerTab.get(tabId);
    const playlists = videos
        .filter(v => v.type === 'hls' && v.url.includes('.m3u8') && !v.isVariant)
        .map(v => normalizeUrl(v.url));
    
    return Array.from(new Set(playlists));
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

// // Store manifest relationship - for compatibility
// function storeManifestRelationship(playlistUrl, variants) {
//     // Since manifests are typically found in a single tab context,
//     // we'll simplify by only updating the first matching tab
    
//     for (const [tabId, videos] of videosPerTab.entries()) {
//         const playlistIndex = videos.findIndex(v => normalizeUrl(v.url) === normalizeUrl(playlistUrl));
        
//         if (playlistIndex !== -1) {
//             // Found the playlist in this tab, update it
//             videos[playlistIndex].variants = variants;
//             videos[playlistIndex].isMasterPlaylist = true;
            
//             // Add any variants that don't already exist in this tab
//             for (const variant of variants) {
//                 const variantIndex = videos.findIndex(v => normalizeUrl(v.url) === normalizeUrl(variant.url));
                
//                 if (variantIndex === -1) {
//                     // Only add new variants, don't duplicate
//                     videos.push({
//                         ...variant,
//                         url: variant.url,
//                         isVariant: true,
//                         masterPlaylistUrl: playlistUrl,
//                         isFullyParsed: false,
//                         needsMetadata: true,
//                         needsFullParsing: true
//                     });
//                 }
//             }
            
//             // Update UI and return after processing the first matching tab
//             broadcastVideoUpdate(tabId);
//             return true;
//         }
//     }
    
//     // No matching playlist found in any tab
//     return false;
// }

// Get manifest relationship - for compatibility
function getManifestRelationship(variantUrl) {
    // Find the variant in our videos collection
    for (const videos of videosPerTab.values()) {
        for (const video of videos) {
            if (video.isVariant && normalizeUrl(v.url) === normalizeUrl(variantUrl)) {
                return {
                    playlistUrl: video.masterPlaylistUrl,
                    bandwidth: video.bandwidth,
                    resolution: video.resolution,
                    codecs: video.codecs,
                    fps: video.fps
                };
            }
            
            // Also check variants list
            if (video.variants) {
                const variant = video.variants.find(v => normalizeUrl(v.url) === normalizeUrl(variantUrl));
                if (variant) {
                    return {
                        playlistUrl: video.url,
                        bandwidth: variant.bandwidth,
                        resolution: variant.resolution,
                        codecs: variant.codecs,
                        fps: variant.fps
                    };
                }
            }
        }
    }
    
    return null;
}

// Clean up for tab
function cleanupForTab(tabId) {
    logDebug('Tab removed:', tabId);
    
    // Clear any pending variants timer
    if (pendingVariantsTimers.has(tabId)) {
        clearTimeout(pendingVariantsTimers.get(tabId));
        pendingVariantsTimers.delete(tabId);
    }
    
    // Clear pending variants
    if (pendingVariantsMap.has(tabId)) {
        pendingVariantsMap.delete(tabId);
    }
    
    // Clear videos from allDetectedVideos
    if (allDetectedVideos.has(tabId)) {
        allDetectedVideos.delete(tabId);
    }
    
    // Clear videos
    if (videosPerTab.has(tabId)) {
        logDebug('Cleaning up videos for tab:', tabId);
        videosPerTab.delete(tabId);
    }
}

/**
 * Notify any open popup that new videos have been detected
 */
function notifyNewVideoDetected(tabId) {
    try {
        // Schedule processing of pending variants
        schedulePendingVariantsProcessing(tabId);
        
        // Check if a popup is open for this tab
        const port = getActivePopupPortForTab(tabId);
        
        if (port) {
            logDebug(`Notifying popup for tab ${tabId} about new video detection`);
            
            try {
                port.postMessage({
                    action: 'newVideoDetected',
                    tabId: tabId
                });
            } catch (error) {
                logDebug(`Error sending new video notification: ${error.message}`);
            }
        }
    } catch (error) {
        logDebug(`Error in notifyNewVideoDetected: ${error.message}`);
    }
}

// Set up a timer to process pending variants after page activity settles
// This will run when no new videos are detected for a period of time
let pendingVariantsTimers = new Map(); // key = tabId, value = timer ID

function schedulePendingVariantsProcessing(tabId) {
    // Clear any existing timer for this tab
    if (pendingVariantsTimers.has(tabId)) {
        clearTimeout(pendingVariantsTimers.get(tabId));
    }
    
    // Set a new timer
    const timerId = setTimeout(() => {
        processPendingVariants(tabId);
        pendingVariantsTimers.delete(tabId);
    }, 2000); // Wait 2 seconds after activity stops
    
    pendingVariantsTimers.set(tabId, timerId);
}

// Add a function to process pending variants after a certain idle time
function processPendingVariants(tabId) {
    if (!pendingVariantsMap.has(tabId)) {
        return;
    }
    
    const pendingVariants = pendingVariantsMap.get(tabId);
    if (pendingVariants.size === 0) {
        return;
    }
    
    logDebug(`Processing ${pendingVariants.size} pending variants for tab ${tabId}`);
    
    // Add all variants to the main collection
    for (const [url, variantInfo] of pendingVariants.entries()) {
        // Check if this is a variant with a known master or a standalone variant
        if (variantInfo.hasKnownMaster) {
            logDebug(`Adding variant with known master to main collection: ${variantInfo.url}`);
        } else {
            logDebug(`Adding standalone variant to main collection: ${variantInfo.url}`);
        }
        
        // Add to main videos collection with appropriate flags
        addVideoToTab(tabId, {
            ...variantInfo,
            // Only mark as standalone if it doesn't have a known master
            isStandaloneVariant: !variantInfo.hasKnownMaster
        });
    }
    
    // Clear the pending variants map for this tab
    pendingVariants.clear();
    
    // Broadcast update with the new variants
    broadcastVideoUpdate(tabId);
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

// Get stream metadata for a URL
async function getStreamMetadata(url) {
    try {
        // Check if we already have this video's metadata
        for (const videos of videosPerTab.values()) {
            const video = videos.find(v => normalizeUrl(v.url) === normalizeUrl(url));
            if (video && video.mediaInfo) {
                return video.mediaInfo;
            }
        }
        
        // Skip blob URLs as they can't be analyzed
        if (url.startsWith('blob:')) {
            logDebug(`Skipping metadata request for blob URL: ${url}`);
            return {
                isBlob: true,
                type: 'blob',
                format: 'blob',
                container: 'blob',
                hasVideo: true,
                hasAudio: true
            };
        }
        
        // Use our rate limiter to prevent too many concurrent requests
        return await rateLimiter.enqueue(async () => {
            logDebug(`Getting stream metadata for ${url}`);
            
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: url
            });

            if (response?.streamInfo) {
                return response.streamInfo;
            }
            return null;
        });
    } catch (error) {
        console.error('Failed to get stream metadata:', error);
        return null;
    }
}

/**
 * Clear all video caches for all tabs
 * This is used by the UI to force a complete refresh
 */
function clearVideoCache() {
    logDebug('Clearing all video caches');
    
    // Clear all videos for all tabs
    videosPerTab.clear();
    
    // Clear central video collection
    allDetectedVideos.clear();
    
    // Clear processing requests
    processingRequests.previews.clear();
    processingRequests.metadata.clear();
    
    // Also clear pending variants
    pendingVariantsMap.clear();
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

export {
    addVideoToTab,
    broadcastVideoUpdate,
    getStreamQualities,
    getVideosForTab,
    getPlaylistsForTab,
    cleanupForTab,
    normalizeUrl,
    fetchManifestContent,
    getManifestRelationship,
    getStreamMetadata,
    clearVideoCache,
    getAllDetectedVideos
};