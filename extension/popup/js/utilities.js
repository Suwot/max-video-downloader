/**
 * @ai-guide-component UtilityFunctions
 * @ai-guide-description General utility functions used across the extension
 * @ai-guide-responsibilities
 * - Provides formatting helpers for video metadata
 * - Manages filename generation and sanitization
 * - Implements time and duration formatting
 * - Provides browser compatibility functions
 * - Offers data conversion and transformation utilities
 */

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
    try {
        if (url.startsWith('blob:')) {
            return 'blob_video';
        }

        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        let filename = pathname.split('/').pop();

        // Remove query parameters and fragments
        filename = filename.split(/[?#]/)[0];

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
