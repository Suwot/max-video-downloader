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
        
        // Normalize trailing slashes - only trim trailing slashes, not adding them
        if (urlObj.pathname.endsWith('/') && urlObj.pathname !== '/') {
            urlObj.pathname = urlObj.pathname.replace(/\/+$/, '');
        }
        
        // Remove common parameters that don't affect the content
        const junkParams = [
            '_t', '_r', 'cache', '_', 'time', 'timestamp', 'random',
            // UTM tracking parameters
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            // Other common tracking IDs
            'fbclid', 'gclid', 'msclkid'
        ];
        
        junkParams.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
            }
        });
        
        // For HLS and DASH, keep a more canonical form
        if (url.includes('.m3u8') || url.includes('.mpd')) {
            // Remove common streaming parameters
            const streamParams = [
                'seq', 'segment', 'session', 'cmsid', 
                'start', 'end', 'quality', 'itag'
            ];
            
            streamParams.forEach(param => {
                if (urlObj.searchParams.has(param)) {
                    urlObj.searchParams.delete(param);
                }
            });
            
            // For manifest files, simply use the path for better duplicate detection
            if (url.includes('/manifest') || url.includes('/playlist') ||
                url.includes('/master.m3u8') || url.includes('/index.m3u8') ||
                url.includes('manifest.mpd')) {
                return urlObj.origin + urlObj.pathname;
            }
        }
        
        // Handle CDN-signed URLs - safely remove only well-known parameters
        // that we're confident don't affect content delivery
        // Note: We're not removing critical auth tokens that could break URLs
        const safeAuthParamsToRemove = [
            'timestamp', 'expires', 'random', 'cachebuster'
        ];
        
        safeAuthParamsToRemove.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
            }
        });
        
        return urlObj.origin + urlObj.pathname + urlObj.search;
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