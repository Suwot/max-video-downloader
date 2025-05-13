/**
 * @ai-guide-component ManifestParser
 * @ai-guide-description Parses HLS (.m3u8) and DASH (.mpd) streaming manifests
 * @ai-guide-responsibilities
 * - Extracts segment information from streaming manifests
 * - Identifies total duration, segment count and bitrate information
 * - Supports both HLS and DASH formats
 * - Handles master playlists with multiple variants
 */

// lib/progress/manifest-parser.js
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { logDebug } = require('../../utils/logger');

/**
 * ManifestParser for HLS and DASH streaming manifests
 * Extracts metadata needed for progress tracking
 */
class ManifestParser {
    /**
     * Parse a streaming manifest
     * @param {string} url URL of the manifest
     * @param {string} type Manifest type ('hls' or 'dash')
     * @returns {Promise<Object|null>} Manifest info or null if failed
     */
    async parse(url, type) {
        if (!url) {
            logDebug('MANIFEST-PARSER ERROR: No URL provided');
            return null;
        }

        try {
            logDebug(`Fetching ${type} manifest from ${url}`);
            
            // Validate URL format before fetching
            try {
                new URL(url);
            } catch (urlError) {
                logDebug(`MANIFEST-PARSER ERROR: Invalid URL format: ${url}`, urlError);
                return null;
            }
            
            const content = await this.fetchManifest(url);
            
            if (!content) {
                logDebug(`MANIFEST-PARSER ERROR: Failed to fetch manifest content from ${url}`);
                return null;
            }
            
            // Log the first 200 characters of content to verify it's valid
            logDebug(`MANIFEST-PARSER: Content preview: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`);

            if (type === 'hls') {
                const result = this.parseHLS(content, url);
                if (!result.segmentCount && !result.totalDuration) {
                    logDebug(`MANIFEST-PARSER ERROR: HLS parsing failed to extract segments or duration from ${url}`);
                }
                return result;
            } else if (type === 'dash') {
                const result = this.parseDASH(content, url);
                if (!result.segmentCount && !result.totalDuration) {
                    logDebug(`MANIFEST-PARSER ERROR: DASH parsing failed to extract segments or duration from ${url}`);
                }
                return result;
            } else {
                logDebug(`MANIFEST-PARSER ERROR: Unknown manifest type: ${type}`);
                return null;
            }
        } catch (error) {
            logDebug('MANIFEST-PARSER ERROR: Exception during parsing:', error.message);
            logDebug('MANIFEST-PARSER ERROR: Stack trace:', error.stack);
            return null;
        }
    }

    /**
     * Light parse a manifest to detect if it's a master playlist without fetching the entire file
     * @param {string} url URL of the manifest
     * @param {string} type Manifest type ('hls' or 'dash')
     * @returns {Promise<Object|null>} Basic manifest info or null if failed
     */
    async lightParse(url, type) {
        if (!url) {
            logDebug('MANIFEST-PARSER ERROR: No URL provided for light parsing');
            return null;
        }

        try {
            logDebug(`Light parsing ${type} manifest from ${url}`);
            
            // Validate URL format before fetching
            try {
                new URL(url);
            } catch (urlError) {
                logDebug(`MANIFEST-PARSER ERROR: Invalid URL format: ${url}`, urlError);
                return null;
            }
            
            // Use fetch with a range request to get just the first part of the manifest
            const content = await this.fetchPartialManifest(url);
            
            if (!content) {
                logDebug(`MANIFEST-PARSER ERROR: Failed to fetch manifest content from ${url}`);
                return null;
            }
            
            // Log the first 200 characters of content to verify it's valid
            logDebug(`MANIFEST-PARSER: Content preview: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`);

            // Basic parsing result structure
            const result = {
                url: url,
                type: type,
                isLightParsed: true
            };
            
            // HLS detection
            if (type === 'hls') {
                // For HLS, check for STREAM-INF tag which indicates a master playlist
                const isMaster = content.includes('#EXT-X-STREAM-INF:');
                
                return {
                    ...result,
                    isMaster: isMaster,
                    isVariant: !isMaster
                };
            }
            
            // DASH detection
            if (type === 'dash') {
                // For DASH, check for AdaptationSet and Representation tags
                const hasMasterElements = content.includes('<AdaptationSet') && 
                                         content.includes('<Representation');
                
                return {
                    ...result,  
                    isMaster: hasMasterElements,
                    isVariant: !hasMasterElements
                };
            }
            
            return null;
        } catch (error) {
            logDebug('MANIFEST-PARSER ERROR: Exception during light parsing:', error.message);
            logDebug('MANIFEST-PARSER ERROR: Stack trace:', error.stack);
            return null;
        }
    }
    
    /**
     * Fetch just the first part of manifest content
     * @param {string} url Manifest URL
     * @returns {Promise<string|null>} First part of manifest content or null if failed
     */
    fetchPartialManifest(url) {
        return new Promise((resolve) => {
            try {
                const urlObj = new URL(url);
                const protocol = urlObj.protocol === 'https:' ? https : http;
                
                logDebug(`MANIFEST-PARSER: Light fetching from ${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}${urlObj.search}`);
                
                const options = {
                    method: 'GET',
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    timeout: 5000, // 5 second timeout for light parsing
                    headers: {
                        'Range': 'bytes=0-2047', // Get first 2KB which is usually enough to determine manifest type
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive'
                    }
                };
                
                const req = protocol.request(options, (res) => {
                    let data = '';
                    
                    res.on('data', (chunk) => {
                        data += chunk.toString();
                    });
                    
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(data);
                        } else {
                            logDebug(`MANIFEST-PARSER ERROR: HTTP error ${res.statusCode} during light parsing`);
                            resolve(null);
                        }
                    });
                });
                
                req.on('error', (error) => {
                    logDebug(`MANIFEST-PARSER ERROR: Network error during light parsing: ${error.message}`);
                    resolve(null);
                });
                
                req.setTimeout(5000, () => {
                    logDebug('MANIFEST-PARSER ERROR: Timeout during light parsing');
                    req.destroy();
                    resolve(null);
                });
                
                req.end();
            } catch (error) {
                logDebug(`MANIFEST-PARSER ERROR: Exception in light fetch: ${error.message}`);
                resolve(null);
            }
        });
    }

    /**
     * Fetch manifest content from URL
     * @param {string} url Manifest URL
     * @returns {Promise<string|null>} Manifest content or null if failed
     */
    fetchManifest(url) {
        return new Promise((resolve) => {
            try {
                const urlObj = new URL(url);
                const protocol = urlObj.protocol === 'https:' ? https : http;
                
                logDebug(`MANIFEST-PARSER: Fetching from ${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}${urlObj.search}`);
                
                const options = {
                    method: 'GET',
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    timeout: 10000, // 10 second timeout
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive'
                    }
                };
                
                const req = protocol.request(options, (res) => {
                    logDebug(`MANIFEST-PARSER: Response status: HTTP ${res.statusCode}`);
                    logDebug(`MANIFEST-PARSER: Response headers:`, JSON.stringify(res.headers, null, 2));
                    
                    if (res.statusCode !== 200) {
                        logDebug(`MANIFEST-PARSER ERROR: Failed to fetch manifest: HTTP ${res.statusCode} from ${url}`);
                        resolve(null);
                        return;
                    }
                    
                    let data = '';
                    
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('end', () => {
                        logDebug(`MANIFEST-PARSER: Successfully fetched manifest, size: ${data.length} bytes`);
                        resolve(data);
                    });
                });
                
                req.on('error', (error) => {
                    logDebug(`MANIFEST-PARSER ERROR: Error fetching manifest: ${error.message}`);
                    logDebug(`MANIFEST-PARSER ERROR: Network error details:`, error.stack || '(No stack trace)');
                    resolve(null);
                });
                
                req.on('timeout', () => {
                    req.destroy();
                    logDebug(`MANIFEST-PARSER ERROR: Request timed out after 10 seconds for ${url}`);
                    resolve(null);
                });
                
                req.end();
                
            } catch (error) {
                logDebug(`MANIFEST-PARSER ERROR: Exception in fetch manifest: ${error.message}`);
                logDebug(`MANIFEST-PARSER ERROR: Stack trace:`, error.stack || '(No stack trace)');
                resolve(null);
            }
        });
    }

    /**
     * Parse HLS manifest (.m3u8)
     * @param {string} content Manifest content
     * @param {string} baseUrl Base URL for resolving relative paths
     * @returns {Object} Parsed manifest info
     */
    parseHLS(content, baseUrl) {
        const lines = content.split('\n').map(line => line.trim());
        const result = {
            isMaster: false,
            segmentCount: 0,
            totalDuration: 0,
            bandwidth: 0,
            variants: []
        };
        
        // Check if this is a master playlist
        const variantRegex = /#EXT-X-STREAM-INF:([^\n]*)[\n,\r]+([^\n]*)/g;
        let variantMatch;
        
        while ((variantMatch = variantRegex.exec(content)) !== null) {
            result.isMaster = true;
            const attributes = variantMatch[1];
            const uri = variantMatch[2];
            
            // Extract bandwidth
            const bandwidthMatch = attributes.match(/BANDWIDTH=(\d+)/);
            const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            
            result.variants.push({
                bandwidth,
                url: this.resolveUrl(baseUrl, uri)
            });
        }
        
        // If this is a master playlist, return without segment parsing
        if (result.isMaster && result.variants.length > 0) {
            // Sort by bandwidth (highest first)
            result.variants.sort((a, b) => b.bandwidth - a.bandwidth);
            result.bandwidth = result.variants[0].bandwidth;
            logDebug(`HLS master playlist with ${result.variants.length} variants`);
            return result;
        }
        
        // Parse segment information
        let segmentCount = 0;
        let totalDuration = 0;
        let segmentDuration = 0;
        let maxBandwidth = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Get segment duration
            if (line.startsWith('#EXTINF:')) {
                const durationMatch = line.match(/#EXTINF:([^,]*)/);
                if (durationMatch) {
                    segmentDuration = parseFloat(durationMatch[1]);
                    totalDuration += segmentDuration;
                }
            }
            // Count segments
            else if (!line.startsWith('#') && line.length > 0) {
                segmentCount++;
            }
            // Extract target duration
            else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                const targetDurationMatch = line.match(/#EXT-X-TARGETDURATION:(\d+)/);
                if (targetDurationMatch && segmentDuration === 0) {
                    segmentDuration = parseInt(targetDurationMatch[1], 10);
                }
            }
            // Extract bandwidth
            else if (line.startsWith('#EXT-X-BITRATE:')) {
                const bitrateMatch = line.match(/#EXT-X-BITRATE:(\d+)/);
                if (bitrateMatch) {
                    maxBandwidth = Math.max(maxBandwidth, parseInt(bitrateMatch[1], 10) * 1000); // Convert to bps
                }
            }
        }
        
        // If we have target duration but no segments found, estimate segment count
        if (segmentCount === 0 && totalDuration > 0) {
            segmentCount = Math.ceil(totalDuration / segmentDuration);
        }
        
        // If we don't have bandwidth from the manifest, estimate it
        // Use a conservative default of 5 Mbps for HD video
        if (maxBandwidth === 0) {
            maxBandwidth = 5000000; // 5 Mbps default
        }
        
        result.segmentCount = segmentCount;
        result.totalDuration = totalDuration;
        result.bandwidth = maxBandwidth;
        
        logDebug(`HLS media playlist: segments=${segmentCount}, duration=${totalDuration}s, bandwidth=${maxBandwidth/1000}kbps`);
        return result;
    }

    /**
     * Parse DASH manifest (.mpd)
     * @param {string} content Manifest content
     * @param {string} baseUrl Base URL for resolving relative paths
     * @returns {Object} Parsed manifest info
     */
    parseDASH(content, baseUrl) {
        const result = {
            segmentCount: 0,
            totalDuration: 0,
            bandwidth: 0,
            variants: []
        };
        
        try {
            // Duration - look for mediaPresentationDuration attribute
            const durationMatch = content.match(/mediaPresentationDuration="PT([^"]+)"/);
            if (durationMatch) {
                result.totalDuration = this.parseDashDuration(durationMatch[1]);
            }
            
            // Segments - look for SegmentTemplate with duration and timescale
            const segmentTemplate = content.match(/<SegmentTemplate[^>]*duration="(\d+)"[^>]*timescale="(\d+)"[^>]*>/);
            if (segmentTemplate && result.totalDuration > 0) {
                const segmentDuration = parseInt(segmentTemplate[1], 10) / parseInt(segmentTemplate[2], 10);
                result.segmentCount = Math.ceil(result.totalDuration / segmentDuration);
            }
            
            // Bandwidth - find all Representation elements with bandwidth attribute
            const bandwidthRegex = /<Representation[^>]*bandwidth="(\d+)"[^>]*>/g;
            let bandwidthMatch;
            let maxBandwidth = 0;
            
            while ((bandwidthMatch = bandwidthRegex.exec(content)) !== null) {
                const bandwidth = parseInt(bandwidthMatch[1], 10);
                maxBandwidth = Math.max(maxBandwidth, bandwidth);
            }
            
            result.bandwidth = maxBandwidth || 5000000; // Default to 5 Mbps if not found
            
            // If we don't have segments, try to estimate from duration and bandwidth
            if (result.segmentCount === 0 && result.totalDuration > 0) {
                // Assume 2-second segments, which is common
                result.segmentCount = Math.ceil(result.totalDuration / 2);
            }
            
            logDebug(`DASH manifest: duration=${result.totalDuration}s, segments=${result.segmentCount}, bandwidth=${result.bandwidth/1000}kbps`);
            return result;
            
        } catch (error) {
            logDebug('Error parsing DASH manifest:', error.message);
            return result;
        }
    }

    /**
     * Parse DASH duration format (e.g. PT1H30M15.5S)
     * @param {string} duration Duration string
     * @returns {number} Duration in seconds
     */
    parseDashDuration(duration) {
        let totalSeconds = 0;
        
        // Hours
        const hoursMatch = duration.match(/(\d+)H/);
        if (hoursMatch) {
            totalSeconds += parseInt(hoursMatch[1], 10) * 3600;
        }
        
        // Minutes
        const minutesMatch = duration.match(/(\d+)M/);
        if (minutesMatch) {
            totalSeconds += parseInt(minutesMatch[1], 10) * 60;
        }
        
        // Seconds
        const secondsMatch = duration.match(/(\d+(\.\d+)?)S/);
        if (secondsMatch) {
            totalSeconds += parseFloat(secondsMatch[1]);
        }
        
        return totalSeconds;
    }

    /**
     * Resolve relative URL against base URL
     * @param {string} base Base URL
     * @param {string} relative Relative URL
     * @returns {string} Resolved absolute URL
     */
    resolveUrl(base, relative) {
        if (!relative) {
            return base;
        }
        
        // Check if the URL is already absolute
        if (relative.match(/^(https?:)?\/\//)) {
            return relative;
        }
        
        // Parse the base URL
        const baseUrl = new URL(base);
        
        // If the relative path starts with a slash, it's relative to the domain root
        if (relative.startsWith('/')) {
            return `${baseUrl.protocol}//${baseUrl.host}${relative}`;
        }
        
        // Otherwise, it's relative to the current path
        // Get the directory part of the path
        const pathParts = baseUrl.pathname.split('/');
        pathParts.pop(); // Remove the filename
        const dirPath = pathParts.join('/');
        
        return `${baseUrl.protocol}//${baseUrl.host}${dirPath}/${relative}`;
    }
}

module.exports = ManifestParser;