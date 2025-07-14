/**
 * URL normalization utilities
 * Provides functions to normalize URLs and extract URL components
 */

/**
 * Normalize URL to prevent duplicates
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
export function normalizeUrl(url) {
    // Quick return for empty URLs
    if (!url) return url;
    
    try {
        const urlObj = new URL(url);
        
        // Remove hash fragments - 100% safe, never affects server response
        urlObj.hash = '';
        
        // Remove only 100% guaranteed safe tracking parameters
        const safeToRemoveParams = [
            // UTM tracking parameters - universally safe to remove
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            // Click tracking IDs - safe to remove
            'fbclid', 'gclid', 'msclkid'
        ];
        
        safeToRemoveParams.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
            }
        });
        
        return urlObj.toString();
    } catch {
        return url;
    }
}

/**
 * Get base directory for a URL
 * @param {string} url - URL to process
 * @returns {string} Base directory of the URL
 */
export function getBaseDirectory(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
    } catch {
        return '';
    }
}