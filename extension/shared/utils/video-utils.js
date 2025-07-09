// Shared utility functions for video renderers

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

// time formatter for dl progress
export function formatTime(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return `${minutes}m ${Math.round(seconds % 60)}s`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
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

// formats bitrate in kbps or Mbps
export function formatBitrate(kbps) {
    if (typeof kbps !== 'number' || isNaN(kbps)) return 'Unknown';
    if (kbps < 0) return 'Invalid';

    return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps} kbps`;
}