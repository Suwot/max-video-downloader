/**
 * Simple JS Parser
 * Pure JavaScript-based parsing of streaming manifests without FFprobe
 * Provides lightweight and full parsing capabilities for HLS and DASH content
 */

import { normalizeUrl } from './normalize-url.js';

// Tracking URLs currently being processed
const processingRequests = {
    light: new Set(),
    full: new Set()
};

/**
 * Perform lightweight parsing of HLS/DASH content to determine its subtype
 * This fetches only the first 4KB to make a quick determination
 * @param {string} url - The URL to analyze
 * @param {string} type - The content type ('hls' or 'dash')
 * @returns {Promise<{isValid: boolean, subtype: string}>} - Analysis result
 */
export async function lightParseContent(url, type) {
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
        
        console.log(`[JS Parser] Light parsing ${url} to determine subtype`);
        
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Range': 'bytes=0-4095' // Request just the first 4KB
            }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[JS Parser] ❌ FAILED light parsing ${url}: ${response.status}`);
            return { isValid: false, subtype: 'fetch-failed' };
        }
        
        const content = await response.text();
        
        // Analyze the content based on type
        let result;
        if (type === 'hls') {
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
        } 
        else if (type === 'dash') {
            // Check for basic MPD structure
            if (content.includes('<MPD') && (content.includes('</MPD') || 
                content.includes('xmlns="urn:mpeg:dash:schema:mpd'))) {
                
                // Check if it has AdaptationSet/Representation (master)
                if (content.includes('<AdaptationSet') && content.includes('<Representation')) {
                    result = { isValid: true, subtype: 'dash-master', isMaster: true };
                }
                // Otherwise it's probably a single representation variant
                else {
                    result = { isValid: true, subtype: 'dash-variant', isVariant: true };
                }
            }
            else {
                result = { isValid: false, subtype: 'not-a-dash-video' };
            }
        }
        else {
            result = { isValid: false, subtype: 'unknown-type' };
        }
        
        console.log(`[JS Parser] ✓ COMPLETED light parsing ${url}: ${result.subtype}`);
        return result;
    } catch (error) {
        console.log(`[JS Parser] ❌ ERROR light parsing ${url}: ${error.message}`);
        return { isValid: false, subtype: 'parse-error' };
    } finally {
        // Clean up
        processingRequests.light.delete(normalizedUrl);
    }
}

/**
 * Perform full parsing of HLS/DASH master playlists to extract variant information
 * This function extracts complete information about all variants in a master playlist
 * 
 * @param {string} url - The URL of the master playlist
 * @param {string} subtype - The subtype from light parsing ('hls-master' or 'dash-master')
 * @returns {Promise<{variants: Array, duration: number}>} - Complete variant information
 */
export async function fullParseContent(url, subtype) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full.has(normalizedUrl)) {
        return { variants: [], status: 'processing' };
    }
    
    // Mark as being processed
    processingRequests.full.add(normalizedUrl);
    
    try {
        console.log(`[JS Parser] Full parsing ${url} (${subtype})`);
        
        // Fetch the full content of the playlist
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);  // 10 second timeout
        
        const response = await fetch(url, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[JS Parser] ❌ FAILED full parsing ${url}: ${response.status}`);
            return { variants: [], status: 'fetch-failed' };
        }
        
        const content = await response.text();
        const baseUrl = getBaseDirectory(url);
        
        // Process based on subtype
        let result;
        if (subtype === 'hls-master') {
            result = parseHlsMaster(content, baseUrl, url);
            
            // For HLS masters, calculate the duration for all variants
            if (result.variants.length > 0) {
                console.log(`[JS Parser] Calculating duration for ${result.variants.length} variants`);
                
                // Process all variants sequentially using Promise.all for better parallel processing
                const durationPromises = result.variants.map(async (variant, index) => {
                    try {
                        // Parse the variant to extract all metadata
                        const variantInfo = await parseHlsVariant(variant.url);
                        
                        // Add metadata to variant only if we got valid duration
                        if (variantInfo.duration > 0) {
                            console.log(`[JS Parser] Calculated duration for variant ${index+1}/${result.variants.length}: ${variantInfo.duration}s`);
                            
                            // Store duration and other metadata in variant's jsMeta
                            variant.jsMeta.duration = variantInfo.duration;
                            variant.jsMeta.isLive = variantInfo.isLive;
                            variant.jsMeta.isEncrypted = variantInfo.isEncrypted || false;
                            
                            // Add encryption type only if encryption is detected
                            if (variantInfo.isEncrypted && variantInfo.encryptionType) {
                                variant.jsMeta.encryptionType = variantInfo.encryptionType;
                            }
                            
                            // Update estimated file size with accurate duration
                            const effectiveBandwidth = variant.jsMeta.averageBandwidth || variant.jsMeta.bandwidth;
                            variant.jsMeta.estimatedFileSize = calculateEstimatedFileSize(effectiveBandwidth, variantInfo.duration);
                            
                            // Log the stream type
                            console.log(`[JS Parser] Variant ${index+1} is ${variantInfo.isLive ? 'LIVE' : 'VOD'}`);
                        }
                    } catch (error) {
                        console.error(`[JS Parser] Failed to parse variant ${index+1}: ${error.message}`);
                    }
                });
                
                // Wait for all variant duration calculations to complete
                await Promise.all(durationPromises);
            }
        } else if (subtype === 'dash-master') {
            result = parseDashMaster(content, baseUrl, url);
        } else {
            console.log(`[JS Parser] ❌ FAILED full parsing ${url}: unsupported subtype ${subtype}`);
            return { variants: [], status: 'unsupported-subtype' };
        }
        
        // Log success message here inside the try block to ensure it only happens on success
        console.log(`[JS Parser] ✓ COMPLETED full parsing ${url}: found ${result.variants.length} variants`);
        return result;
    } catch (error) {
        console.error(`[JS Parser] ❌ ERROR full parsing ${url}: ${error.message}`);
        return { variants: [], status: 'parse-error', error: error.message };
    } finally {
        // Clean up
        processingRequests.full.delete(normalizedUrl);
    }
}

/**
 * Parse an HLS variant playlist to extract full metadata
 * @param {string} variantUrl - URL of the HLS variant playlist
 * @returns {Promise<Object>} - Complete variant metadata
 */
async function parseHlsVariant(variantUrl) {
    try {
        // Set up request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);  // 5 second timeout
        
        const response = await fetch(variantUrl, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[JS Parser] ❌ FAILED fetching variant ${variantUrl}: ${response.status}`);
            return { duration: null, isLive: true };
        }
        
        const content = await response.text();
        
        // Extract different types of metadata from variant playlist
        const durationInfo = calculateHlsVariantDuration(content);
        const encryptionInfo = extractHlsEncryptionInfo(content);
        
        // Build a complete result object
        const result = {
            duration: durationInfo.duration,
            isLive: durationInfo.isLive,
            isEncrypted: encryptionInfo.isEncrypted
        };
        
        // Only add encryptionType if encryption is detected
        if (encryptionInfo.isEncrypted && encryptionInfo.encryptionType) {
            result.encryptionType = encryptionInfo.encryptionType;
        }
        
        return result;
    } catch (error) {
        console.error(`[JS Parser] ❌ ERROR parsing variant ${variantUrl}: ${error.message}`);
        return { duration: null, isLive: true };
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
 * Calculate estimated file size from bitrate and duration
 * 
 * @param {number} bitrate - Bitrate in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number|null} - Estimated file size in bytes or null if inputs are invalid
 */
function calculateEstimatedFileSize(bitrate, duration) {
    if (!bitrate || !duration || isNaN(bitrate) || isNaN(duration)) {
        return null;
    }
    
    // Convert bitrate (bits/s) * duration (s) to bytes (divide by 8)
    return Math.round((bitrate * duration) / 8);
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
                jsMeta: {
                    bandwidth: currentStreamInf.bandwidth,
                    averageBandwidth: currentStreamInf.averageBandwidth,
                    codecs: currentStreamInf.codecs,
                    resolution: currentStreamInf.resolution,
                    width: currentStreamInf.width,
                    height: currentStreamInf.height,
                    frameRate: currentStreamInf.frameRate
                    // estimatedFileSize will be added later with accurate duration
                },
                source: 'js-parser',
                timestamp: Date.now()
            };
            
            variants.push(variant);
            currentStreamInf = null;
        }
    }
    
    return { 
        variants,
        status: 'success'
        // No longer returning duration as it wasn't accurate
    };
}

/**
 * Parse DASH MPD content to extract variant information
 * 
 * @param {string} content - The MPD content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL
 * @returns {Object} Object containing variants array and playlist info
 */
function parseDashMaster(content, baseUrl, masterUrl) {
    const variants = [];
    
    try {
        // Use regex-based approach instead of DOMParser which isn't available in background context
        console.log(`[JS Parser] Using regex-based parser for DASH MPD`);
        
        // Extract duration from MPD tag
        const durationMatch = content.match(/mediaPresentationDuration="([^"]+)"/);
        const duration = durationMatch ? parseDashDuration(durationMatch[1]) : 0;
        
        // Check if this is a live stream (type="dynamic")
        const isLive = content.match(/type="dynamic"/i) !== null;
        
        // Check for encryption/DRM
        const isEncrypted = content.includes('<ContentProtection') || content.includes('cenc:') || content.includes('dashif:');
        
        // Try to extract encryption type if present
        let encryptionType = null;
        if (isEncrypted) {
            // Check for common encryption schemes
            if (content.includes('urn:mpeg:dash:mp4protection:2011')) {
                encryptionType = 'cenc';
            } else if (content.includes('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')) {
                encryptionType = 'widevine';
            } else if (content.includes('urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95')) {
                encryptionType = 'playready';
            } else if (content.includes('urn:uuid:f239e769-efa3-4850-9c16-a903c6932efb')) {
                encryptionType = 'clearkey';
            } else if (content.includes('urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2')) {
                encryptionType = 'fairplay';
            }
        }
        
        // Extract all AdaptationSet blocks
        const adaptationSets = extractAdaptationSets(content);
        
        // First pass: Identify which adaptation set is audio
        let audioAdaptationSet = null;
        let globalAudioCodec = null;
        
        for (const adaptationSet of adaptationSets) {
            // Determine if this is audio
            const mimeType = extractAttribute(adaptationSet, 'mimeType') || '';
            const contentType = extractAttribute(adaptationSet, 'contentType') || '';
            
            if (mimeType.includes('audio') || contentType === 'audio') {
                audioAdaptationSet = adaptationSet;
                
                // Check representations first for audio codec
                const audioRepresentations = extractRepresentations(audioAdaptationSet);
                if (audioRepresentations.length > 0) {
                    // Try to get codec from first audio representation
                    globalAudioCodec = extractAttribute(audioRepresentations[0], 'codecs');
                }
                
                // If not found in representations, check adaptation set level
                if (!globalAudioCodec) {
                    globalAudioCodec = extractAttribute(audioAdaptationSet, 'codecs');
                }
                
                if (globalAudioCodec) {
                    console.log(`[JS Parser] Found audio codec: ${globalAudioCodec}`);
                }
                
                break;
            }
        }
        
        // Second pass: Process video adaptations
        for (const adaptationSet of adaptationSets) {
            // Determine if this is video, audio, or other
            const mimeType = extractAttribute(adaptationSet, 'mimeType') || null;
            const contentType = extractAttribute(adaptationSet, 'contentType') || null;
            const isVideo = mimeType.includes('video') || contentType === 'video';
            
            // We primarily care about video adaptations for variant selection
            if (isVideo) {
                // Get adaptation level codec (fallback)
                const adaptationSetVideoCodec = extractAttribute(adaptationSet, 'codecs');
                
                // Process each representation
                const representations = extractRepresentations(adaptationSet);
                for (const representation of representations) {
                    // Extract variant details
                    const id = extractAttribute(representation, 'id') || null;
                    const bandwidth = parseInt(extractAttribute(representation, 'bandwidth') || '0', 10);
                    
                    // First check for codec at representation level (preferred)
                    let videoCodec = extractAttribute(representation, 'codecs');
                    
                    // If not found, fall back to adaptation set level
                    if (!videoCodec) {
                        videoCodec = adaptationSetVideoCodec;
                    }
                    
                    // Combine codecs in "videoCodec,audioCodec" format (consistent with HLS)
                    let combinedCodecs = null;
                    if (videoCodec && globalAudioCodec) {
                        combinedCodecs = `${videoCodec},${globalAudioCodec}`;
                    } else if (videoCodec) {
                        combinedCodecs = videoCodec;
                    } else if (globalAudioCodec) {
                        combinedCodecs = globalAudioCodec;
                    }
                    
                    const width = parseInt(extractAttribute(representation, 'width') || '0', 10);
                    const height = parseInt(extractAttribute(representation, 'height') || '0', 10);
                    const frameRate = parseFrameRate(extractAttribute(representation, 'frameRate') || null);
                    
                    // Calculate estimated file size if we have bandwidth and duration
                    const estimatedFileSize = calculateEstimatedFileSize(bandwidth, duration);
                    
                    // For standard DASH, we point to the master with representation ID
                    const variantUrl = masterUrl + `#representation=${id}`;
                    
                    // Create a variant entry with all the information
                    const variant = {
                        url: variantUrl,
                        normalizedUrl: normalizeUrl(variantUrl), 
                        id: id,
                        masterUrl: masterUrl,
                        hasKnownMaster: true,
                        type: 'dash',
                        subtype: 'dash-variant',
                        isVariant: true,
                        jsMeta: {
                            bandwidth: bandwidth,
                            codecs: combinedCodecs,
                            videoCodec: videoCodec,
                            audioCodec: globalAudioCodec,
                            width: width,
                            height: height,
                            frameRate: frameRate,
                            resolution: width && height ? `${width}x${height}` : null,
                            estimatedFileSize: estimatedFileSize,
                            isEncrypted: isEncrypted,
                            isLive: isLive
                        },
                        source: 'js-parser',
                        timestamp: Date.now()
                    };
                    
                    // Add encryption type only if encryption is detected
                    if (isEncrypted && encryptionType) {
                        variant.jsMeta.encryptionType = encryptionType;
                    }
                    
                    variants.push(variant);
                }
            }
        }
        
        return {
            variants,
            duration: duration,
            status: 'success'
        };
    } catch (error) {
        console.error(`[JS Parser] ❌ ERROR parsing DASH MPD: ${error.message}`);
        return { variants: [], status: 'xml-parse-error' };
    }
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
        frameRate: null
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
                result.frameRate = parseFloat(value);
                break;
        }
    }
    
    return result;
}

/**
 * Resolve a URL relative to a base URL
 *
 * @param {string} baseUrl - The base URL
 * @param {string} relativeUrl - The relative URL to resolve
 * @returns {string} The resolved URL
 */
function resolveUrl(baseUrl, relativeUrl) {
    // If the URL is already absolute, return it as is
    if (relativeUrl.match(/^https?:\/\//i)) {
        return relativeUrl;
    }
    
    // Make sure the base URL ends with a slash
    if (!baseUrl.endsWith('/')) {
        baseUrl += '/';
    }
    
    // Handle relative paths with "../"
    if (relativeUrl.startsWith('../')) {
        // Remove last directory from baseUrl
        baseUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/', baseUrl.length - 2) + 1);
        // Remove '../' from relative URL
        relativeUrl = relativeUrl.substring(3);
        // Recursively handle multiple '../'
        return resolveUrl(baseUrl, relativeUrl);
    }
    
    // Remove './' from the start of the relative URL
    if (relativeUrl.startsWith('./')) {
        relativeUrl = relativeUrl.substring(2);
    }
    
    // Join the base URL and the relative URL
    return baseUrl + relativeUrl;
}

/**
 * Parse DASH duration string (ISO 8601 format)
 * Example: PT1H22M3.546S
 * 
 * @param {string} durationStr - The duration string
 * @returns {number} Duration in seconds
 */
function parseDashDuration(durationStr) {
    if (!durationStr) return 0;
    
    // Handle full ISO 8601 duration format including years, months, days
    // P[n]Y[n]M[n]DT[n]H[n]M[n]S
    const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = durationStr.match(regex);
    
    if (!matches) return 0;
    
    // Extract time components (we're simplifying by using approximate values for years/months)
    const years = matches[1] ? parseInt(matches[1], 10) * 31536000 : 0;   // Approximate year as 365 days
    const months = matches[2] ? parseInt(matches[2], 10) * 2592000 : 0;   // Approximate month as 30 days
    const days = matches[3] ? parseInt(matches[3], 10) * 86400 : 0;
    const hours = matches[4] ? parseInt(matches[4], 10) * 3600 : 0;
    const minutes = matches[5] ? parseInt(matches[5], 10) * 60 : 0;
    const seconds = matches[6] ? parseFloat(matches[6]) : 0;
    
    // Calculate the total and round to full seconds
    return Math.round(years + months + days + hours + minutes + seconds);
}

/**
 * Parse frame rate string, which can be a fraction (e.g., "30000/1001") or a number
 * 
 * @param {string} frameRateStr - The frame rate string
 * @returns {number} Parsed frame rate
 */
function parseFrameRate(frameRateStr) {
    if (!frameRateStr) return 0;
    
    // Check if it's a fraction
    if (frameRateStr.includes('/')) {
        const [numerator, denominator] = frameRateStr.split('/');
        return parseInt(numerator, 10) / parseInt(denominator, 10);
    }
    
    // Otherwise it's a direct number
    return parseFloat(frameRateStr);
}

/**
 * Get the base directory of a URL
 * 
 * @param {string} url - The URL
 * @returns {string} The base directory URL
 */
function getBaseDirectory(url) {
    try {
        // Get everything up to the last '/'
        return url.substring(0, url.lastIndexOf('/') + 1);
    } catch (error) {
        return url;
    }
}

/**
 * Helper function to extract attributes from XML tags
 * 
 * @param {string} xmlString - The XML string to extract from
 * @param {string} attributeName - The attribute name to extract
 * @returns {string|null} The attribute value or null
 */
function extractAttribute(xmlString, attributeName) {
    const regex = new RegExp(`\\b${attributeName}="([^"]*)"`, 'i');
    const match = xmlString.match(regex);
    return match ? match[1] : null;
}

/**
 * Helper function to extract AdaptationSet sections
 * 
 * @param {string} content - The MPD content
 * @returns {Array<string>} Array of AdaptationSet XML strings
 */
function extractAdaptationSets(content) {
    const adaptationSets = [];
    const regex = /<AdaptationSet[^>]*>[\s\S]*?<\/AdaptationSet>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        adaptationSets.push(match[0]);
    }
    return adaptationSets;
}

/**
 * Helper function to extract Representation sections
 * 
 * @param {string} adaptationSetContent - The AdaptationSet XML content
 * @returns {Array<string>} Array of Representation XML strings
 */
function extractRepresentations(adaptationSetContent) {
    const representations = [];
    const regex = /<Representation[^>]*>[\s\S]*?<\/Representation>|<Representation[^\/]*\/>/g;
    let match;
    while ((match = regex.exec(adaptationSetContent)) !== null) {
        representations.push(match[0]);
    }
    return representations;
}
