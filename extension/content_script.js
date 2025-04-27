/**
 * @ai-guide-component ContentScript
 * @ai-guide-description In-page video detector
 * @ai-guide-responsibilities
 * - Scans DOM for video elements and sources
 * - Monitors network requests for video streams
 * - Detects HLS and DASH manifests in page resources
 * - Extracts metadata from video elements
 * - Intercepts media player initialization
 * - Reports detected videos to background service
 * - Maintains real-time monitoring of video content
 * - Extracts legitimate video URLs from query parameters
 * - Filters out tracking pixels while preserving embedded media URLs
 * - Normalizes URLs for efficient duplicate detection
 * - Propagates metadata about URL extraction origins
 */

// content_script.js
// Import shared validation utility
import { validateAndFilterVideos, isValidVideo, isValidVideoUrl } from './js/utilities/video-validator.js';

console.log('Content script loading...');

// Track detected videos to avoid duplicates
const detectedVideos = new Set();
const blobUrls = new Map();
let autoDetectionEnabled = true;
let isInitialized = false;
let pendingMetadataQueue = new Map();

// Track XMLHttpRequest and fetch requests for video content
function setupNetworkListeners() {
    // Override XMLHttpRequest to capture video URLs
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        const xhr = this;
        const originalOnReadyStateChange = xhr.onreadystatechange;
        
        this.addEventListener('readystatechange', function() {
            if (xhr.readyState === 4 && xhr.status === 200) {
                const contentType = xhr.getResponseHeader('Content-Type');
                const url = xhr.responseURL;
                
                if (url && isVideoRelatedUrl(url, contentType)) {
                    // Add to pending queue for parallel processing
                    pendingMetadataQueue.set(url, {
                        type: 'xhr',
                        contentType,
                        responseHeaders: Array.from(xhr.getAllResponseHeaders().trim().split(/[\r\n]+/))
                            .reduce((headers, line) => {
                                const parts = line.split(': ');
                                headers[parts[0]] = parts[1];
                                return headers;
                            }, {})
                    });
                    processPendingMetadata();
                }
            }
            
            if (originalOnReadyStateChange) {
                originalOnReadyStateChange.apply(this, arguments);
            }
        });
        
        return originalXhrOpen.apply(this, [method, url, ...args]);
    };

    // Override fetch to capture video URLs with parallel processing
    const originalFetch = window.fetch;
    window.fetch = function(resource, init) {
        const url = resource instanceof Request ? resource.url : resource;
        
        return originalFetch.apply(this, arguments).then(response => {
            const clonedResponse = response.clone();
            
            clonedResponse.headers.get('Content-Type').then(contentType => {
                if (isVideoRelatedUrl(url, contentType)) {
                    // Add to pending queue for parallel processing
                    pendingMetadataQueue.set(url, {
                        type: 'fetch',
                        contentType,
                        responseHeaders: Object.fromEntries(clonedResponse.headers.entries())
                    });
                    processPendingMetadata();
                }
            }).catch(() => {});
            
            return response;
        });
    };
}

// Process pending metadata in batches
function processPendingMetadata(batchSize = 3) {
    if (pendingMetadataQueue.size === 0) return;
    
    const entries = Array.from(pendingMetadataQueue.entries()).slice(0, batchSize);
    const processPromises = entries.map(([url, info]) => {
        return new Promise(async (resolve) => {
            pendingMetadataQueue.delete(url);

            // Determine video type using getVideoType
            const typeInfo = getVideoType(url);

            // Skip ignored types
            if (typeInfo === 'ignored' || (typeof typeInfo === 'object' && typeInfo.type === 'ignored')) {
                return resolve(); // Skip sending ignored URLs
            }

            let finalUrl = url;
            let finalType = info.source || info.type; // Default to source or type from info
            let foundFromQueryParam = false;

            // If getVideoType returns an object with URL and type, use those
            if (typeof typeInfo === 'object' && typeInfo.url && typeInfo.type) {
                finalUrl = typeInfo.url;
                finalType = typeInfo.type;
                foundFromQueryParam = typeInfo.foundFromQueryParam || false;
            } else if (typeInfo !== 'ignored' && typeInfo !== 'unknown') {
                finalType = typeInfo; // Use the type detected by getVideoType
            }

            // Send to background with enhanced metadata
            await sendVideoToBackground(finalUrl, finalType, {
                contentType: info.contentType,
                headers: info.responseHeaders,
                foundFromQueryParam: foundFromQueryParam
            });
            resolve();
        });
    });

    Promise.all(processPromises).then(() => {
        if (pendingMetadataQueue.size > 0) {
            setTimeout(() => processPendingMetadata(batchSize), 100);
        }
    });
}

// Track MediaSource and SourceBuffer for blob URLs
function setupBlobListeners() {
    // Monitor all video elements for blob URLs
    const videoObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const video = mutation.target;
                if (video.src && video.src.startsWith('blob:')) {
                    captureBlob(video);
                }
            }
        });
        
        // Also check for new video elements
        document.querySelectorAll('video').forEach(video => {
            if (video.src && video.src.startsWith('blob:')) {
                captureBlob(video);
            }
        });
    });
    
    // Start observing all video elements
    document.querySelectorAll('video').forEach(video => {
        videoObserver.observe(video, { attributes: true });
        if (video.src && video.src.startsWith('blob:')) {
            captureBlob(video);
        }
    });
    
    // Monitor for new videos being added to the DOM
    const bodyObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeName === 'VIDEO') {
                    videoObserver.observe(node, { attributes: true });
                    if (node.src && node.src.startsWith('blob:')) {
                        captureBlob(node);
                    }
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(video => {
                        videoObserver.observe(video, { attributes: true });
                        if (video.src && video.src.startsWith('blob:')) {
                            captureBlob(video);
                        }
                    });
                }
            });
        });
    });
    
    bodyObserver.observe(document.body, { childList: true, subtree: true });
}

// Try to snapshot info about a blob URL
function captureBlob(videoElement) {
    const blobUrl = videoElement.src;
    if (!blobUrl || !blobUrl.startsWith('blob:') || blobUrls.has(blobUrl)) {
        return false;
    }
    
    // Store basic info about the blob
    const info = {
        url: blobUrl,
        type: 'blob',
        time: Date.now(),
        poster: videoElement.poster || null,
        title: getVideoTitle(videoElement)
    };
    
    blobUrls.set(blobUrl, info);
    sendVideoToBackground(blobUrl, 'blob', info);
    return true;
}

// Determine a good title for the video
function getVideoTitle(videoElement) {
    // Try to get title from various sources
    // 1. aria-label attribute
    if (videoElement.hasAttribute('aria-label')) {
        return videoElement.getAttribute('aria-label');
    }
    
    // 2. title attribute
    if (videoElement.hasAttribute('title')) {
        return videoElement.getAttribute('title');
    }
    
    // 3. Look for nearby heading elements
    let parent = videoElement.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
        const heading = parent.querySelector('h1, h2, h3');
        if (heading && heading.textContent.trim()) {
            return heading.textContent.trim();
        }
        parent = parent.parentElement;
    }
    
    // 4. Page title fallback
    return document.title || 'Video';
}

// Check if a URL is likely to be video content
function isVideoRelatedUrl(url, contentType) {
    try {
        // First, quickly check for obvious tracking pixels to avoid processing them further
        const urlObj = new URL(url);
        
        // Early rejection for known tracking pixels
        if (url.includes('ping.gif') || url.includes('jwpltx.com') || 
            urlObj.pathname.includes('/pixel') || urlObj.pathname.includes('/track')) {
            
            // However, check first if it contains a video URL in query params
            for (const [key, value] of urlObj.searchParams.entries()) {
                try {
                    const decoded = decodeURIComponent(value);
                    if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
                        (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
                        // If we find a video URL embedded, allow this to be processed further
                        return true;
                    }
                } catch {}
            }
            
            // No embedded video URL found, reject this tracking pixel
            return false;
        }
    } catch {}
    
    // Known video extensions and manifest formats
    const videoPatterns = [
        /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i,   // Direct video files
        /\.(m3u8|m3u)(\?|$)/i,                       // HLS playlists
        /\.(mpd)(\?|$)/i,                            // DASH manifests
        /\/(playlist|manifest|master)\.json(\?|$)/i   // Some custom manifest formats
    ];
    
    // Known video MIME types
    const videoMimeTypes = [
        'video/',
        'application/x-mpegURL',
        'application/dash+xml',
        'application/vnd.apple.mpegURL'
    ];
    
    // Check URL patterns
    if (videoPatterns.some(pattern => pattern.test(url))) {
        return true;
    }
    
    // Check content type if available
    if (contentType && videoMimeTypes.some(type => contentType.includes(type))) {
        return true;
    }
    
    return false;
}

// Send a detected video to the background script
function sendVideoToBackground(url, source, additionalInfo = {}) {
    // Determine type from URL
    const typeInfo = getVideoType(url);
    let type = source;
    let foundFromQueryParam = additionalInfo.foundFromQueryParam || false;
    
    // If getVideoType returns an object, use its values
    if (typeof typeInfo === 'object' && typeInfo.url && typeInfo.type) {
        url = typeInfo.url;
        type = typeInfo.type;
        foundFromQueryParam = typeInfo.foundFromQueryParam || foundFromQueryParam;
    } else if (typeInfo !== 'ignored' && typeInfo !== 'unknown') {
        type = typeInfo; // Use the type detected by getVideoType
    }

    // Early skip if type is ignored
    if (type === 'ignored') {
        return;
    }

    // Normalize URL to avoid duplicates
    const normalizedUrl = normalizeUrl(url);

    // Skip if already detected
    if (detectedVideos.has(normalizedUrl)) {
        return;
    }

    // Add to detected videos
    detectedVideos.add(normalizedUrl);

    // Send to background
    chrome.runtime.sendMessage({
        action: 'addVideo',
        url: url,
        source: source,
        type: type,
        foundFromQueryParam: foundFromQueryParam,
        ...additionalInfo
    });
}

// Get video type from URL
function getVideoType(url) {
    if (url.startsWith('blob:')) {
        return 'blob';
    }
    
    try {
        const urlObj = new URL(url);
                
        // Early rejection: skip tracking images and known bad extensions
        const badExtensions = /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i;
        if (badExtensions.test(urlObj.pathname)) {
            // However, check if a real video URL is buried inside query params
            for (const [key, value] of urlObj.searchParams.entries()) {
                try {
                    const decoded = decodeURIComponent(value);
                    if (decoded.match(/\.m3u8(\?|$)/) || decoded.match(/\.mpd(\?|$)/)) {
                        // Only consider it if it looks like an actual URL
                        if (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) {
                            // Return both the embedded URL and its type, plus a flag indicating it was found in a query param
                            return {
                                url: decoded,
                                type: decoded.match(/\.m3u8(\?|$)/) ? 'hls' : 'dash',
                                foundFromQueryParam: true
                            };
                        }
                    }
                } catch {}
            }
            // Otherwise, reject
            return 'ignored';
        }
        
        const baseUrl = url.split('?')[0].split('#')[0];
        
        // Define patterns for tracking/analytics URLs
        const ignoredPathPatterns = [
            /\.gif$/i,                  // tracking pixels
            /\/ping/i,                  // ping endpoints
            /\/track/i, /\/pixel/i,
            /\/stats/i, /\/metric/i,
            /\/telemetry/i,
            /\/analytics/i,
            /jwpltx/, /\/tracking/
        ];

        // Check if URL matches ignored patterns
        if (ignoredPathPatterns.some(pattern => pattern.test(urlObj.pathname) || pattern.test(urlObj.hostname))) {
            return 'ignored';
        }

        // Improved HLS detection - check for common indicators that confirm it's an actual HLS stream
        // rather than just having .m3u8 in the URL
        if (baseUrl.toLowerCase().endsWith('.m3u8')) {
            // Check for additional HLS indicators to confirm it's really a manifest
            const hasHLSIndicators = 
                // These are common URL patterns for actual HLS streams
                urlObj.pathname.includes('/playlist/') || 
                urlObj.pathname.includes('/manifest/') || 
                urlObj.pathname.includes('/media/') ||
                urlObj.pathname.includes('/content/') ||
                urlObj.pathname.includes('/stream/') ||
                urlObj.pathname.includes('/video/') ||
                urlObj.hostname.includes('cdn') ||
                // Check for pattern of direct media URLs
                /\/[^\/]+\/[^\/]+\.m3u8$/.test(urlObj.pathname);
                
            if (hasHLSIndicators) {
                return 'hls';
            }
                
            // If the path has many segments and ends with .m3u8, it's likely a real HLS URL
            if (urlObj.pathname.split('/').length > 3) {
                return 'hls';
            }
                
            // Additional validation: if m3u8 is a structural part of the URL rather than just a parameter
            if (!urlObj.search.includes('m3u8')) {
                return 'hls';
            }
                
            // Less confident, but still check for content in /hls/ paths
            if (urlObj.pathname.includes('/hls/')) {
                return 'hls';
            }
            
            // Default to unknown for suspicious .m3u8 URLs that don't match expected patterns
            return 'unknown';
        } 
        
        // Special case for /hls/ paths - more strict validation
        if (urlObj.pathname.includes('/hls/')) {
            // Only consider it HLS if it has other typical media path components
            const hasMediaPathComponents =
                urlObj.pathname.includes('/stream/') ||
                urlObj.pathname.includes('/video/') ||
                urlObj.pathname.includes('/content/') ||
                urlObj.pathname.includes('/media/');
                
            if (hasMediaPathComponents) {
                return 'hls';
            }
        }
        
        // Check query parameters for embedded video URLs
        for (const [key, value] of urlObj.searchParams.entries()) {
            try {
                const decoded = decodeURIComponent(value);
                
                // More precise check for HLS in query params
                if (decoded.match(/\.m3u8(\?|$)/)) {
                    // Only consider it HLS if:
                    // 1. It looks like a valid URL rather than just a parameter containing "m3u8" text
                    // 2. AND it's not just a simple token/identifier with "m3u8" in it
                    if ((decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) && 
                        // Additional validation to prevent false positives:
                        // It should look like an actual URL path, not just text containing "m3u8"
                        (decoded.includes('/') || decoded.match(/^https?:\/\//))) {
                        // Return both the embedded URL and its type, plus a flag indicating it was found in a query param
                        return {
                            url: decoded,
                            type: 'hls',
                            foundFromQueryParam: true
                        };
                    }
                }
                
                if (decoded.match(/\.mpd(\?|$)/)) {
                    // Similar validation for DASH manifests
                    if ((decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://')) &&
                        (decoded.includes('/') || decoded.match(/^https?:\/\//))) {
                        // Return both the embedded URL and its type, plus a flag indicating it was found in a query param
                        return {
                            url: decoded,
                            type: 'dash',
                            foundFromQueryParam: true
                        };
                    }
                }
            } catch {}
        }
        
        if (baseUrl.toLowerCase().endsWith('.mpd')) {
            return 'dash';
        }
        
        if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)$/i.test(baseUrl)) {
            return 'direct';
        }
    } catch (e) {
        console.error('Error parsing URL:', e);
    }
    
    return 'unknown';
}

// Normalize URL to avoid duplicates
function normalizeUrl(url) {
    // Keep blob URLs as is
    if (url.startsWith('blob:')) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        
        // Special case for tracking pixels with embedded URLs:
        // If this is a tracking pixel with video URLs in parameters,
        // we want to avoid duplicate detection between the original and extracted URL
        if (url.includes('ping.gif') || url.includes('jwpltx.com') || urlObj.pathname.includes('/pixel')) {
            // Look for embedded video URLs in query parameters
            for (const [key, value] of urlObj.searchParams.entries()) {
                try {
                    const decoded = decodeURIComponent(value);
                    if ((decoded.includes('.m3u8') || decoded.includes('.mpd')) &&
                        (decoded.includes('http') || decoded.startsWith('/') || decoded.includes('://'))) {
                        // Use the embedded URL for normalization to prevent duplicate detection
                        try {
                            // Handle relative URLs
                            const fullUrl = decoded.startsWith('/') ? 
                                (urlObj.origin + decoded) : decoded;
                            return normalizeUrl(fullUrl); // Recursively normalize the extracted URL
                        } catch (e) {
                            // If we can't parse the extracted URL, fall back to default normalization
                        }
                    }
                } catch {}
            }
        }
        
        // Remove common tracking or cache-busting parameters
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        urlObj.searchParams.delete('_');
        urlObj.searchParams.delete('time');
        urlObj.searchParams.delete('timestamp');
        urlObj.searchParams.delete('random');
        
        // For HLS manifest URLs, canonicalize some common patterns
        if (url.includes('.m3u8') || url.includes('/hls/')) {
            // Remove common HLS-specific transient params
            urlObj.searchParams.delete('seq');
            urlObj.searchParams.delete('segment');
            urlObj.searchParams.delete('cmsid');
            urlObj.searchParams.delete('v');
            urlObj.searchParams.delete('session');
            
            // Special case for manifests with media IDs - keep the core URL
            const pathname = urlObj.pathname.toLowerCase();
            if (pathname.includes('/manifest') || pathname.includes('/playlist') || 
                pathname.includes('/master.m3u8') || pathname.includes('/index.m3u8')) {
                // Try to create a canonical form for better duplicate detection
                return urlObj.origin + urlObj.pathname;
            }
        }
        
        return urlObj.toString();
    } catch {
        return url;
    }
}

// After the normalizeUrl function

/**
 * Validate video URL to filter out tracking pixels and other non-video content
 * @param {string} url - URL to validate
 * @return {boolean} True if the URL is a valid video, false otherwise
 */
function isValidVideoUrl(url) {
    try {
        // Skip blob URLs as they're handled separately
        if (url.startsWith('blob:')) {
            return true;
        }
        
        const urlObj = new URL(url);
        
        // Early rejection: skip tracking images and known bad extensions
        const badExtensions = /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i;
        if (badExtensions.test(urlObj.pathname)) {
            return false;
        }
        
        // Define patterns for tracking/analytics URLs
        const ignoredPathPatterns = [
            /\.gif$/i,                  // tracking pixels
            /\/ping/i,                  // ping endpoints
            /\/track/i, /\/pixel/i,
            /\/stats/i, /\/metric/i,
            /\/telemetry/i,
            /\/analytics/i,
            /jwpltx/, /\/tracking/
        ];

        // Check if URL matches ignored patterns
        if (ignoredPathPatterns.some(pattern => pattern.test(urlObj.pathname) || pattern.test(urlObj.hostname))) {
            return false;
        }
        
        return true;
    } catch (e) {
        console.error('Error validating URL:', e);
        return false;
    }
}

/**
 * Validate video info object and determine if it should be processed
 * @param {Object} videoInfo - Video information object
 * @return {Object|null} Valid video info or null if invalid
 */
function validateVideoInfo(videoInfo) {
    if (!videoInfo || !videoInfo.url) {
        return null;
    }
    
    // Get and validate type - this may also change the URL if it's extracted from a query param
    const typeInfo = getVideoType(videoInfo.url);
    
    // If type is ignored, skip this video
    if (typeInfo === 'ignored' || 
        (typeof typeInfo === 'object' && typeInfo.type === 'ignored')) {
        return null; 
    }
    
    // If URL wasn't validated by getVideoType, use our centralized validation
    if (typeof typeInfo !== 'object' && typeInfo !== 'ignored') {
        // Skip invalid URLs using the centralized isValidVideoUrl function
        if (!isValidVideoUrl(videoInfo.url)) {
            return null;
        }
    }
    
    // If type is an object with URL and type, update videoInfo with extracted URL
    if (typeof typeInfo === 'object' && typeInfo.url && typeInfo.type) {
        // Original URL might be needed for debugging, so store it
        videoInfo.originalUrl = videoInfo.url;
        // Replace with the extracted URL
        videoInfo.url = typeInfo.url;
        videoInfo.type = typeInfo.type;
        
        // Propagate foundFromQueryParam flag if present
        if (typeInfo.foundFromQueryParam) {
            videoInfo.foundFromQueryParam = true;
            console.log('Found URL in query parameter:', typeInfo.url, 'from', videoInfo.originalUrl);
        }
    } else if (typeInfo !== 'unknown') {
        videoInfo.type = typeInfo;
    }
    
    return videoInfo;
}

// Find all video elements and their sources
function findVideos() {
    const sources = [];
    
    // Find direct video elements
    document.querySelectorAll('video').forEach(video => {
        // Check direct src attribute
        if (video.src) {
            const videoInfo = extractVideoInfo(video);
            if (videoInfo) {
                sources.push(videoInfo);
                detectedVideos.add(normalizeUrl(videoInfo.url));
            }
        }

        // Check source elements inside the video
        video.querySelectorAll('source').forEach(source => {
            if (source.src) {
                const videoInfo = {
                    url: source.src,
                    poster: video.poster || null,
                    title: getVideoTitle(video),
                    timestamp: Date.now()
                };
                
                const validVideo = validateVideoInfo(videoInfo);
                if (validVideo) {
                    sources.push(validVideo);
                    detectedVideos.add(normalizeUrl(validVideo.url));
                }
            }
        });
    });
    
    // Add blob URLs
    blobUrls.forEach((info) => {
        sources.push({
            url: info.url,
            type: 'blob',
            poster: info.poster || null,
            title: info.title || 'Blob Video',
            timestamp: info.time || Date.now()
        });
    });
    
    return sources;
}

// Override init() function for proactive video scanning
function init() {
    if (isInitialized) return;
    
    console.log('Initializing video detection proactively...');
    
    // Setup listeners immediately
    setupNetworkListeners();
    setupBlobListeners();
    setupEnhancedDetection();
    
    // Listen for messages from popup with retry mechanism
    function setupMessageListener() {
        try {
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                console.log('Content script received message:', message);
                
                if (message.action === 'findVideos') {
                    const videos = findVideos();
                    console.log('Found videos:', videos);
                    sendResponse(videos);
                    return true;
                }
                
                if (message.action === 'startBackgroundDetection') {
                    autoDetectionEnabled = true;
                    sendResponse({ status: 'ok' });
                    return true;
                }
                
                if (message.action === 'stopBackgroundDetection') {
                    autoDetectionEnabled = false;
                    sendResponse({ status: 'ok' });
                    return true;
                }
                
                if (message.action === 'popupOpened') {
                    // Run an immediate video check when popup opens
                    const videos = findVideos();
                    if (videos && videos.length > 0) {
                        notifyBackground(videos);
                    }
                    sendResponse({ status: 'ready' });
                    return true;
                }
                
                if (message.action === 'popupClosed') {
                    sendResponse({ status: 'ok' });
                    return true;
                }

                // Default response for unknown messages
                sendResponse({ error: 'Unknown message type' });
                return true;
            });
            
            // Successfully set up listener
            isInitialized = true;
            console.log('Content script initialized successfully');
            
            // Immediately perform an initial scan for videos - don't wait for popup to open
            setTimeout(() => {
                const videos = findVideos();
                if (videos && videos.length > 0) {
                    notifyBackground(videos);
                    console.log('Initial video scan found videos:', videos.length);
                }
            }, 500);
            
        } catch (error) {
            console.error('Failed to setup message listener:', error);
            // Retry setup after a short delay if it fails
            setTimeout(setupMessageListener, 500);
        }
    }
    
    setupMessageListener();
}

// Start initialization immediately when content script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    // Page already loaded (rare with document_start but possible)
    init();
}

// Additional fallback - ensure initialization happens
setTimeout(() => {
    if (!isInitialized) {
        console.log('Fallback initialization...');
        init();
    }
}, 500);

// Enhanced video detection with MutationObserver
function setupEnhancedDetection() {
    // Initial check for videos
    setTimeout(() => {
        const videos = findVideos();
        if (videos && videos.length > 0) {
            notifyBackground(videos);
        }
    }, 1000);
    
    // Setup MutationObserver to watch for DOM changes
    const observer = new MutationObserver((mutations) => {
        if (!autoDetectionEnabled) return;
        
        let newVideoFound = false;
        let potentialVideoElements = new Set();
        
        // Check if any mutation might have added videos
        for (const mutation of mutations) {
            // Check added nodes
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    // Video element directly added
                    if (node.nodeName === 'VIDEO') {
                        potentialVideoElements.add(node);
                    } 
                    // Container that might have videos
                    else if (node.querySelectorAll) {
                        node.querySelectorAll('video').forEach(video => {
                            potentialVideoElements.add(video);
                        });
                    }
                });
            }
            
            // Check for attribute changes on video elements
            if (mutation.type === 'attributes' && 
                mutation.target.nodeName === 'VIDEO' && 
                (mutation.attributeName === 'src' || mutation.attributeName === 'data-src')) {
                potentialVideoElements.add(mutation.target);
            }
        }
        
        if (potentialVideoElements.size > 0) {
            // Process after a small delay to let the video elements initialize
            setTimeout(() => {
                const newVideos = [];
                
                potentialVideoElements.forEach(video => {
                    // Check if it's a valid video with a source
                    if (video.src || video.querySelector('source')) {
                        const videoInfo = extractVideoInfo(video);
                        if (videoInfo && !detectedVideos.has(normalizeUrl(videoInfo.url))) {
                            newVideos.push(videoInfo);
                            detectedVideos.add(normalizeUrl(videoInfo.url));
                            newVideoFound = true;
                        }
                    }
                    
                    // Check for blob URLs
                    if (video.src && video.src.startsWith('blob:')) {
                        if (captureBlob(video)) {
                            newVideoFound = true;
                        }
                    }
                });
                
                // Send new videos to background script if found
                if (newVideoFound) {
                    notifyBackground(newVideos);
                }
            }, 500);
        }
    });
    
    // Start observing the entire document
    observer.observe(document.documentElement, { 
        childList: true, 
        subtree: true, 
        attributes: true,
        attributeFilter: ['src', 'data-src'] 
    });
}

// Extract video information from a video element
function extractVideoInfo(videoElement) {
    let src = videoElement.src || '';
    
    // If no src attribute, check for source elements
    if (!src) {
        const source = videoElement.querySelector('source');
        if (source) {
            src = source.src || '';
        }
    }
    
    if (!src) return null;
    
    // Create basic video info
    const videoInfo = {
        url: src,
        poster: videoElement.poster || null,
        title: getVideoTitle(videoElement),
        timestamp: Date.now()
    };
    
    // Validate and return
    return validateVideoInfo(videoInfo);
}

// Notify background script of new videos
function notifyBackground(videos) {
    if (!videos || videos.length === 0) return;

    // Apply consistent validation to all videos
    const validVideos = videos
        .map(video => validateVideoInfo(video))
        .filter(video => video !== null && video.type !== 'ignored');

    if (validVideos.length === 0) return;

    // Send each valid video to background
    validVideos.forEach(video => {
        sendVideoToBackground(video.url, video.type, {
            poster: video.poster,
            title: video.title,
            foundFromQueryParam: video.foundFromQueryParam || false
        });
    });

    // Always notify about new videos, regardless of popup state
    chrome.runtime.sendMessage({
        action: 'newVideoDetected',
        videos: validVideos
    });
}