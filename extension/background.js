/**
 * @ai-guide-component BackgroundScript
 * @ai-guide-description Main extension service worker
 * @ai-guide-responsibilities
 * - Initializes the video detection system on extension startup
 * - Manages cross-tab communication via message passing
 * - Coordinates content script injection into web pages
 * - Maintains video detection state across browser sessions
 * - Handles native host communication via Native Host Service
 * - Implements browser action icon and badge functionality  
 * - Provides centralized video metadata storage for popup UI
 * - Filters tracking pixels while preserving legitimate video URLs
 * - Processes URLs extracted from query parameters with proper metadata
 * - Maintains the foundFromQueryParam flag throughout the video pipeline
 * - Deduplicates videos using smart URL normalization
 */

// background.js - Service worker for the extension

// Import our modularized services
import { addVideoToTab, getAllDetectedVideos } from './background/services/video-manager.js';
import { initTabTracking } from './background/services/tab-tracker.js';
import { setupDownloadPort } from './background/services/download-manager.js';
import { setupPopupPort } from './background/services/popup-ports.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Background]', new Date().toISOString(), ...args);
}

// Debug logger for allDetectedVideos - will log every 10 seconds
// TO BE REMOVED AFTER DEBUGGING
let debugInterval;
function startDebugLogger() {
  if (debugInterval) {
    clearInterval(debugInterval);
  }
  
  debugInterval = setInterval(() => {
    console.log('=== DEBUG: allDetectedVideos Map ===');
    
    try {
      // Get direct access to the internal structure via globalThis
      const rawStructure = globalThis.allDetectedVideosInternal;
      if (rawStructure && rawStructure instanceof Map) {
        // This is the raw nested Map structure
        console.log('Total tabs with videos:', rawStructure.size);
        
        // Display each tab's data separately for clearer output
        for (const [tabId, urlMap] of rawStructure.entries()) {
          if (urlMap instanceof Map) {
            console.log(`Tab ${tabId}: (${urlMap.size} videos)`);
            // Convert urlMap entries to a regular object for easier console viewing
            // Make sure to check if urlMap has entries method before using it
            try {
              const urlMapObj = {};
              for (const [url, videoInfo] of urlMap.entries()) {
                urlMapObj[url] = videoInfo;
              }
              console.log('  Videos:', urlMapObj);
            } catch (err) {
              console.log('  Videos:', urlMap);
              console.error('  Error processing tab videos:', err);
            }
          } else {
            console.log(`Tab ${tabId}: (urlMap is not a Map)`, urlMap);
          }
        }
      } else {
        // Fallback to using the getAllDetectedVideos function
        console.log('Using getAllDetectedVideos() - flattened view:');
        const videos = getAllDetectedVideos();
        if (videos instanceof Map) {
          console.log('Total videos across all tabs:', videos.size);
          
          // Group by tab ID
          const byTab = {};
          try {
            for (const [url, video] of videos.entries()) {
              const tabId = video.tabId;
              if (!byTab[tabId]) byTab[tabId] = [];
              byTab[tabId].push({ url, ...video });
            }
            
            // Print the grouping
            for (const tabId in byTab) {
              console.log(`Tab ${tabId}: (${byTab[tabId].length} videos)`);
              console.log('  Videos:', byTab[tabId]);
            }
          } catch (err) {
            console.error('  Error processing videos by tab:', err);
            console.log('  Raw videos object:', videos);
          }
        } else {
          console.log('getAllDetectedVideos() did not return a Map:', videos);
        }
      }
    } catch (e) {
      console.error('Error in debug logger:', e);
    }
    
    console.log('================================');
  }, 10000); // Log every 10 seconds
}

// Start the debug logger
startDebugLogger();

// Initialize tab tracking
initTabTracking();

// Handle port connections
chrome.runtime.onConnect.addListener(port => {
    console.log('Background woke up: port connected:', port.name);
    
    // Create unique port ID
    const portId = Date.now().toString();
    
    if (port.name === 'download_progress') {
        setupDownloadPort(port, portId);
    } else if (port.name === 'popup') {
        setupPopupPort(port, portId);
    }
});

// Listen for web requests to catch video-related content
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const url = details.url;
        
        // Skip known tracking/analytics domains
        const trackingDomains = [
            'jwpltx.com',
            'analytics',
            'telemetry',
            'tracking',
            'tracker',
            'pixel',
            'beacon',
            'stats',
            'metrics'
        ];
        
        try {
            // Parse the URL to examine its components
            const urlObj = new URL(url);
            
            // Skip obvious tracking/analytics endpoints
            if (urlObj.pathname.endsWith('.gif') || 
                urlObj.pathname.endsWith('.pixel') || 
                urlObj.pathname.includes('/ping') || 
                urlObj.pathname.includes('/analytics') || 
                urlObj.hostname.includes('tracker')) {
                return;
            }
            
            // Skip if domain contains any tracking keywords
            const domainLower = urlObj.hostname.toLowerCase();
            if (trackingDomains.some(term => domainLower.includes(term))) {
                return;
            }
            
            // Check for HLS, DASH, and direct video files with more precise path-based detection
            let isVideoUrl = false;
            let type = 'unknown';
            
            // Check for HLS streams (.m3u8)
            if (url.includes('.m3u8')) {
                // Verify it's in the path, not just a parameter
                const isActualM3U8 = 
                    urlObj.pathname.includes('.m3u8') || 
                    urlObj.pathname.includes('/master.m3u8') || 
                    urlObj.pathname.includes('/index-f');
                
                if (isActualM3U8) {
                    isVideoUrl = true;
                    type = 'hls';
                }
            } 
            // Check for DASH manifests (.mpd)
            else if (url.includes('.mpd')) {
                // Verify it's in the path, not just a parameter
                const isActualMPD = urlObj.pathname.includes('.mpd');
                
                if (isActualMPD) {
                    isVideoUrl = true;
                    type = 'dash';
                }
            } 
            // Check for direct video files
            else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)) {
                isVideoUrl = true;
                type = 'direct';
            }
            
            // Add video if it passed all the filtering
            if (isVideoUrl) {
                addVideoToTab(details.tabId, {
                    url: url,
                    type: type,
                    source: 'webRequest'
                });
            }
        } catch (err) {
            // If URL parsing fails, fall back to the original simpler checks
            // This ensures we don't miss videos due to URL parsing errors
            if (
                (url.includes('.m3u8') && !url.includes('.gif') && !url.includes('ping')) || 
                (url.includes('.mpd') && !url.includes('.gif') && !url.includes('ping')) || 
                /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)
            ) {
                // Determine type
                let type = 'unknown';
                if (url.includes('.m3u8')) {
                    type = 'hls';
                } else if (url.includes('.mpd')) {
                    type = 'dash';
                } else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)) {
                    type = 'direct';
                }
                
                // Add video
                addVideoToTab(details.tabId, {
                    url: url,
                    type: type,
                    source: 'webRequest'
                });
            }
        }
    },
    { urls: ["<all_urls>"] }
);

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle video detection from content script 
    if (request.action === 'newVideoDetected' && request.videos && request.videos.length > 0) {
        const tabId = sender?.tab?.id;
        if (!tabId) return false;
        
        console.log(`Received ${request.videos.length} new videos from content script for tab ${tabId}`);
        
        // Process each video through the same pipeline
        request.videos.forEach(video => {
            addVideoToTab(tabId, {
                url: video.url,
                type: video.type,
                source: 'contentScript',
                poster: video.poster,
                title: video.title,
                foundFromQueryParam: video.foundFromQueryParam || false,
                originalUrl: video.originalUrl
            });
        });
        
        return false;
    }
    
    // Handle video detection from content script (legacy format)
    if (request.action === 'addVideo') {
        const tabId = sender.tab?.id;
        if (tabId && tabId > 0) {
            addVideoToTab(tabId, request);
        }
        return false;
    }
    
    return false;
});

logDebug('Background script initialized');

// Listen for when the service worker is about to be suspended
chrome.runtime.onSuspend.addListener(() => {
  console.log('Background going to sleep...');
});