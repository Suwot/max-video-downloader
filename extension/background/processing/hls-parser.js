/**
 * HLS Parser
 * Pure JavaScript-based parsing of HLS manifests without FFprobe
 * Provides lightweight and full parsing capabilities for HLS content
 */

import { 
    normalizeUrl,
    processingRequests,
    calculateEstimatedFileSizeBytes,
    resolveUrl,
    getBaseDirectory,
    fetchManifest,
    validateManifestType
} from './parser-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { getVideoByUrl } from './video-store.js';
import { standardizeResolution } from '../../shared/utils/video-utils.js';

// Create a logger for the HLS parser
const logger = createLogger('HLS Parser');

/**
 * Parse an HLS variant playlist to extract full metadata
 * @param {string} variantUrl - URL of the HLS variant playlist
 * @param {Object} [headers] - Optional headers to use for the request
 * @returns {Promise<Object>} - Complete variant metadata
 */
async function parseHlsVariant(variantUrl, headers = null, tabId) {
    try {
        logger.debug(`Fetching variant: ${variantUrl} with headers:`, headers);
        
        // Use the unified fetchManifest function with retry logic
        const fetchResult = await fetchManifest(variantUrl, {
            headers,
            timeoutMs: 10000,
            maxRetries: 2,
            tabId: tabId
        });
        
        if (!fetchResult.ok) {
            logger.warn(`❌ Failed fetching variant ${variantUrl}: ${fetchResult.status}`);
            return { 
                duration: null, 
                isLive: true,
                segmentCount: null,
                isEncrypted: false,
                encryptionType: null,
                retryCount: fetchResult.retryCount || 0
            };
        }
        
        const content = fetchResult.content;
        logger.debug(`Received variant playlist (${content.length} bytes)`);
        
        if (content.length === 0) {
            logger.warn(`Empty response for variant ${variantUrl}`);
            return { 
                duration: null, 
                isLive: true,
                segmentCount: null,
                isEncrypted: false,
                encryptionType: null
            };
        }
        
        // Extract different types of metadata from variant playlist
        const durationInfo = calculateHlsVariantDuration(content);
        logger.debug(`Variant duration info: ${JSON.stringify(durationInfo)}`);
        
        const encryptionInfo = extractHlsEncryptionInfo(content);
        logger.debug(`Variant encryption info: ${JSON.stringify(encryptionInfo)}`);

        // Extract HLS version
        const version = extractHlsVersion(content);
        logger.debug(`Variant version: ${version}`);
        
        // Build a complete result object
        const result = {
            duration: durationInfo.duration,
            isLive: durationInfo.isLive,
            segmentCount: durationInfo.segmentCount,
            isEncrypted: encryptionInfo.isEncrypted,
            encryptionType: encryptionInfo.isEncrypted ? encryptionInfo.encryptionType : null,
            version: version
        };

        logger.debug(`Complete variant info: ${JSON.stringify(result)}`);
        return result;
    } catch (error) {
        logger.error(`❌ ERROR parsing variant ${variantUrl}: ${error.message}`);
        // Return complete object with defaults
        return { 
            duration: null, 
            isLive: true,
            segmentCount: null,
            isEncrypted: false,
            encryptionType: null
        };
    }
}

/**
 * Calculate the duration of an HLS variant playlist by summing segment durations
 * Also counts the total number of segments
 * @param {string} content - The playlist content 
 * @returns {Object} - Duration information and segment count
 */
function calculateHlsVariantDuration(content) {
    const lines = content.split(/\r?\n/);
    let totalDuration = 0;
    let segmentCount = 0;
    
    // Parse #EXTINF lines which contain segment durations
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            // Extract the duration value (format: #EXTINF:4.5,)
            const durationStr = line.substring(8).split(',')[0];
            const segmentDuration = parseFloat(durationStr);
            if (!isNaN(segmentDuration)) {
                totalDuration += segmentDuration;
                segmentCount++;
            }
        }
    }
    
    // Check if this is a live stream (no EXT-X-ENDLIST tag)
    const isLive = !content.includes('#EXT-X-ENDLIST');
    
    return {
        duration: Math.round(totalDuration), // Round to full seconds
        isLive: isLive,
        segmentCount: segmentCount
    };
}

/**
 * Extract encryption information from HLS playlist content
 * @param {string} content - HLS playlist content
 * @returns {Object} - Encryption information
 */
function extractHlsEncryptionInfo(content) {
    let isEncrypted = false;
    let encryptionType = null;
    
    // Check for encryption by looking for EXT-X-KEY tags
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (line.trim().startsWith('#EXT-X-KEY:')) {
            isEncrypted = true;
            
            // Try to extract encryption method
            const methodMatch = line.match(/METHOD=([^,]+)/);
            if (methodMatch && methodMatch[1]) {
                encryptionType = methodMatch[1].replace(/"/g, '');  // Remove quotes if present
            }
            break; // Found what we need
        }
    }
    
    return {
        isEncrypted: isEncrypted,
        encryptionType: encryptionType
    };
}

/**
 * Parse HLS master playlist content to extract variant information
 * Uses shared variant entry extraction logic for consistency and minimal codebase
 * 
 * @param {string} content - The playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL
 * @returns {Object} Object containing variants array and playlist info
 */
function parseHlsMaster(content, baseUrl, masterUrl) {
    // Extract the HLS version from the master playlist
    const version = extractHlsVersion(content);
    logger.debug(`HLS master playlist version: ${version}`);
    logger.debug(`Processing master playlist with ${content.split(/\r?\n/).length} lines`);
    logger.debug(`First few lines: ${content.split(/\r?\n/).slice(0, 3).join('\n')}`);

    // Use the unified variant entry extraction
    const variantEntries = extractMasterVariantEntries(content, baseUrl, masterUrl);

    // Build variant objects
    const variants = variantEntries.map(entry => {
        return {
            url: entry.url,
            normalizedUrl: entry.normalizedUrl,
            masterUrl: masterUrl,
            hasKnownMaster: true,
            type: 'hls',
            isVariant: true,
            metaJS: {
                bandwidth: entry.streamInf.bandwidth,
                averageBandwidth: entry.streamInf.averageBandwidth,
                codecs: entry.streamInf.codecs,
                resolution: entry.streamInf.resolution,
                width: entry.streamInf.width,
                height: entry.streamInf.height,
                standardizedResolution: entry.streamInf.height ? standardizeResolution(entry.streamInf.height) : null,
                fps: entry.streamInf.fps,
                hasVideo: entry.streamInf.hasVideo,
                hasAudio: entry.streamInf.hasAudio,
                isAudioOnly: entry.streamInf.isAudioOnly,
                audioGroup: entry.streamInf.audioGroup,
                videoGroup: entry.streamInf.videoGroup,
                subtitleGroup: entry.streamInf.subtitleGroup,
                ccGroup: entry.streamInf.ccGroup
            },
            source: 'parseHlsMaster()',
            timestampDetected: Date.now()
        };
    });

    // --- Audio, subtitle and closed caption track detection ---
    // Parse #EXT-X-MEDIA:TYPE=AUDIO, TYPE=SUBTITLES and TYPE=CLOSED-CAPTIONS lines
    const audioTracks = [];
    const subtitleTracks = [];
    const closedCaptions = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA:')) {
            // Parse attributes
            const attrPattern = /([A-Z0-9\-]+)=(("[^"]*")|([^,]*))/g;
            let match;
            const attrs = {};
            while ((match = attrPattern.exec(line)) !== null) {
                const key = match[1];
                let value = match[3] || match[4] || '';
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                attrs[key] = value;
            }
            if (/TYPE=AUDIO/.test(line)) {
                audioTracks.push({
                    groupId: attrs['GROUP-ID'] || null,
                    name: attrs['NAME'] || null,
                    language: attrs['LANGUAGE'] || null,
                    url: attrs['URI'] ? resolveUrl(baseUrl, attrs['URI']) : null,
                    normalizedUrl: attrs['URI'] ? normalizeUrl(resolveUrl(baseUrl, attrs['URI'])) : null,
                    default: attrs['DEFAULT'] === 'YES',
                    autoselect: attrs['AUTOSELECT'] === 'YES',
                    characteristics: attrs['CHARACTERISTICS'] || null,
                    channels: attrs['CHANNELS'] || null,
                    assocLanguage: attrs['ASSOC-LANGUAGE'] || null
                });
            } else if (/TYPE=SUBTITLES/.test(line)) {
                subtitleTracks.push({
                    groupId: attrs['GROUP-ID'] || null,
                    name: attrs['NAME'] || null,
                    language: attrs['LANGUAGE'] || null,
                    url: attrs['URI'] ? resolveUrl(baseUrl, attrs['URI']) : null,
                    normalizedUrl: attrs['URI'] ? normalizeUrl(resolveUrl(baseUrl, attrs['URI'])) : null,
                    default: attrs['DEFAULT'] === 'YES',
                    autoselect: attrs['AUTOSELECT'] === 'YES',
                    forced: attrs['FORCED'] === 'YES',
                    characteristics: attrs['CHARACTERISTICS'] || null,
                    instreamId: attrs['INSTREAM-ID'] || null
                });
            } else if (/TYPE=CLOSED-CAPTIONS/.test(line)) {
                closedCaptions.push({
                    groupId: attrs['GROUP-ID'] || null,
                    name: attrs['NAME'] || null,
                    language: attrs['LANGUAGE'] || null,
                    instreamId: attrs['INSTREAM-ID'] || null,
                    default: attrs['DEFAULT'] === 'YES',
                    autoselect: attrs['AUTOSELECT'] === 'YES',
                    characteristics: attrs['CHARACTERISTICS'] || null
                });
            }
        }
    }
    logger.debug(`Found ${audioTracks.length} audio track(s), ${subtitleTracks.length} subtitle track(s) and ${closedCaptions.length} closed caption track(s) in HLS master: ${masterUrl}`);

    // Filter out audio-only variants
    const filteredVariants = variants.filter(variant => !variant.metaJS.isAudioOnly);
    if (variants.length !== filteredVariants.length) {
        logger.debug(`Filtered out ${variants.length - filteredVariants.length} audio-only variants`);
    }

    // Sort variants by bandwidth (highest first for best quality)
    if (filteredVariants.length > 0) {
        filteredVariants.sort((a, b) => {
            const aBandwidth = a.metaJS.averageBandwidth || a.metaJS.bandwidth || 0;
            const bBandwidth = b.metaJS.averageBandwidth || b.metaJS.bandwidth || 0;
            return bBandwidth - aBandwidth;
        });
        logger.debug(`Variants sorted by bandwidth, highest: ${filteredVariants[0].metaJS.bandwidth}`);
    }

    return {
        variants: filteredVariants,
        audioTracks: audioTracks,
        subtitles: subtitleTracks,
        closedCaptions: closedCaptions,
        hasMediaGroups: audioTracks.length > 0 || subtitleTracks.length > 0 || closedCaptions.length > 0,
        status: 'success',
        version: version
    };
}

/**
 * Parse StreamInf line to extract variant information
 * Example: #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
 *
 * @param {string} line - The #EXT-X-STREAM-INF line
 * @returns {Object} Parsed stream information
 */
function parseStreamInf(line) {
    // Remove the #EXT-X-STREAM-INF: prefix
    const attrText = line.substring(line.indexOf(':') + 1);
    
    // Initialize result object
    const result = {
        bandwidth: null,
        averageBandwidth: null,
        codecs: null,
        resolution: null,
        width: null,
        height: null,
        fps: null,
        hasAudio: null,
        hasVideo: null,
        isAudioOnly: false, // Default to false, will be set based on codecs
        audioGroup: null,
        videoGroup: null,
        subtitleGroup: null,
        ccGroup: null
    };
    
    // Pattern for parsing attribute expressions, handling quoted values properly
    const attributePattern = /([^=,]+)=(?:"([^"]*)"|([^,]*))/g;
    
    let match;
    while ((match = attributePattern.exec(attrText)) !== null) {
        const key = match[1].trim();
        const value = (match[2] || match[3]).trim();
        
        switch (key) {
            case 'BANDWIDTH':
                result.bandwidth = parseInt(value, 10);
                break;
            case 'AVERAGE-BANDWIDTH':
                result.averageBandwidth = parseInt(value, 10);
                break;
            case 'CODECS':
                result.codecs = value;
                // Check if this is an audio-only stream based on codecs
                if (value) {
                    // Audio-only streams typically only have audio codec (mp4a, ac-3, etc.) 
                    // and no video codec (avc1, hvc1, vp9, etc.)
                    const hasVideoCodec = /avc1|hvc1|hev1|vp\d|av01/.test(value);
                    const hasAudioCodec = /mp4a|ac-3|ec-3|mp3/.test(value);

                    if (hasAudioCodec) {result.hasAudio = true;}
                    if (hasVideoCodec) {result.hasVideo = true;}
                    result.isAudioOnly = !hasVideoCodec && hasAudioCodec;
                }
                break;
            case 'RESOLUTION':
                result.resolution = value;
                // Parse resolution in the format "widthxheight"
                const [width, height] = value.split('x');
                result.width = parseInt(width, 10);
                result.height = parseInt(height, 10);
                break;
            case 'FRAME-RATE':
                result.fps = Math.round(parseFloat(value));
                break;
            case 'AUDIO':
                result.audioGroup = value;
                break;
            case 'VIDEO':
                result.videoGroup = value;
                break;
            case 'SUBTITLES':
                result.subtitleGroup = value;
                break;
            case 'CLOSED-CAPTIONS':
                result.ccGroup = value === 'NONE' ? null : value;
                break;
        }
    }
    
    return result;
}

/**
 * Parse an HLS playlist and organize content by type
 * First validates if it's really an HLS manifest using universal validator
 * 
 * @param {string} url - URL of the HLS manifest
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Object>} Validated and parsed HLS content with variants
 */
export async function parseHlsManifest(url, headers = null, tabId) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full && processingRequests.full.has(normalizedUrl)) {
        return { 
            status: 'processing',
            isValid: false,
            isMaster: false,
            isVariant: false,
            variants: [],
            audioTracks: [],
            subtitles: [],
            closedCaptions: [],
            hasMediaGroups: false
        };
    }
    
    // Mark as being processed
    if (processingRequests.full) {
        processingRequests.full.add(normalizedUrl);
    }
    
    try {
        logger.debug(`Validating manifest: ${url} with these headers:`, headers);
        
        // Get video metadata from storage if available
        const videoInfo = await getVideoByUrl(url);
        const existingMetadata = videoInfo?.metadata;
        
        // First perform universal validation to confirm this is an HLS manifest
        const validation = await validateManifestType(url, headers, existingMetadata, tabId);
        
        // Preserve the light parsing timestamp
        const timestampLP = validation.timestampLP || Date.now();
        
        // Early return if not a valid manifest or if not HLS
        if (!validation.isValid || validation.manifestType !== 'hls') {
            logger.warn(`URL does not point to a valid HLS manifest: ${url} (${validation.status})`);
            return {
                status: validation.status || 'not-hls',
                isValid: false,
                timestampLP,
                isMaster: false,
                isVariant: false,
                variants: [],
                audioTracks: [],
                subtitles: [],
                closedCaptions: [],
                hasMediaGroups: false
            };
        }
        
        // Use data from validation if available
        let isMaster = validation.isMaster || false; 
        let isVariant = validation.isVariant || false;
        
        logger.debug(`Confirmed valid HLS ${isMaster ? 'master' : (isVariant ? 'variant' : 'unknown')} manifest, proceeding to full parse: ${url}`);
        
        // Use content from light parsing if available, otherwise fetch full content
        let content;
        if (validation.content) {
            logger.debug('Reusing content from light parsing for full parse');
            content = validation.content;
        } else {
            logger.debug('Content not available from light parsing, fetching full content');
            const fetchResult = await fetchManifest(url, {
                headers,
                maxRetries: 3,
                tabId: tabId
            });
            
            if (!fetchResult.ok) {
                logger.error(`Failed to fetch HLS playlist: ${fetchResult.status}`);
                return { 
                    status: 'fetch-failed',
                    isValid: false,
                    timestampLP,
                    isMaster: false,
                    isVariant: false, 
                    variants: [],
                    audioTracks: [],
                    subtitles: [],
                    closedCaptions: [],
                    hasMediaGroups: false
                };
            }
            
            content = fetchResult.content;
        }
        
        // Double-check content type based on actual content
        // This ensures we handle the manifest correctly regardless of Content-Type header
        const hasStreamInf = content.includes('#EXT-X-STREAM-INF');
        const hasExtInf = content.includes('#EXTINF');
        
        // Force correct type detection based on content inspection
        isMaster = hasStreamInf;
        isVariant = !isMaster && hasExtInf;
        
        logger.debug(`Content inspection confirms: isMaster=${isMaster}, isVariant=${isVariant}`);
        
        const baseUrl = getBaseDirectory(url);
        
        // For master playlists, parse variants
        let variants = [];
        let duration = null;
        let isEncrypted = false;
        let encryptionType = null;
        let version = null; 
        let subtitles = [];
        let closedCaptions = [];
        let audioTracks = [];
        let hasMediaGroups = false;

        if (isMaster) {
            // Parse the master playlist to extract variant URLs, subtitle tracks, and closed captions
            logger.debug(`Parsing HLS master playlist content: ${content.substring(0, 100)}...`);
            const masterParseResult = parseHlsMaster(content, baseUrl, url);

            // Store version from master playlist
            version = masterParseResult.version;
            subtitles = masterParseResult.subtitles || [];
            closedCaptions = masterParseResult.closedCaptions || [];
            audioTracks = masterParseResult.audioTracks || [];
            hasMediaGroups = masterParseResult.hasMediaGroups || false;

            if (masterParseResult.variants && masterParseResult.variants.length > 0) {
                // Get basic variant information
                const basicVariants = masterParseResult.variants;
                logger.debug(`Found ${basicVariants.length} basic variants in master playlist`);

                // Attach headers directly to each variant for explicit downstream use
                if (headers) {
                    for (const variant of basicVariants) {
                        variant.headers = headers;
                    }
                }

                // Prepare variants array with basic info
                variants = [...basicVariants];

                // Try to fetch the highest quality variant first
                let variantInfo = null;
                let processedVariantIndex = 0;

                // Try highest quality first, then fall back to others if needed
                while (!variantInfo && processedVariantIndex < Math.min(3, basicVariants.length)) {
                    try {
                        const currentVariant = basicVariants[processedVariantIndex];
                        logger.debug(`Processing variant ${processedVariantIndex+1}: ${currentVariant.url}`);

                        variantInfo = await parseHlsVariant(currentVariant.url, headers, tabId);

                        if (variantInfo) {
                            logger.debug(`Successfully fetched variant ${processedVariantIndex+1}`);
                            break;
                        }
                    } catch (error) {
                        logger.warn(`Failed to fetch variant ${processedVariantIndex+1}: ${error.message}`);
                    }

                    processedVariantIndex++;
                }

                if (variantInfo) {
                    // Extract metadata for all variants from this one
                    duration = variantInfo.duration;
                    isEncrypted = variantInfo.isEncrypted || false;
                    encryptionType = variantInfo.encryptionType;
                    const isLive = variantInfo.isLive || false;
                    const segmentCount = variantInfo.segmentCount;

                    // Apply this metadata to all variants
                    variants = variants.map(variant => {
                        // Create a new variant object with detailed information
                        const updatedVariant = {...variant};

                        // Apply metadata from the processed variant
                        updatedVariant.metaJS.duration = duration;
                        updatedVariant.metaJS.isLive = isLive;
                        updatedVariant.metaJS.isEncrypted = isEncrypted;
                        updatedVariant.metaJS.encryptionType = encryptionType;
                        updatedVariant.metaJS.segmentCount = segmentCount;
                        updatedVariant.metaJS.version = variantInfo.version || version;

                        // Distinguish the actually fetched variant
                        if (variant.url === basicVariants[processedVariantIndex].url) {
                            updatedVariant.metaJS.directlyFetched = true;
                        }

                        // Calculate estimated file size based on bandwidth and duration
                        if (duration !== null && duration >= 0) {
                            const effectiveBandwidth = updatedVariant.metaJS.averageBandwidth || updatedVariant.metaJS.bandwidth;
                            updatedVariant.metaJS.estimatedFileSizeBytes = calculateEstimatedFileSizeBytes(
                                effectiveBandwidth, 
                                duration
                            );
                        }

                        return updatedVariant;
                    });
                } else {
                    // If all fetches failed, return basic variants
                    logger.warn('Failed to fetch any variant for metadata extraction');
                }
            } else {
                logger.debug(`No variants found in master playlist`);
            }
        }
        else if (isVariant) {
            // For variant playlists, extract duration and encryption info directly
            logger.debug(`Parsing standalone variant playlist`);
            const variantInfo = calculateHlsVariantDuration(content);
            duration = variantInfo.duration;
            const isLive = variantInfo.isLive;
            
            logger.debug(`Variant duration: ${duration}s, isLive: ${isLive}`);
            
            // Extract encryption info
            const encryptionInfo = extractHlsEncryptionInfo(content);
            isEncrypted = encryptionInfo.isEncrypted;
            encryptionType = encryptionInfo.encryptionType;
            
            // Extract HLS version for standalone variant
            version = extractHlsVersion(content);
            logger.debug(`Standalone variant version: ${version}`);
            
            // Create a single-item variants array with this variant
            variants = [{
                url: url,
                normalizedUrl: normalizedUrl,
                masterUrl: null,
                hasKnownMaster: false,
                type: 'hls',
                isVariant: true,
                metaJS: {
                    duration: duration,
                    isLive: isLive,
                    segmentCount: variantInfo.segmentCount,
                    isEncrypted: isEncrypted,
                    encryptionType: encryptionType,
                    version: version
                },
                source: 'parseHlsManifest()',
                timestampDetected: Date.now()
            }];
            
            logger.debug(`Created standalone variant entry: ${JSON.stringify(variants[0])}`);
        }
        
        // Set the full parse timestamp
        const timestampFP = Date.now();

        // Construct the full result
        const result = {
            url: url,
            normalizedUrl: normalizedUrl,
            type: 'hls',
            isValid: true,
            isMaster: isMaster,
            isVariant: isVariant,
            timestampLP: timestampLP,
            timestampFP: timestampFP,
            duration: duration,
            isEncrypted: isEncrypted,
            encryptionType: encryptionType,
            version: version,
            variants: variants,
            audioTracks: audioTracks,
            subtitles: subtitles,
            closedCaptions: closedCaptions,
            hasMediaGroups: hasMediaGroups,
            status: 'success'
        };

        logger.info(`Successfully parsed HLS: found ${variants.length} variants, ${audioTracks.length} audio tracks, ${subtitles.length} subtitle tracks, ${closedCaptions.length} closed caption tracks`);
        return result;
    } catch (error) {
        logger.error(`Error parsing HLS: ${error.message}`);
        return { 
            status: 'parse-error',
            error: error.message,
            isValid: false,
            timestampLP: Date.now(),
            isMaster: false,
            isVariant: false,
            variants: [],
            audioTracks: [],
            subtitles: [],
            closedCaptions: [],
            hasMediaGroups: false
        };
    } finally {
        // Clean up
        if (processingRequests.full) {
            processingRequests.full.delete(normalizedUrl);
        }
    }
}


/**
 * Extract HLS manifest version from content
 * @param {string} content - HLS playlist content
 * @returns {number|null} - HLS version number or null if not specified
 */
function extractHlsVersion(content) {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#EXT-X-VERSION:')) {
            const versionStr = trimmedLine.substring(15).trim();
            const version = parseInt(versionStr, 10);
            return isNaN(version) ? null : version;
        }
    }
    // If no version tag is present, the specification states it defaults to version 1
    return 1;
}

/**
 * Extract variant URLs from HLS master playlist for deduplication
 * Uses shared variant entry extraction logic for consistency
 * @param {string} url - URL of the HLS master playlist
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Array<string>>} Array of normalized variant URLs
 */
export async function extractHlsVariantUrls(url, headers = null, tabId) {
    try {
        logger.debug(`Extracting variant URLs from master: ${url}`);
        // Fetch the master playlist content
        const fetchResult = await fetchManifest(url, {
            headers,
            maxRetries: 2,
            tabId: tabId
        });
        if (!fetchResult.ok) {
            logger.warn(`Failed to fetch master playlist for variant extraction: ${fetchResult.status}`);
            return [];
        }
        // Quick validation that this is an HLS master playlist
        const content = fetchResult.content;
        if (!content.includes('#EXTM3U') || !content.includes('#EXT-X-STREAM-INF')) {
            logger.warn(`Content is not an HLS master playlist`);
            return [];
        }
        const baseUrl = getBaseDirectory(url);
        const normalizedMasterUrl = normalizeUrl(url);
        // Use the unified variant entry extraction and return only normalized URLs
        const variantEntries = extractMasterVariantEntries(content, baseUrl, normalizedMasterUrl);
        return variantEntries.map(entry => entry.normalizedUrl);
    } catch (error) {
        logger.error(`Error extracting variant URLs from ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Unified extraction of variant entries from HLS master playlist content
 * Returns array of objects: { url, normalizedUrl, streamInf }
 * Used by both parseHlsMaster and extractHlsVariantUrls for minimal codebase
 * @param {string} content - The master playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL (normalized)
 * @returns {Array<Object>} Array of variant entry objects
 */
function extractMasterVariantEntries(content, baseUrl, masterUrl) {
    const entries = [];
    const lines = content.split(/\r?\n/);
    let currentStreamInf = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInf = parseStreamInf(line);
        } else if (currentStreamInf && line && !line.startsWith('#')) {
            const variantUrl = resolveUrl(baseUrl, line);
            const normalizedVariantUrl = normalizeUrl(variantUrl);
            entries.push({
                url: variantUrl,
                normalizedUrl: normalizedVariantUrl,
                streamInf: currentStreamInf,
                masterUrl: masterUrl
            });
            currentStreamInf = null;
        }
    }
    logger.debug(`Extracted ${entries.length} variant entries from master playlist`);
    return entries;
}

/**
 * Extract all media URLs from HLS master playlist for comprehensive deduplication
 * @param {string} url - URL of the HLS master playlist
 * @param {Object} [headers] - Optional request headers
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object>} Object containing arrays of normalized URLs for variants, audioTracks, and subtitles
 */
export async function extractHlsMediaUrls(url, headers = null, tabId) {
    try {
        logger.debug(`Extracting all media URLs from master: ${url}`);
        // Fetch the master playlist content
        const fetchResult = await fetchManifest(url, {
            headers,
            maxRetries: 2,
            tabId: tabId
        });
        if (!fetchResult.ok) {
            logger.warn(`Failed to fetch master playlist for media URL extraction: ${fetchResult.status}`);
            return { variants: [], audioTracks: [], subtitles: [] };
        }
        // Quick validation that this is an HLS master playlist
        const content = fetchResult.content;
        if (!content.includes('#EXTM3U') || !content.includes('#EXT-X-STREAM-INF')) {
            logger.warn(`Content is not an HLS master playlist`);
            return { variants: [], audioTracks: [], subtitles: [] };
        }
        const baseUrl = getBaseDirectory(url);
        const normalizedMasterUrl = normalizeUrl(url);
        
        // Extract variants
        const variantEntries = extractMasterVariantEntries(content, baseUrl, normalizedMasterUrl);
        const variantUrls = variantEntries.map(entry => entry.normalizedUrl);
        
        // Extract audio tracks and subtitles from #EXT-X-MEDIA lines
        const audioUrls = [];
        const subtitleUrls = [];
        const lines = content.split(/\r?\n/);
        
        for (const line of lines) {
            if (line.startsWith('#EXT-X-MEDIA:')) {
                // Parse attributes
                const attrPattern = /([A-Z0-9\-]+)=(("[^"]*")|([^,]*))/g;
                let match;
                const attrs = {};
                while ((match = attrPattern.exec(line)) !== null) {
                    const key = match[1];
                    let value = match[3] || match[4] || '';
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1);
                    }
                    attrs[key] = value;
                }
                
                if (/TYPE=AUDIO/.test(line) && attrs['URI']) {
                    const audioUrl = resolveUrl(baseUrl, attrs['URI']);
                    audioUrls.push(normalizeUrl(audioUrl));
                } else if (/TYPE=SUBTITLES/.test(line) && attrs['URI']) {
                    const subtitleUrl = resolveUrl(baseUrl, attrs['URI']);
                    subtitleUrls.push(normalizeUrl(subtitleUrl));
                }
            }
        }
        
        logger.debug(`Extracted ${variantUrls.length} variant URLs, ${audioUrls.length} audio URLs, ${subtitleUrls.length} subtitle URLs`);
        return { 
            variants: variantUrls, 
            audioTracks: audioUrls, 
            subtitles: subtitleUrls 
        };
    } catch (error) {
        logger.error(`Error extracting media URLs from ${url}: ${error.message}`);
        return { variants: [], audioTracks: [], subtitles: [] };
    }
}