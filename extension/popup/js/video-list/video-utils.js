// extension/popup/js/video-list/video-utils.js
// Shared utility functions for video renderers

/**
 * Format quality label for video variants
 * @param {Object} video - Video object
 * @returns {string} - Formatted quality label
 */
export function formatQualityLabel(video) {
    let qualityLabel = '';
    
    // Get height info
    let height = video.metaJS?.height || video.metaFFprobe?.height || null;
    
    if (height) {
        qualityLabel = `${height}p`;
    }
    
    // Add fps if available
    let fps = video.metaJS?.fps || video.metaFFprobe?.fps || null;
    if (fps) {
        qualityLabel += ` @${fps}fps`;
    }
    
    // // Add bandwidth info if available
    // let bandwidth = video.metaFFprobe?.totalBitrate || video.metaJS?.averageBandwidth || video.metaJS?.bandwidth || null;
    // if (bandwidth) {
    //     const mbps = (bandwidth / 1000000).toFixed(1);
    //     if (mbps > 0) {
    //         qualityLabel += ` (${mbps} Mbps)`;
    //     }
    // }
    
     // Add file size info - prioritizing actual file size over estimated size
    // This handles both direct media and streaming variants
    let fileSizeBytes = video.metaJS?.estimatedFileSizeBytes || 
                        video.metaFFprobe?.sizeBytes || null;

    if (fileSizeBytes) {
        const formattedSize = formatFileSize(fileSizeBytes);
        if (formattedSize) {
            qualityLabel += ` (~${formattedSize})`;
        }
    }

    return qualityLabel;
}

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
 * Format file size in bytes to human readable format
 * @param {Number} bytes - File size in bytes
 * @returns {String|null} - Formatted file size or null if unavailable
 */
// extension/popup/js/video-list/video-utils.js
export function formatFileSize(bytes) {
    if (!bytes) return null;

    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 Bytes';

    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${Math.round(value * 10) / 10} ${sizes[i]}`;
}
