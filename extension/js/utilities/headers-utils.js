/**
 * Headers Utilities
 * Provides functions for creating standardized browser-like request headers
 * for video/media content requests to prevent 403 errors
 */

import { createLogger } from './logger.js';

// Cache headers promises by tab ID
const tabHeadersCache = new Map();

// Create a logger instance for the headers utilities
const logger = createLogger('Headers Utils');

/**
 * Get shared headers for a specific tab, with Promise memoization
 * @param {number} tabId - Tab ID where the video is located (optional)
 * @param {string} videoUrl - The URL of the video being requested
 * @returns {Promise<Object>} Headers object mimicking a real browser request
 */
async function getSharedHeaders(tabId, videoUrl) {
    // For non-tab requests, always build fresh headers
    if (!tabId || tabId <= 0) {
        return buildRequestHeaders(null, videoUrl);
    }
    
    // If we don't have a promise for this tab yet, create one
    if (!tabHeadersCache.has(tabId)) {
        const promise = buildRequestHeaders(tabId, videoUrl).catch(error => {
            // Only clear if this exact promise is still cached
            if (tabHeadersCache.get(tabId) === promise) {
                tabHeadersCache.delete(tabId); // Allow retry on next request
            }
            throw error; // Re-throw to propagate the error
        });
        
        tabHeadersCache.set(tabId, promise);
    }
    
    return tabHeadersCache.get(tabId);
}

/**
 * Clear the header promise cache for a specific tab
 * @param {number} tabId - Tab ID to clear cache for
 */
function clearHeaderCache(tabId) {
    if (tabHeadersCache.has(tabId)) {
        tabHeadersCache.delete(tabId);
    }
}

/**
 * Clear all header caches (useful when browser session changes)
 */
function clearAllHeaderCaches() {
    tabHeadersCache.clear();
}

/**
 * Get cookies for a specific URL
 * @param {string} url - URL to get cookies for
 * @returns {Promise<string>} Cookie string in format "name1=value1; name2=value2"
 */
async function getCookiesForUrl(url) {
    if (!url) return '';
    
    try {
        const urlObj = new URL(url);
        
        // Get cookies for this domain
        const cookies = await chrome.cookies.getAll({ url: urlObj.origin });
        
        if (!cookies || cookies.length === 0) {
            return '';
        }
        
        // Format cookies as string
        const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        
        logger.debug(`Retrieved ${cookies.length} cookies for ${urlObj.hostname}`);
        return cookieString;
    } catch (error) {
        logger.warn(`Error getting cookies for ${url}: ${error.message}`);
        return '';
    }
}

/**
 * Build realistic browser-like request headers for video requests
 * @param {number} tabId - Tab ID where the video is located (optional)
 * @param {string} videoUrl - The URL of the video being requested
 * @returns {Promise<Object>} Headers object mimicking a real browser request
 */
async function buildRequestHeaders(tabId, videoUrl) {
    const headers = {
        // Standard headers
        'User-Agent': navigator.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
    };
    
    // Add Origin and Referer if we can get the tab info
    if (tabId && tabId > 0) {
        try {
            const tabInfo = await chrome.tabs.get(tabId);
            if (tabInfo?.url) {
                // Valid tab with URL found
                const pageUrl = new URL(tabInfo.url);
                
                // Add Referer header
                headers['Referer'] = tabInfo.url;
                
                // Add Origin header
                headers['Origin'] = pageUrl.origin;
            }
        } catch (error) {
            logger.warn('Failed to get tab info for headers:', error.message);
            // We specifically DON'T add fake Referer/Origin here, 
            // better to omit than to send fake ones that trigger protections
        }
    }
    
    // Get cookies for the video URL if provided
    if (videoUrl) {
        const cookieString = await getCookiesForUrl(videoUrl);
        if (cookieString) {
            headers['Cookie'] = cookieString;
        }
    }
    
    logger.debug(`Generated headers for request to ${videoUrl}:`, headers);
    return headers;
}

export { getSharedHeaders, buildRequestHeaders, clearHeaderCache, clearAllHeaderCaches };
