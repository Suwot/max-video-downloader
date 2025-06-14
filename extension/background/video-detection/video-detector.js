import { createLogger } from '../../js/utilities/logger.js';
import { shouldIgnoreForMediaDetection } from './url-filters.js';
import { addDetectedVideo } from '../services/video-manager.js';
import { identifyVideoType, identifyVideoTypeFromMime, extractExpiryInfo, isMediaSegment } from './video-type-identifier.js';

// Create a logger instance for video detection
const logger = createLogger('VideoDetector');

// Detection context tracking (tabId -> timestamp when MPD was detected)
const tabsWithMpd = new Map();

// tabId -> Set of segment paths
const dashSegmentPathCache = new Map();

/**
 * Process a video URL from a web request
 * @param {number} tabId - Tab ID where request originated
 * @param {string} url - The URL to process
 * @param {Object} metadata - Optional metadata from response headers
 */
export function processWebRequest(tabId, url, metadata = null) {
    if (tabId < 0 || !url) return;

    logger.debug(`Processing video URL: ${url} with metadata:`, metadata);
    
    // First check if we should ignore this URL
    if (shouldIgnoreForMediaDetection(url, metadata)) {
        return;
    }
    
    // If we have a content type from metadata, check it first - this is our primary detection for DASH/HLS
    if (metadata && metadata.contentType) {
        const mimeTypeInfo = identifyVideoTypeFromMime(metadata.contentType, url);
        
        if (mimeTypeInfo) {
            // For DASH manifests, record the MPD context
            if (mimeTypeInfo.type === 'dash') {
                tabsWithMpd.set(tabId, Date.now());
            }
            
            // For direct video/audio files, apply additional filtering
            if (mimeTypeInfo.type === 'direct') {
                // First check file size before anything else
                if (metadata.contentLength < 100 * 1024) {  // Skip files smaller than 100kb
                    logger.debug(`Skipping small media file (${metadata.contentLength} bytes): ${url}`);
                    return;
                } 
                
                // Check if this appears to be a media segment
                const hasMpdContext = tabsWithMpd.has(tabId);
                const segmentPaths = dashSegmentPathCache.get(tabId);
                
                if (isMediaSegment(url, hasMpdContext, segmentPaths)) {
                    logger.debug(`Skipping media segment: ${url}`);
                    return;
                }
            }
            
            // Check for expiration info before adding the video
            const expiryInfo = extractExpiryInfo(url);

            addDetectedVideo(tabId, {
                url,
                type: mimeTypeInfo.type,
                source: `BG_webRequest_mime_${mimeTypeInfo.type}`,
                timestampDetected: metadata.timestampDetected || Date.now(),
                metadata: metadata,
                ...(mimeTypeInfo.mediaType ? { mediaType: mimeTypeInfo.mediaType } : {}),
                ...(mimeTypeInfo.originalContainer ? { originalContainer: mimeTypeInfo.originalContainer } : {}),
                ...(expiryInfo ? { expiryInfo } : {})
            });
            return;
        }
    }
    
    // For URLs without MIME type information, fall back to URL-based detection
    const videoInfo = identifyVideoType(url);
    
    // Skip if not a recognized video type
    if (!videoInfo) return;
    
    // For streaming formats, add directly
    if (videoInfo.type === 'hls' || videoInfo.type === 'dash' || videoInfo.type === 'direct') {
        const expiryInfo = extractExpiryInfo(url);
        
        addDetectedVideo(tabId, {
            url,
            type: videoInfo.type,
            source: `BG_webRequest_${videoInfo.type}`,
            ...(videoInfo.container ? {originalContainer: videoInfo.container} : {}),
            ...(metadata ? {metadata: metadata} : {}), // Still pass metadata even in URL-based detection
            timestampDetected: Date.now(),
            ...(expiryInfo ? { expiryInfo } : {})
        });
    }
}

/**
 * Process video detection from content script
 * @param {number} tabId - Tab ID where video was detected
 * @param {Object} videoData - Video data from content script
 */
export function processContentScriptVideo(tabId, videoData) {
    if (!tabId || tabId <= 0 || !videoData) {
        logger.warn('Invalid content script video data:', { tabId, videoData });
        return;
    }

    logger.debug(`Processing content script video for tab ${tabId}:`, videoData);
    
    // Add the video through the video manager
    addDetectedVideo(tabId, videoData);
}

/**
 * Register DASH segment paths for filtering
 * @param {number} tabId - Tab ID
 * @param {Array<string>} paths - Array of segment paths
 * @param {string} url - MPD URL (optional, for finding matching tab)
 */
export function registerDashSegmentPaths(tabId, paths, url = null) {
    // If no tabId was provided but we have a URL, try to find the corresponding tab
    if (!tabId && url) {
        // Try to find the tab that loaded this MPD
        for (const [existingTabId, timestamp] of tabsWithMpd.entries()) {
            // Only check tabs with recent MPD activity (1 minute)
            if (timestamp > Date.now() - 60000) {
                tabId = existingTabId;
                logger.debug(`Found matching tab ${tabId} for MPD URL: ${url}`);
                break;
            }
        }
    }
    
    if (!tabId) {
        logger.warn('Could not determine tab ID for segment paths, ignoring');
        return;
    }
    
    if (!Array.isArray(paths) || paths.length === 0) {
        logger.warn('Invalid segment paths provided:', paths);
        return;
    }
    
    // Initialize segment paths set for this tab if it doesn't exist
    if (!dashSegmentPathCache.has(tabId)) {
        dashSegmentPathCache.set(tabId, new Set());
    }
    
    // Add all paths to the cache
    const pathCache = dashSegmentPathCache.get(tabId);
    paths.forEach(path => pathCache.add(path));
    
    logger.debug(`Added ${paths.length} segment paths to cache for tab ${tabId}`);
}

/**
 * Clean up detection context for a tab
 * @param {number} tabId - Tab ID to clean up
 */
export function cleanupDetectionContext(tabId) {
    if (tabsWithMpd.has(tabId)) {
        tabsWithMpd.delete(tabId);
        logger.debug(`Cleaned up MPD context for tab ${tabId}`);
    }
    
    if (dashSegmentPathCache.has(tabId)) {
        dashSegmentPathCache.delete(tabId);
        logger.debug(`Cleaned up segment paths for tab ${tabId}`);
    }
}

/**
 * Initialize the video detector - sets up web request listeners and message handlers
 */
export function initVideoDetector() {
    logger.info('Initializing video detector');
    
    // Clear any stale detection context on initialization
    tabsWithMpd.clear();
    dashSegmentPathCache.clear();
    
    setupWebRequestListener();     // Set up web request listener for video detection    
    setupMessageListener();        // Set up message listener for content script and other communications
}

/**
 * Set up the web request listener for video detection
 */
function setupWebRequestListener() {
    chrome.webRequest.onHeadersReceived.addListener(
        function (details) {
            // Extract all relevant headers into a metadata object
            const metadata = {
                contentType: null,
                contentLength: null,
                contentEncoding: null,
                lastModified: null,
                etag: null,
                contentDisposition: null,
                filename: null,
                supportsRanges: false,
                timestampDetected: Date.now()
            };
            
            // Process important headers
            for (const header of details.responseHeaders) {
                const headerName = header.name.toLowerCase();
                
                switch(headerName) {
                    case 'content-type':
                        metadata.contentType = header.value;
                        break;
                    case 'content-length':
                        metadata.contentLength = parseInt(header.value, 10);
                        break;
                    case 'content-encoding':
                        metadata.contentEncoding = header.value;
                        break;
                    case 'last-modified':
                        metadata.lastModified = header.value;
                        break;
                    case 'etag':
                        metadata.etag = header.value;
                        break;
                    case 'content-disposition':
                        metadata.contentDisposition = header.value;
                        // Extract filename from Content-Disposition if present
                        const filenameMatch = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(header.value);
                        if (filenameMatch && filenameMatch[1]) {
                            let filename = filenameMatch[1].replace(/['"]/g, '').trim();
                            // Decode URL encoded characters
                            try {
                                filename = decodeURIComponent(filename);
                            } catch (e) {
                                // If decoding fails, use the original value
                            }
                            metadata.filename = filename;
                        }
                        break;
                    case 'accept-ranges':
                        metadata.supportsRanges = header.value === 'bytes';
                        break;
                    case 'access-control-allow-origin':
                        metadata.cors = header.value;
                        break;
                    case 'x-content-type-options':
                        metadata.xContentTypeOptions = header.value;
                        break;
                }
            }

            // Call the video detector with the metadata
            processWebRequest(details.tabId, details.url, metadata);
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media"] },
        ["responseHeaders"]
    );
    
    logger.debug('Web request listener set up for video detection');
}

/**
 * Set up message listener for content script communications and DASH segment registration
 */
function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // Handle video detection from Content Script
        if (request.command === 'addVideo') {
            const tabId = sender.tab?.id;
            if (tabId && tabId > 0) {
                processContentScriptVideo(tabId, request);
            }
            return false;
        }
        
        // Let other handlers deal with non-detection messages
        return false;
    });
    
    logger.debug('Message listener set up for video detection');
}

/**
 * Get detection statistics (for debugging)
 */
export function getDetectionStats() {
    return {
        tabsWithMpd: tabsWithMpd.size,
        dashSegmentPathCache: dashSegmentPathCache.size,
        tabsTracked: Array.from(tabsWithMpd.keys()),
        segmentCacheTabsTracked: Array.from(dashSegmentPathCache.keys())
    };
}
