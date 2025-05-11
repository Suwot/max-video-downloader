/**
 * @ai-guide-component VideoProcessor
 * @ai-guide-description Video processing and organization
 * @ai-guide-responsibilities
 * - Groups videos by type (HLS, DASH, etc.)
 * - Handles video processing logic
 * - Implements video validation and filtering
 * - Manages video quality variants
 */

// popup/js/video-processor.js

// Import from video-state-service
import { 
    videoStateService
} from './services/video-state-service.js';

import { sendPortMessage } from './index.js';

// Cache for stream metadata
const metadataCache = new Map();

/**
 * [DEPRECATED] Process videos - pass through only
 * @deprecated Use background-processed videos directly, this method is only for backward compatibility
 * @param {Array} videos - Videos to process
 * @returns {Array} The same videos (passthrough)
 */
export function processVideos(videos) {
    console.warn('processVideos is deprecated - videos are now processed in the background script');
    return videos;
}

/**
 * Check if two videos have the same HLS base directory
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos share base directory
 */
function shareHLSBaseDirectory(video1, video2) {
    try {
        const getBaseDirectory = (url) => {
            const parts = url.split('/');
            parts.pop();
            return parts.join('/');
        };
        
        const dir1 = getBaseDirectory(video1.url);
        const dir2 = getBaseDirectory(video2.url);
        return dir1 === dir2;
    } catch (e) {
        console.error('Error checking HLS directory:', e);
        return false;
    }
}

/**
 * Get base URL (for grouping purposes)
 * @param {string} url - Full URL
 * @returns {string} Base URL
 */
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname.split('/').slice(0, -1).join('/');
    } catch (e) {
        return url.split('/').slice(0, -1).join('/');
    }
}

/**
 * Check if two videos should be grouped together
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos should be grouped
 */
export function shouldGroupVideos(video1, video2) {
    // For HLS videos, use manifest relationships
    if (video1.type === 'hls' && video2.type === 'hls') {
        // Must be in same directory first
        if (!shareHLSBaseDirectory(video1, video2)) {
            return false;
        }

        // If one is a master playlist and has variants
        if (video1.isMasterPlaylist && video1.variants?.some(v => v.url === video2.url)) {
            return true;
        }
        if (video2.isMasterPlaylist && video2.variants?.some(v => v.url === video1.url)) {
            return true;
        }

        // Both are variants - check if they're from same directory and have variant naming
        if (!video1.isMasterPlaylist && !video2.isMasterPlaylist) {
            const name1 = video1.url.split('/').pop();
            const name2 = video2.url.split('/').pop();
            if (name1.startsWith('video_') && name2.startsWith('video_')) {
                return true;
            }
        }
    }
    
    // For non-HLS videos, check base URL
    const baseUrl1 = getBaseUrl(video1.url);
    const baseUrl2 = getBaseUrl(video2.url);
    
    return (baseUrl1 === baseUrl2) && 
           video1.resolution && video2.resolution && 
           (video1.resolution.width !== video2.resolution.width || 
            video1.resolution.height !== video2.resolution.height);
}

/**
 * [DEPRECATED] Group videos - pass through only 
 * @deprecated Use background-processed videos directly, this method is only for backward compatibility
 * @param {Array} videos - Videos to group
 * @returns {Array} The same videos (passthrough)
 */
export function groupVideos(videos) {
    console.warn('groupVideos is deprecated - grouping is now handled in the background script');
    return videos;
}

/**
 * Group videos by type for display
 * @param {Array} videos - The videos to group
 * @returns {Object} Grouped videos by type
 */
export function groupVideosByType(videos) {
    // Initialize video groups
    const groups = {
        hls: [],
        dash: [],
        direct: [],
        blob: [],
        unknown: []
    };

    // Group videos by type
    videos.forEach(video => {
        if (!video || !video.url) return;
        
        const type = video.type || 'unknown';
        
        // Add to appropriate group
        if (type === 'hls') {
            groups.hls.push(video);
        } else if (type === 'dash') {
            groups.dash.push(video);
        } else if (type === 'blob') {
            groups.blob.push(video);
        } else if (type === 'direct' || type === 'mp4' || type === 'mp3' || type === 'video') {
            groups.direct.push(video);
        } else {
            groups.unknown.push(video);
        }
    });
    
    return groups;
}

/**
 * Parse and process stream qualities
 * @param {Object} streamInfo - Stream information from native host
 * @returns {Array} Array of quality options
 */
export function processStreamQualities(streamInfo) {
    const qualities = [];
    
    // Process HLS/DASH variants if available
    if (streamInfo.variants && streamInfo.variants.length > 0) {
        streamInfo.variants.forEach(variant => {
            qualities.push({
                type: 'variant',
                resolution: variant.resolution || `${variant.width}x${variant.height}`,
                bandwidth: parseInt(variant.bandwidth),
                codecs: variant.codecs,
                url: variant.url,
                fps: variant.fps
            });
        });
    }
    
    // Add main stream quality
    if (streamInfo.hasVideo) {
        qualities.push({
            type: 'main',
            resolution: `${streamInfo.width}x${streamInfo.height}`,
            fps: streamInfo.fps,
            videoBitrate: streamInfo.videoBitrate,
            videoCodec: streamInfo.videoCodec.name,
            audioBitrate: streamInfo.audioBitrate,
            audioCodec: streamInfo.audioCodec?.name,
            url: streamInfo.url
        });
    }
    
    // Sort by resolution and bitrate
    return qualities.sort((a, b) => {
        const [aHeight] = a.resolution.split('x').map(Number).reverse();
        const [bHeight] = b.resolution.split('x').map(Number).reverse();
        if (aHeight === bHeight) {
            return (b.bandwidth || b.videoBitrate) - (a.bandwidth || a.videoBitrate);
        }
        return bHeight - aHeight;
    });
}

/**
 * Process and cache stream metadata locally
 * @param {string} url - Stream URL
 * @param {Object} streamInfo - Stream information
 */
export function processStreamMetadata(url, streamInfo) {
    // Extract and normalize stream configuration
    const config = {
        format: streamInfo.container,
        videoCodec: streamInfo.hasVideo ? {
            name: streamInfo.videoCodec.name,
            profile: streamInfo.videoCodec.profile,
            level: streamInfo.videoCodec.level
        } : null,
        audioCodec: streamInfo.hasAudio ? {
            name: streamInfo.audioCodec.name,
            channels: streamInfo.audioCodec.channels,
            sampleRate: streamInfo.audioCodec.sampleRate
        } : null,
        qualities: processStreamQualities(streamInfo)
    };
    
    // Cache the processed metadata locally
    metadataCache.set(url, config);
    return config;
}

/**
 * Add stream metadata to local cache
 * @param {string} url - Video URL
 * @param {Object} metadata - Video metadata
 */
export function addStreamMetadata(url, metadata) {
    metadataCache.set(url, metadata);
}

/**
 * Get stream metadata from local cache
 * @param {string} url - Video URL
 * @returns {Object|undefined} Metadata if available
 */
export function getStreamMetadata(url) {
    return metadataCache.get(url);
}

/**
 * Get stream qualities for a URL
 * @param {string} url - Video URL
 * @returns {Promise<Array>} Array of available qualities
 */
export async function getStreamQualities(url) {
    // Get current tab ID
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    
    if (!tabId) {
        throw new Error('Cannot determine active tab');
    }
    
    // Check local cache first
    if (metadataCache.has(url)) {
        return metadataCache.get(url);
    }
    
    // Send port message to request qualities
    sendPortMessage({
        type: 'getHLSQualities',
        url: url,
        tabId: tabId
    });
    
    // Wait for response via event
    return new Promise((resolve, reject) => {
        let timeoutId;
        
        const handleResponse = (event) => {
            const response = event.detail;
            
            // Only process responses for our URL
            if (response.url === url) {
                clearTimeout(timeoutId);
                document.removeEventListener('qualities-response', handleResponse);
                
                // If we got stream info, extract the qualities
                if (response.streamInfo) {
                    const streamInfo = response.streamInfo;
                    
                    // Cache the response locally
                    metadataCache.set(url, streamInfo);
                    
                    // If we have variants, format them for the quality selector
                    if (streamInfo.variants && streamInfo.variants.length > 0) {
                        const qualities = streamInfo.variants.map(variant => {
                            return {
                                url: variant.url,
                                resolution: `${variant.width}x${variant.height}`,
                                height: variant.height,
                                width: variant.width,
                                fps: variant.fps,
                                bandwidth: variant.bandwidth,
                                codecs: variant.codecs
                            };
                        });
                        
                        resolve(qualities);
                    } else {
                        // No variants, just use the original URL with its resolution
                        resolve([{
                            url: url,
                            resolution: streamInfo.width && streamInfo.height ? 
                                `${streamInfo.width}x${streamInfo.height}` : 'Original',
                            height: streamInfo.height,
                            width: streamInfo.width,
                            fps: streamInfo.fps,
                            bandwidth: streamInfo.videoBitrate || streamInfo.totalBitrate,
                            codecs: streamInfo.videoCodec?.name
                        }]);
                    }
                } else {
                    resolve([]);
                }
            }
        };
        
        // Set timeout for response
        timeoutId = setTimeout(() => {
            document.removeEventListener('qualities-response', handleResponse);
            resolve([]);
        }, 5000);
        
        // Listen for response
        document.addEventListener('qualities-response', handleResponse);
    });
}

/**
 * Clear HLS relationships
 */
export function clearHLSRelationships() {
    // HLS relationships are now managed entirely in the background
    console.log('HLS relationships now managed in background script');
}

// Export a minimal setVideoGroups function for backward compatibility
export function setVideoGroups(groups) {
    // No-op - groups are maintained in background
}