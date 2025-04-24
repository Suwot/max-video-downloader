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
 * Check if two videos have the same HLS base directory
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos share base directory
 */
function shareHLSBaseDirectory(video1, video2) {
    try {
        const url1 = new URL(video1.url);
        const url2 = new URL(video2.url);
        const dir1 = url1.origin + url1.pathname.substring(0, url1.pathname.lastIndexOf('/'));
        const dir2 = url2.origin + url2.pathname.substring(0, url2.pathname.lastIndexOf('/'));
        return dir1 === dir2;
    } catch (e) {
        console.error('Error checking HLS directory:', e);
        return false;
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
        if (video1.isPlaylist && video1.qualityVariants?.some(v => v.url === video2.url)) {
            return true;
        }
        if (video2.isPlaylist && video2.qualityVariants?.some(v => v.url === video1.url)) {
            return true;
        }

        // Both are variants - check if they're from same directory and have variant naming
        if (!video1.isPlaylist && !video2.isPlaylist) {
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
 * Group videos by resolution and HLS relationships
 * @param {Array} videos - Videos to group
 * @returns {Array} Grouped videos
 */
export function groupVideos(videos) {
    const groupedVideos = [];
    const processed = new Set();

    // First pass: collect all master playlists
    const masterPlaylists = videos.filter(v => v.type === 'hls' && v.isPlaylist && v.qualityVariants?.length > 0);
    
    // Process master playlists first
    for (const master of masterPlaylists) {
        if (processed.has(master.url)) continue;

        const variants = videos.filter(v => 
            v.type === 'hls' && 
            !v.isPlaylist && 
            shareHLSBaseDirectory(master, v) &&
            master.qualityVariants.some(qv => qv.url === v.url)
        );

        // Add all variants to processed set
        processed.add(master.url);
        variants.forEach(v => processed.add(v.url));

        // Create grouped video with master as base
        const groupedVideo = {
            ...master,
            qualityVariants: master.qualityVariants.map(qv => ({
                url: qv.url,
                width: qv.width,
                height: qv.height,
                fps: qv.fps,
                bandwidth: qv.bandwidth,
                codecs: qv.codecs
            }))
        };

        groupedVideos.push(groupedVideo);
    }

    // Second pass: handle remaining videos
    for (const video of videos) {
        if (processed.has(video.url)) continue;

        processed.add(video.url);
        const group = [video];

        // Look for related videos
        for (const otherVideo of videos) {
            if (processed.has(otherVideo.url)) continue;
            if (shouldGroupVideos(video, otherVideo)) {
                group.push(otherVideo);
                processed.add(otherVideo.url);
            }
        }

        if (group.length > 1) {
            // Sort by resolution and pick highest as main
            const sortedGroup = group.sort((a, b) => {
                if (!a.resolution || !b.resolution) return 0;
                return b.resolution.height - a.resolution.height;
            });

            const mainVideo = { ...sortedGroup[0] };
            mainVideo.qualityVariants = sortedGroup.slice(1).map(v => ({
                url: v.url,
                width: v.resolution?.width,
                height: v.resolution?.height,
                fps: v.resolution?.fps
            }));

            groupedVideos.push(mainVideo);
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