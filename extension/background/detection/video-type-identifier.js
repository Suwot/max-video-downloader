import { createLogger } from '../../shared/utils/logger.js';

// Create a logger instance for video type identification
const logger = createLogger('VideoTypeIdentifier');

/**
 * Extracts expiration information from URL parameters
 * @param {string} url - The URL to analyze
 * @returns {Object|null} - Expiration data or null if none found
 */
export function extractExpiryInfo(url) {
    if (!url) return null;
    
    try {
        const urlObj = new URL(url);
        const params = urlObj.searchParams;
        
        // Check for common expiration parameters
        const expiryParams = {
            // Standard expiry parameters
            expires: params.get('expires'),
            exp: params.get('exp'),
            expiry: params.get('expiry'),
            token_expires: params.get('token_expires'),
            valid_until: params.get('valid_until'),
            validUntil: params.get('validUntil'),
            e: params.get('e'),
            // CDN specific parameters
            cdn_expiry: params.get('cdn_expiry'),
            edge_expires: params.get('edge_expires'),
            // Token parameters
            token: params.get('token'), // Often contains encoded expiry
            auth_token: params.get('auth_token'),
            access_token: params.get('access_token'),
            // AWS/CDN specific
            Expires: params.get('Expires'), // AWS S3 parameter
            expire: params.get('expire'),
            expiration: params.get('expiration')
        };
        
        // Filter out undefined/null values
        const expiryData = Object.entries(expiryParams)
            .filter(([, value]) => value !== null && value !== undefined)
            .reduce((obj, [key, value]) => {
                obj[key] = value;
                return obj;
            }, {});
            
        // If we have data, add timestamp for easier programmatic use
        if (Object.keys(expiryData).length > 0) {
            // Try to identify a numeric timestamp for easy processing
            // Common formats: unix timestamp (seconds or milliseconds)
            const numericValues = Object.values(expiryData)
                .filter(value => !isNaN(Number(value)))
                .map(value => Number(value));
                
            if (numericValues.length > 0) {
                // Find the most likely timestamp (future date, reasonable range)
                const now = Date.now();
                const nowInSeconds = Math.floor(now / 1000);
                
                // Check both millisecond and second formats
                const possibleTimestamps = numericValues.filter(val => {
                    // If it's a timestamp in milliseconds (13 digits typically)
                    if (val > now && val < now + 365 * 24 * 60 * 60 * 1000) {
                        return true;
                    }
                    // If it's a timestamp in seconds (10 digits typically)
                    if (val > nowInSeconds && val < nowInSeconds + 365 * 24 * 60 * 60) {
                        return true;
                    }
                    return false;
                });
                
                if (possibleTimestamps.length > 0) {
                    // Use the earliest expiry as the most restrictive
                    const earliestExpiry = Math.min(...possibleTimestamps);
                    
                    // If it's likely seconds format, convert to milliseconds
                    const expiryTimestamp = 
                        (earliestExpiry < 10000000000) ? earliestExpiry * 1000 : earliestExpiry;
                        
                    expiryData._expiryTimestamp = expiryTimestamp;
                    expiryData._expiresIn = expiryTimestamp - now;
                }
            }
            
            return expiryData;
        }
        
        return null;
    } catch (err) {
        logger.debug(`Error extracting expiry info: ${err.message}`);
        return null;
    }
}

/**
 * Process and identify video type from URL patterns
 * @param {string} url - URL to process
 * @returns {Object|null} Video type info or null if not video
 */
export function identifyVideoType(url) {
    if (!url) return null;
    
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname.toLowerCase();
        
        // Check for segments first (most common case to filter out quickly)
        if (path.endsWith('.m4s') || path.endsWith('.ts') || path.endsWith('.m4v')) {
            return null;
        }
        
        // Combined exclusion patterns - do these checks to exit early
        if (
            // Check for image extensions
            /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i.test(path) ||
            // Known analytics endpoints
            /\/(ping|track|pixel|analytics|telemetry|stats|metrics)\//i.test(path)
        ) {
            return null;
        }
        
        // Positive checks for media types
        
        // Check for HLS streams (.m3u8)
        if (path.includes('.m3u8')) {
            return { type: 'hls' };
        }
        
        // Check for DASH manifests (.mpd)
        if (path.includes('.mpd')) {
            return { type: 'dash' };
        }
        
        // Check for direct video files
        const directVideoMatch = path.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|wmv)(\?|$)/i);
        if (directVideoMatch) {
            return { 
                type: 'direct', 
                originalContainer: directVideoMatch[1].toLowerCase()
            };
        }
        
        // Not a recognized video format
        return null;
        
    } catch (err) {
        logger.debug(`Error in identifyVideoType: ${err.message}`);
        
        // Less accurate but simple fallback if URL parsing fails - use string matching
        const urlLower = url.toLowerCase();
        
        // Check for streaming formats
        if (urlLower.includes('.m3u8')) {
            return { type: 'hls' };
        }
        
        if (urlLower.includes('.mpd')) {
            return { type: 'dash' };
        }
        
        // Check for direct video files
        const directVideoMatch = url.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|wmv)(\?|$)/i);
        if (directVideoMatch) {
            return { 
                type: 'direct', 
                originalContainer: directVideoMatch[1].toLowerCase()
            };
        }
        
        // Not a recognized video format or URL parsing failed
        return null;
    }
}

/**
 * Identify video type from MIME type in response headers
 * @param {string} contentType - Content-Type header value
 * @param {string} url - URL for additional context
 * @returns {Object|null} Video type info or null if not video
 */
export function identifyVideoTypeFromMime(contentType, url) {
    if (!contentType) return null;
    
    const contentTypeLower = contentType.toLowerCase();
    
    // Define MIME type matchers
    const dashMimePatterns = ['dash+xml', 'vnd.mpeg.dash.mpd'];
    const hlsMimePatterns = ['mpegurl', 'm3u8', 'm3u'];
    const possibleDashMimePatterns = ['application/xml', 'text/xml', 'octet-stream'];
    
    // Check for DASH manifests (MPD files)
    const isDash = dashMimePatterns.some(pattern => contentTypeLower.includes(pattern));
    
    // More restrictive check for misconfigured DASH
    const isPossibleDash = 
        possibleDashMimePatterns.some(pattern => contentTypeLower.includes(pattern)) &&
        url && url.toLowerCase().includes('.mpd');
    
    if (isDash || isPossibleDash) {
        return { 
            type: 'dash',
            confidence: isDash ? 'high' : 'medium',
            source: 'mime'
        };
    }
    
    // Check for HLS manifests (M3U8 files)
    const isHls = hlsMimePatterns.some(pattern => contentTypeLower.includes(pattern));
    
    // More restrictive check for misconfigured HLS
    const isLikelyHls = url && url.toLowerCase().includes('.m3u8');

    if (isHls || isLikelyHls) {
        return { 
            type: 'hls',
            confidence: isHls ? 'high' : 'medium',
            source: 'mime'
        };
    }
    
    // For direct video/audio files
    if (contentTypeLower.startsWith('video/') || contentTypeLower.startsWith('audio/')) {
        // Determine if it's audio-only or video content
        const mediaType = contentTypeLower.startsWith('audio/') ? 'audio' : 'video';
        
        return {
            type: 'direct',
            mediaType: mediaType,
            originalContainer: contentTypeLower.split('/')[1],
            confidence: 'high',
            source: 'mime'
        };
    }
    
    return null;
}

/**
 * Check if URL appears to be a media segment (should be filtered out)
 * @param {string} url - URL to check
 * @param {string} contentType - Content type (optional)
 * @param {boolean} hasDashContext - Whether this tab has DASH manifests
 * @param {Set} segmentPaths - Set of known segment paths for this tab
 * @returns {boolean} True if this appears to be a segment
 */
export function isMediaSegment(url, contentType = null, hasDashContext = false, segmentPaths = null) {
    // Skip TS segments typically used in HLS and M4S segments used in DASH
    if (url.includes('.ts') || url.includes('.m4s') || url.includes('.m4v') || (url.includes('.mp4') && url.includes('range='))) {
        return true;
    }

    // Check against cached segment paths
    if (hasDashContext && segmentPaths && segmentPaths.size > 0) {
        try {
            // Extract path from URL for comparison
            const urlObj = new URL(url);
            const urlPath = urlObj.pathname;
            
            // Check if any cached segment path is part of this URL's path
            for (const basePath of segmentPaths) {
                if (urlPath.includes(basePath)) {
                    return true;
                }
            }
        } catch (e) {
            // URL parsing failed, fall back to string includes
            for (const basePath of segmentPaths) {
                if (url.includes(basePath)) {
                    return true;
                }
            }
        }
    }
    
    // Standard segment pattern detection
    const segmentPatterns = [
        /segment-\d+/, /chunk-\d+/, /frag-\d+/, /seq-\d+/, /part-\d+/,
        /\/(media|video|audio)_\d+/, /dash\d+/, /\d+\.(m4s|ts)$/,
        /-\d+\.m4[sv]$/i,
        /[_-]\d+_\d+\.(m4s|mp4)$/i
    ];
    
    if (segmentPatterns.some(pattern => pattern.test(url))) {
        return true;
    }
    
    // Check byte ranges as the last resort (most expensive check)
    if (hasDashContext) {
        // First check if the URL contains "bytes=" or "range=" before expensive URL parsing
        if (url.includes('bytes=') || url.includes('range=')) {
            try {
                const parsedUrl = new URL(url);
                const byteRangePattern = /(?:bytes|range)=\d+-\d+/i;
                return byteRangePattern.test(parsedUrl.search);
            } catch (e) {
                // Fallback for URL parsing failure
                return /bytes=\d+-\d+/.test(url) || /range=\d+-\d+/.test(url);
            }
        }
    }
    
    return false;
}
