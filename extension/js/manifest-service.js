/**
 * @ai-guide-component ManifestService
 * @ai-guide-description Centralized service for handling streaming manifests
 * @ai-guide-responsibilities
 * - Provides unified parsing for HLS and DASH manifests
 * - Manages master-variant relationships directly within master playlist objects
 * - Caches parsing results to prevent duplicate processing
 * - Coordinates manifest operations across background and popup contexts
 * - Exposes consistent API for all manifest operations
 */

import { parseHLSManifest, parseDASHManifest, detectPlaylistType } from '../popup/js/manifest-parser.js';

// Cache for master playlists (which contain their variants directly)
const masterPlaylistCache = new Map();

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
    
    try {
        // Use fetch with a range request to get just the first part of the manifest
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // Try to fetch using Range header first, but be prepared to fall back to full fetch
        let response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Range': 'bytes=0-4095' // Get first 4KB for basic detection
            },
            credentials: 'include',
            mode: 'cors'
        });
        
        // Fall back to full fetch if Range isn't supported
        if (response.status === 416 || (response.status === 206 && parseInt(response.headers.get('content-length') || '0') < 100)) {
            response = await fetch(url, { 
                signal: controller.signal,
                credentials: 'include',
                mode: 'cors',
                headers: {
                    'Accept': '*/*'
                }
            });
        }
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.error(`Error fetching manifest: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const content = await response.text();
        
        // Cache the content
        manifestContentCache.set(normalizedUrl, {
            content,
            timestamp: now
        });
        
        return content;
    } catch (error) {
        console.error('Error fetching manifest content:', error);
        return null;
    }
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
    
    try {
        // Fetch manifest content using the cached content manager
        const content = await getManifestContent(url);
        if (!content) {
            console.error(`Failed to fetch manifest content for ${url}`);
            return null;
        }
        
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
        
        if (!manifestInfo) {
            console.error(`Failed to parse ${type} manifest for ${url}`);
            return null;
        }
        
        // Standardize and cache master playlists with variants
        if (manifestInfo.isMasterPlaylist && manifestInfo.variants?.length > 0) {
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
            
            // Create enhanced metadata with counts and quality info
            const metadata = {
                ...(manifestInfo.metadata || {}),
                playlistType: 'master',
                container: type === 'hls' ? 'Apple HTTP Live Streaming' : 'MPEG-DASH',
                variantCount: mappedVariants.length,
                hasBandwidthInfo: mappedVariants.some(v => v.bandwidth !== null)
            };
            
            // Add quality range information if available
            const heightsAvailable = mappedVariants
                .map(v => v.height)
                .filter(Boolean)
                .sort((a, b) => a - b);
                
            if (heightsAvailable.length > 0) {
                metadata.lowestQuality = heightsAvailable[0];
                metadata.highestQuality = heightsAvailable[heightsAvailable.length - 1];
                metadata.qualityLevels = [...new Set(heightsAvailable)].length;
            }
            
            // Create standardized video object with complete metadata
            const enhancedVideo = standardizeVideoObject({
                url: url,
                type: type,
                isMasterPlaylist: true,
                isVariant: false,
                variants: mappedVariants,
                metadata: metadata,
                confidence: manifestInfo.confidence || 0.9
            }, {}, {
                isLightParsed: true,
                isFullyParsed: true,
                needsMetadata: false,
                needsPreview: manifestInfo.needsPreview !== false // Default to true unless explicitly false
            });
            
            // Store in cache - the variants are already included directly in the enhancedVideo object
            masterPlaylistCache.set(normalizedUrl, enhancedVideo);
            
            return enhancedVideo;
        }
        
        // For non-master playlists or those without variants
        return standardizeVideoObject({
            url: url,
            type: type,
            isMasterPlaylist: manifestInfo.isMasterPlaylist === true,
            isVariant: manifestInfo.isVariant === true,
            metadata: manifestInfo.metadata || {},
            confidence: manifestInfo.confidence || 0.8
        }, {}, {
            isLightParsed: true,
            isFullyParsed: true
        });
    } catch (error) {
        console.error(`Error in fetchAndParseManifest for ${url}:`, error);
        return null;
    }
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
            // Use getManifestContent helper to fetch and cache content
            content = await getManifestContent(url);
            
            if (!content) {
                console.error(`Failed to fetch manifest content for ${url}`);
                return null;
            }
        }
        
        // Basic parsing result structure
        const result = {
            url: url,
            type: type,
            format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null,
            isLightParsed: true,
            isFullyParsed: false
        };
        
        // Prepare metadata object with common fields
        const metadata = {
            container: type === 'hls' ? 'Apple HTTP Live Streaming' : 
                      type === 'dash' ? 'MPEG-DASH' : null
        };
        
        // HLS detection
        if (type === 'hls') {
            const playlistType = detectPlaylistType(content);
            
            // Add HLS-specific metadata fields
            metadata.playlistType = playlistType.isMaster ? 'master' : 'variant';
            
            // Extract version information
            const versionMatch = content.match(/#EXT-X-VERSION:(\d+)/);
            if (versionMatch) metadata.version = parseInt(versionMatch[1]);
            
            // For variant playlists, extract additional metadata
            if (!playlistType.isMaster) {
                const targetDurationMatch = content.match(/#EXT-X-TARGETDURATION:(\d+)/);
                if (targetDurationMatch) metadata.targetDuration = parseInt(targetDurationMatch[1]);
                
                const mediaSequenceMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                if (mediaSequenceMatch) metadata.mediaSequence = parseInt(mediaSequenceMatch[1]);
                
                // Attempt to get playlist type (VOD/LIVE/EVENT)
                const playlistTypeMatch = content.match(/#EXT-X-PLAYLIST-TYPE:([^\r\n]+)/);
                if (playlistTypeMatch) metadata.streamType = playlistTypeMatch[1].trim();
                
                // Count segments to provide approximate segment count
                const segmentCount = (content.match(/#EXTINF:/g) || []).length;
                if (segmentCount > 0) metadata.segmentCount = segmentCount;
                
                // Estimate total duration from segments if targetDuration is known
                if (metadata.targetDuration && metadata.segmentCount) {
                    metadata.estimatedDuration = metadata.targetDuration * metadata.segmentCount;
                }
            } else {
                // For master playlists, count variants
                const variantCount = (content.match(/#EXT-X-STREAM-INF:/g) || []).length;
                if (variantCount > 0) metadata.variantCount = variantCount;
            }
            
            // Create standardized result object
            return standardizeVideoObject({
                url,
                type,
                isMasterPlaylist: playlistType.isMaster,
                isVariant: !playlistType.isMaster,
                confidence: playlistType.confidence,
                reasons: playlistType.reason || null,
                metadata,
                isLightParsed: true,
                isFullyParsed: false
            });
        }
        
        // DASH detection
        if (type === 'dash') {
            const hasMasterElements = content.includes('<AdaptationSet') && 
                                     content.includes('<Representation');
            
            // Add DASH-specific metadata fields
            metadata.playlistType = hasMasterElements ? 'master' : 'variant';
            
            // Extract DASH version
            const mpdMatch = content.match(/<MPD[^>]*version="([^"]+)"/);
            if (mpdMatch) metadata.version = mpdMatch[1];
            
            // Extract duration if available
            const durationMatch = content.match(/mediaPresentationDuration="PT([^"]+)"/);
            if (durationMatch) {
                const durationStr = durationMatch[1];
                let totalSeconds = 0;
                
                // Parse ISO 8601 duration format more comprehensively
                if (durationStr.includes('H')) {
                    const hours = parseFloat(durationStr.split('H')[0].replace('PT', ''));
                    totalSeconds += hours * 3600;
                    
                    // Check for minutes after hours
                    if (durationStr.includes('M')) {
                        const minutesPart = durationStr.split('H')[1];
                        const minutes = parseFloat(minutesPart.split('M')[0]);
                        totalSeconds += minutes * 60;
                    }
                    
                    // Check for seconds after hours/minutes
                    if (durationStr.includes('S')) {
                        const secondsPart = durationStr.includes('M') ? 
                            durationStr.split('M')[1] : durationStr.split('H')[1];
                        const seconds = parseFloat(secondsPart.split('S')[0]);
                        totalSeconds += seconds;
                    }
                } else if (durationStr.includes('M')) {
                    const minutes = parseFloat(durationStr.split('M')[0].replace('PT', ''));
                    totalSeconds += minutes * 60;
                    
                    // Check for seconds after minutes
                    if (durationStr.includes('S')) {
                        const seconds = parseFloat(durationStr.split('M')[1].split('S')[0]);
                        totalSeconds += seconds;
                    }
                } else if (durationStr.includes('S')) {
                    const seconds = parseFloat(durationStr.split('S')[0].replace('PT', ''));
                    totalSeconds += seconds;
                }
                
                metadata.totalDuration = totalSeconds;
            }
            
            // Count representations for master playlists
            if (hasMasterElements) {
                const representationCount = (content.match(/<Representation/g) || []).length;
                if (representationCount > 0) metadata.variantCount = representationCount;
            }
            
            // Create standardized result object
            return standardizeVideoObject({
                url,
                type,
                isMasterPlaylist: hasMasterElements,
                isVariant: !hasMasterElements,
                confidence: hasMasterElements ? 0.9 : 0.8,
                metadata,
                isLightParsed: true,
                isFullyParsed: false
            });
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
    
    // Check all master playlists to see if any contain this URL as a variant
    for (const [masterNormalizedUrl, masterPlaylist] of masterPlaylistCache.entries()) {
        if (masterPlaylist.variants && Array.isArray(masterPlaylist.variants)) {
            const variant = masterPlaylist.variants.find(v => normalizeUrl(v.url) === normalizedUrl);
            if (variant) {
                return {
                    masterUrl: masterPlaylist.url,
                    masterNormalizedUrl: masterNormalizedUrl,
                    variant: variant
                };
            }
        }
    }
    
    return null;
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
        // But mark it as needing full parsing - this is key to ensuring full metadata
        return standardizeVideoObject(video, {
            isVariant: true,
            isMasterPlaylist: false,
            masterUrl: masterInfo.masterUrl,
            masterInfo: masterInfo,
            needsFullParsing: true // Add flag to indicate we want full parsing
        }, {
            isLightParsed: true,
            isFullyParsed: false, // Mark as NOT fully parsed so it gets full metadata
            needsMetadata: true   // Always get metadata for variants
        });
    }
    
    // Check if this is already a known master playlist
    if (isMasterPlaylist(video.url)) {
        const masterPlaylist = masterPlaylistCache.get(normalizedUrl);
        return standardizeVideoObject(video, masterPlaylist, {
            isMasterPlaylist: true,
            isVariant: false,
            isLightParsed: true,
            isFullyParsed: true
        });
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
                        return standardizeVideoObject(video, fullInfo, {
                            isLightParsed: true,
                            isFullyParsed: true,
                            needsMetadata: false,
                            // Only needs preview if we don't have one
                            needsPreview: !video.poster && !fullInfo.poster
                        });
                    }
                    
                    // If full parsing failed, use light parsing results
                    return standardizeVideoObject(video, lightInfo, {
                        isLightParsed: true,
                        isFullyParsed: false,
                        needsMetadata: true,  // Still needs full metadata
                        processed: false      // Not fully processed
                    });
                } else {
                    // Fully parse variant playlists too, to get complete metadata
                    const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
                    if (fullInfo) {
                        return standardizeVideoObject(video, fullInfo, {
                            isVariant: true,
                            isMasterPlaylist: false,
                            isLightParsed: true,
                            isFullyParsed: true,
                            needsMetadata: false
                        });
                    } else {
                        // Fallback to light parsing if full parsing fails
                        return standardizeVideoObject(video, lightInfo, {
                            isVariant: true,
                            isMasterPlaylist: false,
                            isLightParsed: true,
                            isFullyParsed: false,
                            needsMetadata: true  // Flag that it needs metadata
                        });
                    }
                }
            }
            
            // If light parsing failed, try full parsing as a fallback
            const fullInfo = await fetchAndParseManifest(video.url, video.type, false);
            if (fullInfo) {
                return standardizeVideoObject(video, fullInfo, {
                    isLightParsed: true,
                    isFullyParsed: true
                });
            }
        } catch (error) {
            console.error(`Error processing relationships for ${video.url}:`, error);
        }
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
 * Clear all caches
 */
export function clearCaches() {
    masterPlaylistCache.clear();
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
        
        // Get cache state
        const normalizedUrl = normalizeUrl(url);
        const isCached = manifestContentCache.has(normalizedUrl);
        const isMasterCached = masterPlaylistCache.has(normalizedUrl);
        
        // Step 2: Light parsing
        console.log(`[DIAGNOSIS] Performing light parsing...`);
        const lightInfo = await lightParseManifest(url, type);
        let result = { 
            url: url,
            normalizedUrl: normalizedUrl,
            type: type,
            format: type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : null,
            cacheStatus: {
                contentCached: isCached,
                masterPlaylistCached: isMasterCached
            }
        };
        
        if (lightInfo) {
            result.lightParse = {
                isMasterPlaylist: lightInfo.isMasterPlaylist,
                isVariant: lightInfo.isVariant,
                confidence: lightInfo.confidence || null,
                reasons: lightInfo.reasons || null,
                metadata: lightInfo.metadata || null,
                isLightParsed: lightInfo.isLightParsed || false,
                isFullyParsed: lightInfo.isFullyParsed || false,
                processed: lightInfo.processed || false
            };
        } else {
            console.log(`[DIAGNOSIS] Light parsing failed`);
            result.lightParse = { error: 'Light parsing failed' };
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
                    sampleUrls: fullInfo.variants.slice(0, 3).map(v => v.url),
                    sample: fullInfo.variants.length > 0 ? 
                        Object.fromEntries(
                            Object.entries(fullInfo.variants[0])
                            .filter(([key]) => !key.includes('url'))
                        ) : null
                } : null,
                metadata: fullInfo.metadata || null,
                confidence: fullInfo.confidence || null,
                isLightParsed: fullInfo.isLightParsed || false,
                isFullyParsed: fullInfo.isFullyParsed || false,
                processed: fullInfo.processed || false
            };
        } else {
            console.log(`[DIAGNOSIS] Full parsing failed`);
            result.fullParse = { error: 'Full parsing failed' };
        }
        
        // Step 4: Detailed parsing for debugging
        const content = await getManifestContent(url);
        if (content) {
            const contentExcerpt = content.substring(0, 500) + '...';
            
            if (type === 'hls') {
                const streamInfMatches = content.match(/#EXT-X-STREAM-INF:/g);
                const streamInfCount = streamInfMatches ? streamInfMatches.length : 0;
                
                const extinf = content.match(/#EXTINF:/g);
                const extinfCount = extinf ? extinf.length : 0;
                
                const keyDirective = content.includes('#EXT-X-KEY');
                const version = content.match(/#EXT-X-VERSION:(\d+)/);
                
                result.details = {
                    contentLength: content.length,
                    contentExcerpt: contentExcerpt,
                    streamInfCount: streamInfCount,
                    segmentCount: extinfCount,
                    hasEncryption: keyDirective,
                    version: version ? parseInt(version[1]) : null,
                    isMultivariant: streamInfCount > 0,
                    isSegmented: extinfCount > 0
                };
            } else if (type === 'dash') {
                const representationMatches = content.match(/<Representation/g);
                const representationCount = representationMatches ? representationMatches.length : 0;
                
                const adaptationSetMatches = content.match(/<AdaptationSet/g);
                const adaptationSetCount = adaptationSetMatches ? adaptationSetMatches.length : 0;
                
                const segmentMatches = content.match(/<Segment/g) || content.match(/<SegmentTemplate/g);
                const segmentCount = segmentMatches ? segmentMatches.length : 0;
                
                result.details = {
                    contentLength: content.length,
                    contentExcerpt: contentExcerpt,
                    adaptationSetCount: adaptationSetCount,
                    representationCount: representationCount,
                    segmentCount: segmentCount,
                    isMultivariant: representationCount > 1,
                    isMultiAdaptation: adaptationSetCount > 1
                };
            }
        }
        
        // Step 5: Check for known relationship in cache
        const knownMaster = getMasterPlaylistForVariant(url);
        if (knownMaster) {
            result.relationships = {
                isKnownVariant: true,
                masterUrl: knownMaster.url,
                variantCount: knownMaster.variants?.length || 0
            };
        } else if (isMasterPlaylist(url)) {
            const master = masterPlaylistCache.get(normalizedUrl);
            result.relationships = {
                isKnownMaster: true,
                variantCount: master.variants?.length || 0,
                variantUrls: master.variants?.slice(0, 3).map(v => v.url) || []
            };
        }
        
        return result;
    } catch (error) {
        console.error(`[DIAGNOSIS] Error: ${error.message}`);
        return { error: error.message, stack: error.stack };
    }
}

/**
 * Get variant options for a video URL
 * @param {string} url - URL of the master playlist
 * @param {string} type - 'hls' or 'dash'
 * @returns {Promise<Array>} Array of variant options
 */
export async function getVariantOptions(url, type = 'auto') {
    try {
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
                
                // First try to get the full variant info via a dedicated fetch
                // This ensures each variant has its own complete metadata
                const variantInfo = {
                    url: variant.url,
                    label: label,
                    resolution: variant.resolution || null,
                    width: variant.width || null,
                    height: variant.height || null,
                    bitrate: variant.bitrate || null,
                    estimatedSize: variant.estimatedSize || null,
                    formatSize: variant.estimatedSize ? formatFileSize(variant.estimatedSize) : null,
                    codecs: variant.codecs || null,
                    format: variant.format || manifestInfo.format || null,
                    type: manifestInfo.type,
                    isVariant: true,
                    isMasterPlaylist: false,
                    masterUrl: url,
                    // Add reference to ensure we have a link back to the master
                    masterInfo: {
                        masterUrl: url,
                        masterType: manifestInfo.type
                    }
                };
                
                // Mark it as ready for full parsing and metadata
                return standardizeVideoObject(variantInfo, {
                    // Required for backend integration
                    needsMetadata: true,
                    needsFullParsing: true,
                }, {
                    isLightParsed: true,
                    isFullyParsed: false, // Set to false to ensure it gets fully parsed
                    needsMetadata: true,  // Mark that it needs full metadata
                });
            });
        }
        
        // For single-variant videos, return the source as the only option
        if (manifestInfo) {
            return [{
                url: url,
                label: 'Original quality',
                resolution: manifestInfo.resolution || null,
                width: manifestInfo.width || (manifestInfo.metadata?.width || null),
                height: manifestInfo.height || (manifestInfo.metadata?.height || null),
                bitrate: manifestInfo.bitrate || (manifestInfo.metadata?.bitrate || null),
                format: manifestInfo.format || null,
                type: manifestInfo.type
            }];
        }
        
        return [];
    } catch (error) {
        console.error(`Error getting variant options for ${url}:`, error);
        return [];
    }
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
    
    // Handle format field consistently
    if (!result.format) {
        result.format = result.type === 'hls' ? 'HLS' : 
                       result.type === 'dash' ? 'DASH' : null;
    }
    
    // Merge metadata properly, preserving original manifest metadata
    // Note: ffprobe data will take priority later in video-manager.js
    result.metadata = {
        ...(additionalInfo.metadata || {}),
        ...(result.metadata || {})
    };
    
    // If we have mediaInfo from ffprobe, it takes precedence over manifest metadata
    if (!result.mediaInfo && result.metadata) {
        result.mediaInfo = { ...result.metadata };
    } else if (result.mediaInfo && result.metadata) {
        // Store manifest metadata separately for reference
        result.manifestMetadata = { ...result.metadata };
    }
    
    // Ensure correct processing flags for variants - this is key to fixing the issue
    if (result.isVariant) {
        // For variants, ensure flags are correctly set to trigger full metadata fetching
        if (options.needsMetadata !== false) {
            result.needsMetadata = true;
        }
        
        // Only set isFullyParsed=false for variants to ensure they get full metadata
        if (options.isFullyParsed === undefined) {
            result.isFullyParsed = false;
        } else {
            result.isFullyParsed = options.isFullyParsed;
        }
        
        // Set flag to request full parsing for all variants
        result.needsFullParsing = true;
    }
    
    // Ensure metadata includes playlistType if we have master/variant info
    if (!result.metadata.playlistType) {
        if (result.isMasterPlaylist) {
            result.metadata.playlistType = 'master';
        } else if (result.isVariant) {
            result.metadata.playlistType = 'variant';
        }
    }
    
    // Ensure playlist type and master/variant flags are consistent
    if (result.metadata.playlistType === 'master') {
        result.isMasterPlaylist = true;
        result.isVariant = false;
    } else if (result.metadata.playlistType === 'variant') {
        result.isMasterPlaylist = false;
        result.isVariant = true;
    }
    
    // Handle container type if available
    if (!result.metadata.container) {
        if (result.type === 'hls') {
            result.metadata.container = 'Apple HTTP Live Streaming';
        } else if (result.type === 'dash') {
            result.metadata.container = 'MPEG-DASH';
        }
    }
    
    // Merge variants lists if both exist, with result.variants taking precedence
    if (additionalInfo.variants && additionalInfo.variants.length > 0) {
        if (!result.variants || result.variants.length === 0) {
            result.variants = [...additionalInfo.variants];
        } else {
            // Merge by URL to avoid duplicates
            const variantMap = new Map();
            
            // Add existing variants first
            result.variants.forEach(v => {
                variantMap.set(normalizeUrl(v.url), v);
            });
            
            // Add additional variants if not already present
            additionalInfo.variants.forEach(v => {
                const normalizedVariantUrl = normalizeUrl(v.url);
                if (!variantMap.has(normalizedVariantUrl)) {
                    variantMap.set(normalizedVariantUrl, v);
                }
            });
            
            result.variants = Array.from(variantMap.values());
        }
        
        // Update metadata with variant count
        if (result.isMasterPlaylist && result.variants.length > 0) {
            result.metadata.variantCount = result.variants.length;
        }
    }
    
    // Handle image fields
    const poster = options.poster || video.poster || additionalInfo.poster || null;
    const previewUrl = options.previewUrl || video.previewUrl || additionalInfo.previewUrl || poster;
    
    result.poster = poster;
    result.previewUrl = previewUrl;
    
    // Set processing flags based on the information we have
    result.isLightParsed = options.isLightParsed ?? result.isLightParsed ?? true;
    result.isFullyParsed = options.isFullyParsed ?? result.isFullyParsed ?? false;
    
    // Determine if metadata is needed
    result.needsMetadata = options.needsMetadata ?? (
        // Default logic: needs metadata if it's a master playlist that isn't fully parsed
        (result.isMasterPlaylist && !result.isFullyParsed) || 
        // Or if metadata is missing critical fields
        !result.metadata || 
        Object.keys(result.metadata).length === 0
    );
    
    // Determine if preview is needed
    result.needsPreview = options.needsPreview ?? (!poster && !previewUrl);
    
    // Determine overall processed state
    // Fully processed means: light parsed, (fully parsed if master), and has preview if needed
    result.processed = options.processed ?? (
        result.isLightParsed && 
        (!result.isMasterPlaylist || result.isFullyParsed) && 
        (!result.needsPreview)
    );
    
    return result;
}