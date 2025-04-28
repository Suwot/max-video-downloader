/**
 * Video Manager Service
 * Manages video detection, metadata, and tracking across tabs
 */

// Add static imports at the top
import nativeHostService from '../../js/native-host-service.js';
import { validateAndFilterVideos, filterRedundantVariants } from '../../js/utilities/video-validator.js';
import { processVideoRelationships } from '../../js/manifest-service.js';

const videosPerTab = {};
const playlistsPerTab = {};
const metadataProcessingQueue = new Map();
const manifestRelationships = new Map();
const previewGenerationQueue = new Map();

// Debug logging helper
function logDebug(...args) {
    console.log('[Video Manager]', new Date().toISOString(), ...args);
}

// Add URL normalization to prevent duplicates
function normalizeUrl(url) {
    // Don't normalize blob URLs
    if (url.startsWith('blob:')) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        
        // Remove common parameters that don't affect the content
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        urlObj.searchParams.delete('_');
        urlObj.searchParams.delete('time');
        urlObj.searchParams.delete('timestamp');
        urlObj.searchParams.delete('random');
        
        // For HLS and DASH, keep a more canonical form
        if (url.includes('.m3u8') || url.includes('.mpd')) {
            // Remove common streaming parameters
            urlObj.searchParams.delete('seq');
            urlObj.searchParams.delete('segment');
            urlObj.searchParams.delete('session');
            urlObj.searchParams.delete('cmsid');
            
            // For manifest files, simply use the path for better duplicate detection
            if (url.includes('/manifest') || url.includes('/playlist') ||
                url.includes('/master.m3u8') || url.includes('/index.m3u8')) {
                return urlObj.origin + urlObj.pathname;
            }
        }
        
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
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

    // Step 1: Collect master and variant URLs
    filteredVideos.forEach(video => {
        if (video.isMasterPlaylist || video.isPlaylist || video.isMasterPlaylist === true) {
            masterUrls.add(normalizeUrl(video.url));
            
            // Check all possible variant properties (for compatibility with different versions)
            const variants = video.variants || video.qualityVariants || [];
            if (Array.isArray(variants)) {
                variants.forEach(variant => {
                    // Handle both object variants and string URLs
                    const variantUrl = typeof variant === 'string' ? variant : variant.url;
                    if (variantUrl) {
                        variantUrls.add(normalizeUrl(variantUrl));
                    }
                });
            }
        }
        
        // Also check explicit variant flags
        if (video.isVariant && video.masterUrl) {
            variantUrls.add(normalizeUrl(video.url));
            masterUrls.add(normalizeUrl(video.masterUrl));
        }
    });

    // Step 2: Build final list - exclude variants when master exists
    filteredVideos.forEach(video => {
        const normalizedUrl = normalizeUrl(video.url);
        
        // Skip if this is a variant and we have at least one master
        if (video.isVariant || variantUrls.has(normalizedUrl)) {
            // Only skip if master exists in the list
            if (masterUrls.size > 0 && masterUrls.has(normalizeUrl(video.masterUrl))) {
                logDebug(`Skipping variant ${video.url} because master exists`);
                return;
            }
        }
        
        // Add additional information needed for immediate display
        const enhancedVideo = {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || Date.now(),
            processed: true,
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            poster: video.poster || video.previewUrl || null,
            downloadable: true,
            // Add source information to track where the video came from
            source: video.source || 'background',
            // Track if this was added via background processing while popup was closed
            detectedWhilePopupClosed: true
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
        
        // Include this video in the final output
        processedVideos.push(enhancedVideo);
    });
    
    logDebug(`Filtered videos: ${validatedVideos.length} input → ${processedVideos.length} output (${masterUrls.size} masters, ${variantUrls.size} variants)`);
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
        logDebug('Skipping tracking URL without embedded video URL:', videoInfo.url);
        return;
    }

    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Get existing video info if any
    const existingVideo = videosPerTab[tabId].get(normalizedUrl);
    
    // For URLs extracted from query params, use them for deduplication
    if (videoInfo.foundFromQueryParam) {
        // Log the original source URL that contained this video URL
        if (videoInfo.originalUrl) {
            logDebug('Using extracted URL instead of original tracking URL:', videoInfo.url, 
                    'extracted from:', videoInfo.originalUrl);
        } else {
            logDebug('Found video URL in query parameter:', videoInfo.url);
        }
    }
    
    // Check if this is actually a new video
    const isNewVideo = !existingVideo;
    
    // Merge with existing data if present
    if (existingVideo) {
        logDebug('Updating existing video:', normalizedUrl);
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
            foundFromQueryParam: videoInfo.foundFromQueryParam || existingVideo.foundFromQueryParam
        };
    } else {
        logDebug('Adding new video:', normalizedUrl);
        videoInfo.timestamp = Date.now();
    }
    
    // Store video info
    videosPerTab[tabId].set(normalizedUrl, videoInfo);
    logDebug('Current video count for tab', tabId, ':', videosPerTab[tabId].size);
    
    // Use the centralized manifest service to check for and process relationships
    if (!videoInfo.isVariant && !videoInfo.isMasterPlaylist && 
        (videoInfo.type === 'hls' || videoInfo.type === 'dash')) {
        try {
            // Process this video to check for master-variant relationships
            const processedVideo = await processVideoRelationships(videoInfo);
            
            // If the video was enhanced with relationship info, update it
            if (processedVideo !== videoInfo) {
                logDebug('Video was processed and enhanced with relationship data:', 
                         processedVideo.isVariant ? 'Is variant' : 
                         processedVideo.isMasterPlaylist ? 'Is master playlist' : 'No relationships');
                
                // Update in collection
                videosPerTab[tabId].set(normalizedUrl, processedVideo);
                videoInfo = processedVideo;
            }
        } catch (error) {
            console.error('Error processing video relationships:', error);
        }
    }
    
    // Add to metadata processing queue
    if (!metadataProcessingQueue.has(normalizedUrl)) {
        metadataProcessingQueue.set(normalizedUrl, {
            ...videoInfo,
            tabId,
            timestamp: videoInfo.timestamp
        });
        processMetadataQueue();
    }
    
    // For HLS playlists, also add to that specific collection
    if (videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
    
    console.log(`Added ${videoInfo.type} video to tab ${tabId}:`, videoInfo.url);
    
    // After processing relationships, group videos and broadcast update
    if (isNewVideo) {
        // Apply automatic grouping and filtering before broadcasting
        broadcastVideoUpdate(tabId);
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
    
    // Convert Map to Array for sending
    const videos = Array.from(videosPerTab[tabId].values());
    videos.sort((a, b) => b.timestamp - a.timestamp);
    
    return videos;
}

// Get playlists for tab
function getPlaylistsForTab(tabId) {
    return playlistsPerTab[tabId] ? Array.from(playlistsPerTab[tabId]) : [];
}

// Helper function to fetch manifest content
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            headers: {
                'Accept': '*/*'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
        }
        
        return await response.text();
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
    normalizeUrl
};