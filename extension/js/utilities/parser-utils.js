/**
 * Parser Utilities
 * Common utilities for HLS and DASH parsing operations
 */

import { normalizeUrl, getBaseDirectory } from './normalize-url.js';
import { getSharedHeaders } from './headers-utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('Parser Utils');

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
    return Math.round(parseFloat(frameRateStr));
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
 * Fetch manifest content with built-in retry logic
 * 
 * @param {string} url - URL to fetch
 * @param {Object} [options] - Fetch options
 * @param {Object} [options.headers] - Optional request headers
 * @param {number} [options.rangeBytes] - If provided, fetches only specified bytes (partial content)
 * @param {number} [options.timeoutMs=10000] - Timeout in milliseconds
 * @param {number} [options.maxRetries=2] - Maximum number of retry attempts
 * @param {number} [options.retryDelayMs=500] - Base delay between retries in milliseconds
 * @returns {Promise<{content: string, ok: boolean, status: number, retryCount: number}>}
 */
export async function fetchManifest(url, options = {}) {
    const {
        headers = null,
        rangeBytes = null,
        timeoutMs = 10000,
        maxRetries = 2,
        retryDelayMs = 500
    } = options;
    
    const logger = createLogger('Fetch');
    const fetchMode = rangeBytes ? `first ${rangeBytes} bytes` : 'full content';
    
    let attempt = 0;
    let lastError = null;
    
    // Get appropriate headers
    const requestHeaders = headers || await getSharedHeaders(null, url);
    
    // Configure range header if needed
    if (rangeBytes) {
        requestHeaders['Range'] = `bytes=0-${rangeBytes - 1}`;
        logger.debug(`Fetching ${fetchMode} of ${url}`);
    } else {
        // Remove any Range header to ensure we get the full content
        if (requestHeaders['Range']) {
            delete requestHeaders['Range'];
        }
        logger.debug(`Fetching ${fetchMode} of ${url}`);
    }
    
    while (attempt <= maxRetries) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            
            // Log retry attempts after the first one
            if (attempt > 0) {
                logger.debug(`Retry attempt ${attempt}/${maxRetries} for ${url}`);
            }
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: requestHeaders
            });
            
            clearTimeout(timeoutId);
            
            // Handle retry-worthy status codes
            if (!response.ok) {
                // Don't retry client errors (except 429 Too Many Requests)
                if (response.status !== 429 && response.status < 500) {
                    logger.debug(`Non-retriable error: HTTP ${response.status} for ${url}`);
                    return { 
                        content: '', 
                        ok: false, 
                        status: response.status, 
                        retryCount: attempt 
                    };
                }
                
                // For retriable errors, check if we have attempts left
                if (attempt >= maxRetries) {
                    logger.debug(`Out of retry attempts (${maxRetries}) for ${url}`);
                    return { 
                        content: '', 
                        ok: false, 
                        status: response.status, 
                        retryCount: attempt 
                    };
                }
                
                // Handle rate limiting specifically
                let delay = retryDelayMs * Math.pow(2, attempt);
                
                if (response.status === 429) {
                    // Check for Retry-After header
                    const retryAfter = response.headers.get('Retry-After');
                    if (retryAfter) {
                        if (!isNaN(retryAfter)) {
                            delay = parseInt(retryAfter, 10) * 1000; // Convert to ms
                        } else {
                            const retryDate = new Date(retryAfter).getTime();
                            if (!isNaN(retryDate)) {
                                delay = Math.max(retryDate - Date.now(), retryDelayMs);
                            }
                        }
                        logger.debug(`Rate limited with Retry-After, waiting ${delay}ms`);
                    }
                }
                
                // Increment attempt and retry after delay
                attempt++;
                logger.debug(`HTTP error ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            // On successful response, extract content
            const content = await response.text();
            return { 
                content, 
                ok: true, 
                status: response.status, 
                retryCount: attempt 
            };
            
        } catch (error) {
            // Network error or timeout
            lastError = error;
            
            if (attempt >= maxRetries) {
                logger.error(`Failed after ${attempt + 1} attempts: ${error.message}`);
                return { 
                    content: '', 
                    ok: false, 
                    status: 0, 
                    error: error.message, 
                    retryCount: attempt 
                };
            }
            
            // Increment attempt and retry with minimal delay for network errors
            attempt++;
            logger.debug(`Network error: ${error.message}, retrying immediately (attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay before retry
        }
    }
    
    // Should never reach here but just in case
    return { 
        content: '', 
        ok: false, 
        status: 0, 
        error: lastError?.message || 'Unknown error', 
        retryCount: attempt 
    };
}

/**
 * Check if a URL points to a streaming manifest (DASH or HLS) with optimized downloading
 * Relies entirely on content inspection to determine manifest type, not content-type header
 * Returns enhanced result with validation and content data when possible
 * 
 * @param {string} url - URL to check
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Object>} - Validation result with additional metadata
 */
export async function validateManifestType(url, headers = null, existingMetadata = null) {
    const logger = createLogger('Manifest Validator');
    try {
        logger.debug(`Checking manifest type for ${url}`);
        
        const reqHeaders = headers || await getSharedHeaders(null, url);
        let contentLength = null;
        let supportsRanges = false;
        let fullContent = null;
        
        // Use existing metadata if provided to avoid redundant HEAD request
        if (existingMetadata) {
            contentLength = existingMetadata.contentLength || null;
            supportsRanges = existingMetadata.supportsRanges || false;
            logger.debug(`Using existing metadata for manifest validation: content-length=${contentLength}, supports-ranges=${supportsRanges}`);
        }
        
        let validationResult = {
            isValid: false,
            manifestType: 'unknown',
            timestampLP: Date.now(),
            status: 'unknown',
            contentLength: contentLength,
            supportsRanges: supportsRanges,
            content: null
        };
        
        // Only do HEAD request if we don't have metadata
        if (!existingMetadata) {
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
                    contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
                    supportsRanges = headResponse.headers.get('accept-ranges') === 'bytes';
                    
                    validationResult.contentLength = contentLength;
                    validationResult.supportsRanges = supportsRanges;
                    
                    logger.debug(`Retrieved metadata: content-length=${contentLength}, supports-ranges=${supportsRanges}`);
                }
            } catch (error) {
                // Ignore HEAD request failures, proceed to content inspection
                logger.debug(`HEAD request failed, using content inspection: ${error.message}`);
                validationResult.status = 'head-request-failed';
            }
        }

        // Download strategies for content inspection
        // Download completely if small file, size unknown, or no range support
        if (!contentLength || contentLength <= 40 * 1024 || !supportsRanges) {
            const downloadType = !supportsRanges && contentLength > 40 * 1024 
                ? "Large manifest without range support" 
                : "Small manifest or size unknown";
                
            logger.debug(`${downloadType} - downloading fully`);
            
            try {
                const fullFetchResult = await fetchManifest(url, {
                    headers: reqHeaders,
                    maxRetries: 3
                });
                
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
            
            const result = await fetchManifest(url, {
                headers: reqHeaders,
                rangeBytes: 10 * 1024,
                maxRetries: 3
            });
            
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
export { normalizeUrl, getSharedHeaders, getBaseDirectory };
