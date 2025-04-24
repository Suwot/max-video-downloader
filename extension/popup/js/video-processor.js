import { getBaseUrl } from './utilities.js';
import { formatQualityLabel, formatQualityDetails } from './utilities.js';
import { setVideoGroups, addStreamMetadata, getStreamMetadata, getCachedVideos, setCachedVideos } from './state.js';

// Get base directory for a URL
function getBaseDirectory(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
    } catch {
        return '';
    }
}

/**
 * Check if videos are related HLS streams
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos are related HLS streams 
 */
function areRelatedHLSStreams(video1, video2) {
    if (video1.type !== 'hls' || video2.type !== 'hls') return false;
    
    const dir1 = getBaseDirectory(video1.url);
    const dir2 = getBaseDirectory(video2.url);
    
    // Must be in same directory
    if (dir1 !== dir2) return false;
    
    const name1 = video1.url.split('/').pop();
    const name2 = video2.url.split('/').pop();
    
    // Check if one is playlist.m3u8 and other is a variant
    if (name1 === 'playlist.m3u8' && name2.startsWith('video_')) return true;
    if (name2 === 'playlist.m3u8' && name1.startsWith('video_')) return true;
    
    // Check if both are video_X.m3u8 variants
    if (name1.startsWith('video_') && name2.startsWith('video_')) return true;
    
    return false;
}

/**
 * Check if two videos should be grouped together
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos should be grouped
 */
export function shouldGroupVideos(video1, video2) {
    // Check if both are HLS videos in the same directory
    if (video1.type === 'hls' && video2.type === 'hls') {
        try {
            const url1 = new URL(video1.url);
            const url2 = new URL(video2.url);
            const dir1 = url1.origin + url1.pathname.substring(0, url1.pathname.lastIndexOf('/'));
            const dir2 = url2.origin + url2.pathname.substring(0, url2.pathname.lastIndexOf('/'));
            
            // Must be in same directory
            if (dir1 === dir2) {
                // If one is a master playlist and the other isn't, they should be grouped
                const isMaster1 = video1.isPlaylist;
                const isMaster2 = video2.isPlaylist;
                if (isMaster1 !== isMaster2) return true;
                
                // If both are variants (not master playlists), they should be grouped
                if (!isMaster1 && !isMaster2) {
                    const name1 = video1.url.split('/').pop();
                    const name2 = video2.url.split('/').pop();
                    if (name1.startsWith('video_') && name2.startsWith('video_')) return true;
                }
            }
        } catch (e) {
            console.error('Error checking HLS relationship:', e);
        }
    }
    
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
 * Group videos by resolution and HLS relationships
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
            // Find the main video (prefer playlist.m3u8 or highest quality)
            const mainVideo = group.find(v => v.url.endsWith('playlist.m3u8')) || 
                            group.reduce((prev, curr) => {
                                if (!prev.resolution) return curr;
                                if (!curr.resolution) return prev;
                                return curr.resolution.height > prev.resolution.height ? curr : prev;
                            });
            
            const baseVideo = { ...mainVideo };
            
            // Add all variants as quality options
            baseVideo.qualityVariants = group
                .filter(v => v !== mainVideo)
                .map(v => ({
                    url: v.url,
                    width: v.resolution?.width,
                    height: v.resolution?.height,
                    fps: v.resolution?.fps,
                    isHLS: v.type === 'hls'
                }))
                .sort((a, b) => {
                    if (!a.height || !b.height) return 0;
                    return b.height - a.height;
                });
            
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