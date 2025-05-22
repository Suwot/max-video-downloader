/**
 * HLS Parser
 * Pure JavaScript-based parsing of HLS manifests without FFprobe
 * Provides lightweight and full parsing capabilities for HLS content
 */

import { 
    normalizeUrl,
    buildRequestHeaders,
    processingRequests,
    calculateEstimatedFileSizeBytes,
    resolveUrl,
    getBaseDirectory
} from './parser-utils.js';
import { createLogger } from './logger.js';

// Create a logger for the HLS parser
const logger = createLogger('HLS Parser');

/**
 * Perform lightweight parsing of HLS content to determine its subtype
 * This fetches only the first 4KB to make a quick determination
 * @param {string} url - The URL to analyze
 * @param {Object} [headers] - Optional custom headers to use for the request
 * @returns {Promise<{isValid: boolean, subtype: string}>} - Analysis result
 */
export async function lightParseHls(url, headers = null) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.light.has(normalizedUrl)) {
        return { isValid: true, subtype: 'processing' };
    }
    
    // Mark as being processed
    processingRequests.light.add(normalizedUrl);
    
    try {
        // Get just the first 4KB of content to determine what it is
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);  // 5 second timeout
        
        logger.debug(`Light parsing ${url} to determine subtype`);
        
        // Use provided headers or build basic headers
        const requestHeaders = headers || await buildRequestHeaders(null, url);
        
        // Add Range header directly for light parsing
        requestHeaders['Range'] = 'bytes=0-4095'; // Request just the first 4KB

        // Final headers used for fetch
        logger.debug(`Final request headers: ${JSON.stringify(requestHeaders)}`);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: requestHeaders
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            logger.debug(`❌ FAILED light parsing ${url}: ${response.status}`);
            return { isValid: false, subtype: 'fetch-failed' };
        }
        
        const content = await response.text();
        
        // Analyze the content
        let result;
        
        // Check if it's a master playlist (contains #EXT-X-STREAM-INF)
        if (content.includes('#EXT-X-STREAM-INF')) {
            result = { isValid: true, subtype: 'hls-master', isMaster: true };
        } 
        // Check if it's a variant/media playlist (contains #EXTINF)
        else if (content.includes('#EXTINF')) {
            result = { isValid: true, subtype: 'hls-variant', isVariant: true };
        }
        // Neither master nor variant markers found
        else {
            result = { isValid: false, subtype: 'not-a-video' };
        }
        
        logger.debug(`✓ COMPLETED light parsing ${url}: ${result.subtype}`);
        return result;
    } catch (error) {
        logger.error(`❌ ERROR light parsing ${url}: ${error.message}`);
        return { isValid: false, subtype: 'parse-error' };
    } finally {
        // Clean up
        processingRequests.light.delete(normalizedUrl);
    }
}

/**
 * Perform full parsing of HLS master playlists to extract variant information
 * This function extracts complete information about all variants in a master playlist
 * 
 * @param {string} url - The URL of the master playlist
 * @param {Object} [headers] - Optional custom headers to use for the request
 * @returns {Promise<{variants: Array, duration: number}>} - Complete variant information
 */
export async function fullParseHls(url, headers = null) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full.has(normalizedUrl)) {
        return { variants: [], status: 'processing' };
    }
    
    // Mark as being processed
    processingRequests.full.add(normalizedUrl);
    
    try {
        logger.debug(`Full parsing ${url}`);
        
        // Fetch the full content of the playlist
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);  // 10 second timeout
        
        // Use provided headers or build basic headers
        const requestHeaders = headers || await buildRequestHeaders(null, url);

        // Remove any Range header to ensure we get the full content
        if (requestHeaders['Range']) {
            delete requestHeaders['Range'];
            logger.debug(`Removed Range header to fetch complete content`);
        }
        
        const response = await fetch(url, {
            signal: controller.signal,
            headers: requestHeaders
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            logger.error(`❌ FAILED full parsing ${url}: ${response.status}`);
            return { variants: [], status: 'fetch-failed' };
        }
        
        const content = await response.text();
        const baseUrl = getBaseDirectory(url);
        
        // Parse the HLS master content
        let result = parseHlsMaster(content, baseUrl, url);
        
        // Ensure result.variants is always an array
        result.variants = result.variants || [];
        
        // For HLS masters, calculate the duration for all variants
        if (result.variants.length > 0) {
            logger.debug(`Calculating duration for ${result.variants.length} variants`);
            
            // Process all variants sequentially using Promise.all for better parallel processing
            const variantPromises = result.variants.map(async (variant, index) => {
                try {
                    // Parse the variant to extract all metadata
                    const variantInfo = await parseHlsVariant(variant.url, headers);
                    
                    // Duration info
                    if (variantInfo.duration !== null && variantInfo.duration >= 0) {
                        variant.metaJS.duration = variantInfo.duration;
                        // File size calculation depends on valid duration
                        const effectiveBandwidth = variant.metaJS.averageBandwidth || variant.metaJS.bandwidth;
                        variant.metaJS.estimatedFileSizeBytes = calculateEstimatedFileSizeBytes(effectiveBandwidth, variantInfo.duration);
                        logger.debug(`Calculated duration for variant ${index+1}/${result.variants.length}: ${variantInfo.duration}s`);
                    }

                    // Live status can be determined even if duration calculation failed
                    variant.metaJS.isLive = variantInfo.isLive === undefined ? false : variantInfo.isLive;

                    // Encryption info can be determined independently of duration
                    variant.metaJS.isEncrypted = variantInfo.isEncrypted || false;
                    if (variantInfo.isEncrypted && variantInfo.encryptionType) {
                        variant.metaJS.encryptionType = variantInfo.encryptionType;
                    }

                    // Log the stream type
                    logger.debug(`Variant ${index+1} is ${variantInfo.isLive ? 'LIVE' : 'VOD'}`);
                } catch (error) {
                    logger.error(`Failed to parse variant ${index+1}: ${error.message}`);
                }
            });
            
            // Wait for all variant duration calculations to complete
            await Promise.all(variantPromises);
        }
        
        // Log success message here inside the try block to ensure it only happens on success
        logger.info(`✓ COMPLETED full parsing ${url}: found ${result.variants.length} variants`);
        return result;
    } catch (error) {
        logger.error(`❌ ERROR full parsing ${url}: ${error.message}`);
        return { variants: [], status: 'parse-error', error: error.message };
    } finally {
        // Clean up
        processingRequests.full.delete(normalizedUrl);
    }
}

/**
 * Parse an HLS variant playlist to extract full metadata
 * @param {string} variantUrl - URL of the HLS variant playlist
 * @param {Object} [headers] - Optional headers to use for the request
 * @returns {Promise<Object>} - Complete variant metadata
 */
async function parseHlsVariant(variantUrl, headers = null) {
    try {
        // Set up request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);  
        
        // Use provided headers or build basic headers
        const requestHeaders = headers || await buildRequestHeaders(null, variantUrl);
        
        // Remove any Range header that might limit the response size
        if (requestHeaders['Range']) {
            delete requestHeaders['Range'];
        }
        
        logger.debug(`Fetching full HLS variant: ${variantUrl}`);
        
        const response = await fetch(variantUrl, {
            signal: controller.signal,
            headers: requestHeaders
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            logger.warn(`❌ FAILED fetching variant ${variantUrl}: ${response.status}`);
            return { 
                duration: null, 
                isLive: true,
                isEncrypted: false,
                encryptionType: null
            };
        }
        
        const content = await response.text();
        logger.debug(`Received variant playlist: ${content.length} bytes, ${content.split('\n').length} lines`);
        
        // Extract different types of metadata from variant playlist
        const durationInfo = calculateHlsVariantDuration(content);
        const encryptionInfo = extractHlsEncryptionInfo(content);
        
        // Build a complete result object
        const result = {
            duration: durationInfo.duration,
            isLive: durationInfo.isLive,
            isEncrypted: encryptionInfo.isEncrypted,
            encryptionType: encryptionInfo.isEncrypted ? encryptionInfo.encryptionType : null
        };
        
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
    
    // No longer tracking TARGETDURATION as it's not accurate for file size calculation
    // Accurate duration will be calculated per variant in fullParseContent
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Process EXT-X-STREAM-INF line (variant declaration)
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInf = parseStreamInf(line);
        } 
        // Process URI line following STREAM-INF
        else if (currentStreamInf && line && !line.startsWith('#')) {
            // Resolve the variant URL
            const variantUrl = resolveUrl(baseUrl, line);
            
            // Create a variant entry with all extracted information
            // File size will be calculated later when we have accurate duration
            const variant = {
                url: variantUrl,
                normalizedUrl: normalizeUrl(variantUrl),
                masterUrl: masterUrl,
                hasKnownMaster: true,
                type: 'hls',
                subtype: 'hls-variant',
                isVariant: true,
                metaJS: {
                    bandwidth: currentStreamInf.bandwidth,
                    averageBandwidth: currentStreamInf.averageBandwidth,
                    codecs: currentStreamInf.codecs,
                    resolution: currentStreamInf.resolution,
                    width: currentStreamInf.width,
                    height: currentStreamInf.height,
                    fps: currentStreamInf.fps
                    // estimatedFileSizeBytes will be added later with accurate duration
                },
                source: 'parseHlsMaster()',
                timestampDetected: Date.now()
            };
            
            variants.push(variant);
            currentStreamInf = null;
        }
    }
    
    // Sort variants by bandwidth (highest first for best quality)
    variants.sort((a, b) => {
        const aBandwidth = a.metaJS.averageBandwidth || a.metaJS.bandwidth || 0;
        const bBandwidth = b.metaJS.averageBandwidth || b.metaJS.bandwidth || 0;
        return bBandwidth - aBandwidth;
    });
    
    return { 
        variants,
        status: 'success'
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
                result.fps = parseFloat(value);
                break;
        }
    }
    
    return result;
}
