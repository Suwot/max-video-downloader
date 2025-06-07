// extension/popup/js/video-list/video-utils.js
// Shared utility functions for video renderers

/**
 * Create standard video metadata object for downloads
 * @param {Object} video - Video data
 * @returns {Object} - Video metadata
 */
export function createVideoMetadata(video) {
    return {
        title: video.title,
        originalContainer: video.originalContainer,
        originalUrl: video.originalUrl,
        foundFromQueryParam: video.foundFromQueryParam
    };
}

/**
 * Format file size bytes to human readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
export function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    // Different decimal precision based on size unit
    let decimals;
    switch (sizes[i]) {
        case 'GB':
            decimals = 2;
            break;
        case 'MB':
            decimals = 1;
            break;
        default: // KB and B
            decimals = 0;
    }
    
    return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

/**
 * Standardize video resolution to common formats
 * @param {number} height - Actual pixel height of the video
 * @returns {string} Standardized resolution string (e.g. "1080p")
 */
export function standardizeResolution(height) { 
    if (height >= 4320) return '4320p';
    if (height >= 2160) return '2160p';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
    if (height >= 240) return '240p';
    if (height >= 144) return '144p';
    return `${height}p`; // Fallback
}
