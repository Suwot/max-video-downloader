import { createLogger } from '../../shared/utils/logger.js';

// Create a logger instance for video type identification
const logger = createLogger('VideoTypeIdentifier');

// Constants for video type identification
const VIDEO_EXTENSIONS = {
    SEGMENTS: ['.ts', '.m4s', '.m4v'],
    MANIFESTS: {
        HLS: '.m3u8',
        DASH: '.mpd'
    },
    DIRECT: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', '3gp', 'wmv']
};

const EXCLUDED_EXTENSIONS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg'];

const PATH_PATTERNS = {
    ANALYTICS: /\/(ping|track|pixel|analytics|telemetry|stats|metrics)\//i,
    SEGMENTS: [
        /segment-\d+/i, /chunk-\d+/i, /frag-\d+/i, /seq-\d+/i, /part-\d+/i,
        /\/(media|video|audio)_\d+/i, /dash\d+/i, /\d+\.(m4s|ts)$/i,
        /-\d+\.m4[sv]$/i, /[_-]\d+_\d+\.(m4s|mp4)$/i
    ]
};

const MIME_PATTERNS = {
    DASH: ['dash+xml', 'vnd.mpeg.dash.mpd'],
    HLS: ['mpegurl', 'm3u8', 'm3u'],
    POSSIBLE_DASH: ['application/xml', 'text/xml', 'octet-stream']
};

const EXPIRY_PARAMS = [
    'expires', 'exp', 'expiry', 'token_expires', 'valid_until', 'validUntil', 'e',
    'cdn_expiry', 'edge_expires', 'token', 'auth_token', 'access_token',
    'Expires', 'expire', 'expiration'
];

/**
 * Parse and analyze URL for media detection
 * @param {string} url - URL to analyze
 * @returns {Object|null} Analysis result or null if invalid
 */
function analyzeMediaUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        const search = urlObj.search.toLowerCase();
        
        // Get file extension
        const extensionMatch = pathname.match(/\.([a-z0-9]{1,5})(?:\?|$)/i);
        const extension = extensionMatch ? extensionMatch[1].toLowerCase() : null;
        
        return {
            url,
            urlObj,
            pathname,
            search,
            extension,
            domain: urlObj.hostname.toLowerCase(),
            hasQuery: urlObj.search.length > 0
        };
    } catch (err) {
        logger.debug(`Invalid URL: ${url}`, err);
        return null;
    }
}

/**
 * Extracts expiration information from URL parameters
 * @param {string} url - The URL to analyze
 * @returns {Object|null} - Expiration data or null if none found
 */
export function extractExpiryInfo(url) {
    if (!url) return null;
    
    const analysis = analyzeMediaUrl(url);
    if (!analysis) return null;
    
    try {
        const params = analysis.urlObj.searchParams;
        
        // Extract expiry parameters
        const expiryData = EXPIRY_PARAMS.reduce((acc, paramName) => {
            const value = params.get(paramName);
            if (value !== null) {
                acc[paramName] = value;
            }
            return acc;
        }, {});
        
        if (Object.keys(expiryData).length === 0) return null;
        
        // Process numeric timestamps
        const numericValues = Object.values(expiryData)
            .map(val => Number(val))
            .filter(val => !isNaN(val));
            
        if (numericValues.length > 0) {
            const now = Date.now();
            const nowInSeconds = Math.floor(now / 1000);
            
            // Find valid future timestamps
            const validTimestamps = numericValues.filter(val => {
                const maxFuture = 365 * 24 * 60 * 60; // 1 year
                return (val > now && val < now + maxFuture * 1000) || // milliseconds
                       (val > nowInSeconds && val < nowInSeconds + maxFuture); // seconds
            });
            
            if (validTimestamps.length > 0) {
                const earliestExpiry = Math.min(...validTimestamps);
                const expiryTimestamp = earliestExpiry < 10000000000 ? 
                    earliestExpiry * 1000 : earliestExpiry;
                    
                expiryData._expiryTimestamp = expiryTimestamp;
                expiryData._expiresIn = expiryTimestamp - now;
            }
        }
        
        return expiryData;
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
    
    const analysis = analyzeMediaUrl(url);
    if (!analysis) {
        // Fallback for invalid URLs - try basic string matching
        return identifyVideoTypeFromString(url);
    }
    
    const { pathname, extension } = analysis;
    
    // Quick exclusions first
    if (VIDEO_EXTENSIONS.SEGMENTS.some(ext => pathname.endsWith(ext)) ||
        EXCLUDED_EXTENSIONS.some(ext => pathname.includes(`.${ext}`)) ||
        PATH_PATTERNS.ANALYTICS.test(pathname)) {
        return null;
    }
    
    // Check for manifest files
    if (pathname.includes(VIDEO_EXTENSIONS.MANIFESTS.HLS)) {
        return { type: 'hls' };
    }
    
    if (pathname.includes(VIDEO_EXTENSIONS.MANIFESTS.DASH)) {
        return { type: 'dash' };
    }
    
    // Check for direct video files
    if (extension && VIDEO_EXTENSIONS.DIRECT.includes(extension)) {
        return { 
            type: 'direct', 
            originalContainer: extension
        };
    }
    
    return null;
}

/**
 * Fallback identification using string matching
 * @param {string} url - URL string
 * @returns {Object|null} Video type info or null
 */
function identifyVideoTypeFromString(url) {
    const urlLower = url.toLowerCase();
    
    if (urlLower.includes(VIDEO_EXTENSIONS.MANIFESTS.HLS)) {
        return { type: 'hls' };
    }
    
    if (urlLower.includes(VIDEO_EXTENSIONS.MANIFESTS.DASH)) {
        return { type: 'dash' };
    }
    
    // Check for direct video files
    const directVideoPattern = new RegExp(`\\.(${VIDEO_EXTENSIONS.DIRECT.join('|')})(\\?|$)`, 'i');
    const match = url.match(directVideoPattern);
    if (match) {
        return { 
            type: 'direct', 
            originalContainer: match[1].toLowerCase()
        };
    }
    
    return null;
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
    
    // Check for DASH manifests
    const isDash = MIME_PATTERNS.DASH.some(pattern => contentTypeLower.includes(pattern));
    const isPossibleDash = !isDash && 
        MIME_PATTERNS.POSSIBLE_DASH.some(pattern => contentTypeLower.includes(pattern)) &&
        url && url.toLowerCase().includes(VIDEO_EXTENSIONS.MANIFESTS.DASH);
    
    if (isDash || isPossibleDash) {
        return { 
            type: 'dash',
            confidence: isDash ? 'high' : 'medium',
            source: 'mime'
        };
    }
    
    // Check for HLS manifests
    const isHls = MIME_PATTERNS.HLS.some(pattern => contentTypeLower.includes(pattern));
    const isLikelyHls = !isHls && url && url.toLowerCase().includes(VIDEO_EXTENSIONS.MANIFESTS.HLS);

    if (isHls || isLikelyHls) {
        return { 
            type: 'hls',
            confidence: isHls ? 'high' : 'medium',
            source: 'mime'
        };
    }
    
    // Check for direct video/audio files
    if (contentTypeLower.startsWith('video/') || contentTypeLower.startsWith('audio/')) {
        const mediaType = contentTypeLower.startsWith('audio/') ? 'audio' : 'video';
        const container = contentTypeLower.split('/')[1];
        
        return {
            type: 'direct',
            mediaType,
            originalContainer: container,
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
 * @returns {boolean} True if this appears to be a segment
 */
export function isMediaSegment(url, contentType = null, hasDashContext = false) {
    // Quick check for common segment extensions
    if (VIDEO_EXTENSIONS.SEGMENTS.some(ext => url.includes(ext))) {
        return true;
    }
    
    // Check standard segment patterns
    return PATH_PATTERNS.SEGMENTS.some(pattern => pattern.test(url));
}
