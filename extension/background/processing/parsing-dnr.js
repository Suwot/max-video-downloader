/**
 * Parsing-Scoped DNR Manager
 * Applies header rules only during manifest parsing operations
 */

import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('Parsing DNR');
// logger.setLevel('ERROR');

// Maximum rule ID supported by Chrome
const MAX_RULE_ID = 2147483647;

/**
 * Generate a unique rule ID for parsing operations
 * @returns {number} Unique rule ID
 */
function generateParsingRuleId() {
    const timestamp = Date.now() % 1000000; // Last 6 digits
    const random = Math.floor(Math.random() * 1000); // 3 digits
    return (timestamp * 1000 + random) % MAX_RULE_ID + 1;
}

/**
 * Apply DNR rule for manifest parsing
 * @param {string} url - Manifest URL to apply rule for
 * @param {Object} headers - Headers to apply
 * @returns {Promise<number|null>} Rule ID if successful, null if failed
 */
async function applyParsingRule(url, headers) {
    if (!chrome.declarativeNetRequest) {
        logger.debug('declarativeNetRequest API not available');
        return null;
    }

    if (!headers || Object.keys(headers).length === 0) {
        logger.debug('No headers provided for parsing rule');
        return null;
    }

    try {
        // Transform headers to DNR format
        const headerRules = [];
        for (const [name, value] of Object.entries(headers)) {
            if (name !== 'timestamp') {
                headerRules.push({
                    header: name.toLowerCase(),
                    operation: 'set',
                    value: value
                });
            }
        }

        if (headerRules.length === 0) {
            logger.debug('No valid headers for parsing rule');
            return null;
        }

        // Create URL pattern for exact matching
        let urlPattern = url;
        if (url.includes('?')) {
            urlPattern = url.split('?')[0] + '*';
        }

        const ruleId = generateParsingRuleId();

        const rule = {
            id: ruleId,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: headerRules
            },
            condition: {
                urlFilter: urlPattern,
                resourceTypes: ['xmlhttprequest', 'other']
            }
        };

        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [rule]
        });

        logger.debug(`Applied parsing rule ${ruleId} for ${url}`);
        return ruleId;
    } catch (error) {
        logger.error(`Error applying parsing rule for ${url}:`, error);
        return null;
    }
}

/**
 * Remove DNR rule after parsing
 * @param {number} ruleId - Rule ID to remove
 * @returns {Promise<boolean>} Success status
 */
async function removeParsingRule(ruleId) {
    if (!chrome.declarativeNetRequest || !ruleId) {
        return false;
    }

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId]
        });

        logger.debug(`Removed parsing rule ${ruleId}`);
        return true;
    } catch (error) {
        logger.error(`Error removing parsing rule ${ruleId}:`, error);
        return false;
    }
}

/**
 * Clean up all parsing rules on startup
 * @returns {Promise<boolean>} Success status
 */
async function cleanupOrphanedRules() {
    if (!chrome.declarativeNetRequest) {
        return false;
    }

    try {
        const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
        if (sessionRules.length > 0) {
            const ruleIds = sessionRules.map(rule => rule.id);
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: ruleIds
            });
            logger.info(`Cleaned up ${ruleIds.length} orphaned parsing rules on startup`);
        }
        return true;
    } catch (error) {
        logger.error('Error cleaning up orphaned rules:', error);
        return false;
    }
}

export {
    applyParsingRule,
    removeParsingRule,
    cleanupOrphanedRules
};