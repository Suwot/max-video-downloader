/**
 * @ai-guide-component VideoValidator
 * @ai-guide-description Centralized video URL validation and filtering
 * @ai-guide-responsibilities
 * - Provides consistent validation logic for video URLs
 * - Filters out tracking pixels, analytics, and non-video URLs
 * - Handles special cases like URLs from query parameters
 * - Ensures only valid video sources are processed
 * - Identifies and filters redundant quality variants
 */

// Debug logging helper - can be replaced with a shared logger
function logDebug(...args) {
    console.log('[Video Validator]', new Date().toISOString(), ...args);
}

/**
 * Validates and filters a list of videos, removing tracking pixels and non-video content
 * @param {Array} videos - Videos to validate
 * @returns {Array} Filtered videos
 */
export function validateAndFilterVideos(videos) {
    if (!videos || !Array.isArray(videos)) return [];
    
    return videos.filter(video => {
        // Validate that we have a URL
        if (!video || !video.url) return false;
        
        // Filter out variants that have a known master - they should only appear nested in their master playlists
        if (video.isVariant && video.hasKnownMaster) {
            logDebug(`Filtering out variant with known master: ${video.url}`);
            return false;
        }
        
        // If this video was found in a query parameter, trust that it's already
        // been validated properly - don't apply additional filtering
        if (video.foundFromQueryParam) {
            return true;
        }
        
        // If it's an HLS or DASH video, check subtype value from light parsing
        if (video.type === 'hls' || video.type === 'dash') {
            // If we have a subtype from light parsing, use it
            if (video.subtype) {
                // Filter out URLs that were identified as non-videos
                if (video.subtype === 'not-a-video' || video.subtype === 'fetch-failed') {
                    logDebug(`Filtering out light-parsed non-video: ${video.url} (${video.subtype})`);
                    return false;
                }
                return true;
            }
            // If no subtype yet, let it through (will be parsed later)
            return true;
        }
        
        try {
            const urlObj = new URL(video.url);
            
            // Filter out known tracking pixel and analytics URLs
            if (video.url.includes('ping.gif') || video.url.includes('jwpltx.com')) {
                logDebug('Filtering out tracking URL:', video.url);
                return false;
            }
            
            // Check for image extensions that shouldn't be treated as videos
            if (/\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(urlObj.pathname)) {
                logDebug('Filtering out image URL:', video.url);
                return false;
            }
            
            // Known analytics endpoints
            const trackingPatterns = [
                /\/ping/i,
                /\/track/i,
                /\/pixel/i,
                /\/analytics/i,
                /\/telemetry/i,
                /\/stats/i,
                /\/metrics/i
            ];
            
            if (trackingPatterns.some(pattern => pattern.test(urlObj.pathname))) {
                logDebug('Filtering out analytics endpoint:', video.url);
                return false;
            }
            
            // If we got here, it's probably a valid video
            return true;
        } catch (e) {
            logDebug('Error validating URL:', e, video.url);
            return false;
        }
    });
}

/**
 * Check if a single video URL is valid
 * @param {Object} video - Video object to validate
 * @returns {boolean} True if video is valid
 */
export function isValidVideo(video) {
    // Use the same logic but for a single video
    const result = validateAndFilterVideos([video]);
    return result.length === 1;
}

/**
 * Validates a URL to determine if it should be rejected as a tracking pixel
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is valid (not a tracking pixel)
 */
export function isValidVideoUrl(url) {
    if (!url) return false;
    
    try {
        const urlObj = new URL(url);
        
        // Filter out known tracking pixel and analytics URLs
        if (url.includes('ping.gif') || url.includes('jwpltx.com')) {
            return false;
        }
        
        // Check for image extensions
        if (/\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(urlObj.pathname)) {
            return false;
        }
        
        // Known analytics endpoints
        const trackingPatterns = [
            /\/ping/i,
            /\/track/i,
            /\/pixel/i,
            /\/analytics/i,
            /\/telemetry/i,
            /\/stats/i,
            /\/metrics/i
        ];
        
        if (trackingPatterns.some(pattern => pattern.test(urlObj.pathname))) {
            return false;
        }
        
        return true;
    } catch (e) {
        return false;
    }
}