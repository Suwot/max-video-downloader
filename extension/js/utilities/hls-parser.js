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
import { createLogger } from './logger.js';
import { getSharedHeaders } from './headers-utils.js';
import { getVideoByUrl } from '../../background/services/video-manager.js';
import { standardizeResolution } from '../../popup/js/video-list/video-utils.js';

// Create a logger for the HLS parser
const logger = createLogger('HLS Parser');

/**
 * Parse an HLS variant playlist to extract full metadata
 * @param {string} variantUrl - URL of the HLS variant playlist
 * @param {Object} [headers] - Optional headers to use for the request
 * @returns {Promise<Object>} - Complete variant metadata
 */
async function parseHlsVariant(variantUrl, headers = null) {
    try {
        logger.debug(`Fetching variant: ${variantUrl}`);
        
        // Use the unified fetchManifest function with retry logic
        const fetchResult = await fetchManifest(variantUrl, {
            headers,
            timeoutMs: 10000,
            maxRetries: 2
        });
        
        if (!fetchResult.ok) {
            logger.warn(`❌ Failed fetching variant ${variantUrl}: ${fetchResult.status}`);
            return { 
                duration: null, 
                isLive: true,
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
            isEncrypted: false,
            encryptionType: null
        };
    }
}

/**
 * Calculate the duration of an HLS variant playlist by summing segment durations
 * @param {string} content - The playlist content 
 * @returns {Object} - Duration information
 */
function calculateHlsVariantDuration(content) {
    const lines = content.split(/\r?\n/);
    let totalDuration = 0;
    
    // Parse #EXTINF lines which contain segment durations
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            // Extract the duration value (format: #EXTINF:4.5,)
            const durationStr = line.substring(8).split(',')[0];
            const segmentDuration = parseFloat(durationStr);
            if (!isNaN(segmentDuration)) {
                totalDuration += segmentDuration;
            }
        }
    }
    
    // Check if this is a live stream (no EXT-X-ENDLIST tag)
    const isLive = !content.includes('#EXT-X-ENDLIST');
    
    return {
        duration: Math.round(totalDuration), // Round to full seconds
        isLive: isLive
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
 * 
 * @param {string} content - The playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL
 * @returns {Object} Object containing variants array and playlist info
 */
function parseHlsMaster(content, baseUrl, masterUrl) {
    const variants = [];
    const lines = content.split(/\r?\n/);
    
    let currentStreamInf = null;

    // Extract the HLS version from the master playlist
    const version = extractHlsVersion(content);
    logger.debug(`HLS master playlist version: ${version}`);
    
    logger.debug(`Processing master playlist with ${lines.length} lines`);
    logger.debug(`First few lines: ${lines.slice(0, 3).join('\n')}`);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Process EXT-X-STREAM-INF line (variant declaration)
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            logger.debug(`Found STREAM-INF: ${line}`);
            currentStreamInf = parseStreamInf(line);
            logger.debug(`Parsed stream info: ${JSON.stringify(currentStreamInf)}`);
        } 
        // Process URI line following STREAM-INF
        else if (currentStreamInf && line && !line.startsWith('#')) {
            logger.debug(`Found variant URI: ${line}`);
            
            // Resolve the variant URL
            const variantUrl = resolveUrl(baseUrl, line);
            logger.debug(`Resolved variant URL: ${variantUrl}`);
            
            // Create a variant entry with all extracted information
            const variant = {
                url: variantUrl,
                normalizedUrl: normalizeUrl(variantUrl),
                masterUrl: masterUrl,
                hasKnownMaster: true,
                type: 'hls',
                isVariant: true,
                metaJS: {
                    bandwidth: currentStreamInf.bandwidth,
                    averageBandwidth: currentStreamInf.averageBandwidth,
                    codecs: currentStreamInf.codecs,
                    resolution: currentStreamInf.resolution,
                    width: currentStreamInf.width,
                    height: currentStreamInf.height,
                    standardizedResolution: currentStreamInf.height ? standardizeResolution(currentStreamInf.height) : null,
                    fps: currentStreamInf.fps
                },
                source: 'parseHlsMaster()',
                timestampDetected: Date.now()
            };
            
            variants.push(variant);
            logger.debug(`Added variant: ${JSON.stringify(variant)}`);
            currentStreamInf = null;
        }
    }
    
    logger.debug(`Total variants found in master: ${variants.length}`);
    
    // Sort variants by bandwidth (highest first for best quality)
    if (variants.length > 0) {
        variants.sort((a, b) => {
            const aBandwidth = a.metaJS.averageBandwidth || a.metaJS.bandwidth || 0;
            const bBandwidth = b.metaJS.averageBandwidth || b.metaJS.bandwidth || 0;
            return bBandwidth - aBandwidth;
        });
        
        logger.debug(`Variants sorted by bandwidth, highest: ${variants[0].metaJS.bandwidth}`);
    }
    
    return { 
        variants,
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
        fps: null
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
export async function parseHlsManifest(url, headers = null) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full && processingRequests.full.has(normalizedUrl)) {
        return { 
            status: 'processing',
            isValid: false,
            isMaster: false,
            isVariant: false,
            variants: []
        };
    }
    
    // Mark as being processed
    if (processingRequests.full) {
        processingRequests.full.add(normalizedUrl);
    }
    
    try {
        logger.debug(`Validating manifest: ${url}`);
        
        // Get video metadata from storage if available
        const videoInfo = await getVideoByUrl(url);
        const existingMetadata = videoInfo?.metadata;
        
        // First perform universal validation to confirm this is an HLS manifest
        const validation = await validateManifestType(url, headers, existingMetadata);
        
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
                variants: []
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
                maxRetries: 3
            });
            
            if (!fetchResult.ok) {
                logger.error(`Failed to fetch HLS playlist: ${fetchResult.status}`);
                return { 
                    status: 'fetch-failed',
                    isValid: false,
                    timestampLP,
                    isMaster: false,
                    isVariant: false, 
                    variants: []
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
        
        if (isMaster) {
            // Parse the master playlist to extract variant URLs
            logger.debug(`Parsing HLS master playlist content: ${content.substring(0, 100)}...`);
            const masterParseResult = parseHlsMaster(content, baseUrl, url);

            // Store version from master playlist
            version = masterParseResult.version;
            logger.debug(`Master playlist version: ${version}`);
            
            logger.debug(`Master parse result: ${JSON.stringify(masterParseResult)}`);
            
            if (masterParseResult.variants && masterParseResult.variants.length > 0) {
                const basicVariants = masterParseResult.variants;
                logger.debug(`Found ${basicVariants.length} basic variants in master playlist`);
                
                // Process variants in parallel but ensure we catch errors per variant
                const variantPromises = basicVariants.map(async (variant, index) => {
                    try {
                        logger.debug(`Processing variant ${index+1}/${basicVariants.length}: ${variant.url}`);
                        const variantInfo = await parseHlsVariant(variant.url, headers);
                        
                        // Create a new variant object to avoid mutation issues
                        const updatedVariant = {...variant};
                        
                        // Update variant with detailed information
                        if (variantInfo.duration !== null && variantInfo.duration >= 0) {
                            updatedVariant.metaJS.duration = variantInfo.duration;
                            const effectiveBandwidth = updatedVariant.metaJS.averageBandwidth || updatedVariant.metaJS.bandwidth;
                            updatedVariant.metaJS.estimatedFileSizeBytes = calculateEstimatedFileSizeBytes(
                                effectiveBandwidth, 
                                variantInfo.duration
                            );
                        }
                        
                        updatedVariant.metaJS.isLive = variantInfo.isLive || false;
                        updatedVariant.metaJS.isEncrypted = variantInfo.isEncrypted || false;
                        updatedVariant.metaJS.encryptionType = variantInfo.encryptionType;
                        updatedVariant.metaJS.version = variantInfo.version || version;
                        
                        logger.debug(`Successfully processed variant ${index+1}`);
                        return updatedVariant;
                    } catch (error) {
                        logger.error(`Error processing variant ${index+1}: ${error.message}`);
                        return variant; // Return the basic variant on error
                    }
                });
                
                try {
                    // Wait for all variant processing to complete
                    variants = await Promise.all(variantPromises);
                    logger.debug(`All ${variants.length} variants processed successfully`);
                    
                    // If we have any variants, use data from the first one (highest quality)
                    if (variants.length > 0) {
                        const bestVariant = variants[0];
                        duration = bestVariant.metaJS.duration;
                        isEncrypted = bestVariant.metaJS.isEncrypted || false;
                        encryptionType = bestVariant.metaJS.encryptionType;
                    }
                    
                    // Ensure variants are properly sorted by quality
                    variants.sort((a, b) => {
                        // First try to sort by resolution if available
                        if (a.metaJS?.height && b.metaJS?.height) {
                            if (a.metaJS.height !== b.metaJS.height) {
                                return b.metaJS.height - a.metaJS.height;
                            }
                        }
                        // Then by bandwidth
                        const aBandwidth = a.metaJS?.averageBandwidth || a.metaJS?.bandwidth || 0;
                        const bBandwidth = b.metaJS?.averageBandwidth || b.metaJS?.bandwidth || 0;
                        return bBandwidth - aBandwidth;
                    });
                } catch (error) {
                    logger.error(`Error during Promise.all for variants: ${error.message}`);
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
            status: 'success'
        };
        
        logger.info(`Successfully parsed HLS: found ${variants.length} variants`);
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
            variants: []
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