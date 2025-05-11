/**
 * Simple JS Parser
 * Pure JavaScript-based parsing of streaming manifests without FFprobe
 * Provides lightweight and full parsing capabilities for HLS and DASH content
 */

import { normalizeUrl } from './normalize-url.js';

// Tracking URLs currently being light parsed
const processingRequests = new Set();

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
    if (processingRequests.has(normalizedUrl)) {
        return { isValid: true, subtype: 'processing' };
    }
    
    // Mark as being processed
    processingRequests.add(normalizedUrl);
    
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
            console.log(`[JS Parser] Failed to fetch ${url} for light parsing: ${response.status}`);
            return { isValid: false, subtype: 'fetch-failed' };
        }
        
        const content = await response.text();
        
        // Analyze the content based on type
        if (type === 'hls') {
            // Check if it's a master playlist (contains #EXT-X-STREAM-INF)
            if (content.includes('#EXT-X-STREAM-INF')) {
                return { isValid: true, subtype: 'hls-master' };
            } 
            // Check if it's a variant/media playlist (contains #EXTINF)
            else if (content.includes('#EXTINF')) {
                return { isValid: true, subtype: 'hls-variant' };
            }
            // Neither master nor variant markers found
            return { isValid: false, subtype: 'not-a-video' };
        } 
        else if (type === 'dash') {
            // Check for basic MPD structure
            if (content.includes('<MPD') && (content.includes('</MPD') || 
                content.includes('xmlns="urn:mpeg:dash:schema:mpd'))) {
                
                // Check if it has AdaptationSet/Representation (master)
                if (content.includes('<AdaptationSet') && content.includes('<Representation')) {
                    return { isValid: true, subtype: 'dash-master' };
                }
                // Otherwise it's probably a single representation variant
                else {
                    return { isValid: true, subtype: 'dash-variant' };
                }
            }
            return { isValid: false, subtype: 'not-a-dash-video' };
        }
        
        return { isValid: false, subtype: 'unknown-type' };
    } catch (error) {
        console.log(`[JS Parser] Error during light parsing of ${url}: ${error.message}`);
        return { isValid: false, subtype: 'parse-error' };
    } finally {
        // Clean up
        processingRequests.delete(normalizedUrl);
    }
}

// TODO: Add fullParseContent function in future implementation
