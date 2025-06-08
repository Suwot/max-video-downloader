/**
 * Headers Utilities
 * Captures and provides request headers for media content
 */

import { createLogger } from './logger.js';

// Create a logger instance for the headers utilities
const logger = createLogger('Headers Utils');

// Store headers by tab, then by URL 
// Map<tabId, Map<url, headers>>
const tabHeadersStore = new Map();

// Track active rules: URL -> Rule ID
const activeRules = new Map();

// Rule ID counter for generating unique IDs
let nextRuleId = 1;

// Skip tracking headers for these extensions to reduce overhead
const IGNORE_EXTENSIONS = [
    '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2',
    '.ttf', '.eot', '.otf', '.json', '.xml', '.webp', '.avif', '.ts'
];

// Important headers to preserve
const IMPORTANT_HEADERS = [
    'origin',
    'referer',
    'user-agent',
    'cookie',
    'authorization',
    'sec-fetch-site',
    'sec-fetch-mode', 
    'sec-fetch-dest',
    'accept',
    'accept-language'
];

/**
 * Checks if a URL should be ignored for header tracking
 * @param {string} url - URL to check
 * @returns {boolean} True if URL should be ignored
 */
function shouldIgnoreUrl(url) {
    try {
        // Quick check for file extensions we want to ignore
        const lowerUrl = url.toLowerCase();
        if (IGNORE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))) {
            return true;
        }
        
        // More detailed check for analytics/tracking/ads
        if (/\/(analytics|track|pixel|impression|ad|ga|beacon|stats|metrics)\//i.test(url)) {
            return true;
        }
        
        return false;
    } catch {
        // If URL parsing fails, don't ignore
        return false;
    }
}

/**
 * Extract headers from webRequest details
 * @param {Array} requestHeaders - Chrome request headers array
 * @returns {Object|null} Extracted headers or null if no important headers
 */
function extractHeaders(requestHeaders) {
    // Extract important headers into a clean object
    const headers = {};
    let hasImportantHeaders = false;
    
    for (const header of requestHeaders) {
        const headerName = header.name.toLowerCase();
        if (IMPORTANT_HEADERS.includes(headerName)) {
            headers[headerName] = header.value;
            hasImportantHeaders = true;
        }
    }
    
    // Add timestamp for debugging/cleanup
    if (hasImportantHeaders) {
        headers.timestamp = Date.now();
        return headers;
    }
    
    return null;
}

/**
 * Captures request headers from onSendHeaders and stores by tab and URL
 * @param {Object} details - Request details from webRequest API
 */
function captureRequestHeaders(details) {
    // Skip if no tabId (extension requests) or if URL should be ignored
    if (details.tabId <= 0 || shouldIgnoreUrl(details.url)) {
        return;
    }
    
    try {
        // Extract headers
        const headers = extractHeaders(details.requestHeaders);
        logger.debug(`Captured headers for ${details.url} in tab ${details.tabId}`, headers);
        if (!headers) return;
        
        // Store in tab-URL structure
        if (!tabHeadersStore.has(details.tabId)) {
            tabHeadersStore.set(details.tabId, new Map());
        }
        
        const tabUrls = tabHeadersStore.get(details.tabId);
        tabUrls.set(details.url, headers);
        
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
 * Get request headers for a URL
 * @param {number} tabId - Tab ID for context
 * @param {string} url - URL to get headers for
 * @returns {Object|null} Headers object or null if not found
 */
function getRequestHeaders(tabId, url) {
    if (!url || !tabId || tabId <= 0) {
        logger.warn(`Invalid request for headers - tabId: ${tabId}, url: ${url}`);
        return null;
    }
    
    try {
        // Direct lookup in tab context
        if (tabHeadersStore.has(tabId)) {
            const tabUrls = tabHeadersStore.get(tabId);
            
            // Exact match is best case
            if (tabUrls.has(url)) {
                return formatHeaders(tabUrls.get(url));
            }
            
            // Log miss for debugging
            logger.debug(`No exact header match for ${url} in tab ${tabId}`);
            
            // Default headers as fallback
            return {
                'User-Agent': navigator.userAgent,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            };
        }
        
        // No data for this tab
        logger.warn(`No headers data for tab ${tabId}`);
        return null;
    } catch (e) {
        logger.error(`Error getting headers for ${url}:`, e);
        return null;
    }
}

/**
 * Initialize header tracking with Chrome listeners
 */
function initHeaderTracking() {
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
        
        // Set up tab cleanup listener
        chrome.tabs.onRemoved.addListener(clearHeadersForTab);
        
        logger.info('Header tracking initialized with options:', listenerOptions);
    } catch (e) {
        logger.error('Failed to initialize header tracking:', e);
    }
}

/**
 * Clear headers for a specific tab
 * @param {number} tabId - Tab ID to clear headers for
 */
function clearHeadersForTab(tabId) {
    if (tabHeadersStore.has(tabId)) {
        tabHeadersStore.delete(tabId);
        logger.debug(`Cleared headers for tab ${tabId}`);
    }
}

/**
 * Clear all stored headers
 */
function clearAllHeaders() {
    tabHeadersStore.clear();
    logger.debug('All headers cleared');
}

/**
 * Get statistics about stored headers
 * @returns {Object} Stats object with counts
 */
function getHeadersStats() {
    let totalUrls = 0;
    for (const [tabId, urls] of tabHeadersStore.entries()) {
        totalUrls += urls.size;
    }
    
    return {
        tabsTracked: tabHeadersStore.size,
        totalUrlsTracked: totalUrls,
        activeRules: activeRules.size
    };
}

/**
 * Apply declarativeNetRequest rule for a URL to ensure headers are set
 * @param {number} tabId - Tab ID for context
 * @param {string} url - URL to apply rule for
 * @returns {Promise<boolean>} Success status
 */
async function applyHeaderRule(tabId, url) {
    if (!chrome.declarativeNetRequest) {
        logger.error('declarativeNetRequest API not available');
        return false;
    }
    
    // If rule already exists, don't create another one
    if (activeRules.has(url)) {
        logger.debug(`Rule already exists for ${url}`);
        return true;
    }
    
    try {
        // Get headers for this URL
        const headers = getRequestHeaders(tabId, url);
        if (!headers) {
            logger.warn(`No headers available for ${url}`);
            return false;
        }
        
        // Transform headers to DNR format
        const headerRules = [];
        for (const [name, value] of Object.entries(headers)) {
            headerRules.push({
                header: name.toLowerCase(),
                operation: 'set',
                value: value
            });
        }
        
        // Create URL pattern (exact URL or with wildcard for query params)
        let urlPattern = url;
        if (url.includes('?')) {
            urlPattern = url.split('?')[0] + '*';
        }
        
        // Create unique rule ID
        const ruleId = nextRuleId++;
        
        // Create the rule
        const rule = {
            id: ruleId,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: headerRules
            },
            condition: {
                urlFilter: urlPattern,
                resourceTypes: ['xmlhttprequest', 'media', 'other']
            }
        };
        
        // Apply rule
        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [rule]
        });
        
        // Store rule ID for cleanup
        activeRules.set(url, ruleId);
        logger.debug(`Applied header rule ${ruleId} for ${url}`);
        return true;
    } catch (e) {
        logger.error(`Error applying header rule for ${url}:`, e);
        return false;
    }
}

/**
 * Remove declarativeNetRequest rule for a URL
 * @param {string} url - URL to remove rule for
 * @returns {Promise<boolean>} Success status
 */
async function removeHeaderRule(url) {
    if (!activeRules.has(url)) {
        return true;
    }
    
    try {
        const ruleId = activeRules.get(url);
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId]
        });
        
        activeRules.delete(url);
        logger.debug(`Removed header rule ${ruleId} for ${url}`);
        return true;
    } catch (e) {
        logger.error(`Error removing header rule for ${url}:`, e);
        return false;
    }
}

/**
 * Fetch a URL with proper headers using declarativeNetRequest
 * @param {number} tabId - Tab ID for context
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithCorrectHeaders(tabId, url, options = {}) {
    // Apply header rule
    await applyHeaderRule(tabId, url);
    
    try {
        // Make the request
        return await fetch(url, options);
    } finally {
        // We'll let the caller decide when to remove the rule
        // Don't remove here as there could be multiple related requests
    }
}

// Export functions
export {
    initHeaderTracking,
    getRequestHeaders,
    clearHeadersForTab,
    clearAllHeaders,
    getHeadersStats,
    applyHeaderRule,
    removeHeaderRule,
    fetchWithCorrectHeaders
};
