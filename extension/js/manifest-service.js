/**
 * @ai-guide-component ManifestService
 * @ai-guide-description Centralized service for handling streaming manifests
 * @ai-guide-responsibilities
 * - Provides unified parsing for HLS and DASH manifests
 * - Manages master-variant relationships for streaming playlists
 * - Caches parsing results to prevent duplicate processing
 * - Coordinates manifest operations across background and popup contexts
 * - Exposes consistent API for all manifest operations
 */

import { parseHLSManifest, parseDASHManifest } from '../popup/js/manifest-parser.js';

// Cache for master playlists and their variants
const masterPlaylistCache = new Map();
const manifestRelationshipCache = new Map();
// Keep track of unclassified variants for later matching
const unclassifiedVariantsPool = new Map();

/**
 * Fetch and parse a manifest file
 * @param {string} url - URL of the manifest
 * @param {string} type - 'hls' or 'dash'
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Parsed manifest
 */
export async function fetchAndParseManifest(url, type = 'auto', options = {}) {
    // First check our cache
    const normalizedUrl = normalizeUrl(url);
    if (masterPlaylistCache.has(normalizedUrl)) {
        console.log('Using cached manifest for:', url);
        return masterPlaylistCache.get(normalizedUrl);
    }

    // Determine type if auto
    if (type === 'auto') {
        type = url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : 'unknown';
    }
    
    // Fetch manifest content
    const content = await fetchManifestContent(url);
    if (!content) return null;
    
    // Use the appropriate parser
    let manifestInfo = null;
    if (type === 'hls') {
        manifestInfo = parseHLSManifest(content, url);
    } else if (type === 'dash') {
        manifestInfo = parseDASHManifest(content, url);
    } else {
        console.error('Unknown manifest type:', type);
        return null;
    }
    
    // Process and store relationships if this is a master playlist
    if (manifestInfo && manifestInfo.isPlaylist && manifestInfo.variants && manifestInfo.variants.length > 0) {
        const enhancedVideo = {
            url: url,
            type: type,
            isPlaylist: true,
            isMasterPlaylist: true,
            // Add source information from options
            source: options.source || 'manifest',
            qualityVariants: manifestInfo.variants.map(v => ({
                url: v.url,
                width: v.width || (v.resolution ? parseInt(v.resolution.split('x')[0]) : null),
                height: v.height || (v.resolution ? parseInt(v.resolution.split('x')[1]) : null),
                fps: v.fps || v.frameRate,
                bandwidth: v.bandwidth,
                codecs: v.codecs,
                // Mark variants as coming from a manifest
                source: 'manifest'
            }))
        };
        
        // Store in master playlist cache
        masterPlaylistCache.set(normalizedUrl, enhancedVideo);
        
        // Store relationships and check for matches with unclassified variants
        manifestInfo.variants.forEach(variant => {
            const variantNormalizedUrl = normalizeUrl(variant.url);
            manifestRelationshipCache.set(variantNormalizedUrl, {
                masterUrl: url,
                masterNormalizedUrl: normalizedUrl,
                variant: variant,
                // Track the source of this relationship for deduplication purposes
                source: options.source || 'manifest'
            });
            
            // Check if this variant was previously detected as a standalone video
            if (unclassifiedVariantsPool.has(variantNormalizedUrl)) {
                const variantInfo = unclassifiedVariantsPool.get(variantNormalizedUrl);
                console.log(`Found match for previously unclassified variant: ${variantNormalizedUrl}`);
                // No need to keep it in the pool anymore since it's now properly classified
                unclassifiedVariantsPool.delete(variantNormalizedUrl);
            }
        });
        
        return enhancedVideo;
    }
    
    return manifestInfo;
}

/**
 * Check if a URL is a variant of a master playlist
 * @param {string} url - URL to check
 * @returns {Object|null} Relationship info or null
 */
export function isVariantOfMasterPlaylist(url) {
    const normalizedUrl = normalizeUrl(url);
    return manifestRelationshipCache.get(normalizedUrl) || null;
}

/**
 * Get all master playlists
 * @returns {Array} Array of master playlists
 */
export function getAllMasterPlaylists() {
    return Array.from(masterPlaylistCache.values());
}

/**
 * Get master playlist for a variant
 * @param {string} variantUrl - URL of the variant
 * @returns {Object|null} Master playlist or null
 */
export function getMasterPlaylistForVariant(variantUrl) {
    const relationship = isVariantOfMasterPlaylist(variantUrl);
    if (relationship) {
        return masterPlaylistCache.get(relationship.masterNormalizedUrl) || null;
    }
    return null;
}

/**
 * Check if a URL is a master playlist
 * @param {string} url - URL to check
 * @returns {boolean} Whether the URL is a master playlist
 */
export function isMasterPlaylist(url) {
    const normalizedUrl = normalizeUrl(url);
    return masterPlaylistCache.has(normalizedUrl);
}

/**
 * Process video to establish master-variant relationships
 * @param {Object} video - Video object
 * @returns {Promise<Object>} Processed video
 */
export async function processVideoRelationships(video) {
    if (!video || !video.url) return video;
    
    const normalizedUrl = normalizeUrl(video.url);
    
    // Check if this is a variant of an existing master playlist
    const relationship = isVariantOfMasterPlaylist(normalizedUrl);
    if (relationship) {
        // This is a variant URL, mark it as such and add master reference
        return {
            ...video,
            isVariant: true,
            masterUrl: relationship.masterUrl,
            // Track that this variant is grouped under a master
            groupedUnderMaster: true
        };
    }
    
    // If already a known master playlist, return as is
    if (isMasterPlaylist(normalizedUrl)) {
        return {
            ...video,
            ...masterPlaylistCache.get(normalizedUrl)
        };
    }
    
    // For HLS URLs, check if it might be a master playlist
    if (video.type === 'hls' && video.url.includes('.m3u8')) {
        try {
            // Pass the video source in options
            const masterInfo = await fetchAndParseManifest(video.url, 'hls', { 
                source: video.source || 'page' 
            });
            
            if (masterInfo && masterInfo.isPlaylist) {
                // It's a master playlist, enhance the video with this info
                return {
                    ...video,
                    ...masterInfo
                };
            } else {
                // Not a master playlist, might be a variant - add to unclassified pool
                addUnclassifiedVariant(video);
            }
        } catch (error) {
            console.error('Error checking for master playlist:', error);
            // Add to unclassified pool in case of error, might be a variant
            addUnclassifiedVariant(video);
        }
    }
    
    // For DASH URLs, similar check
    if (video.type === 'dash' && video.url.includes('.mpd')) {
        try {
            // Pass the video source in options
            const masterInfo = await fetchAndParseManifest(video.url, 'dash', {
                source: video.source || 'page'
            });
            
            if (masterInfo && masterInfo.variants && masterInfo.variants.length > 0) {
                return {
                    ...video,
                    isPlaylist: true,
                    qualityVariants: masterInfo.variants
                };
            } else {
                // Not a master playlist, might be a variant - add to unclassified pool
                addUnclassifiedVariant(video);
            }
        } catch (error) {
            console.error('Error checking for DASH manifest:', error);
            // Add to unclassified pool in case of error, might be a variant
            addUnclassifiedVariant(video);
        }
    }
    
    return video;
}

/**
 * Clear all caches
 */
export function clearCaches() {
    masterPlaylistCache.clear();
    manifestRelationshipCache.clear();
    unclassifiedVariantsPool.clear();
}

/**
 * Add a potential variant to the unclassified pool until it can be matched with a master
 * @param {Object} video - Video object containing variant information
 */
export function addUnclassifiedVariant(video) {
    if (!video || !video.url) return;
    
    // Only process HLS/DASH variants
    if (!(video.type === 'hls' && video.url.includes('.m3u8')) && 
        !(video.type === 'dash' && video.url.includes('.mpd'))) {
        return;
    }
    
    // Skip if already a known variant
    const normalizedUrl = normalizeUrl(video.url);
    if (manifestRelationshipCache.has(normalizedUrl)) {
        return;
    }
    
    // Skip if already in unclassified pool
    if (unclassifiedVariantsPool.has(normalizedUrl)) {
        return;
    }
    
    // Add to unclassified pool
    unclassifiedVariantsPool.set(normalizedUrl, {
        video: video,
        addedAt: Date.now(),
        normalizedUrl: normalizedUrl
    });
    
    console.log(`Added to unclassified variants pool: ${normalizedUrl}`);
}

/**
 * Check if URL is in the unclassified pool
 * @param {string} url - URL to check
 * @returns {boolean} Whether the URL is in the pool
 */
export function isInUnclassifiedPool(url) {
    const normalizedUrl = normalizeUrl(url);
    return unclassifiedVariantsPool.has(normalizedUrl);
}

/**
 * Get all unclassified variants
 * @returns {Array} Array of unclassified variants
 */
export function getUnclassifiedVariants() {
    return Array.from(unclassifiedVariantsPool.values());
}

/**
 * Helper to fetch manifest content
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Manifest content
 */
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            headers: {
                'Accept': '*/*'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
        }
        
        return await response.text();
    } catch (error) {
        console.error('Error fetching manifest:', error);
        return null;
    }
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
        
        // For HLS and DASH, keep a more canonical form
        if (url.includes('.m3u8') || url.includes('.mpd')) {
            // Remove common streaming parameters
            urlObj.searchParams.delete('seq');
            urlObj.searchParams.delete('segment');
            urlObj.searchParams.delete('session');
            urlObj.searchParams.delete('cmsid');
            
            // For manifest files, simply use the path for better duplicate detection
            if (url.includes('/manifest') || url.includes('/playlist') ||
                url.includes('/master.m3u8') || url.includes('/index.m3u8')) {
                return urlObj.origin + urlObj.pathname;
            }
        }
        
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
    }
}