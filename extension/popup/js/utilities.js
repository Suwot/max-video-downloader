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
 * @returns {string} Formatted resolution string
 */
export function formatResolution(width, height, fps, bitrate) {
    if (!width || !height) return 'Unknown resolution';
    
    let label = `${width}x${height}`;
    
    // Add common resolution label
    if (height >= 2160) label += ' (4K)';
    else if (height >= 1440) label += ' (2K)';
    else if (height >= 1080) label += ' (FHD)';
    else if (height >= 720) label += ' (HD)';
    
    // Add framerate if available
    if (fps) label += ` @ ${Math.round(fps)}fps`;
    
    // Add bitrate if available
    if (bitrate) {
        const formattedBitrate = formatBitrate(bitrate);
        if (formattedBitrate) label += ` • ${formattedBitrate}`;
    }
    
    console.log('Formatted resolution:', { width, height, fps, bitrate, result: label });
    return label;
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
 * Display error notification
 * @param {string} message - Error message
 */
export function showError(message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/48.png',
        title: 'Download Error',
        message: message
    });
} 