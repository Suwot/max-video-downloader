/**
 * Headers Utilities
 * Captures and provides request headers for media content
 */

import { createLogger } from './logger.js';
import { shouldIgnoreForHeaderCapture } from '../../background/detection/url-filters.js';

// Create a logger instance for the headers utilities
const logger = createLogger('Headers Utils');

// Store headers by requestId
// Map<requestId, headers>
const requestHeadersStore = new Map();

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
    requestHeadersStore.clear();
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
    let totalRules = 0;
    for (const [tabId, rules] of activeRules.entries()) {
        totalRules += rules.size;
    }
    return {
        requestsTracked: requestHeadersStore.size,
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
 * @param {number} tabId - Tab ID for context (for rule tracking)
 * @param {string} url - URL to apply rule for
 * @param {Object} headers - Headers to set (already formatted)
 * @returns {Promise<boolean>} Success status
 */
async function applyDNRRule(tabId, url, headers) {
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
        if (!headers || Object.keys(headers).length === 0) {
            logger.warn(`No headers provided for ${url} in tab ${tabId}`);
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
    cleanupHeaderRulesForTab,
    clearAllHeaders,
    clearAllHeaderRules,
    clearAllHeaderCaches,
    getHeadersStats,
    applyDNRRule,
    removeHeadersByRequestId
};