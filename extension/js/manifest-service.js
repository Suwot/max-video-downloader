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

// Cache with expiration for manifest content
const manifestContentCache = new Map();
const CACHE_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get content from cache or fetch it
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Manifest content
 */
async function getManifestContent(url) {
    const normalizedUrl = normalizeUrl(url);
    const now = Date.now();
    
    // Check cache first
    if (manifestContentCache.has(normalizedUrl)) {
        const cacheEntry = manifestContentCache.get(normalizedUrl);
        // If not expired, use cached content
        if (now - cacheEntry.timestamp < CACHE_EXPIRATION_MS) {
            return cacheEntry.content;
        }
        // Otherwise remove expired entry
        manifestContentCache.delete(normalizedUrl);
    }
    
    // Fetch fresh content
    const content = await fetchManifestContent(url);
    if (content) {
        // Store in cache with timestamp
        manifestContentCache.set(normalizedUrl, {
            content,
            timestamp: now
        });
    }
    
    return content;
}

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
    
    // Fetch manifest content using the cached content manager
    const content = await getManifestContent(url);
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
        // Standardize variant info format with all available metadata
        const mappedVariants = manifestInfo.variants.map(v => {
            // Extract resolution from string if needed
            const width = v.width || (v.resolution ? parseInt(v.resolution.split('x')[0]) : null);
            const height = v.height || (v.resolution ? parseInt(v.resolution.split('x')[1]) : null);
            const bandwidth = v.bandwidth || null;
            const duration = v.duration || manifestInfo.metadata?.totalDuration || null;
            
            // Calculate estimated size if we have bandwidth and duration
            let estimatedSize = null;
            if (bandwidth && duration) {
                estimatedSize = estimateFileSize(bandwidth, duration);
            }
            
            return {
                url: v.url,
                width: width,
                height: height,
                resolution: width && height ? `${width}x${height}` : null,
                fps: v.fps || v.frameRate || null,
                bandwidth: bandwidth,
                bitrate: bandwidth ? Math.round(bandwidth / 1000) : null, // In kbps for readability
                codecs: v.codecs || null,
                duration: duration,
                estimatedSize: estimatedSize,
                mimeType: v.mimeType || null,
                format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null
            };
        });
        
        // Create standardized video object with complete metadata
        const enhancedVideo = {
            url: url,
            type: type,
            format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null,
            isMasterPlaylist: true,
            isVariant: false,
            isLightParsed: true,
            isFullyParsed: true,
            variants: mappedVariants,
            metadata: manifestInfo.metadata || null,
            confidence: manifestInfo.confidence || null
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
        // First check if we already have content in cache
        let content = null;
        const cachedContent = manifestContentCache.get(normalizedUrl);
        
        if (cachedContent && (Date.now() - cachedContent.timestamp < CACHE_EXPIRATION_MS)) {
            content = cachedContent.content;
        } else {
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
            
            content = await response.text();
            
            // Cache the content
            manifestContentCache.set(normalizedUrl, {
                content: content,
                timestamp: Date.now()
            });
        }
        
        // Basic parsing result structure with consistent property names
        const result = {
            url: url,
            type: type,
            format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null,
            isLightParsed: true,
            isFullyParsed: false
        };
        
        // HLS detection
        if (type === 'hls') {
            const playlistType = detectPlaylistType(content);
            return {
                ...result,
                isMasterPlaylist: playlistType.isMaster,
                isVariant: !playlistType.isMaster,
                confidence: playlistType.confidence,
                reasons: playlistType.reason || null,
                metadata: {
                    playlistType: playlistType.isMaster ? 'master' : 'variant'
                }
            };
        }
        
        // DASH detection
        if (type === 'dash') {
            const hasMasterElements = content.includes('<AdaptationSet') && 
                                     content.includes('<Representation');
            return {
                ...result,
                isMasterPlaylist: hasMasterElements,
                isVariant: !hasMasterElements,
                confidence: hasMasterElements ? 0.8 : 0.8, // Set confidence level
                metadata: {
                    playlistType: hasMasterElements ? 'master' : 'variant'
                }
            };
        }
        
        return null;
    } catch (error) {
        console.error('Error in light parsing manifest:', error);
        return null;
    }
}

/**
 * Helper to estimate file size based on bandwidth and duration
 * @param {number} bandwidth - Bandwidth in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number} Estimated file size in bytes
 */
function estimateFileSize(bandwidth, duration) {
    // Convert bandwidth from bits/second to bytes/second
    const bytesPerSecond = bandwidth / 8;
    // Account for container overhead (approximately 5-10%)
    const estimatedSize = bytesPerSecond * duration * 1.08;
    return Math.round(estimatedSize);
}

/**
 * Helper to format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size with appropriate unit
 */
function formatFileSize(bytes) {
    if (!bytes || isNaN(bytes)) return null;
    
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
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
 * Process video relationships (master-variants) using the 2-stage approach
 * @param {Object} video - Video object to process
 * @returns {Promise<Object>} Updated video object with relationship info
 */
export async function processVideoRelationships(video) {
    if (!video || !video.url) {
        console.error('Invalid video object provided to processVideoRelationships');
        return video;
    }
    
    const normalizedUrl = normalizeUrl(video.url);
    
    // If already processed, return the video as is
    if (video.isLightParsed && (video.isVariant || video.isMasterPlaylist)) {
        return video;
    }
    
    // First check if this is already known to be a variant
    const masterInfo = getMasterPlaylistForVariant(video.url);
    if (masterInfo) {
        // This is a known variant, link it to its master
        return {
            ...video,
            isVariant: true,
            isMasterPlaylist: false,
            masterUrl: masterInfo.masterUrl,
            masterInfo: masterInfo,
            isLightParsed: true,
            isFullyParsed: true,
            format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
        };
    }
    
    // Check if this is already a known master playlist
    if (isMasterPlaylist(video.url)) {
        const masterPlaylist = masterPlaylistCache.get(normalizedUrl);
        return {
            ...video,
            ...masterPlaylist,
            isMasterPlaylist: true,
            isVariant: false,
            isLightParsed: true,
            isFullyParsed: true,
            format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
        };
    }
    
    // For streaming formats, use the two-stage parsing approach
    if ((video.type === 'hls' && video.url.includes('.m3u8')) || 
        (video.type === 'dash' && video.url.includes('.mpd'))) {
        
        try {
            // Stage 1: Light parsing to determine if it's a master or variant
            const lightInfo = await lightParseManifest(video.url, video.type);
            
            if (lightInfo) {
                // If it's a master playlist, proceed to full parsing to get variants
                if (lightInfo.isMasterPlaylist) {
                    // Stage 2: Full parsing for master playlists
                    const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
                    if (fullInfo) {
                        // Return complete info with standardized structure
                        return {
                            ...video,
                            ...fullInfo,
                            isLightParsed: true,
                            isFullyParsed: true,
                            format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
                        };
                    }
                    
                    // If full parsing failed, use light parsing results
                    return {
                        ...video,
                        ...lightInfo,
                        isLightParsed: true,
                        isFullyParsed: false,
                        format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
                    };
                } else {
                    // For variants, light parsing is sufficient
                    return {
                        ...video,
                        ...lightInfo,
                        isVariant: true,
                        isMasterPlaylist: false,
                        isLightParsed: true,
                        isFullyParsed: false, // No full parsing needed for variants
                        format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
                    };
                }
            }
            
            // If light parsing failed, try full parsing as a fallback
            const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
            if (fullInfo) {
                return {
                    ...video,
                    ...fullInfo,
                    isLightParsed: true,
                    isFullyParsed: true,
                    format: video.type === 'hls' ? 'HLS' : video.type === 'dash' ? 'DASH' : null
                };
            }
        } catch (error) {
            console.error(`Error processing relationships for ${video.url}:`, error);
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
    manifestContentCache.clear();
}

/**
 * Helper to fetch manifest content with timeout and caching
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
        let result = { 
            url: url,
            type: type,
            format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null
        };
        
        if (lightInfo) {
            result.lightParse = {
                isMasterPlaylist: lightInfo.isMasterPlaylist,
                isVariant: lightInfo.isVariant,
                confidence: lightInfo.confidence || null,
                reasons: lightInfo.reasons || null,
                metadata: lightInfo.metadata || null
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
                isVariant: fullInfo.isVariant,
                variants: fullInfo.variants ? {
                    count: fullInfo.variants.length,
                    sample: fullInfo.variants.length > 0 ? fullInfo.variants[0] : null
                } : null,
                metadata: fullInfo.metadata || null,
                confidence: fullInfo.confidence || null
            };
        } else {
            console.log(`[DIAGNOSIS] Full parsing failed`);
        }
        
        // Step 4: Detailed parsing for debugging
        const content = await getManifestContent(url);
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

/**
 * Get variant options for a video URL
 * @param {string} url - URL of the master playlist
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Array>} Array of variant options
 */
export async function getVariantOptions(url, type = 'auto') {
    // Fully parse the manifest to get variants
    const manifestInfo = await fetchAndParseManifest(url, type, false);
    
    if (manifestInfo && manifestInfo.variants && manifestInfo.variants.length > 0) {
        return manifestInfo.variants.map(variant => {
            // Create a user-friendly label
            let label = '';
            if (variant.resolution) {
                label += variant.resolution;
            } else if (variant.width && variant.height) {
                label += `${variant.width}x${variant.height}`;
            }
            
            if (variant.bitrate) {
                label += label ? ` (${variant.bitrate} kbps)` : `${variant.bitrate} kbps`;
            }
            
            if (!label && variant.bandwidth) {
                label = `${Math.round(variant.bandwidth / 1000)} kbps`;
            }
            
            if (!label) {
                label = 'Unknown quality';
            }
            
            // Include estimated file size if available
            if (variant.estimatedSize) {
                label += ` - ${formatFileSize(variant.estimatedSize)}`;
            }
            
            return {
                url: variant.url,
                label: label,
                resolution: variant.resolution || null,
                width: variant.width || null,
                height: variant.height || null,
                bitrate: variant.bitrate || null,
                estimatedSize: variant.estimatedSize || null,
                formatSize: variant.estimatedSize ? formatFileSize(variant.estimatedSize) : null,
                codecs: variant.codecs || null,
                format: variant.format || manifestInfo.format || null
            };
        });
    }
    
    return [];
}

/**
 * Get best quality variant for a video URL
 * @param {string} url - URL of the master playlist
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Object>} Best quality variant
 */
export async function getBestQualityVariant(url, type = 'auto') {
    const variants = await getVariantOptions(url, type);
    
    if (variants.length === 0) {
        return null;
    }
    
    // Sort by resolution height (higher is better)
    return variants.sort((a, b) => {
        // First by height (resolution)
        if (a.height && b.height) {
            return b.height - a.height;
        }
        
        // Then by bitrate
        if (a.bitrate && b.bitrate) {
            return b.bitrate - a.bitrate;
        }
        
        return 0;
    })[0];
}