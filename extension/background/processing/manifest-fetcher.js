/**
 * Manifest Fetcher
 * Single purpose: fetch manifest content with parsing-scoped DNR
 */

import { createLogger } from '../../shared/utils/logger.js';
import { applyParsingRule, removeParsingRule } from './parsing-dnr.js';

const logger = createLogger('Manifest Fetcher');
logger.setLevel('ERROR');

/**
 * Fetch manifest content with parsing-scoped DNR rules
 * @param {string} url - Manifest URL to fetch
 * @param {Object} headers - Headers for DNR rule
 * @param {Object} [options] - Fetch options
 * @param {number} [options.timeoutMs=10000] - Timeout in milliseconds
 * @param {number} [options.maxRetries=2] - Maximum retry attempts
 * @returns {Promise<{content: string, success: boolean, status: number, error?: string}>}
 */
export async function fetchManifest(url, headers, options = {}) {
    const {
        timeoutMs = 10000,
        maxRetries = 2
    } = options;
    
    let ruleId = null;
    let attempt = 0;
    
    // Apply parsing rule for manifest access
    if (headers) {
        ruleId = await applyParsingRule(url, headers);
    }
    
    try {
        while (attempt <= maxRetries) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                
                if (attempt > 0) {
                    logger.debug(`Retry attempt ${attempt}/${maxRetries} for ${url}`);
                }
                
                const response = await fetch(url, {
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    // Don't retry client errors (except 429)
                    if (response.status !== 429 && response.status < 500) {
                        return { 
                            content: '', 
                            success: false, 
                            status: response.status 
                        };
                    }
                    
                    if (attempt >= maxRetries) {
                        return { 
                            content: '', 
                            success: false, 
                            status: response.status 
                        };
                    }
                    
                    // Retry with exponential backoff
                    const delay = 500 * Math.pow(2, attempt);
                    attempt++;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                
                const content = await response.text();
                return { 
                    content, 
                    success: true, 
                    status: response.status 
                };
                
            } catch (error) {
                if (attempt >= maxRetries) {
                    return { 
                        content: '', 
                        success: false, 
                        status: 0, 
                        error: error.message 
                    };
                }
                
                attempt++;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        return { 
            content: '', 
            success: false, 
            status: 0, 
            error: 'Max retries exceeded' 
        };
    } finally {
        // Clean up parsing rule immediately
        if (ruleId) {
            await removeParsingRule(ruleId);
        }
    }
}