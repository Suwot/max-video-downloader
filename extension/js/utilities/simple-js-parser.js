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
                result = { isValid: true, subtype: 'hls-master' };
            } 
            // Check if it's a variant/media playlist (contains #EXTINF)
            else if (content.includes('#EXTINF')) {
                result = { isValid: true, subtype: 'hls-variant' };
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
                    result = { isValid: true, subtype: 'dash-master' };
                }
                // Otherwise it's probably a single representation variant
                else {
                    result = { isValid: true, subtype: 'dash-variant' };
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

// TODO: Add fullParseContent function in future implementation

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
        } else if (subtype === 'dash-master') {
            result = parseDashMaster(content, baseUrl, url);
        } else {
            console.log(`[JS Parser] ❌ FAILED full parsing ${url}: unsupported subtype ${subtype}`);
            return { variants: [], status: 'unsupported-subtype' };
        }
        
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
    let globalDuration = 0;
    
    // Check for duration in the main playlist
    const durationMatch = content.match(/#EXT-X-TARGETDURATION:([0-9.]+)/);
    if (durationMatch) {
        globalDuration = parseFloat(durationMatch[1]);
    }
    
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
            const variant = {
                url: variantUrl,
                normalizedUrl: normalizeUrl(variantUrl),
                masterUrl: masterUrl,
                hasKnownMaster: true,
                type: 'hls',
                subtype: 'hls-variant',
                isVariant: true,
                bandwidth: currentStreamInf.bandwidth,
                averageBandwidth: currentStreamInf.averageBandwidth,
                codecs: currentStreamInf.codecs,
                resolution: currentStreamInf.resolution,
                width: currentStreamInf.width,
                height: currentStreamInf.height,
                frameRate: currentStreamInf.frameRate,
                source: 'js-parser',
                timestamp: Date.now()
            };
            
            variants.push(variant);
            currentStreamInf = null;
        }
    }
    
    return { 
        variants,
        duration: globalDuration,
        status: 'success'
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
        // Parse XML content
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, "text/xml");
        
        // Extract duration information
        let duration = 0;
        const mpdNode = xmlDoc.querySelector('MPD');
        if (mpdNode) {
            const mediaPresentationDuration = mpdNode.getAttribute('mediaPresentationDuration');
            if (mediaPresentationDuration) {
                duration = parseDashDuration(mediaPresentationDuration);
            }
        }
        
        // Process each adaptation set
        const adaptationSets = xmlDoc.querySelectorAll('AdaptationSet');
        for (const adaptationSet of adaptationSets) {
            // Determine if this is video, audio, or other
            const mimeType = adaptationSet.getAttribute('mimeType') || '';
            const contentType = adaptationSet.getAttribute('contentType') || '';
            const isVideo = mimeType.includes('video') || contentType === 'video';
            
            // We primarily care about video adaptations for variant selection
            if (isVideo) {
                // Process each representation
                const representations = adaptationSet.querySelectorAll('Representation');
                for (const representation of representations) {
                    // Extract variant details
                    const id = representation.getAttribute('id') || '';
                    const bandwidth = parseInt(representation.getAttribute('bandwidth') || '0', 10);
                    const codecs = representation.getAttribute('codecs') || '';
                    const width = parseInt(representation.getAttribute('width') || '0', 10);
                    const height = parseInt(representation.getAttribute('height') || '0', 10);
                    const frameRate = parseFrameRate(representation.getAttribute('frameRate') || '');
                    
                    // Find BaseURL - could be in representation, adaptationSet, or MPD
                    let segmentTemplate = representation.querySelector('SegmentTemplate') || 
                                         adaptationSet.querySelector('SegmentTemplate');
                    
                    let variantUrl = masterUrl;
                    if (segmentTemplate) {
                        // For standard DASH, we point to the master since we need the MPD
                        // to properly resolve segments
                        variantUrl = masterUrl + `#representation=${id}`;
                    }
                    
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
                        bandwidth: bandwidth,
                        codecs: codecs,
                        width: width,
                        height: height,
                        frameRate: frameRate,
                        source: 'js-parser',
                        timestamp: Date.now()
                    };
                    
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
        bandwidth: 0,
        averageBandwidth: 0,
        codecs: '',
        resolution: '',
        width: 0,
        height: 0,
        frameRate: 0
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
    
    // Handle ISO 8601 duration format
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = durationStr.match(regex);
    
    if (!matches) return 0;
    
    const hours = matches[1] ? parseInt(matches[1], 10) : 0;
    const minutes = matches[2] ? parseInt(matches[2], 10) : 0;
    const seconds = matches[3] ? parseFloat(matches[3]) : 0;
    
    return hours * 3600 + minutes * 60 + seconds;
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
