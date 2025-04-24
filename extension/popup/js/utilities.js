/**
 * Debounce helper to limit function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

/**
 * Format resolution for display
 * @param {number} width - Video width
 * @param {number} height - Video height
 * @param {number} fps - Frames per second
 * @param {number} bitrate - Video bitrate
 * @param {Object} codecInfo - Codec information
 * @returns {string} Formatted resolution string
 */
export function formatResolution(width, height, fps, bitrate, codecInfo = {}) {
    const parts = [];
    
    // Resolution info
    if (width && height) {
        parts.push(`${width}x${height}`);
    }
    
    // Codec info
    if (codecInfo.videoCodec) {
        const codec = codecInfo.videoCodec;
        const codecStr = codec.profile ? 
            `${codec.name} ${codec.profile}` : 
            codec.name;
        parts.push(`(${codecStr})`);
        
        if (codec.bitDepth) {
            parts.push(`${codec.bitDepth}-bit`);
        }
    }
    
    // FPS info
    if (fps) {
        parts.push(`@ ${Math.round(fps)}fps`);
    }
    
    // Bitrate info
    if (bitrate) {
        const bitrateStr = formatBitrate(bitrate);
        if (bitrateStr) parts.push(bitrateStr);
    }
    
    return parts.length > 0 ? parts.join(' ') : 'Unknown resolution';
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
 * Extract filename from URL
 * @param {string} url - URL to extract filename from
 * @returns {string} Extracted filename
 */
export function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        if (filename && filename.length > 0) {
            // Clean up filename
            return decodeURIComponent(filename)
                .replace(/[?#].*$/, '') // Remove query params
                .replace(/\.(m3u8|mpd)$/, '.mp4'); // Replace manifest extensions with mp4
        }
    } catch {}
    
    return 'video';
}

/**
 * Get base URL without query parameters
 * @param {string} url - URL to process
 * @returns {string} Base URL
 */
export function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname;
    } catch {
        return url;
    }
}

/**
 * Show error notification
 * @param {string} message - Error message to display
 */
export function showError(message) {
    // Show both popup notification and chrome notification
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Animate in
    requestAnimationFrame(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateY(0)';
    });
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateY(20px)';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
    
    // Also show Chrome notification
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/48.png',
        title: 'Download Error',
        message: message
    });
}

/**
 * Format duration in MM:SS format
 * @param {number} duration - Duration in seconds
 * @returns {string} Formatted duration
 */
export function formatDuration(duration) {
    if (!duration) return '';
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}