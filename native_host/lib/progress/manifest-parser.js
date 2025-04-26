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
            return null;
        }

        try {
            logDebug(`Fetching ${type} manifest from ${url}`);
            const content = await this.fetchManifest(url);
            
            if (!content) {
                logDebug('Failed to fetch manifest');
                return null;
            }

            if (type === 'hls') {
                return this.parseHLS(content, url);
            } else if (type === 'dash') {
                return this.parseDASH(content, url);
            } else {
                logDebug('Unknown manifest type:', type);
                return null;
            }
        } catch (error) {
            logDebug('Error parsing manifest:', error.message);
            return null;
        }
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
                
                const options = {
                    method: 'GET',
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    timeout: 10000, // 10 second timeout
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };
                
                const req = protocol.request(options, (res) => {
                    if (res.statusCode !== 200) {
                        logDebug(`Failed to fetch manifest: HTTP ${res.statusCode}`);
                        resolve(null);
                        return;
                    }
                    
                    let data = '';
                    
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('end', () => {
                        resolve(data);
                    });
                });
                
                req.on('error', (error) => {
                    logDebug('Error fetching manifest:', error.message);
                    resolve(null);
                });
                
                req.on('timeout', () => {
                    req.destroy();
                    logDebug('Manifest request timed out');
                    resolve(null);
                });
                
                req.end();
                
            } catch (error) {
                logDebug('Error in fetch manifest:', error.message);
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