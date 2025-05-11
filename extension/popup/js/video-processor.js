/**
 * @ai-guide-component VideoProcessor
 * @ai-guide-description Video processing and organization
 * @ai-guide-responsibilities
 * - Groups videos by type (HLS, DASH, etc.)
 * - Handles video processing logic
 * - Implements video validation and filtering
 * - Manages video quality variants
 */


import { sendPortMessage } from './index.js';

// Cache for stream metadata
const metadataCache = new Map();

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