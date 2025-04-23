console.log('Content script loaded');

// Track detected videos to avoid duplicates
const detectedVideos = new Set();
const blobUrls = new Map();
let isPopupOpen = false;
let autoDetectionEnabled = true;

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
                    sendVideoToBackground(url, 'xhr');
                }
            }
            
            if (originalOnReadyStateChange) {
                originalOnReadyStateChange.apply(this, arguments);
            }
        });
        
        return originalXhrOpen.apply(this, [method, url, ...args]);
    };
    
    // Override fetch to capture video URLs
    const originalFetch = window.fetch;
    window.fetch = function(resource, init) {
        const url = resource instanceof Request ? resource.url : resource;
        
        return originalFetch.apply(this, arguments).then(response => {
            const clonedResponse = response.clone();
            
            clonedResponse.headers.get('Content-Type').then(contentType => {
                if (isVideoRelatedUrl(url, contentType)) {
                    sendVideoToBackground(url, 'fetch');
                }
            }).catch(() => {});
            
            return response;
        });
    };
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
    console.log('Checking URL for video content:', url, 'Content-Type:', contentType);
    
    // Known video extensions and manifest formats
    const videoPatterns = [
        /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|#|$)/i,    // Direct video files
        /\.(m3u8|m3u)(\?|#|$)/i,                        // HLS playlists
        /\.(mpd)(\?|#|$)/i,                            // DASH manifests
        /\/(playlist|manifest|master)\.json(\?|#|$)/i,  // Some custom manifest formats
        /\/hls[\/\-_]/i,                               // HLS folder patterns
        /\/dash[\/\-_]/i,                              // DASH folder patterns
        /\/playlist[\/\-_]/i,                          // Playlist folder patterns
        /\/live[\/\-_]/i,                              // Live stream patterns
        /\/segment[s]?[\/\-_]/i,                       // Segment patterns
        /\/manifest[\/\-_]/i,                          // Manifest patterns
        /\/audio_/i,                                   // Audio patterns
        /_audio/i                                      // Audio patterns
    ];
    
    // Known video MIME types
    const videoMimeTypes = [
        'video/',
        'application/x-mpegURL',
        'application/vnd.apple.mpegURL',
        'application/dash+xml',
        'application/vnd.ms-sstr+xml',  // Smooth Streaming
        'audio/',                       // Include audio MIME types
        'application/octet-stream'      // Some streams use this generic MIME type
    ];
    
    // Check URL patterns
    if (videoPatterns.some(pattern => pattern.test(url))) {
        const matchedPattern = videoPatterns.find(pattern => pattern.test(url));
        console.log('URL matched video pattern:', matchedPattern);
        return true;
    }
    
    // Check content type if available
    if (contentType && videoMimeTypes.some(type => contentType.includes(type))) {
        const matchedType = videoMimeTypes.find(type => contentType.includes(type));
        console.log('Content-Type matched video MIME type:', matchedType);
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
    
    console.log(`Sending ${type} video to background:`, url, 'Source:', source);
    
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
    // Check for HLS manifests (.m3u8)
    if (url.match(/\.m3u8(\?|$)/i)) {
        return 'hls';
    }

    // Check for DASH manifests
    if (url.match(/\.mpd(\?|$)/i) || url.match(/\/dash[\/\-_]/i)) {
        return 'dash';
    }

    // Check for audio files
    if (url.match(/\.(mp3|m4a|aac|wav|flac|ogg)(\?|$)/i)) {
        return 'audio';
    }

    // Default to regular video
    return 'video';
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
    console.log('Initializing video detection...');
    setupNetworkListeners();
    setupBlobListeners();
    
    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Ping to check if content script is ready
        if (message.action === 'ping') {
            sendResponse({ status: 'ready' });
            return true;
        }
        
        if (message.action === 'findVideos') {
            const videos = findVideos();
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
            sendResponse({ status: 'ok' });
            return true;
        }
        
        if (message.action === 'popupClosed') {
            isPopupOpen = false;
            sendResponse({ status: 'ok' });
            return true;
        }
    });
    
    // Enhanced video detection with MutationObserver
    setupEnhancedDetection();
}

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
    if (!videoElement || !videoElement.src) {
        return null;
    }
    
    // Determine type based on URL
    let type = getVideoType(videoElement.src);
    
    // Check if this is actually an audio element or video without visual tracks
    if (videoElement.videoWidth === 0 || 
        videoElement.videoHeight === 0 || 
        videoElement.getAttribute('data-audio-only') === 'true' ||
        videoElement.classList.contains('audio-only') ||
        videoElement.mozHasAudio ||
        (videoElement.src && (
            videoElement.src.includes('/audio_') ||
            videoElement.src.includes('_audio') ||
            videoElement.src.match(/\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?|#|$)/i)
        ))) {
        type = 'audio';
    }
    
    return {
        url: videoElement.src,
        type: type,
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

// Check if service worker is responsive
function checkServiceWorkerHealth() {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.warn('Service worker health check timed out');
            resolve(false);
        }, 1000);
        
        chrome.runtime.sendMessage({ type: 'healthCheck' })
            .then(() => {
                clearTimeout(timeout);
                resolve(true);
            })
            .catch((error) => {
                clearTimeout(timeout);
                console.error('Service worker health check failed:', error);
                resolve(false);
            });
    });
}

// Perform periodic health checks
setInterval(async () => {
    const isHealthy = await checkServiceWorkerHealth();
    
    if (!isHealthy) {
        console.warn('Service worker appears to be unresponsive, reloading extension...');
        // Notify user that extension needs to reload
        chrome.runtime.reload(); // This might help in some cases
    }
}, 120000); // Check every 2 minutes

// Initialize listeners
init();