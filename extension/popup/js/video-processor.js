import { getBaseUrl } from './utilities.js';
import { formatQualityLabel, formatQualityDetails } from './utilities.js';
import { setVideoGroups, addStreamMetadata, getStreamMetadata, getCachedVideos, setCachedVideos } from './state.js';

/**
 * Check if two videos should be grouped together
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos should be grouped
 */
export function shouldGroupVideos(video1, video2) {
    // Check if it's the same base URL (ignoring quality parameters)
    const baseUrl1 = getBaseUrl(video1.url);
    const baseUrl2 = getBaseUrl(video2.url);
    
    // Group together if same base URL and both have resolution info
    return (baseUrl1 === baseUrl2) && 
           video1.resolution && video2.resolution && 
           (video1.resolution.width !== video2.resolution.width || 
            video1.resolution.height !== video2.resolution.height);
}

/**
 * Group videos by resolution
 * @param {Array} videos - Videos to group
 * @returns {Array} Grouped videos
 */
export function groupVideos(videos) {
    const groupedVideos = [];
    const processed = new Set();
    
    // First pass: find groups
    for (let i = 0; i < videos.length; i++) {
        if (processed.has(i)) continue;
        
        const video = videos[i];
        const group = [video];
        processed.add(i);
        
        // Look for related videos
        for (let j = i + 1; j < videos.length; j++) {
            if (processed.has(j)) continue;
            
            const otherVideo = videos[j];
            if (shouldGroupVideos(video, otherVideo)) {
                group.push(otherVideo);
                processed.add(j);
            }
        }
        
        if (group.length > 1) {
            // Create a group entry
            const baseVideo = { ...group[0] };
            // Sort resolutions from highest to lowest
            baseVideo.resolutionOptions = group
                .sort((a, b) => {
                    if (!a.resolution || !b.resolution) return 0;
                    return (b.resolution.height - a.resolution.height);
                })
                .map(v => ({
                    url: v.url,
                    width: v.resolution?.width,
                    height: v.resolution?.height,
                    fps: v.resolution?.fps
                }));
            groupedVideos.push(baseVideo);
        } else {
            groupedVideos.push(video);
        }
    }
    
    return groupedVideos;
}

/**
 * Group videos by type (HLS, DASH, etc.)
 * @param {Array} videos - Videos to group
 * @returns {Object} Videos grouped by type
 */
export function groupVideosByType(videos) {
    const groups = {
        hls: [],
        dash: [],
        direct: [],
        blob: [],
        unknown: []
    };
    
    if (!videos || videos.length === 0) return groups;
    
    videos.forEach(video => {
        const type = video.type || 'unknown';
        if (groups[type]) {
            groups[type].push(video);
        } else {
            groups.unknown.push(video);
        }
    });
    
    // Store in state for access elsewhere
    setVideoGroups(groups);
    
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
 * Process and cache stream metadata
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
    
    // Cache the processed metadata
    addStreamMetadata(url, config);
    return config;
}

/**
 * Get stream qualities for a URL
 * @param {string} url - Stream URL
 * @returns {Promise<Array>} Array of quality options
 */
export async function getStreamQualities(url) {
    // Check cache first
    const cached = getStreamMetadata(url);
    if (cached?.qualities) {
        return cached.qualities;
    }
    
    // Request fresh metadata
    const response = await chrome.runtime.sendMessage({
        type: 'getHLSQualities',
        url: url
    });
    
    if (response?.streamInfo) {
        const config = processStreamMetadata(url, response.streamInfo);
        return config.qualities;
    }
    
    return [];
}