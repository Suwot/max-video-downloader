console.log('Content script loading...');

// Track detected videos to avoid duplicates
const detectedVideos = new Set();
const blobUrls = new Map();
let isPopupOpen = false;
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
            
            // Send to background with enhanced metadata
            await sendVideoToBackground(url, info.type, {
                contentType: info.contentType,
                headers: info.responseHeaders
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
    // Normalize URL to avoid duplicates
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already detected
    if (detectedVideos.has(normalizedUrl)) {
        return;
    }
    
    // Add to detected videos
    detectedVideos.add(normalizedUrl);
    
    // Determine type from URL
    const type = getVideoType(url);
    
    // Send to background
    chrome.runtime.sendMessage({
        action: 'addVideo',
        url: url,
        source: source,
        type: type,
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
        const baseUrl = url.split('?')[0].split('#')[0];
        
        // Define patterns for tracking/analytics URLs
        const ignoredPathPatterns = [
            /\.gif$/i,                  // tracking pixels
            /\/ping/i,                  // ping endpoints
            /\/track/i, /\/pixel/i,
            /\/stats/i, /\/metric/i,
            /\/telemetry/i,
            /\/analytics/i,
            /jwpltx/, /tracking/
        ];

        // Check if URL matches ignored patterns
        if (ignoredPathPatterns.some(pattern => pattern.test(urlObj.pathname) || pattern.test(urlObj.hostname))) {
            // Before rejecting, check if query params contain actual video URLs
            const containsVideoParam = Array.from(urlObj.searchParams.values()).some(v => {
                try {
                    const decoded = decodeURIComponent(v);
                    return decoded.includes('.m3u8') || decoded.includes('.mpd');
                } catch {
                    return false;
                }
            });
            
            if (!containsVideoParam) {
                return 'direct';
            }
        }

        // Scan query parameters for embedded video URLs
        for (const [key, value] of urlObj.searchParams.entries()) {
            try {
                const decoded = decodeURIComponent(value);
                if (decoded.match(/\.m3u8(\?|$)/)) return 'hls';
                if (decoded.match(/\.mpd(\?|$)/)) return 'dash';
            } catch {}
        }

        // Check the base URL for direct video patterns
        if (baseUrl.toLowerCase().endsWith('.m3u8') || urlObj.pathname.includes('/hls/')) {
            return 'hls';
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
        // Remove common tracking or cache-busting parameters
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        return urlObj.toString();
    } catch {
        return url;
    }
}

// Find all video elements and their sources
function findVideos() {
    const sources = [];
    
    // Find direct video elements
    document.querySelectorAll('video').forEach(video => {
        // Check direct src attribute (can be blob or direct)
        if (video.src) {
            const info = extractVideoInfo(video);
            if (info) {
                sources.push(info);
                detectedVideos.add(normalizeUrl(info.url));
            }
        }
        
        // Check source elements inside the video
        video.querySelectorAll('source').forEach(source => {
            if (source.src) {
                sources.push({
                    url: source.src,
                    type: getVideoType(source.src),
                    poster: video.poster || null,
                    title: getVideoTitle(video),
                    timestamp: Date.now()
                });
                detectedVideos.add(normalizeUrl(source.src));
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

// Initialize
function init() {
    if (isInitialized) return;
    
    console.log('Initializing video detection...');
    
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
                    isPopupOpen = true;
                    // Run an immediate video check when popup opens
                    const videos = findVideos();
                    if (videos && videos.length > 0) {
                        notifyBackground(videos);
                    }
                    sendResponse({ status: 'ready' });
                    return true;
                }
                
                if (message.action === 'popupClosed') {
                    isPopupOpen = false;
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
            
        } catch (error) {
            console.error('Failed to setup message listener:', error);
            // Retry setup after a short delay if it fails
            setTimeout(setupMessageListener, 500);
        }
    }
    
    setupMessageListener();
}

// Ensure initialization happens at the right time
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
    // Fallback in case DOMContentLoaded was missed
    window.addEventListener('load', init);
}

// Additional fallback - check initialization after a delay
setTimeout(() => {
    if (!isInitialized) {
        console.log('Fallback initialization...');
        init();
    }
}, 1000);

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
    
    return {
        url: src,
        type: getVideoType(src),
        poster: videoElement.poster || null,
        title: getVideoTitle(videoElement),
        timestamp: Date.now()
    };
}

// Notify background script of new videos
function notifyBackground(videos) {
    if (!videos || videos.length === 0) return;
    
    // Send each video to background
    videos.forEach(video => {
        sendVideoToBackground(video.url, video.type, {
            poster: video.poster,
            title: video.title
        });
    });
    
    // If popup is open, also notify it directly
    if (isPopupOpen) {
        chrome.runtime.sendMessage({
            action: 'newVideoDetected',
            videos: videos
        });
    }
}