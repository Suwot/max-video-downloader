import { createLogger } from '../../shared/utils/logger.js';
import { shouldIgnoreForMediaDetection } from './url-filters.js';
import { addDetectedVideo } from '../processing/video-manager.js';
import { identifyVideoType, identifyVideoTypeFromMime, extractExpiryInfo, isMediaSegment } from './video-type-identifier.js';

// Create a logger instance for video detection
const logger = createLogger('VideoDetector');

// Detection constants
const DETECTION_CONSTANTS = {
    MIN_FILE_SIZE: 100 * 1024, // 100KB minimum for direct video files
    MPD_CONTEXT_TIMEOUT: 60000 // 1 minute timeout for MPD context
};

// Detection context tracking (tabId -> timestamp when MPD was detected)
const tabsWithMpd = new Map();

// tabId -> Set of segment paths
const dashSegmentPathCache = new Map();

/**
 * Get the URL of a tab for page context tracking
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object|null>} Tab info object or null if not found
 */
async function getTabUrl(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        // logger.debug(`Retrieved tab info for ${tabId}:`, tab);
        return {
            pageUrl: tab.url || null,
            pageTitle: tab.title || null,
            pageFavicon: tab.favIconUrl || null,
            incognito: tab.incognito || false,
            windowId: tab.windowId || null
        };
    } catch (error) {
        logger.debug(`Could not get URL for tab ${tabId}:`, error.message);
        return null;
    }
}

/**
 * Helper function to add detected video with common processing
 * @param {number} tabId - Tab ID
 * @param {string} url - Video URL
 * @param {Object} videoInfo - Video type information
 * @param {Object} metadata - Request metadata
 * @param {string} source - Detection source identifier
 * @param {Object|null} tabInfo - Tab information (url, title, favIconUrl, incognito)
 */
function addVideoWithCommonProcessing(tabId, url, videoInfo, metadata, source, tabInfo = null) {
    // Extract expiry info once
    const expiryInfo = extractExpiryInfo(url);
    
    const videoData = {
        url,
        type: videoInfo.type,
        source,
        timestampDetected: metadata?.timestampDetected || Date.now(),
        tabId,
        ...(tabInfo || {}),
        ...(metadata && { metadata }),
        ...(videoInfo.mediaType && { mediaType: videoInfo.mediaType }),
        ...(videoInfo.originalContainer && { originalContainer: videoInfo.originalContainer }),
        ...(expiryInfo && { expiryInfo })
    };
    
    addDetectedVideo(tabId, videoData);
}

/**
 * Process a video URL from a web request
 * @param {number} tabId - Tab ID where request originated
 * @param {string} url - The URL to process
 * @param {Object} metadata - Optional metadata from response headers
 */
export async function processWebRequest(details, metadata = null) {
    const { tabId, url } = details;

    if (tabId < 0 || !url) return;

    // First check if we should ignore this URL
    if (shouldIgnoreForMediaDetection(url, metadata)) return;
    logger.debug(`Processing video URL after ShouldIgnoreForMediaDetection: ${url} with metadata:`, metadata);
    
    // Get tab URL for page context tracking
    const tabInfo = await getTabUrl(tabId);
    
    // Try MIME type detection first (most reliable)
    if (metadata?.contentType) {
        const mimeTypeInfo = identifyVideoTypeFromMime(metadata.contentType, url);
        
        if (mimeTypeInfo) {
            // Handle DASH manifest detection
            if (mimeTypeInfo.type === 'dash') {
                tabsWithMpd.set(tabId, Date.now());
                addVideoWithCommonProcessing(tabId, url, mimeTypeInfo, metadata, `BG_webRequest_mime_${mimeTypeInfo.type}`, tabInfo);
                return;
            }
            
            // Handle direct video/audio files with additional filtering
            if (mimeTypeInfo.type === 'direct') {
                // Skip small files
                if (metadata.contentLength && metadata.contentLength < DETECTION_CONSTANTS.MIN_FILE_SIZE) {
                    logger.debug(`Skipping small media file (${metadata.contentLength} bytes): ${url}`);
                    return;
                }
                
                // Skip media segments
                const hasMpdContext = tabsWithMpd.has(tabId);
                const segmentPaths = dashSegmentPathCache.get(tabId);
                
                if (isMediaSegment(url, metadata.contentType, hasMpdContext, segmentPaths)) {
                    logger.debug(`Skipping media segment: ${url}`);
                    return;
                }
            }
            
            addVideoWithCommonProcessing(tabId, url, mimeTypeInfo, metadata, `BG_webRequest_mime_${mimeTypeInfo.type}`, tabInfo);
            return;
        }
    }
    
    // Fallback to URL-based detection
    const videoInfo = identifyVideoType(url);
    if (videoInfo) {
        addVideoWithCommonProcessing(tabId, url, videoInfo, metadata, `BG_webRequest_${videoInfo.type}`, tabInfo);
    }
}

/**
 * Process video detection from content script
 * @param {number} tabId - Tab ID where video was detected
 * @param {Object} videoData - Video data from content script (should include pageUrl)
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
            // Only check tabs with recent MPD activity
            if (timestamp > Date.now() - DETECTION_CONSTANTS.MPD_CONTEXT_TIMEOUT) {
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
export function cleanupMPDContextForTab(tabId) {
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
                timestampDetected: Math.round(details.timeStamp)
            };
            
            // Process important headers
            for (const header of details.responseHeaders) {
                const headerName = header.name.toLowerCase();
                
                switch(headerName) {
                    case 'content-range':
                        // Parse Content-Range to determine if this is a legitimate video or just a segment
                        const shouldSkip = shouldSkipBasedOnContentRange(header.value, details.url);
                        if (shouldSkip) {
                            return;
                        }
                        metadata.contentRange = header.value;
                        break;
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

            // logger.debug(`Found NEW URL with headers:`, details);

            // Call the video detector with the metadata (async, but don't await to avoid blocking)
            processWebRequest(details, metadata).catch(error => {
                logger.debug('Error in processWebRequest:', error);
            });
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media"] },
        ["responseHeaders"]
    );
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
                // Process async but don't await to avoid blocking the message handler
                processContentScriptVideo(tabId, request).catch(error => {
                    logger.debug('Error in processContentScriptVideo:', error);
                });
            }
            return false;
        }
        
        // Let other handlers deal with non-detection messages
        return false;
    });
    
    logger.debug('Message listener set up for video detection');
}

/**
 * Analyze Content-Range header to determine if we should skip this request
 * @param {string} contentRange - Content-Range header value
 * @param {string} url - Request URL for logging
 * @returns {boolean} True if should skip, false if should process
 */
function shouldSkipBasedOnContentRange(contentRange, url) {
    // Parse Content-Range header: "bytes start-end/total"
    const rangeMatch = /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange);
    
    if (!rangeMatch) {
        logger.debug(`Invalid Content-Range format: ${contentRange} for URL: ${url}`);
        return false; // If we can't parse it, don't skip
    }
    
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const total = parseInt(rangeMatch[3], 10);
    
    // Calculate what percentage of the file this range covers
    const rangeSize = end - start + 1;
    const coverage = rangeSize / total;
    
    // Keep if: starts at 0 OR covers ≥95% of the file
    const shouldKeep = start === 0 || coverage >= 0.95;
    
    if (shouldKeep) {
        logger.debug(`Keeping Content-Range request: ${contentRange} (${(coverage * 100).toFixed(1)}% coverage, starts at ${start}) for URL: ${url}`);
        return false; // Don't skip
    } else {
        logger.debug(`Skipping partial Content-Range request: ${contentRange} (${(coverage * 100).toFixed(1)}% coverage, starts at ${start}) for URL: ${url}`);
        return true; // Skip
    }
}
