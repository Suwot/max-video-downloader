/**
 * @ai-guide-component ManifestService
 * @ai-guide-description Minimalist service for handling streaming manifests
 * @ai-guide-responsibilities
 * - Processes manifest relationships for streaming videos
 */

import { parseHLSManifest, parseDASHManifest, detectPlaylistType } from '../popup/js/manifest-parser.js';

/**
 * Process video relationships (master-variants)
 * @param {Object} video - Video object to process
 * @returns {Promise<Object>} Updated video object with relationship info
 */
export async function processVideoRelationships(video) {
    if (!video || !video.url) {
        console.error('Invalid video object provided to processVideoRelationships');
        return video;
    }
    
    // For other types (direct media), just return the video as is
    return standardizeVideoObject(video, {}, {
        // Direct videos are fully processed after basic metadata extraction
        isLightParsed: true,
        isFullyParsed: true,
        needsPreview: !video.poster && !video.previewUrl
    });
}

/**
 * Helper to normalize URLs for comparison
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeUrl(url) {
    // Don't normalize blob URLs
    if (url.startsWith('blob:')) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        
        // Remove common parameters that don't affect the content
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        urlObj.searchParams.delete('_');
        urlObj.searchParams.delete('time');
        urlObj.searchParams.delete('timestamp');
        urlObj.searchParams.delete('random');
        
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
    }
}

/**
 * Standardize video object with consistent metadata and processing flags
 * @param {Object} video - Base video object
 * @param {Object} additionalInfo - Additional info to merge in
 * @param {Object} options - Options for standardization
 * @returns {Object} Standardized video object
 */
function standardizeVideoObject(video, additionalInfo = {}, options = {}) {
    // Start with base video or empty object
    const result = { ...video };
    
    // Merge in additional info, without overriding existing values unless specified
    Object.keys(additionalInfo).forEach(key => {
        // Skip certain fields that should be handled specifically
        if (['metadata', 'poster', 'previewUrl', 'variants'].includes(key)) return;
        
        // Use additionalInfo value if video doesn't have this property or override is specified
        if (result[key] === undefined || options.overrideExisting) {
            result[key] = additionalInfo[key];
        }
    });
    
    // Handle processing flags based on options
    result.isLightParsed = options.isLightParsed ?? result.isLightParsed ?? true;
    result.isFullyParsed = options.isFullyParsed ?? result.isFullyParsed ?? false;
    result.needsPreview = options.needsPreview ?? (!result.poster && !result.previewUrl);
    
    return result;
}