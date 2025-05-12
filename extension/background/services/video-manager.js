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
import { getActivePopupPortForTab } from './popup-ports.js';
import { lightParseContent, fullParseContent } from '../../js/utilities/simple-js-parser.js';

// The primary data structure: Map<tabId, Array<VideoEntry>>
// Each VideoEntry now contains all necessary information including metadata, preview, etc.
const videosPerTab = new Map();

// Central store for all detected videos, keyed by tab ID, then normalized URL
// Map<tabId, Map<normalizedUrl, videoInfo>>
const allDetectedVideos = new Map();

// Expose allDetectedVideos for debugging
globalThis.allDetectedVideosInternal = allDetectedVideos;

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
    const tabDetectedVideos = allDetectedVideos.get(tabId);
    
    // Skip if already in this tab's collection
    if (tabDetectedVideos.has(normalizedUrl)) {
        return false;
    }
    
    // Add to tab's collection with timestamp
    tabDetectedVideos.set(normalizedUrl, {
        ...videoInfo,
        normalizedUrl,
        tabId, // Store the tab ID for reference
        timestamp: Date.now(),
        detectionTimestamp: Date.now()
    });
    
    logDebug(`Added new video to detection map: ${videoInfo.url} (type: ${videoInfo.type})`);
    
    // Now process based on video type
    if (videoInfo.type === 'direct' || videoInfo.url.startsWith('blob:')) {
        // Direct videos and blobs can go straight to addVideoToTab
        addVideoToTab(tabId, videoInfo);
    } else if (videoInfo.type === 'hls' || videoInfo.type === 'dash') {
        // First determine subtype via lightweight parsing before adding to tab
    (async () => {
        try {
            const parseResult = await lightParseContent(videoInfo.url, videoInfo.type);
            
            // Update the entry in allDetectedVideos with subtype info
            const tabMap = allDetectedVideos.get(tabId);
            if (tabMap && tabMap.has(normalizedUrl)) {
                const updatedEntry = {
                    ...tabMap.get(normalizedUrl),
                    subtype: parseResult.subtype,
                    isValid: parseResult.isValid,
                    isMasterPlaylist: parseResult.subtype === 'hls-master' || parseResult.subtype === 'dash-master',
                    isVariant: parseResult.subtype === 'hls-variant' || parseResult.subtype === 'dash-variant'
                };
                
                tabMap.set(normalizedUrl, updatedEntry);
                
                // Only add master playlists to the tab collection
                if (parseResult.isValid && (parseResult.subtype === 'hls-master' || parseResult.subtype === 'dash-master')) {
                    logDebug(`Adding master playlist to tab: ${videoInfo.url} (${parseResult.subtype})`);
                    addVideoToTab(tabId, updatedEntry);
                } else if (parseResult.isValid) {
                    logDebug(`Skipping variant in main tab collection: ${videoInfo.url} (${parseResult.subtype})`);
                }
            }
        } catch (error) {
            logDebug(`Error determining subtype for ${videoInfo.url}: ${error.message}`);
            // Fall back to adding video as-is if parsing fails
            addVideoToTab(tabId, videoInfo);
        }
    })();
    } else {
        // Unknown types also go straight to addVideoToTab
        addVideoToTab(tabId, videoInfo);
    }
    
    return true;
}

// Temporary processing trackers (not for storage)
const processingRequests = {
  previews: new Set(), // Track URLs currently being processed for previews
  metadata: new Set(),  // Track URLs currently being processed for metadata
  lightParsing: new Set() // Track URLs currently being light parsed
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
        // If this is a master playlist with variants, enhance each variant with available info
        if (video.isMasterPlaylist && video.variants && video.variants.length > 0) {
            const processedVariants = video.variants.map(variant => {
                // The variant info is already stored in the master playlist
                // No need to look for standalone variants anymore
                return {
                    ...variant,
                    // Add any missing properties needed for UI display
                    isVariant: true,
                    hasKnownMaster: true,
                    mediaInfo: variant.mediaInfo || null
                };
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

// Add video to tab's collection
function addVideoToTab(tabId, videoInfo) {
    // Normalize URL for deduplication - we'll need this for lookup
    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Get the video from the allDetectedVideos map if available
    let videoToAdd = videoInfo;
    const tabDetectedVideos = allDetectedVideos.get(tabId);
    if (tabDetectedVideos && tabDetectedVideos.has(normalizedUrl)) {
        // Use the enhanced video from the allDetectedVideos map
        videoToAdd = tabDetectedVideos.get(normalizedUrl);
    } else {
        logDebug(`Warning: Video not found in allDetectedVideos map: ${videoInfo.url}`);
    }
    
    // Create array for tab if it doesn't exist
    if (!videosPerTab.has(tabId)) {
        videosPerTab.set(tabId, []);
    }
    
    const tabVideos = videosPerTab.get(tabId);
    
    // Variant handling approach:
    // - Variants detected via a master are stored only as nested objects in their master playlist
    // - Standalone variants (not detected through a master) are still added directly to the collection
    
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
                hasVideo: null,
                hasAudio: null
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
    
    // Note: At this point, even variants from master playlists are still added to the main collection
    // But they will be filtered out at display time in getVideosForTab() if they have a known master
    // This ensures we can still work with them in the background but they don't appear as duplicates in the UI
    }
    
    // Broadcast update
    broadcastVideoUpdate(tabId);
}

// Enrich video with playlist information (for HLS/DASH)
async function enrichWithPlaylistInfo(video, tabId) {
    try {
        // Skip if already light parsed and we know its type
        if (video.isLightParsed || (video.subtype && video.subtype !== 'processing')) {
            logDebug(`Skipping playlist info enrichment for already parsed video: ${video.url} (${video.subtype || 'no subtype'})`);
            
            // If it's a light-parsed master, we still want to extract variants
            if (video.subtype === 'hls-master' || video.subtype === 'dash-master') {
                logDebug(`Processing master playlist for variants: ${video.url}`);
                // Continue with variant extraction
            } else if (video.subtype === 'not-a-video' || video.subtype === 'fetch-failed') {
                // Skip further processing for non-videos
                return;
            }
        }
        
        // Use only our JS-based parser for all playlists, no fallback
        logDebug(`Using JS parser to extract variants from ${video.url} (${video.subtype || video.type})`);
        
        // Use our fast JS-based parser
        const parseResult = await fullParseContent(video.url, video.subtype || video.type);
        
        if (parseResult.variants && parseResult.variants.length > 0) {
            logDebug(`JS parser found ${parseResult.variants.length} variants in ${video.url}`);
            
            // Update video with the variants info
            const normalizedUrl = normalizeUrl(video.url);
            const videos = videosPerTab.get(tabId);
            const index = videos.findIndex(v => normalizeUrl(v.url) === normalizedUrl);
            
            if (index !== -1) {
                // Update the video with duration if available
                if (parseResult.duration) {
                    videos[index].duration = parseResult.duration;
                }
                
                // Enhanced variants with additional information
                const enhancedVariants = parseResult.variants.map(variant => {
                    return {
                        ...variant,
                        type: video.type,
                        source: 'simple-js-parser',
                        isVariant: true,
                        masterUrl: video.url,
                        hasKnownMaster: true,
                        timestamp: Date.now(),
                    };
                });
                
                // Update the master playlist's variants with the enhanced variants
                videos[index].variants = enhancedVariants;
                videos[index].parsedWithJsParser = true;
                logDebug(`Updated master playlist with ${enhancedVariants.length} variants from JS parser`);
                
                // Also update in allDetectedVideos map
                const tabMap = allDetectedVideos.get(tabId);
                if (tabMap && tabMap.has(normalizedUrl)) {
                    const updatedEntry = {
                        ...tabMap.get(normalizedUrl),
                        variants: enhancedVariants,
                        parsedWithJsParser: true,
                        duration: parseResult.duration || tabMap.get(normalizedUrl).duration
                    };
                    tabMap.set(normalizedUrl, updatedEntry);
                }
                
                // NEW CODE: Enrich each variant with FFprobe metadata
                logDebug(`Enriching ${enhancedVariants.length} variants with FFprobe metadata`);
                
                // Process each variant sequentially to avoid overwhelming the system
                for (let i = 0; i < enhancedVariants.length; i++) {
                    const variant = enhancedVariants[i];
                    logDebug(`Getting FFprobe metadata for variant ${i+1}/${enhancedVariants.length}: ${variant.url}`);
                    
                    try {
                        // Get FFprobe data directly
                        const ffprobeData = await rateLimiter.enqueue(async () => {
                            const response = await nativeHostService.sendMessage({
                                type: 'getQualities',
                                url: variant.url,
                                light: false  // Always use full mode
                            });
                            return response?.streamInfo || null;
                        });
                        
                        if (ffprobeData) {
                            // Store FFprobe data in a dedicated field without merging
                            videos[index].variants[i].ffprobeMeta = ffprobeData;
                            // Mark as having ffprobe metadata
                            videos[index].variants[i].hasFFprobeMetadata = true;
                            
                            // Also update in allDetectedVideos map
                            if (tabMap && tabMap.has(normalizedUrl)) {
                                const currentEntry = tabMap.get(normalizedUrl);
                                if (currentEntry.variants && currentEntry.variants[i]) {
                                    currentEntry.variants[i].ffprobeMeta = ffprobeData;
                                    currentEntry.variants[i].hasFFprobeMetadata = true;
                                    // Update the entry in the map
                                    tabMap.set(normalizedUrl, currentEntry);
                                }
                            }
                            
                            logDebug(`Successfully added FFprobe metadata to variant ${i+1}`);
                        }
                    } catch (error) {
                        console.error(`Error getting FFprobe metadata for variant ${variant.url}:`, error);
                    }
                }
                
                // Broadcast update with the new information about the master
                broadcastVideoUpdate(tabId);
            } else {
                logDebug(`Video no longer exists in tab videos: ${video.url}`);
            }
        } else {
            logDebug(`JS parser couldn't extract variants from ${video.url}`);
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
            // NEW: Skip variants that already have ffprobeMeta from the master playlist process
            if (video.hasFFprobeMetadata || video.ffprobeMeta) {
                logDebug(`Skipping metadata enrichment for variant with existing ffprobeMeta: ${video.url}`);
                processingRequests.metadata.delete(normalizedUrl);
                return;
            }
            
            const videos = videosPerTab.get(tabId);
            const masterVideo = videos.find(v => normalizeUrl(v.url) === normalizeUrl(video.masterUrl));
            
            // Check if the variant has ffprobeMeta in its master's variants array
            if (masterVideo && masterVideo.variants) {
                const matchingVariantIndex = masterVideo.variants.findIndex(
                    v => normalizeUrl(v.url) === normalizedUrl
                );
                
                if (matchingVariantIndex !== -1 && 
                    masterVideo.variants[matchingVariantIndex].hasFFprobeMetadata) {
                    logDebug(`Variant ${video.url} already has ffprobeMeta in its master, using that data`);
                    // Apply the ffprobeMeta from the master playlist to this variant
                    const ffprobeData = masterVideo.variants[matchingVariantIndex].ffprobeMeta;
                    if (ffprobeData) {
                        video.ffprobeMeta = ffprobeData;
                        video.hasFFprobeMetadata = true;
                        applyMetadataToVideo(tabId, normalizedUrl, ffprobeData);
                        return;
                    }
                }
                
                if (matchingVariantIndex !== -1) {
                    // Get the variant's base info from the master, but always continue to full metadata fetch
                    logDebug(`Variant ${video.url} found in master ${video.masterUrl} at index ${matchingVariantIndex}`);
                    
                    // Extract basic info from the matching variant in the master playlist
                    const variantBaseInfo = {
                        type: video.type,
                        format: video.type,
                        container: video.type,
                        isVariant: true,
                        hasVideo: true,
                        hasAudio: true,
                        width: masterVideo.variants[matchingVariantIndex].width,
                        height: masterVideo.variants[matchingVariantIndex].height,
                        fps: masterVideo.variants[matchingVariantIndex].fps || masterVideo.variants[matchingVariantIndex].frameRate,
                        videoBitrate: masterVideo.variants[matchingVariantIndex].bandwidth,
                        totalBitrate: masterVideo.variants[matchingVariantIndex].bandwidth,
                        estimatedSize: estimateFileSize(masterVideo.variants[matchingVariantIndex].bandwidth, video.duration)
                    };
                    
                    // Update the variant in the master playlist with this metadata
                    masterVideo.variants[matchingVariantIndex] = {
                        ...masterVideo.variants[matchingVariantIndex],
                        ...variantBaseInfo,
                        mediaInfo: variantBaseInfo,
                        isFullyParsed: true
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
        
        // Check if this is ffprobe metadata that should be stored separately
        const isFFprobeData = mediaInfo.source === 'ffprobe' || (videos[index].isVariant && videos[index].hasFFprobeMetadata);
        
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
        
        // If this is FFprobe data, store it separately as well
        if (isFFprobeData && !videos[index].ffprobeMeta) {
            videos[index].ffprobeMeta = mediaInfo;
            videos[index].hasFFprobeMetadata = true;
        }
        
        // Special handling for variants - ensure they have proper flag set
        if (videos[index].isVariant) {
            videos[index].isVariantFullyProcessed = true;
            
            // If this is a variant with a known master, update the variant in the master playlist too
            if (videos[index].hasKnownMaster && videos[index].masterUrl) {
                const masterVideo = videos.find(v => normalizeUrl(v.url) === normalizeUrl(videos[index].masterUrl));
                if (masterVideo && masterVideo.variants) {
                    const variantIndex = masterVideo.variants.findIndex(
                        v => normalizeUrl(v.url) === normalizedUrl
                    );
                    
                    if (variantIndex !== -1) {
                        logDebug(`Updating variant in master playlist: ${normalizedUrl}`);
                        
                        // Update the variant in the master playlist with the new metadata
                        const updatedVariant = {
                            ...masterVideo.variants[variantIndex],
                            mediaInfo: mergedMediaInfo,
                            isFullyParsed: true,
                            isVariantFullyProcessed: true,
                            resolution: videos[index].resolution,
                            fileSize: videos[index].fileSize
                        };
                        
                        // If this is FFprobe data, also update the ffprobeMeta field
                        if (isFFprobeData && !masterVideo.variants[variantIndex].ffprobeMeta) {
                            updatedVariant.ffprobeMeta = mediaInfo;
                            updatedVariant.hasFFprobeMetadata = true;
                        }
                        
                        masterVideo.variants[variantIndex] = updatedVariant;
                    }
                }
            }
        }
        
        // Also update in allDetectedVideos map if it exists there
        const tabMap = allDetectedVideos.get(tabId);
        if (tabMap && tabMap.has(normalizedUrl)) {
            const currentEntry = tabMap.get(normalizedUrl);
            const updatedEntry = {
                ...currentEntry,
                mediaInfo: mergedMediaInfo,
                isFullyParsed: true,
                needsMetadata: false,
                resolution: videos[index].resolution,
                fileSize: videos[index].fileSize
            };
            
            // If this is FFprobe data, also update the ffprobeMeta field
            if (isFFprobeData && !currentEntry.ffprobeMeta) {
                updatedEntry.ffprobeMeta = mediaInfo;
                updatedEntry.hasFFprobeMetadata = true;
            }
            
            tabMap.set(normalizedUrl, updatedEntry);
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
                
                // Check if we need to update this variant in its master playlist
                if (updatedVideo.masterUrl && updatedVideo.hasKnownMaster) {
                    logDebug(`This variant belongs to master: ${updatedVideo.masterUrl}`);
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
    
    // Filter out variants with known masters before processing
    const videos = videosPerTab.get(tabId).filter(video => {
        // Filter out variants that have a known master - they should only appear nested in their master playlists
        return !(video.isVariant && video.hasKnownMaster);
    });
    
    return processVideosForBroadcast(videos);
}

// Clean up for tab
function cleanupForTab(tabId) {
    logDebug('Tab removed:', tabId);
    
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
    addDetectedVideo,
    addVideoToTab,
    broadcastVideoUpdate,
    getStreamQualities,
    getVideosForTab,
    cleanupForTab,
    normalizeUrl,
    getAllDetectedVideos,
    clearVideoCache
};