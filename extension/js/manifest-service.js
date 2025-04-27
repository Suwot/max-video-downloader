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

/**
 * Fetch and parse a manifest file
 * @param {string} url - URL of the manifest
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Object>} Parsed manifest
 */
export async function fetchAndParseManifest(url, type = 'auto') {
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
            qualityVariants: manifestInfo.variants.map(v => ({
                url: v.url,
                width: v.width || (v.resolution ? parseInt(v.resolution.split('x')[0]) : null),
                height: v.height || (v.resolution ? parseInt(v.resolution.split('x')[1]) : null),
                fps: v.fps || v.frameRate,
                bandwidth: v.bandwidth,
                codecs: v.codecs
            }))
        };
        
        // Store in master playlist cache
        masterPlaylistCache.set(normalizedUrl, enhancedVideo);
        
        // Store relationships
        manifestInfo.variants.forEach(variant => {
            const variantNormalizedUrl = normalizeUrl(variant.url);
            manifestRelationshipCache.set(variantNormalizedUrl, {
                masterUrl: url,
                masterNormalizedUrl: normalizedUrl,
                variant: variant
            });
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
            masterUrl: relationship.masterUrl
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
            const masterInfo = await fetchAndParseManifest(video.url, 'hls');
            if (masterInfo && masterInfo.isPlaylist) {
                // It's a master playlist, enhance the video with this info
                return {
                    ...video,
                    ...masterInfo
                };
            }
        } catch (error) {
            console.error('Error checking for master playlist:', error);
        }
    }
    
    // For DASH URLs, similar check
    if (video.type === 'dash' && video.url.includes('.mpd')) {
        try {
            const masterInfo = await fetchAndParseManifest(video.url, 'dash');
            if (masterInfo && masterInfo.variants && masterInfo.variants.length > 0) {
                return {
                    ...video,
                    isPlaylist: true,
                    qualityVariants: masterInfo.variants
                };
            }
        } catch (error) {
            console.error('Error checking for DASH manifest:', error);
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