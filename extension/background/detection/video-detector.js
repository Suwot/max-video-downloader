import { createLogger } from '../../shared/utils/logger.js';
import { shouldIgnoreForMediaDetection } from './url-filters.js';
import { addDetectedVideo } from '../processing/video-processor.js';
import { getRequestHeaders, removeHeadersByRequestId } from '../../shared/utils/headers-utils.js';
import { identifyVideoType, identifyVideoTypeFromMime, extractExpiryInfo, isMediaSegment } from './video-type-identifier.js';
import { settingsManager } from '../index.js';

// Create a logger instance for video detection
const logger = createLogger('VideoDetector');
logger.setLevel('ERROR');

// Detection context tracking (tabId -> timestamp when MPD was detected)
const tabsWithMpd = new Map();

/**
 * Get containers from MIME type for direct assignment during detection
 * @param {string} mimeType - Content-Type header value
 * @param {string} mediaType - Media type ('video', 'audio', or undefined)
 * @returns {Object|null} Container assignment or null
 */
function getContainersFromMimeType(mimeType, mediaType) {
    if (!mimeType) return null;
    
    const normalizedMime = mimeType.toLowerCase().split(';')[0]; // Remove parameters
    const subtype = normalizedMime.split('/')[1] || '';
    
    let videoContainer = 'mp4'; // Default
    
    // Special cases for webm and mkv
    if (subtype.includes('webm')) {
        videoContainer = 'webm';
    } else if (subtype.includes('matroska') || subtype.includes('mkv')) {
        videoContainer = 'mkv';
    }
    
    // Audio container based on video container
    const audioContainer = videoContainer === 'webm' ? 'webm' : 
                          videoContainer === 'mkv' ? 'mp3' : 'm4a';
    
    return {
        videoContainer,
        audioContainer,
        reason: `detection-mime: ${normalizedMime}`
    };
}

/**
 * Get the URL of a tab for page context tracking
 * @param {number} tabId - Tab ID
 * @param {string} initiatorUrl - Optional initiator URL for fallback when tabId is negative
 * @returns {Promise<Object|null>} Tab info object or null if not found
 */
async function getTabUrl(tabId, initiatorUrl = null) {
    // Handle negative tabId with initiator fallback
    if (tabId < 0 && initiatorUrl?.startsWith('http')) {
        try {
            const tabs = await chrome.tabs.query({});
            const matchingTabs = tabs.filter(tab => tab.url && tab.url.startsWith(initiatorUrl));
            
            if (matchingTabs.length === 1) {
                // Single match - use this tab
                const tab = matchingTabs[0];
                logger.debug(`Resolved tabId ${tabId} to ${tab.id} using initiator: ${initiatorUrl}`);
                return {
                    tabId: tab.id, // Return the resolved tabId
                    pageUrl: tab.url || null,
                    pageTitle: tab.title || null,
                    pageFavicon: tab.favIconUrl || null,
                    incognito: tab.incognito || false,
                    windowId: tab.windowId || null
                };
            } else if (matchingTabs.length > 1) {
                // Multiple matches - use the most recently active one
                const mostRecentTab = matchingTabs.reduce((latest, current) => 
                    (current.lastAccessed || 0) > (latest.lastAccessed || 0) ? current : latest
                );
                logger.debug(`Resolved tabId ${tabId} to ${mostRecentTab.id} (most recent of ${matchingTabs.length}) using initiator: ${initiatorUrl}`);
                return {
                    tabId: mostRecentTab.id, // Return the resolved tabId
                    pageUrl: mostRecentTab.url || null,
                    pageTitle: mostRecentTab.title || null,
                    pageFavicon: mostRecentTab.favIconUrl || null,
                    incognito: mostRecentTab.incognito || false,
                    windowId: mostRecentTab.windowId || null
                };
            } else {
                logger.debug(`No matching tabs found for initiator: ${initiatorUrl}`);
                return null;
            }
        } catch (error) {
            logger.debug(`Error querying tabs for initiator ${initiatorUrl}:`, error.message);
            return null;
        }
    }
    
    // Original logic for positive tabId
    if (tabId < 0) {
        return null;
    }
    
    try {
        const tab = await chrome.tabs.get(tabId);
        // logger.debug(`Retrieved tab info for ${tabId}:`, tab);
        return {
            tabId, // Keep original tabId
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
function addVideoWithCommonProcessing(tabId, url, videoInfo, metadata, source, tabInfo = null, requestId = null) {
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
    
    // For direct videos, create videoTracks immediately with container info for instant download capability
    if (videoInfo.type === 'direct' && metadata?.contentType) {
        const containers = getContainersFromMimeType(metadata.contentType, videoInfo.mediaType);
        if (containers) {
            videoData.videoTracks = [{
                url,
                type: 'direct',
                videoContainer: containers.videoContainer,
                audioContainer: containers.audioContainer,
                containerDetectionReason: containers.reason
            }];
        }
    }
    
    // Attach headers if requestId is provided
    if (requestId) {
        const headers = getRequestHeaders(requestId);
        if (headers) {
            videoData.headers = headers;
        } else {
            logger.debug(`No headers found for requestId: ${requestId}`);
        }
    }
    
    addDetectedVideo(videoData);
}

/**
 * Process a video URL from a web request
 * @param {number} tabId - Tab ID where request originated
 * @param {string} url - The URL to process
 * @param {Object} metadata - Optional metadata from response headers
 * @param {string} requestId - Request ID for header cleanup (handled by caller)
 */
export async function processWebRequest(details, metadata = null) {
    const { tabId, url, requestId, initiator } = details;
	// logger.info(`Received URL ${url} after processing in onHeadersReceived:`, metadata)

    // First check if we should ignore this URL
    if (shouldIgnoreForMediaDetection(url, metadata)) return;
    logger.debug(`Processing video URL after ShouldIgnoreForMediaDetection: ${url} with metadata:`, metadata);

    // Get tab URL for page context tracking (with fallback for negative tabId)
    const tabInfo = await getTabUrl(tabId, initiator);
    
    // If we couldn't resolve the tab, skip processing
    if (!tabInfo) {
        logger.debug(`Could not resolve tab for tabId ${tabId}, initiator: ${initiator}`);
        return;
    }
    
    // Use resolved tabId if available
    const resolvedTabId = tabInfo.tabId || tabId;

    // Try MIME type detection first (most reliable)
    if (metadata?.contentType) {
        const mimeTypeInfo = identifyVideoTypeFromMime(metadata.contentType, url);

        if (mimeTypeInfo) {
            // Handle DASH manifest detection
            if (mimeTypeInfo.type === 'dash') {
                tabsWithMpd.set(resolvedTabId, Date.now());
                addVideoWithCommonProcessing(resolvedTabId, url, mimeTypeInfo, metadata, `BG_webRequest_mime_${mimeTypeInfo.type}`, tabInfo, requestId);
                return;
            }

            // Handle direct video/audio files with additional filtering
            if (mimeTypeInfo.type === 'direct') {
                // Skip audio-only direct types
                if (mimeTypeInfo.mediaType === 'audio') {
                    logger.debug(`Skipping audio-only direct type: ${url}`);
                    return;
                }
                // Skip small files based on user setting
                const minFileSize = settingsManager.get('minFileSizeFilter');
                if (metadata.contentLength && metadata.contentLength < minFileSize) {
                    logger.debug(`Skipping small media file (${metadata.contentLength} bytes, min: ${minFileSize}): ${url}`);
                    return;
                }

                // Skip media segments
                const hasMpdContext = tabsWithMpd.has(resolvedTabId);

                if (isMediaSegment(url, metadata.contentType, hasMpdContext)) {
                    logger.debug(`Skipping media segment: ${url}`);
                    return;
                }
            }

            addVideoWithCommonProcessing(resolvedTabId, url, mimeTypeInfo, metadata, `BG_webRequest_mime_${mimeTypeInfo.type}`, tabInfo, requestId);
            return;
        }
    }

    // Fallback to URL-based detection
    const videoInfo = identifyVideoType(url);
    if (videoInfo) {
        addVideoWithCommonProcessing(resolvedTabId, url, videoInfo, metadata, `BG_webRequest_${videoInfo.type}`, tabInfo, requestId);
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
    addDetectedVideo(videoData);
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
    

}

/**
 * Initialize the video detector - sets up web request listeners and message handlers
 */
export function initVideoDetector() {
    logger.info('Initializing video detector');
    
    // Clear any stale detection context on initialization
    tabsWithMpd.clear();
    
    setupWebRequestListener();     // Set up web request listener for video detection    
    setupMessageListener();        // Set up message listener for content script and other communications
}

/**
 * Set up the web request listener for video detection
 */
function setupWebRequestListener() {
    chrome.webRequest.onHeadersReceived.addListener(
        function (details) {
			logger.info(`NEW onHeadersReceived request for url: ${details.url}, requestId: ${details.requestId}`, details);
            // Centralized cleanup - ensure headers are always cleaned up
            const cleanupHeaders = () => {
                if (details.requestId) {
                    removeHeadersByRequestId(details.requestId);
                }
            };

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
            let shouldSkipRequest = false;
            for (const header of details.responseHeaders) {
                const headerName = header.name.toLowerCase();
                switch(headerName) {
                    case 'content-range':
                        // Parse Content-Range to determine if this is a legitimate video or just a segment
                        const shouldSkip = shouldSkipBasedOnContentRange(header.value, details.url);
                        if (shouldSkip) {
                            shouldSkipRequest = true;
                            break;
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
            
            // Early cleanup if we should skip this request
            if (shouldSkipRequest) {
                cleanupHeaders();
                return;
            }
            
            // Call the video detector with the metadata (async, but don't await to avoid blocking)
            processWebRequest(details, metadata)
                .catch(error => {
                    logger.debug('Error in processWebRequest:', error);
                })
                .finally(() => {
                    // Always cleanup headers after processing, regardless of success/failure
                    cleanupHeaders();
                });
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media"] },
        ["responseHeaders"]
    );

    // Clean up headers for failed requests
    chrome.webRequest.onErrorOccurred.addListener(
        function(details) {
            if (details && details.requestId) {
                removeHeadersByRequestId(details.requestId);
                logger.debug(`Cleaned up headers for failed requestId: ${details.requestId}`, details);
            }
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "other", "media"] }
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
