/**
 * Parser Utilities
 * Common utilities for HLS and DASH parsing operations
 */

import { normalizeUrl, getBaseDirectory as getBaseDirectoryFromUrl } from './normalize-url.js';
import { buildRequestHeaders } from './headers-utils.js';

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

// Re-export utilities that we're using directly from other modules
export { normalizeUrl, buildRequestHeaders, getBaseDirectoryFromUrl as getBaseDirectory };
