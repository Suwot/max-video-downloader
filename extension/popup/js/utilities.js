/**
 * @ai-guide-component UtilityFunctions
 * @ai-guide-description General utility functions used across the extension
 * @ai-guide-responsibilities
 * - Provides formatting helpers for video metadata
 * - Handles URL parsing and normalization
 * - Manages filename generation and sanitization
 * - Implements time and duration formatting
 * - Provides browser compatibility functions
 * - Offers data conversion and transformation utilities
 */

// popup/js/utilities.js

/**
 * Debounce helper to limit function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Format bitrate for display
 * @param {number|string} bitrate - Video bitrate
 * @returns {string|null} Formatted bitrate string
 */
export function formatBitrate(bitrate) {
    if (!bitrate) return null;
    
    // Convert to number if it's a string
    const rate = typeof bitrate === 'string' ? parseInt(bitrate, 10) : bitrate;
    
    if (isNaN(rate) || rate <= 0) return null;
    
    if (rate >= 1000000) {
        return `${(rate / 1000000).toFixed(1)} Mbps`;
    } else if (rate >= 1000) {
        return `${(rate / 1000).toFixed(0)} Kbps`;
    } else {
        return `${rate} bps`;
    }
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
 * Extract filename from URL
 * @param {string} url - URL to extract filename from
 * @returns {string} Extracted filename
 */
export function getFilenameFromUrl(url) {
    try {
        if (url.startsWith('blob:')) {
            return 'blob_video';
        }
        
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        // Remove query parameters and fragments
        const cleanFilename = filename.split(/[?#]/)[0];
        
        // Extract extension from URL for better format detection
        const urlExtMatch = url.match(/\.([^./?#]+)($|\?|#)/i);
        const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : null;
        
        // Use the clean filename if it has a video extension
        if (/\.(mp4|webm|mkv|mov|m3u8|mpd|ts)$/i.test(cleanFilename)) {
            return cleanFilename;
        }
        
        // If URL has a WebM extension, preserve it for container compatibility
        if (urlExt && urlExt === 'webm') {
            return cleanFilename + '.webm';
        }
        
        // If no video extension, add .mp4 as default
        if (!/\.\w+$/.test(cleanFilename)) {
            return cleanFilename + '.mp4';
        }
        
        return cleanFilename;
    } catch (e) {
        return 'video.mp4';
    }
}

/**
 * Extract base URL without quality parameters
 * @param {string} url - URL to process
 * @returns {string} Base URL
 */
export function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        // Remove common quality-related parameters
        urlObj.searchParams.delete('quality');
        urlObj.searchParams.delete('q');
        urlObj.searchParams.delete('res');
        urlObj.searchParams.delete('resolution');
        return urlObj.toString();
    } catch {
        return url;
    }
}

/**
 * Normalize URL to compare without query parameters
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
export function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname;
    } catch {
        return url;
    }
}

/**
 * Show error notification
 * @param {string} message - Error message to show
 */
export function showError(message) {
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Animate in
    requestAnimationFrame(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(-50%) translateY(0)';
    });
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

/**
 * Format quality label for display
 * @param {Object} quality Quality option
 * @returns {string} Formatted label
 */
export function formatQualityLabel(quality) {
    const [width, height] = quality.resolution.split('x').map(Number);
    let label = `${height}p`;
    
    if (quality.fps && quality.fps > 30) {
        label += quality.fps;
    }
    
    const bitrate = quality.bandwidth || quality.videoBitrate;
    if (bitrate) {
        label += ` (${formatBitrate(bitrate)})`;
    }
    
    return label;
}

/**
 * Format quality details
 * @param {Object} quality Quality option
 * @returns {Object} Formatted details
 */
export function formatQualityDetails(quality) {
    let codecs = '';
    if (quality.codecs) {
        codecs = quality.codecs;
    } else if (quality.videoCodec) {
        codecs = quality.videoCodec;
        if (quality.audioCodec) {
            codecs += ` / ${quality.audioCodec}`;
        }
    }

    const bitrate = quality.bandwidth || quality.videoBitrate;
    
    return {
        label: formatQualityLabel(quality),
        resolution: quality.resolution,
        codecs: codecs || undefined,
        bitrate: bitrate ? formatBitrate(bitrate) : undefined
    };
}