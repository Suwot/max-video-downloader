/**
 * Parser Utilities
 * Common utilities for HLS and DASH parsing operations
 */

import { normalizeUrl, getBaseDirectory } from './normalize-url.js';
import { buildRequestHeaders } from './headers-utils.js';
import { createLogger } from './logger.js';

// Tracking URLs currently being processed
export const processingRequests = {
    light: new Set(),
    full: new Set()
};

/**
 * Helper function to extract attributes from XML tags
 * 
 * @param {string} xmlString - The XML string to extract from
 * @param {string} attributeName - The attribute name to extract
 * @returns {string|null} The attribute value or null
 */
export function extractAttribute(xmlString, attributeName) {
    const regex = new RegExp(`\\b${attributeName}="([^"]*)"`, 'i');
    const match = xmlString.match(regex);
    return match ? match[1] : null;
}

/**
 * Calculate estimated file size from bitrate and duration
 * 
 * @param {number} bitrate - Bitrate in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number|null} - Estimated file size in bytes or null if inputs are invalid
 */
export function calculateEstimatedFileSizeBytes(bitrate, duration) {
    if (!bitrate || !duration || isNaN(bitrate) || isNaN(duration)) {
        return null;
    }
    
    // Convert bitrate (bits/s) * duration (s) to bytes (divide by 8)
    return Math.round((bitrate * duration) / 8);
}

/**
 * Parse frame rate string, which can be a fraction (e.g., "30000/1001") or a number
 * 
 * @param {string} frameRateStr - The frame rate string
 * @returns {number} Parsed frame rate
 */
export function parseFrameRate(frameRateStr) {
    if (!frameRateStr) return 0;
    
    // Check if it's a fraction
    if (frameRateStr.includes('/')) {
        const [numerator, denominator] = frameRateStr.split('/');
        return parseInt(numerator, 10) / parseInt(denominator, 10);
    }
    
    // Otherwise it's a direct number
    return parseFloat(frameRateStr);
}

/**
 * Parse DASH duration string (ISO 8601 format)
 * Example: PT1H22M3.546S
 * 
 * @param {string} durationStr - The duration string
 * @returns {number} Duration in seconds
 */
export function parseDashDuration(durationStr) {
    if (!durationStr) return 0;
    
    // Handle full ISO 8601 duration format including years, months, days
    // P[n]Y[n]M[n]DT[n]H[n]M[n]S
    const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = durationStr.match(regex);
    
    if (!matches) return 0;
    
    // Extract time components (we're simplifying by using approximate values for years/months)
    const years = matches[1] ? parseInt(matches[1], 10) * 31536000 : 0;   // Approximate year as 365 days
    const months = matches[2] ? parseInt(matches[2], 10) * 2592000 : 0;   // Approximate month as 30 days
    const days = matches[3] ? parseInt(matches[3], 10) * 86400 : 0;
    const hours = matches[4] ? parseInt(matches[4], 10) * 3600 : 0;
    const minutes = matches[5] ? parseInt(matches[5], 10) * 60 : 0;
    const seconds = matches[6] ? parseFloat(matches[6]) : 0;
    
    // Calculate the total and round to full seconds
    return Math.round(years + months + days + hours + minutes + seconds);
}

/**
 * Resolve a URL relative to a base URL
 *
 * @param {string} baseUrl - The base URL
 * @param {string} relativeUrl - The relative URL to resolve
 * @returns {string} The resolved URL
 */
export function resolveUrl(baseUrl, relativeUrl) {
    // If the URL is already absolute, return it as is
    if (relativeUrl.match(/^https?:\/\//i)) {
        return relativeUrl;
    }
    
    // Make sure the base URL ends with a slash
    if (!baseUrl.endsWith('/')) {
        baseUrl += '/';
    }
    
    // Handle relative paths with "../"
    if (relativeUrl.startsWith('../')) {
        // Remove last directory from baseUrl
        baseUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/', baseUrl.length - 2) + 1);
        // Remove '../' from relative URL
        relativeUrl = relativeUrl.substring(3);
        // Recursively handle multiple '../'
        return resolveUrl(baseUrl, relativeUrl);
    }
    
    // Remove './' from the start of the relative URL
    if (relativeUrl.startsWith('./')) {
        relativeUrl = relativeUrl.substring(2);
    }
    
    // Join the base URL and the relative URL
    return baseUrl + relativeUrl;
}

/**
 * Perform lightweight content request with range limiting
 * 
 * @param {string} url - URL to fetch
 * @param {Object} [headers] - Optional request headers
 * @param {number} [rangeBytes=4096] - Number of bytes to request
 * @param {number} [timeoutMs=5000] - Timeout in milliseconds
 * @returns {Promise<{content: string, ok: boolean, status: number}>} - Response
 */
export async function fetchContentRange(url, headers = null, rangeBytes = 4096, timeoutMs = 5000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        console.log(`[Parser Utils] Fetching first ${rangeBytes} bytes of ${url}`);
        
        // Use provided headers or build basic headers
        const requestHeaders = headers || await buildRequestHeaders(null, url);
        
        // Add Range header
        requestHeaders['Range'] = `bytes=0-${rangeBytes - 1}`;
        
        const response = await fetch(url, {
            signal: controller.signal,
            headers: requestHeaders
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[Parser Utils] ❌ Failed to fetch content: ${response.status}`);
            return { content: '', ok: false, status: response.status };
        }
        
        const content = await response.text();
        return { content, ok: true, status: response.status };
    } catch (error) {
        console.error(`[Parser Utils] ❌ Error fetching content: ${error.message}`);
        return { content: '', ok: false, status: 0, error: error.message };
    }
}

/**
 * Fetch full content of a URL
 * 
 * @param {string} url - URL to fetch
 * @param {Object} [headers] - Optional request headers
 * @param {number} [timeoutMs=10000] - Timeout in milliseconds
 * @returns {Promise<{content: string, ok: boolean, status: number}>} - Response
 */
export async function fetchFullContent(url, headers = null, timeoutMs = 10000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        console.log(`[Parser Utils] Fetching full content of ${url}`);
        
        // Use provided headers or build basic headers
        const requestHeaders = headers || await buildRequestHeaders(null, url);
        
        // Remove any Range header to ensure we get the full content
        if (requestHeaders['Range']) {
            delete requestHeaders['Range'];
        }
        
        const response = await fetch(url, {
            signal: controller.signal,
            headers: requestHeaders
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[Parser Utils] ❌ Failed to fetch content: ${response.status}`);
            return { content: '', ok: false, status: response.status };
        }
        
        const content = await response.text();
        return { content, ok: true, status: response.status };
    } catch (error) {
        console.error(`[Parser Utils] ❌ Error fetching content: ${error.message}`);
        return { content: '', ok: false, status: 0, error: error.message };
    }
}

// Helper functions for DASH parsing
/**
 * Helper function to extract AdaptationSet sections
 * 
 * @param {string} content - The MPD content
 * @returns {Array<string>} Array of AdaptationSet XML strings
 */
export function extractAdaptationSets(content) {
    const adaptationSets = [];
    const regex = /<AdaptationSet[^>]*>[\s\S]*?<\/AdaptationSet>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        adaptationSets.push(match[0]);
    }
    return adaptationSets;
}

/**
 * Helper function to extract Representation sections
 * 
 * @param {string} adaptationSetContent - The AdaptationSet XML content
 * @returns {Array<string>} Array of Representation XML strings
 */
export function extractRepresentations(adaptationSetContent) {
    const representations = [];
    const regex = /<Representation[^>]*>[\s\S]*?<\/Representation>|<Representation[^\/]*\/>/g;
    let match;
    while ((match = regex.exec(adaptationSetContent)) !== null) {
        representations.push(match[0]);
    }
    return representations;
}

/**
 * Check if a URL points to a streaming manifest (DASH or HLS) with optimized downloading
 * Returns enhanced result with validation and content data when possible
 * 
 * @param {string} url - URL to check
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Object>} - Validation result with additional metadata
 */
export async function validateManifestType(url, headers = null) {
    const logger = createLogger('Manifest Validator');
    try {
        logger.debug(`Checking manifest type for ${url}`);
        
        const reqHeaders = headers || await buildRequestHeaders(null, url);
        let contentType = null;
        let contentLength = null;
        let supportsRanges = false;
        let fullContent = null;
        let validationResult = {
            isValid: false,
            manifestType: 'unknown',
            timestampLP: Date.now(),
            status: 'unknown',
            contentType: null,
            contentLength: null,
            supportsRanges: false,
            content: null
        };
        
        // First do a HEAD request to check content metadata
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            const headResponse = await fetch(url, {
                method: 'HEAD',
                signal: controller.signal,
                headers: reqHeaders
            });
            
            clearTimeout(timeoutId);
            
            if (headResponse.ok) {
                contentType = headResponse.headers.get('content-type') || '';
                contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
                supportsRanges = headResponse.headers.get('accept-ranges') === 'bytes';
                
                validationResult.contentType = contentType;
                validationResult.contentLength = contentLength;
                validationResult.supportsRanges = supportsRanges;
                
                // DASH content type validation
                if (contentType.includes('application/dash+xml') || 
                    contentType.includes('video/vnd.mpeg.dash.mpd')) {
                    logger.debug(`Content-Type indicates DASH: ${contentType}`);
                    validationResult.isValid = true;
                    validationResult.manifestType = 'dash';
                    validationResult.status = 'confirmed-by-header';
                    validationResult.timestampLP = Date.now();
                    return validationResult;
                }
                
                // HLS content type validation
                if (contentType.includes('application/vnd.apple.mpegurl') || 
                    contentType.includes('application/x-mpegurl') ||
                    contentType.includes('audio/mpegurl') ||
                    contentType.includes('audio/x-mpegurl') ||
                    contentType.includes('application/x-mpegURL') ||
                    contentType.includes('vnd.apple.mpegURL')) {
                    logger.debug(`Content-Type indicates HLS: ${contentType}`);
                    validationResult.isValid = true;
                    validationResult.manifestType = 'hls';
                    validationResult.status = 'confirmed-by-header';
                    validationResult.timestampLP = Date.now();
                    return validationResult;
                }
                
                // If content-type clearly indicates it's not an HLS/DASH manifest
                if (contentType.includes('video/mp4') || 
                    contentType.includes('video/webm') || 
                    contentType.includes('audio/')) {
                    logger.debug(`Content-Type indicates non-manifest: ${contentType}`);
                    validationResult.status = 'rejected-by-header';
                    validationResult.timestampLP = Date.now();
                    return validationResult;
                }
            }
        } catch (error) {
            // Ignore HEAD request failures, proceed to content inspection
            logger.debug(`HEAD request failed, using content inspection: ${error.message}`);
            validationResult.status = 'head-request-failed';
        }
        
        // Download strategies for content inspection
        // Download completely if small file, size unknown, or no range support
        if (!contentLength || contentLength <= 40 * 1024 || !supportsRanges) {
            const downloadType = !supportsRanges && contentLength > 40 * 1024 
                ? "Large manifest without range support" 
                : "Small manifest or size unknown";
                
            logger.debug(`${downloadType} - downloading fully`);
            
            try {
                const fullFetchResult = await fetchFullContent(url, reqHeaders);
                
                if (!fullFetchResult.ok) {
                    logger.warn(`Failed to fetch content: ${fullFetchResult.status}`);
                    validationResult.status = 'fetch-failed';
                    validationResult.timestampLP = Date.now();
                    return validationResult;
                }
                
                fullContent = fullFetchResult.content;
                validationResult.content = fullContent;
                
                // Check for DASH signatures
                const isDash = fullContent.includes('<MPD') && 
                              (fullContent.includes('xmlns="urn:mpeg:dash:schema:mpd') || 
                               fullContent.includes('</MPD>'));
                               
                // Check for HLS signatures
                const isHls = fullContent.includes('#EXTM3U');
                
                if (isDash) {
                    validationResult.isValid = true;
                    validationResult.manifestType = 'dash';
                    validationResult.status = 'confirmed-by-content';
                    validationResult.timestampLP = Date.now();
                    logger.debug(`Content inspection confirms DASH manifest`);
                    return validationResult;
                } else if (isHls) {
                    // Additional HLS type detection
                    const isMaster = fullContent.includes('#EXT-X-STREAM-INF');
                    const isVariant = !isMaster && fullContent.includes('#EXTINF');
                    
                    validationResult.isValid = true;
                    validationResult.manifestType = 'hls';
                    validationResult.isMaster = isMaster;
                    validationResult.isVariant = isVariant;
                    validationResult.status = 'confirmed-by-content';
                    validationResult.timestampLP = Date.now();
                    logger.debug(`Content inspection confirms HLS ${isMaster ? 'master' : (isVariant ? 'variant' : '')} playlist`);
                    return validationResult;
                }
                
                validationResult.status = 'rejected-by-content';
                validationResult.timestampLP = Date.now();
                logger.debug('Content inspection rejects manifest - neither DASH nor HLS');
                return validationResult;
            } catch (error) {
                logger.error(`Error fetching full content: ${error.message}`);
                validationResult.status = 'fetch-error';
                validationResult.timestampLP = Date.now();
                return validationResult;
            }
        }
        // Case 2: Larger file with range support - fetch partial content
        else {
            logger.debug(`Large manifest with range support - fetching partial content`);
            
            const result = await fetchContentRange(url, reqHeaders, 10 * 1024); // 10 KB for manifest header
            
            if (!result.ok) {
                logger.warn(`Failed to fetch partial content: ${result.status}`);
                validationResult.status = 'fetch-failed';
                validationResult.timestampLP = Date.now();
                return validationResult;
            }
            
            // Check for DASH signatures in partial content
            const isDash = result.content.includes('<MPD') && 
                          (result.content.includes('xmlns="urn:mpeg:dash:schema:mpd') || 
                           result.content.includes('</MPD>'));
                           
            // Check for HLS signatures in partial content
            const isHls = result.content.includes('#EXTM3U');
            
            if (isDash) {
                validationResult.isValid = true;
                validationResult.manifestType = 'dash';
                validationResult.status = 'confirmed-by-partial';
                validationResult.timestampLP = Date.now();
                logger.debug(`Partial content inspection confirms DASH manifest`);
                return validationResult;
            } else if (isHls) {
                // Additional HLS type detection
                const isMaster = result.content.includes('#EXT-X-STREAM-INF');
                const isVariant = !isMaster && result.content.includes('#EXTINF');
                
                validationResult.isValid = true;
                validationResult.manifestType = 'hls';
                validationResult.isMaster = isMaster;
                validationResult.isVariant = isVariant;
                validationResult.status = 'confirmed-by-partial';
                validationResult.timestampLP = Date.now();
                logger.debug(`Partial content inspection confirms HLS ${isMaster ? 'master' : (isVariant ? 'variant' : '')} playlist`);
                return validationResult;
            }
            
            validationResult.status = 'rejected-by-partial';
            validationResult.timestampLP = Date.now();
            logger.debug('Partial content inspection rejects manifest - neither DASH nor HLS');
            return validationResult;
        }
    } catch (error) {
        logger.error(`Error checking manifest type: ${error.message}`);
        return {
            isValid: false,
            manifestType: 'unknown',
            status: 'validation-error',
            error: error.message,
            timestampLP: Date.now()
        };
    }
}

// Re-export utilities that we're using directly from other modules
export { normalizeUrl, buildRequestHeaders, getBaseDirectory };
