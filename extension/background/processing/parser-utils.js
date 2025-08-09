/**
 * Parser Utilities
 * Common utilities for HLS and DASH parsing operations
 */

import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('Parser Utils');
logger.setLevel('ERROR');

/**
 * Simple codec to container mapping for DASH tracks
 * Only includes cases that need specific containers, everything else falls back to universal containers
 */
const DASH_CODEC_CONTAINERS = {
    // Video codecs that need WebM
    'vp8': 'webm',
    'vp9': 'webm', 
    'vp09': 'webm',
    'vp80': 'webm',
    'av01': 'webm',
    'av1': 'webm',
    
    // Audio codecs with specific containers
    'mp4a': 'm4a',
    'aac': 'm4a',
    'opus': 'webm',
    'vorbis': 'ogg',
    'flac': 'flac'
    // Everything else falls back to mp4 (video) or mp3 (audio)
};

/**
 * MIME type to container mapping for DASH tracks
 */
const DASH_MIME_CONTAINERS = {
    // Video
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/mkv': 'mkv',
    
    // Audio
    'audio/mp4': 'm4a',
    'audio/aac': 'm4a',
    'audio/x-aac': 'm4a',
    'audio/webm': 'webm',
    'audio/opus': 'webm',
    'audio/ogg': 'ogg',
    'audio/vorbis': 'ogg',
    'audio/flac': 'flac',
    
    // Subtitles
    'text/vtt': 'vtt',
    'text/webvtt': 'vtt',
    'application/x-subrip': 'srt',
    'text/srt': 'srt',
    'application/ttml+xml': 'ttml',
    'application/ttaf+xml': 'ttml'
};

/**
 * Helper function to extract attributes from XML tags
 * 
 * @param {string} xmlString - The XML string to extract from
 * @param {string} attributeName - The attribute name to extract
 * @returns {string|null} The attribute value or null
 */
export function extractAttribute(xmlString, attributeName) {
    const regex = new RegExp(`\\b${attributeName}="([^"]*)"`, 'i');
    const match = xmlString.match(regex);
    return match ? match[1] : null;
}

/**
 * Calculate estimated file size from bitrate and duration
 * 
 * @param {number} bitrate - Bitrate in bits per second
 * @param {number} duration - Duration in seconds
 * @returns {number|null} - Estimated file size in bytes or null if inputs are invalid
 */
export function calculateEstimatedFileSizeBytes(bitrate, duration) {
    if (!bitrate || !duration || isNaN(bitrate) || isNaN(duration)) {
        return null;
    }
    
    // Convert bitrate (bits/s) * duration (s) to bytes (divide by 8)
    return Math.round((bitrate * duration) / 8);
}

/**
 * Parse frame rate string, which can be a fraction (e.g., "30000/1001") or a number
 * 
 * @param {string} frameRateStr - The frame rate string
 * @returns {number} Parsed frame rate
 */
export function parseFrameRate(frameRateStr) {
    if (!frameRateStr) return 0;
    
    // Check if it's a fraction
    if (frameRateStr.includes('/')) {
        const [numerator, denominator] = frameRateStr.split('/');
        const frameRate = parseInt(numerator, 10) / parseInt(denominator, 10);
        
        // Round to nearest integer
        return Math.round(frameRate);
    }
    
    // Otherwise it's a direct number
    return Math.round(parseFloat(frameRateStr));
}

/**
 * Resolve a URL relative to a base URL
 *
 * @param {string} baseUrl - The base URL
 * @param {string} relativeUrl - The relative URL to resolve
 * @returns {string} The resolved URL
 */
export function resolveUrl(baseUrl, relativeUrl) {
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
 * Detect container format for DASH tracks based on codecs and mimeType
 * 
 * @param {Object} options - Detection options
 * @param {string} [options.mimeType] - MIME type from DASH manifest
 * @param {string} [options.codecs] - Codec string from DASH manifest
 * @param {string} [options.mediaType] - Media type ('video', 'audio', 'subtitle')
 * @param {string} [options.videoContainer] - Video container for subtitle context
 * @returns {Object} Container detection result with container and reason
 */
export function detectContainerFromDashTrack(options = {}) {
    const { mimeType, codecs, mediaType, videoContainer } = options;
    
    // 1. Try codec detection first (most specific)
    if (codecs) {
        const codecList = codecs.split(',').map(c => c.trim().split('.')[0].toLowerCase());
        for (const codec of codecList) {
            if (DASH_CODEC_CONTAINERS[codec]) {
                return {
                    container: DASH_CODEC_CONTAINERS[codec],
                    reason: `codec: ${codec}`
                };
            }
        }
    }
    
    // 2. Try MIME type detection
    if (mimeType) {
        const normalizedMime = mimeType.toLowerCase().split(';')[0];
        if (DASH_MIME_CONTAINERS[normalizedMime]) {
            return {
                container: DASH_MIME_CONTAINERS[normalizedMime],
                reason: `mime type: ${normalizedMime}`
            };
        }
    }
    
    // 3. Apply media type fallbacks
    if (mediaType === 'video') {
        return {
            container: 'mp4',
            reason: 'video fallback'
        };
    } else if (mediaType === 'audio') {
        return {
            container: 'mp3',
            reason: 'audio fallback'
        };
    } else if (mediaType === 'subtitle') {
        // Context-aware subtitle fallbacks
        if (videoContainer === 'webm') {
            return {
                container: 'vtt',
                reason: 'webm subtitle fallback'
            };
        } else {
            return {
                container: 'ttml',
                reason: 'dash subtitle fallback'
            };
        }
    }
    
    // Final fallback
    return {
        container: 'mp4',
        reason: 'unknown fallback'
    };
}