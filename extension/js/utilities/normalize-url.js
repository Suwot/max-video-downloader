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
    
    // For blob URLs, use a special normalization method
    if (url.startsWith('blob:')) {
        try {
            // Extract the origin to help identify the source page
            const urlObj = new URL(url);
            const origin = urlObj.origin;
            
            // For blob URLs from the same origin, use just the origin plus a hash 
            // to identify them as "same kind of blob URL from this page"
            // We'll append the mime type too if we can extract it from search params
            let mimeTypeIndicator = '';
            if (url.includes('mime=') || url.includes('type=')) {
                const searchParams = new URLSearchParams(urlObj.search);
                const mime = searchParams.get('mime') || searchParams.get('type') || '';
                if (mime) {
                    // Just use the main MIME type part (video/mp4 -> video)
                    const mainType = mime.split('/')[0];
                    mimeTypeIndicator = `-${mainType}`;
                }
            }
            
            // If it's a video player blob, try to get a more specific identifier
            const playerIndicators = [
                'youtube', 'vimeo', 'dailymotion', 'jwplayer', 'player', 'video', 'media'
            ];
            
            let playerIndicator = '';
            const lowerUrl = url.toLowerCase();
            for (const indicator of playerIndicators) {
                if (lowerUrl.includes(indicator)) {
                    playerIndicator = `-${indicator}`;
                    break;
                }
            }
            
            return `${origin}-blob${mimeTypeIndicator}${playerIndicator}`;
        } catch (e) {
            console.error('Error normalizing blob URL:', e);
            return url; // Return original if we can't normalize it
        }
    }
    
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
 * Get base URL for video
 * @param {string} url - Video URL
 * @returns {string} Base URL
 */
export function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin;
    } catch {
        return '';
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