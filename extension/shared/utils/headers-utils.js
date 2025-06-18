/**
 * Headers Utilities
 * Captures and provides request headers for media content
 */

import { createLogger } from './logger.js';
import { shouldIgnoreForHeaderCapture } from '../../background/detection/url-filters.js';

// Create a logger instance for the headers utilities
const logger = createLogger('Headers Utils');

// Store headers by tab, then by URL 
// Map<tabId, Map<url, headers>>
const tabHeadersStore = new Map();

// Track active rules by tab ID, then URL
// Map<tabId, Map<url, ruleId>>
const activeRules = new Map();

// Maximum rule ID supported by Chrome (2^31 - 1)
const MAX_RULE_ID = 2147483647;

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
 * Captures request headers from onSendHeaders and stores by tab and URL
 * @param {Object} details - Request details from webRequest API
 */
function captureRequestHeaders(details) {
    // Skip if no tabId (extension requests) or if URL should be ignored
    if (details.tabId <= 0 || shouldIgnoreForHeaderCapture(details.url)) {
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
        if (tabHeadersStore.has(tabId)) {
            const tabUrls = tabHeadersStore.get(tabId);
            
            if (tabUrls.has(url)) {
                return formatHeaders(tabUrls.get(url));
            }
            
            logger.debug(`No headers found for ${url} in tab ${tabId}`);
        } else {
            logger.warn(`No headers data for tab ${tabId}`);
        }
        
        return null;
    } catch (e) {
        logger.error(`Error getting headers for ${url}:`, e);
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
        // First check for any existing rules to avoid conflicts
        if (chrome.declarativeNetRequest) {
            try {
                const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
                if (sessionRules.length > 0) {
                    logger.debug(`Found ${sessionRules.length} existing rules on startup`);
                }
            } catch (e) {
                logger.warn('Error checking existing rules:', e);
            }
        }
        
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
 * Clear headers for a specific tab
 * @param {number} tabId - Tab ID to clear headers for
 */
function cleanupHeadersForTab(tabId) {
    if (tabHeadersStore.has(tabId)) {
        tabHeadersStore.delete(tabId);
        logger.debug(`Cleared headers for tab ${tabId}`);
    }
}

/**
 * Clear header rules for a specific tab
 * @param {number} tabId - Tab ID to clear rules for
 * @returns {Promise<boolean>} Success status
 */
async function cleanupHeaderRulesForTab(tabId) {
    if (!chrome.declarativeNetRequest || !activeRules.has(tabId)) {
        return true;
    }
    
    try {
        const tabRules = activeRules.get(tabId);
        const ruleIds = Array.from(tabRules.values());
        
        if (ruleIds.length === 0) {
            return true;
        }
        
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: ruleIds
        });
        
        activeRules.delete(tabId);
        logger.debug(`Cleared ${ruleIds.length} header rules for tab ${tabId}`);
        return true;
    } catch (e) {
        logger.error(`Error clearing header rules for tab ${tabId}:`, e);
        return false;
    }
}

/**
 * Clear all header caches including headers and rules
 */
function clearAllHeaderCaches() {
    clearAllHeaders();
    clearAllHeaderRules();
}

/**
 * Clear all stored headers
 */
function clearAllHeaders() {
    tabHeadersStore.clear();
    logger.debug('All headers cleared');
}

/**
 * Clear all active header rules
 * @returns {Promise<boolean>} Success status
 */
async function clearAllHeaderRules() {
    if (!chrome.declarativeNetRequest || activeRules.size === 0) {
        return true;
    }
    
    try {
        // Collect all rule IDs from all tabs
        const allRuleIds = [];
        for (const [tabId, tabRules] of activeRules.entries()) {
            allRuleIds.push(...tabRules.values());
        }
        
        if (allRuleIds.length === 0) {
            return true;
        }
        
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: allRuleIds
        });
        
        activeRules.clear();
        logger.debug(`Cleared ${allRuleIds.length} header rules across all tabs`);
        return true;
    } catch (e) {
        logger.error('Error clearing header rules:', e);
        return false;
    }
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
    
    let totalRules = 0;
    for (const [tabId, rules] of activeRules.entries()) {
        totalRules += rules.size;
    }
    
    return {
        tabsTracked: tabHeadersStore.size,
        totalUrlsTracked: totalUrls,
        activeRules: totalRules
    };
}

/**
 * Generate a unique rule ID that stays within Chrome's allowed range
 * @returns {number} - Unique rule ID between 1 and MAX_RULE_ID
 */
function generateRuleId() {
    // Start with a random base between 1 and 100,000
    const base = 1 + Math.floor(Math.random() * 100000);
    
    // Add timestamp component but keep within valid range
    // Using modulo to ensure we stay within Chrome's limits
    const timestamp = Date.now() % 10000000; // Last 7 digits of timestamp
    
    // Combine and ensure within valid range
    return (base + timestamp) % MAX_RULE_ID + 1;
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
    
    // Initialize tab rules if needed
    if (!activeRules.has(tabId)) {
        activeRules.set(tabId, new Map());
    }
    
    const tabRules = activeRules.get(tabId);
    
    // If rule already exists for this URL in this tab, don't create another one
    if (tabRules.has(url)) {
        logger.debug(`Rule already exists for ${url} in tab ${tabId}`);
        return true;
    }
    
    try {
        // Get headers for this URL
        const headers = getRequestHeaders(tabId, url);
        if (!headers) {
            logger.warn(`No headers available for ${url} in tab ${tabId}`);
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
        const ruleId = generateRuleId();
        
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
        
        // Store rule ID for cleanup (in tab-specific map)
        tabRules.set(url, ruleId);
        logger.debug(`Applied header rule ${ruleId} for ${url} in tab ${tabId}`);
        return true;
    } catch (e) {
        logger.error(`Error applying header rule for ${url} in tab ${tabId}:`, e);
        return false;
    }
}

/**
 * Propagate headers from one URL to other URLs in the same tab context
 * Useful for HLS variants derived from master playlists
 * 
 * @param {number} tabId - Tab ID context
 * @param {string} sourceUrl - URL to copy headers from
 * @param {Array<string>} targetUrls - URLs to copy headers to
 * @returns {boolean} Success status
 */
function propagateHeaders(tabId, sourceUrl, targetUrls) {
    if (!tabId || tabId <= 0) {
        logger.error(`Invalid tabId ${tabId} for header propagation`);
        return false;
    }
    
    if (!sourceUrl || !targetUrls || !Array.isArray(targetUrls) || targetUrls.length === 0) {
        logger.error('Invalid source or target URLs for header propagation');
        return false;
    }
    
    try {
        // Check if we have the source tab in our store
        if (!tabHeadersStore.has(tabId)) {
            logger.warn(`No headers data for tab ${tabId}`);
            return false;
        }
        
        // Get the tab's URL map
        const tabUrls = tabHeadersStore.get(tabId);
        
        // Check if we have headers for the source URL
        if (!tabUrls.has(sourceUrl)) {
            logger.warn(`No headers found for source URL: ${sourceUrl}`);
            return false;
        }
        
        // Get the source headers
        const sourceHeaders = tabUrls.get(sourceUrl);
        
        // Copy headers to each target URL
        let propagatedCount = 0;
        for (const targetUrl of targetUrls) {
            // Skip if target already has headers
            if (tabUrls.has(targetUrl)) {
                logger.debug(`Target URL already has headers: ${targetUrl}`);
                continue;
            }
            
            // Clone the headers to avoid reference issues
            const clonedHeaders = {...sourceHeaders};
            
            // Update timestamp to current time
            clonedHeaders.timestamp = Date.now();
            
            // Store in the tab's URL map
            tabUrls.set(targetUrl, clonedHeaders);
            propagatedCount++;
        }
        
        logger.debug(`Propagated headers from ${sourceUrl} to ${propagatedCount} target URLs`);
        return propagatedCount > 0;
    } catch (e) {
        logger.error(`Error propagating headers: ${e.message}`);
        return false;
    }
}

// Export functions
export {
    initHeaderTracking,
    getRequestHeaders,
    cleanupHeadersForTab,
    cleanupHeaderRulesForTab,
    clearAllHeaders,
    clearAllHeaderRules,
    clearAllHeaderCaches,
    getHeadersStats,
    applyHeaderRule,
    propagateHeaders
};