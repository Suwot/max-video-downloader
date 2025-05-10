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
    if (manifestInfo && manifestInfo.isMasterPlaylist && manifestInfo.variants && manifestInfo.variants.length > 0) {
        console.log(`[DEBUG] 📋 Full parse found ${manifestInfo.variants.length} variants for ${url}`);
        
        // Map variant info to a more standardized format
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
            variants: mappedVariants  // Use only variants as the single source of truth
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
 * Light parse a manifest to detect if it's a master playlist without fetching the entire file
 * @param {string} url - URL of the manifest
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Object|null>} Basic manifest info or null if failed
 */
export async function lightParseManifest(url, type = 'auto') {
    const normalizedUrl = normalizeUrl(url);
    
    console.log(`[DEBUG] 🔍 LIGHT PARSING started for ${url} (${type})`);
    
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
                'Range': 'bytes=0-4095' // Get first 4KB which is usually enough to determine manifest type
            }
        });
        
        // Some servers don't support Range requests, so if we get a 416 (Range Not Satisfiable)
        // or 206 (Partial Content) but with a very small response, try again without Range
        if (response.status === 416 || (response.status === 206 && parseInt(response.headers.get('content-length') || '0') < 100)) {
            console.log(`[DEBUG] ♻️ Range request failed for ${url}, falling back to full fetch`);
            response = await fetch(url, { signal: controller.signal });
        }
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.error('Failed to light parse manifest:', response.statusText);
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
            // Use the detectPlaylistType function directly
            const playlistType = detectPlaylistType(content);
            
            return {
                ...result,
                isMasterPlaylist: playlistType.isMaster,
                isVariant: !playlistType.isMaster,
                confidence: playlistType.confidence,
                reasons: playlistType.reason
            };
        }
        
        // DASH detection
        if (type === 'dash') {
            // For DASH, check for AdaptationSet and Representation tags
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
    
    // If already light parsed, use that information
    if (video.isLightParsed) {
        // If it's already identified as a variant or master, use that information
        if (video.isVariant || video.isMasterPlaylist) {
            return video;
        }
    }
    
    // Check if this is a variant of an existing master playlist
    const relationship = isVariantOfMasterPlaylist(normalizedUrl);
    if (relationship) {
        // This is a variant URL, mark it as such and add master reference
        return {
            ...video,
            isVariant: true,
            isLightParsed: true,
            masterUrl: relationship.masterUrl
        };
    }
    
    // If already a known master playlist, return as is
    if (isMasterPlaylist(normalizedUrl)) {
        return {
            ...video,
            ...masterPlaylistCache.get(normalizedUrl),
            isLightParsed: true
        };
    }
    
    // For HLS or DASH videos, use light parsing first to determine if it's a master or variant
    if ((video.type === 'hls' && video.url.includes('.m3u8')) || 
        (video.type === 'dash' && video.url.includes('.mpd'))) {
        
        try {
            // First try light parsing to determine master/variant status
            const lightInfo = await fetchAndParseManifest(video.url, video.type, true);
            
            if (lightInfo) {
                console.log(`[DEBUG] 🔍 LIGHT PARSING result for ${video.url}:`, 
                    JSON.stringify({
                        isMasterPlaylist: lightInfo.isMasterPlaylist,
                        isVariant: lightInfo.isVariant,
                        confidence: lightInfo.confidence
                    }));
                
                // Update video with light parsing results
                const updatedVideo = {
                    ...video,
                    ...lightInfo,
                    isLightParsed: true
                };
                
                // If it's a master playlist and we have enough info, return early
                if (lightInfo.isMasterPlaylist) {
                    // Master playlists need full parsing for variants
                    return await processMasterPlaylist(updatedVideo);
                }
                
                // For variants, we can return with just the light parsing
                if (lightInfo.isVariant) {
                    return updatedVideo;
                }
                
                return updatedVideo;
            }
            
            // If light parsing failed, fall back to full parsing
            const masterInfo = await fetchAndParseManifest(video.url, video.type);
            if (masterInfo) {
                if ((video.type === 'hls' && masterInfo.isMasterPlaylist) || 
                    (video.type === 'dash' && masterInfo.variants && masterInfo.variants.length > 0)) {
                    // It's a master playlist
                    return {
                        ...video,
                        ...masterInfo,
                        isLightParsed: true,
                        isFullyParsed: true,
                        isMasterPlaylist: true
                    };
                } else {
                    // It's a variant stream
                    return {
                        ...video,
                        ...masterInfo,
                        isLightParsed: true,
                        isFullyParsed: true,
                        isVariant: true
                    };
                }
            }
        } catch (error) {
            console.error(`Error processing relationships for ${video.url}:`, error);
        }
    }
    
    return video;
}

/**
 * Process a master playlist video to extract variants
 * @param {Object} video - Master playlist video object
 * @returns {Promise<Object>} Processed video with variants
 */
async function processMasterPlaylist(video) {
    // If it's already a known master playlist with variants, return as is
    if (video.isMasterPlaylist && video.variants?.length > 0) {
        console.log(`[DEBUG] Using existing variants for master playlist ${video.url}`, 
                   {variants: video.variants?.length || 0});
        return video;
    }
    
    try {
        console.log(`[DEBUG] 🔍 Performing FULL PARSING for master playlist ${video.url}`);
        // Do full parsing to extract variant information
        const masterInfo = await fetchAndParseManifest(video.url, video.type, false);
        
        if (masterInfo) {
            console.log(`[DEBUG] Full parse result:`, 
                      {hasVariants: !!(masterInfo.variants && masterInfo.variants.length > 0),
                       variantCount: masterInfo.variants?.length || 0});
                       
            if (masterInfo.variants && masterInfo.variants.length > 0) {
                // Create a complete master playlist object
                const result = {
                    ...video,
                    ...masterInfo,
                    isLightParsed: true,
                    isFullyParsed: true,
                    isMasterPlaylist: true,
                    variants: masterInfo.variants  // Use only variants
                };
                console.log(`[DEBUG] ✅ Successfully extracted ${masterInfo.variants.length} variants for ${video.url}`);
                return result;
            } else {
                console.warn(`[DEBUG] ⚠️ Full parsing did not return any variants for master playlist ${video.url}`);
            }
        } else {
            console.warn(`[DEBUG] ⚠️ Full parsing returned no result for ${video.url}`);
        }
    } catch (error) {
        console.error(`Error processing master playlist ${video.url}:`, error);
    }
    
    // If we couldn't get variants, just mark as master and return
    return {
        ...video,
        isLightParsed: true,
        isMasterPlaylist: true,
        variants: video.variants || [],
    };
}

/**
 * Process a variant stream to extract detailed metadata
 * @param {Object} video - Variant stream video object
 * @returns {Promise<Object>} Processed variant video
 */
async function processVariantStream(video) {
    if (video.isFullyParsed) return video;
    
    try {
        // Check if this variant is related to a master playlist
        const masterPlaylist = getMasterPlaylistForVariant(video.url);
        
        if (masterPlaylist) {
            // Extract variant-specific information from the master playlist
            const variants = masterPlaylist.variants || [];
            const matchingVariant = variants.find(v => normalizeUrl(v.url) === normalizeUrl(video.url));
            
            if (matchingVariant) {
                // Merge variant info from master playlist
                return {
                    ...video,
                    ...matchingVariant,
                    masterUrl: masterPlaylist.url,
                    isVariant: true,
                    isLightParsed: true,
                    isFullyParsed: true
                };
            }
        }
        
        // If no master info available, do full parsing on the variant itself
        const variantInfo = await fetchAndParseManifest(video.url, video.type);
        
        if (variantInfo) {
            return {
                ...video,
                ...variantInfo,
                isLightParsed: true,
                isFullyParsed: true,
                isVariant: true
            };
        }
    } catch (error) {
        console.error(`Error processing variant stream ${video.url}:`, error);
    }
    
    return {
        ...video,
        isLightParsed: true,
        isVariant: true
    };
}

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

/**
 * Debug function to diagnose variant detection issues
 * @param {string} url - URL of the manifest to diagnose
 * @returns {Promise<Object>} Diagnostic information
 */
export async function diagnoseManifestVariants(url) {
    try {
        console.log(`[DIAGNOSIS] 🔍 Starting manifest diagnosis for: ${url}`);
        
        // Step 1: Determine manifest type
        const type = url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : 'unknown';
        console.log(`[DIAGNOSIS] Manifest type: ${type}`);
        
        if (type === 'unknown') {
            return { error: 'Unknown manifest type' };
        }
        
        // Step 2: Check cache
        const normalizedUrl = normalizeUrl(url);
        if (masterPlaylistCache.has(normalizedUrl)) {
            const cached = masterPlaylistCache.get(normalizedUrl);
            console.log(`[DIAGNOSIS] Found in cache:`, {
                isMasterPlaylist: cached.isMasterPlaylist,
                variants: cached.variants?.length || 0
            });
        } else {
            console.log(`[DIAGNOSIS] Not found in cache`);
        }
        
        // Step 3: Fetch full manifest
        console.log(`[DIAGNOSIS] Fetching full manifest...`);
        const content = await fetchManifestContent(url);
        
        if (!content) {
            return { error: 'Failed to fetch manifest content' };
        }
        
        console.log(`[DIAGNOSIS] Received ${content.length} bytes of content`);
        
        // Step 4: Parse the manifest
        let result;
        if (type === 'hls') {
            // Display first 100 characters to verify format
            console.log(`[DIAGNOSIS] Content start: ${content.substring(0, 100).replace(/\n/g, '\\n')}`);
            
            // Count STREAM-INF tags
            const streamInfMatches = content.match(/#EXT-X-STREAM-INF:/g);
            const streamInfCount = streamInfMatches ? streamInfMatches.length : 0;
            console.log(`[DIAGNOSIS] STREAM-INF tags found: ${streamInfCount}`);
            
            // Parse using the same logic
            const parsed = parseHLSManifest(content, url);
            result = {
                type: 'hls',
                detectionResult: detectPlaylistType(content),
                parsed: parsed,
                variantCount: parsed.variants?.length || 0
            };
        } else if (type === 'dash') {
            // Display first 100 characters
            console.log(`[DIAGNOSIS] Content start: ${content.substring(0, 100).replace(/\n/g, '\\n')}`);
            
            // Count Representation tags
            const representationMatches = content.match(/<Representation/g);
            const representationCount = representationMatches ? representationMatches.length : 0;
            console.log(`[DIAGNOSIS] Representation tags found: ${representationCount}`);
            
            const parsed = parseDASHManifest(content, url);
            result = {
                type: 'dash',
                parsed: parsed,
                variantCount: parsed.variants?.length || 0
            };
        }
        
        console.log(`[DIAGNOSIS] 📊 Parse result:`, result);
        return result;
        
    } catch (error) {
        console.error(`[DIAGNOSIS] ❌ Error: ${error.message}`);
        return { error: error.message };
    }
}