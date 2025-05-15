/**
 * Headers Utilities
 * Provides functions for creating standardized browser-like request headers
 * for video/media content requests to prevent 403 errors
 */

/**
 * Build realistic browser-like request headers for video requests
 * @param {number} tabId - Tab ID where the video is located (optional)
 * @param {string} videoUrl - The URL of the video being requested
 * @returns {Object} Headers object mimicking a real browser request
 */
export async function buildRequestHeaders(tabId, videoUrl) {
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
            console.warn('Failed to get tab info for headers:', error.message);
            // We specifically DON'T add fake Referer/Origin here, 
            // better to omit than to send fake ones that trigger protections
        }
    }
    
    return headers;
}
