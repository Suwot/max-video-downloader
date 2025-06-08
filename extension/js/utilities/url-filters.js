/**
 * URL filtering utilities
 * Provides functions to filter out non-media URLs consistently across the extension
 */

import { createLogger } from './logger.js';

// Create a logger instance for URL filters
const logger = createLogger('URL Filters');

// Non-media file extensions that should be ignored
const IGNORE_EXTENSIONS = [
    // Common web resources
    '.js', '.css', '.json', '.xml', '.woff', '.woff2', '.ttf', '.eot', '.otf',
    
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp',
    
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt',
    
    // Other web assets
    '.map', '.html', '.htm', '.php', '.asp', '.aspx', '.jsp',

    // Media segments (not complete files)
    '.ts', '.m4s', '.m4v', '.m4a'
];

// Common domains that are definitely not media content
const NON_MEDIA_DOMAINS = [
    // Analytics and tracking
    'googletagmanager.com',
    'google-analytics.com',
    'analytics.google.com',
    'stats.g.doubleclick.net',
    'connect.facebook.net',
    'facebook.com/tr',
    'bat.bing.com',
    'analytics.twitter.com',
    'platform.twitter.com',
    'assets.pinterest.com',
    'sc-static.net',
    'sitepoint.com',
    'hotjar.com',
    'clicktale.net',
    'mouseflow.com',
    'fullstory.com',
    
    // CDNs for common web assets (non-media)
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'unpkg.com',
    
    // Common API domains
    'api.stripe.com',
    'checkout.stripe.com',
    'api.paypal.com',
    'challenges.cloudflare.com',
    'hcaptcha.com',
    'recaptcha.net',
    'www.google.com/recaptcha',
    'www.gstatic.com/recaptcha',
    
    // Authentication services
    'accounts.google.com',
    'login.microsoftonline.com',
    'auth0.com',
    'id.twitch.tv',
    
    // Common cloud icons/assets services
    'maps.googleapis.com',
    'maps.gstatic.com',
    'chart.googleapis.com'
];

// URL path patterns that indicate non-media content
const IGNORE_PATH_PATTERNS = [
    // Analytics and tracking
    /\/(analytics|track|pixel|impression|beacon|stats|metrics)\//i,
    /\/(ga|gtm|pixel|piwik|matomo)\//i,
    
    // Ads
    /\/(ads|ad|advertising|advert|banner)\//i,
    
    // API endpoints unlikely to be media
    /\/api\/v?\d+\/(user|auth|login|session|config|settings)/i,
    
    // Common CDN resources that aren't media
    /\/cdn\/.*\/(js|css|fonts|images)\//i,
    
    // Web services
    /\/(service-worker|sw)\.js/i,
    
    // Icons and common UI elements
    /\/(icons|ui-elements|badges|avatars)\//i,
    
    // Security features
    /\/(captcha|csrf|token|security)\//i,
    
    // Payment endpoints
    /\/(checkout|payment|cart|basket)\//i
];

// Segment patterns for identifying media segments
const SEGMENT_PATTERNS = [
    /segment[-_]\d+/i,
    /chunk[-_]\d+/i, 
    /frag[-_]\d+/i,
    /seq[-_]\d+/i,
    /part[-_]\d+/i,
    /\/(media|video|audio)[-_]\d+/i,
    /dash\d+/i,
    /\d+\.(m4s|ts)$/i,
    /[-_]\d+\.m4[sv]$/i,
    /[-_]\d+[-_]\d+\.(m4s|mp4)$/i
];

/**
 * Parse and analyze a URL
 * @param {string} url - URL to analyze
 * @returns {Object|null} URL analysis or null if invalid
 */
function analyzeUrl(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    
    try {
        // Create URL object for robust parsing
        const urlObj = new URL(url);
        
        // Extract path without query or hash
        const pathname = urlObj.pathname.toLowerCase();
        
        // Get file extension if any
        const extensionMatch = pathname.match(/\.([a-z0-9]{1,5})(?:$|\?)/i);
        const extension = extensionMatch ? `.${extensionMatch[1].toLowerCase()}` : null;
        
        // Check if URL is a manifest
        const isManifest = pathname.includes('.m3u8') || pathname.includes('.mpd');
        
        // Check if URL is likely a segment
        const isSegment = SEGMENT_PATTERNS.some(pattern => pattern.test(url));
        
        return {
            url,
            domain: urlObj.hostname.toLowerCase(),
            pathname,
            extension,
            isManifest,
            isSegment,
            hasQueryParams: urlObj.search.length > 0
        };
    } catch (e) {
        // If URL is invalid, log error and return null
        logger.warn(`Invalid URL: ${url}`, e);
        return null;
    }
}

/**
 * Basic filtering for header capture - blacklist approach
 * Used in onSendHeaders to determine which URLs to track
 * 
 * @param {string} url - URL to check
 * @returns {boolean} True if URL should be ignored
 */
function shouldIgnoreForHeaderCapture(url) {
    if (!url || typeof url !== 'string') {
        return true;
    }
    
    try {
        // Parse URL
        const analysis = analyzeUrl(url);
        if (!analysis) {
            // Invalid URL, log and don't ignore to be safe
            logger.debug(`Invalid URL for header capture: ${url}`);
            return false;
        }
        
        // Check domain against blacklist (fastest check)
        for (const domain of NON_MEDIA_DOMAINS) {
            if (analysis.domain === domain || 
                analysis.domain.endsWith(`.${domain}`) || 
                analysis.url.includes(domain)) {
                return true;
            }
        }
        
        // Check file extension if present
        if (analysis.extension && IGNORE_EXTENSIONS.includes(analysis.extension)) {
            return true;
        }
        
        // Check path patterns
        if (IGNORE_PATH_PATTERNS.some(pattern => pattern.test(analysis.pathname))) {
            return true;
        }
        
        // For header capture, be inclusive (don't filter segments)
        return false;
    } catch (err) {
        logger.warn('Error in shouldIgnoreForHeaderCapture:', err);
        return false; // On error, don't ignore (be inclusive)
    }
}

/**
 * Comprehensive filtering for media detection - can be stricter
 * Used in onHeadersReceived to determine if URL is media
 * 
 * @param {string} url - URL to check
 * @param {Object} metadata - Optional response metadata with content type
 * @returns {boolean} True if URL should be ignored
 */
function shouldIgnoreForMediaDetection(url, metadata = null) {
    if (!url || typeof url !== 'string') {
        return true;
    }
    
    try {
        // Parse URL
        const analysis = analyzeUrl(url);
        if (!analysis) {
            // Invalid URL, log and don't ignore to be safe
            logger.debug(`Invalid URL for media detection: ${url}`);
            return false;
        }
        
        // Check domain against blacklist (fastest check)
        for (const domain of NON_MEDIA_DOMAINS) {
            if (analysis.domain === domain || 
                analysis.domain.endsWith(`.${domain}`) || 
                analysis.url.includes(domain)) {
                return true;
            }
        }
        
        // Check file extension if present
        if (analysis.extension && IGNORE_EXTENSIONS.includes(analysis.extension)) {
            return true;
        }
        
        // Check path patterns
        if (IGNORE_PATH_PATTERNS.some(pattern => pattern.test(analysis.pathname))) {
            return true;
        }
        
        // Check for media segments unless it's a manifest
        if (!analysis.isManifest && analysis.isSegment) {
            return true;
        }
        
        // If we have metadata with content type, use it for additional filtering
        if (metadata && metadata.contentType) {
            const contentType = metadata.contentType.toLowerCase();
            
            // Skip tiny files that aren't manifests
            if (!analysis.isManifest && metadata.contentLength && metadata.contentLength < 1024) {
                return true;
            }
            
            // Handle specific content types we know aren't media
            const nonMediaTypes = [
                'text/html', 'text/css', 'application/javascript',
                'application/json', 'text/plain', 'image/'
            ];
            
            if (nonMediaTypes.some(type => contentType.includes(type))) {
                // Special exception: Allow XML and plain text that might be MPD or M3U8
                if ((contentType.includes('xml') || contentType.includes('text/plain')) && analysis.isManifest) {
                    return false;
                }
                return true;
            }
        }
        
        return false;
    } catch (err) {
        logger.warn('Error in shouldIgnoreForMediaDetection:', err);
        return false; // On error, don't ignore (be inclusive)
    }
}

export {
    shouldIgnoreForHeaderCapture,
    shouldIgnoreForMediaDetection,
    IGNORE_EXTENSIONS
};