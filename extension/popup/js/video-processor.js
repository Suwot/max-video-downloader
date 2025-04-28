/**
 * @ai-guide-component VideoProcessor
 * @ai-guide-description Transforms and enhances video data
 * @ai-guide-responsibilities
 * - Processes raw video data into displayable formats
 * - Groups videos by type and source
 * - Extracts and normalizes video metadata
 * - Handles stream metadata for different formats (HLS/DASH)
 * - Manages video quality variants and resolution info
 * - Provides analysis of video content types
 * - Deduplicates video sources across formats
 * - Filters out redundant quality variants
 */

// popup/js/video-processor.js

import { getBaseUrl } from './utilities.js';
import { formatQualityLabel, formatQualityDetails } from './utilities.js';
import { setVideoGroups, addStreamMetadata, getStreamMetadata, getCachedVideos, setCachedVideos } from './state.js';
// Import the video validation and filtering functions
import { filterRedundantVariants } from '../../js/utilities/video-validator.js';

// Track HLS relationships globally
const hlsRelationships = new Map();

/**
 * Normalize URL to prevent duplicates
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
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

/**
 * Two-pass video processing to ensure proper grouping
 * @param {Array} videos - Videos to process
 * @returns {Array} Processed and grouped videos
 */
export function processVideos(videos) {
    if (!videos || !Array.isArray(videos)) return [];

    console.log('Processing videos in popup:', videos.length);
    
    // First apply our variant filtering to reduce redundant quality options
    const filteredVideos = filterRedundantVariants(videos, {
        removeNeighboringQualities: true,
        qualityThreshold: 15 // 15% difference threshold
    });

    // Create sets to track master and variant URLs
    const variantUrls = new Set();
    const masterUrls = new Set();
    
    // Step 1: Collect ALL master playlists and their variant URLs
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
    });

    // Step 2: Build final list - ONLY include non-variant videos
    const dedupedVideos = [];
    filteredVideos.forEach(video => {
        const normalizedUrl = normalizeUrl(video.url);
        
        // SKIP if it's a variant URL that was listed under a master playlist
        if (variantUrls.has(normalizedUrl)) {
            console.log(`Skipping variant ${video.url} because it's a known variant of a master`);
            return;
        }
        
        dedupedVideos.push(video);
    });

    console.log(`Filtered videos: ${videos.length} input → ${dedupedVideos.length} output (${masterUrls.size} masters, ${variantUrls.size} variants)`);
    
    // Now group the processed videos
    return groupVideos(dedupedVideos);
}

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

/**
 * Clear HLS relationships (call this when forcing refresh)
 */
export function clearHLSRelationships() {
    hlsRelationships.clear();
}