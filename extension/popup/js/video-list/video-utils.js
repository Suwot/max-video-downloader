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
 * Extract preview URL from video object
 * @param {Object} video - Video data
 * @returns {string|null} - Preview URL or null
 */
export function extractPreviewUrl(video) {
    if (Array.isArray(video.variants) && video.variants.length > 0 && video.variants[0].previewUrl) {
        return video.variants[0].previewUrl;
    } else if (video.previewUrl) {
        return video.previewUrl;
    } else if (video.poster) {
        return video.poster;
    }
    return null;
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
