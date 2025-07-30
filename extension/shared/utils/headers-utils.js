/**
 * Headers Utilities
 * Captures and provides request headers for media content
 */

import { createLogger } from './logger.js';
import { shouldIgnoreForHeaderCapture } from '../../background/detection/url-filters.js';

// Create a logger instance for the headers utilities
const logger = createLogger('Headers Utils');
logger.setLevel('ERROR');

// Store headers by requestId
// Map<requestId, headers>
const requestHeadersStore = new Map();



// Essential headers for media access
const ESSENTIAL_HEADERS = [
    'origin',
    'referer',
    'user-agent'
];

/**
 * Extract essential headers from webRequest details
 * @param {Array} requestHeaders - Chrome request headers array
 * @returns {Object|null} Extracted headers or null if no essential headers found
 */
function extractHeaders(requestHeaders) {
    const headers = {};
    let hasEssentialHeaders = false;
    
    for (const header of requestHeaders) {
        const headerName = header.name.toLowerCase();
        if (ESSENTIAL_HEADERS.includes(headerName)) {
            headers[headerName] = header.value;
            hasEssentialHeaders = true;
        }
    }
    
    if (hasEssentialHeaders) {
        headers.timestamp = Date.now();
        return headers;
    }
    
    return null;
}

/**
 * Captures request headers from onSendHeaders and stores by tab and requestId
 * @param {Object} details - Request details from webRequest API
 */
function captureRequestHeaders(details) {
    // Skip if should be ignored or missing requestId
    if (shouldIgnoreForHeaderCapture(details.url)) {
        return;
    }
    if (!details.requestId) {
        logger.warn('No requestId in details, cannot store headers');
        return;
    }
    try {
        // Extract headers
        const headers = extractHeaders(details.requestHeaders);
        logger.debug(`Captured headers for requestId ${details.requestId}`, headers);
        if (!headers) return;
        // Store by requestId only
        requestHeadersStore.set(details.requestId, headers);
    } catch (e) {
        logger.warn('Error capturing headers:', e);
    }
}

/**
 * Format headers for use in fetch/XHR requests
 * @param {Object} headers - Raw headers object
 * @returns {Object} Properly formatted headers
 */
function formatHeaders(headers) {
    if (!headers) return {};
    
    const formattedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (key !== 'timestamp') {
            // Convert from lowercase to proper case for header names
            const properKey = key.replace(/\b([a-z])/g, match => match.toUpperCase());
            formattedHeaders[properKey] = value;
        }
    }
    
    return formattedHeaders;
}

/**
 * Get request headers for a requestId
 * @param {string} requestId - requestId to get headers for
 * @returns {Object|null} Headers object or null if not found
 */
function getRequestHeaders(requestId) {
    if (!requestId) {
        logger.warn(`Invalid request for headers - requestId: ${requestId}`);
        return null;
    }
    try {
        if (requestHeadersStore.has(requestId)) {
            return formatHeaders(requestHeadersStore.get(requestId));
        }
        logger.debug(`No headers found for requestId ${requestId}`);
        return null;
    } catch (e) {
        logger.error(`Error getting headers for requestId ${requestId}:`, e);
        return null;
    }
}

/**
 * Initialize header tracking with Chrome listeners
 */
async function initHeaderTracking() {
    if (!chrome.webRequest) {
        logger.error('webRequest API not available, header tracking disabled');
        return;
    }
    
    try {
        // Define options with extraHeaders to access referer and origin
        const listenerOptions = ["requestHeaders"];
        
        // Check if we need to add extraHeaders (Chrome)
        // Firefox doesn't need or support this option
        if (chrome.webRequest.OnSendHeadersOptions && 
            chrome.webRequest.OnSendHeadersOptions.hasOwnProperty('EXTRA_HEADERS')) {
            listenerOptions.push('extraHeaders');
        }
        
        chrome.webRequest.onSendHeaders.addListener(
            captureRequestHeaders,
            { urls: ["<all_urls>"] },
            listenerOptions
        );
        
        logger.info('Header tracking initialized with options:', listenerOptions);
    } catch (e) {
        logger.error('Failed to initialize header tracking:', e);
    }
}




/**
 * Clear all stored headers
 */
function clearAllHeaders() {
    requestHeadersStore.clear();
    logger.debug('All headers cleared');
}

/**
 * Get statistics about stored headers
 * @returns {Object} Stats object with counts
 */
function getHeadersStats() {
    return {
        requestsTracked: requestHeadersStore.size
    };
}



/**
 * Remove headers for a specific requestId
 * @param {string} requestId - requestId to remove
 */
function removeHeadersByRequestId(requestId) {
    if (!requestId) return;
    requestHeadersStore.delete(requestId);
    logger.debug(`Removed headers for requestId ${requestId}`);
}

// Export functions
export {
    initHeaderTracking,
    getRequestHeaders,
    clearAllHeaders,
    getHeadersStats,
    removeHeadersByRequestId
};