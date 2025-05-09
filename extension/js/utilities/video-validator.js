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
        
        // If this video was found in a query parameter, trust that it's already
        // been validated properly - don't apply additional filtering
        if (video.foundFromQueryParam) {
            return true;
        }
        
        // If it's an HLS or DASH video, we can safely assume it's valid 
        // as these were already validated by specialized functions
        if (video.type === 'hls' || video.type === 'dash') {
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
 * Filters redundant quality variants from a list of videos
 * @param {Array} videos - Array of videos with potential quality variants
 * @param {Object} options - Filter options
 * @param {boolean} options.removeNeighboringQualities - Whether to remove qualities that are very close to each other
 * @param {number} options.qualityThreshold - Threshold for determining similar qualities (percentage)
 * @returns {Array} Filtered videos with redundant variants removed
 */
export function filterRedundantVariants(videos, options = {}) {
    if (!videos || !Array.isArray(videos)) return [];

    const {
        removeNeighboringQualities = true,
        qualityThreshold = 15 // 15% difference is considered similar
    } = options;

    // First, find master playlists with variants
    const mastersWithVariants = videos.filter(v => 
        v.variants && v.variants.length > 1
    );

    // Process each master playlist to filter variants
    mastersWithVariants.forEach(master => {
        if (!master.variants) return;

        // Sort variants by resolution (height) - highest first
        const sortedVariants = [...master.variants].sort((a, b) => {
            const heightA = a.height || 0;
            const heightB = b.height || 0;
            if (heightA === heightB) {
                // If heights are the same, prefer higher width or bandwidth
                return ((b.width || 0) - (a.width || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0));
            }
            return heightB - heightA;
        });

        // Keep track of qualities we want to retain
        const filteredVariants = [];
        const seenQualities = new Set();

        sortedVariants.forEach(variant => {
            // Always include variants without height/width info
            if (!variant.height && !variant.width) {
                filteredVariants.push(variant);
                return;
            }

            // Normalize quality as height (since it's the most common way to express resolution)
            const quality = variant.height || 0;
            
            // Skip if we've already seen an exact match for this quality
            if (seenQualities.has(quality)) {
                logDebug(`Filtering out duplicate ${quality}p variant:`, variant.url);
                return;
            }
            
            // Filter out neighboring qualities if option is enabled
            if (removeNeighboringQualities && filteredVariants.length > 0) {
                const lastVariant = filteredVariants[filteredVariants.length - 1];
                const lastQuality = lastVariant.height || 0;
                
                // If quality is very close to a quality we've already included, skip it
                if (lastQuality > 0 && quality > 0) {
                    const percentDifference = Math.abs((lastQuality - quality) / lastQuality) * 100;
                    if (percentDifference < qualityThreshold) {
                        logDebug(`Filtering out similar quality variant (${quality}p vs ${lastQuality}p):`, variant.url);
                        return;
                    }
                }
            }

            // This is a unique quality, keep it
            seenQualities.add(quality);
            filteredVariants.push(variant);
        });

        // Replace variants with filtered list
        master.variants = filteredVariants;
    });

    return videos;
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