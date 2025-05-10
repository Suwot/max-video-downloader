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

import { parseHLSManifest, parseDASHManifest, detectPlaylistType } from '../popup/js/manifest-parser.js';

// Cache for master playlists and their variants
const masterPlaylistCache = new Map();
const manifestRelationshipCache = new Map();

/**
 * Fetch and parse a manifest file
 * @param {string} url - URL of the manifest
 * @param {string} type - 'hls' or 'dash'
 * @param {boolean} light - Whether to do light parsing only (just detect master/variant)
 * @returns {Promise<Object>} Parsed manifest
 */
export async function fetchAndParseManifest(url, type = 'auto', light = false) {
    // If light parsing is requested, use the light parser
    if (light) {
        return await lightParseManifest(url, type);
    }
    
    // Check cache for full parsed results
    const normalizedUrl = normalizeUrl(url);
    if (masterPlaylistCache.has(normalizedUrl)) {
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
    
    // Standardize and cache master playlists with variants
    if (manifestInfo && manifestInfo.isMasterPlaylist && manifestInfo.variants?.length > 0) {
        // Standardize variant info format
        const mappedVariants = manifestInfo.variants.map(v => ({
            url: v.url,
            width: v.width || (v.resolution ? parseInt(v.resolution.split('x')[0]) : null),
            height: v.height || (v.resolution ? parseInt(v.resolution.split('x')[1]) : null),
            fps: v.fps || v.frameRate,
            bandwidth: v.bandwidth,
            codecs: v.codecs
        }));
        
        const enhancedVideo = {
            url: url,
            type: type,
            isMasterPlaylist: true,
            variants: mappedVariants
        };
        
        // Store in cache
        masterPlaylistCache.set(normalizedUrl, enhancedVideo);
        
        // Store relationships for easier lookup
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
 * Light parse a manifest to detect if it's a master playlist without fetching the entire file
 * @param {string} url - URL of the manifest
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Object|null>} Basic manifest info or null if failed
 */
export async function lightParseManifest(url, type = 'auto') {
    const normalizedUrl = normalizeUrl(url);
    
    // Determine type if auto
    if (type === 'auto') {
        type = url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : 'unknown';
    }
    
    try {
        // Use fetch with a range request to get just the first part of the manifest
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // Try to fetch using Range header first, but be prepared to fall back to full fetch
        let response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Range': 'bytes=0-4095' // Get first 4KB for basic detection
            }
        });
        
        // Fall back to full fetch if Range isn't supported
        if (response.status === 416 || (response.status === 206 && parseInt(response.headers.get('content-length') || '0') < 100)) {
            response = await fetch(url, { signal: controller.signal });
        }
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return null;
        }
        
        const content = await response.text();
        
        // Basic parsing result structure
        const result = {
            url: url,
            type: type,
            isLightParsed: true
        };
        
        // HLS detection
        if (type === 'hls') {
            const playlistType = detectPlaylistType(content);
            return {
                ...result,
                isMasterPlaylist: playlistType.isMaster,
                isVariant: !playlistType.isMaster,
                confidence: playlistType.confidence,
                reasons: playlistType.reason || null
            };
        }
        
        // DASH detection
        if (type === 'dash') {
            const hasMasterElements = content.includes('<AdaptationSet') && 
                                     content.includes('<Representation');
            return {
                ...result,
                isMasterPlaylist: hasMasterElements,
                isVariant: !hasMasterElements
            };
        }
        
        return null;
    } catch (error) {
        console.error('Error in light parsing manifest:', error);
        return null;
    }
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
    
    // If already light parsed and role is determined, use that info
    if (video.isLightParsed && (video.isVariant || video.isMasterPlaylist)) {
        return video;
    }
    
    // Check cache for existing relationships
    const relationship = isVariantOfMasterPlaylist(normalizedUrl);
    if (relationship) {
        return {
            ...video,
            isVariant: true,
            isLightParsed: true,
            masterUrl: relationship.masterUrl
        };
    }
    
    // Check if it's a known master playlist
    if (isMasterPlaylist(normalizedUrl)) {
        return {
            ...video,
            ...masterPlaylistCache.get(normalizedUrl),
            isLightParsed: true
        };
    }
    
    // For HLS or DASH, use the two-stage parsing approach
    if ((video.type === 'hls' && video.url.includes('.m3u8')) || 
        (video.type === 'dash' && video.url.includes('.mpd'))) {
        
        try {
            // Stage 1: Light parsing
            const lightInfo = await lightParseManifest(video.url, video.type);
            
            if (lightInfo) {
                // Update video with light parsing results
                const updatedVideo = {
                    ...video,
                    ...lightInfo,
                    isLightParsed: true
                };
                
                // If it's a master playlist, do full parsing to get variants
                if (lightInfo.isMasterPlaylist) {
                    // Stage 2: Full parsing for master playlists
                    const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
                    if (fullInfo && fullInfo.variants?.length > 0) {
                        return {
                            ...updatedVideo,
                            ...fullInfo,
                            isFullyParsed: true
                        };
                    }
                }
                
                return updatedVideo;
            }
            
            // If light parsing failed, try full parsing
            const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
            if (fullInfo) {
                const result = {
                    ...video,
                    ...fullInfo,
                    isLightParsed: true,
                    isFullyParsed: true
                };
                
                if (fullInfo.isMasterPlaylist || (fullInfo.variants?.length > 0)) {
                    result.isMasterPlaylist = true;
                } else {
                    result.isVariant = true;
                }
                
                return result;
            }
        } catch (error) {
            console.error(`Error processing relationships for ${video.url}:`, error);
        }
    }
    
    return video;
}

// These functions have been consolidated into processVideoRelationships
// to simplify the flow with the new 2-stage parsing approach

/**
 * Estimate file size based on bitrate and duration
 * @param {number} bitrate - Bitrate in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number} Estimated file size in bytes
 */
function estimateFileSize(bitrate, duration) {
    if (!bitrate || !duration) return null;
    
    // Formula: (bitrate in bps * duration in seconds) / 8 = bytes
    return Math.round((bitrate * duration) / 8);
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        const response = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            signal: controller.signal,
            headers: {
                'Accept': '*/*'
            }
        });
        
        clearTimeout(timeoutId);
        
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

/**
 * Debug function to diagnose variant detection issues
 * @param {string} url - URL of the manifest to diagnose
 * @returns {Promise<Object>} Diagnostic information
 */
export async function diagnoseManifestVariants(url) {
    try {
        console.log(`[DIAGNOSIS] Starting manifest diagnosis for: ${url}`);
        
        // Step 1: Determine manifest type
        const type = url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : 'unknown';
        console.log(`[DIAGNOSIS] Manifest type: ${type}`);
        
        if (type === 'unknown') {
            return { error: 'Unknown manifest type' };
        }
        
        // Step 2: Light parsing
        console.log(`[DIAGNOSIS] Performing light parsing...`);
        const lightInfo = await lightParseManifest(url, type);
        let result = { type };
        
        if (lightInfo) {
            result.lightParse = {
                isMasterPlaylist: lightInfo.isMasterPlaylist,
                isVariant: lightInfo.isVariant
            };
        } else {
            console.log(`[DIAGNOSIS] Light parsing failed`);
        }
        
        // Step 3: Full parsing
        console.log(`[DIAGNOSIS] Performing full parsing...`);
        const fullInfo = await fetchAndParseManifest(url, type, false);
        
        if (fullInfo) {
            result.fullParse = {
                isMasterPlaylist: fullInfo.isMasterPlaylist,
                variants: fullInfo.variants?.length || 0
            };
        } else {
            console.log(`[DIAGNOSIS] Full parsing failed`);
        }
        
        // Step 4: Detailed parsing for debugging
        const content = await fetchManifestContent(url);
        if (content) {
            if (type === 'hls') {
                const streamInfMatches = content.match(/#EXT-X-STREAM-INF:/g);
                const streamInfCount = streamInfMatches ? streamInfMatches.length : 0;
                result.details = {
                    contentLength: content.length,
                    streamInfCount: streamInfCount
                };
            } else if (type === 'dash') {
                const representationMatches = content.match(/<Representation/g);
                const representationCount = representationMatches ? representationMatches.length : 0;
                result.details = {
                    contentLength: content.length,
                    representationCount: representationCount
                };
            }
        }
        
        return result;
    } catch (error) {
        console.error(`[DIAGNOSIS] Error: ${error.message}`);
        return { error: error.message };
    }
}