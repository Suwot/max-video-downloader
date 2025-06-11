// Shared utility functions for video renderers

/**
 * Create standard video metadata object for downloads
 * @param {Object} video - Video data
 * @returns {Object} - Video metadata
 */
export function createVideoMetadata(video) {
    return {
        filename: video.title,
        type: video.type,
        originalContainer: video.type === 'hls' ? 'mp4' : (video.originalContainer || null),
        segmentCount: video.type === 'hls' ? video.variants?.[0].metaJS?.segmentCount : null,
        duration: video.duration || null,
        masterUrl: video.isMaster ? video.url : null,
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

/**
 * Format duration in seconds to HH:MM:SS or MM:SS format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration
 */
export function formatDuration(seconds) {
    if (!seconds) return '';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Extract filename (without extension) from URL
 * @param {string} url - URL to extract filename from
 * @returns {string} Extracted filename without extension
 */
export function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
            return 'blob_video';
        }

    try {
        const urlObj = new URL(url);
        let filename = urlObj.pathname.split('/').pop() || '';

        // Decode URI components
        try {
            filename = decodeURIComponent(filename);
        } catch (e) {
            // fallback: keep as-is
        }

        // Remove query parameters and fragments
        filename = filename.split(/[?#]/)[0];

        // Only proceed if it looks like a file
        if (!/\.\w{2,5}$/.test(filename)) {
            return 'video';
        }

        // Remove extension if present
        const dotIndex = filename.lastIndexOf('.');
        if (dotIndex > 0) {
            filename = filename.substring(0, dotIndex);
        }

        return filename || 'video';
    } catch (e) {
        return 'video';
    }
}