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
import { addVideoToTab } from './background/services/video-manager.js';
import { initTabTracking } from './background/services/tab-tracker.js';
import { setupDownloadPort } from './background/services/download-manager.js';
import { setupPopupPort } from './background/services/popup-ports.js';

// Debug logging helper
function logDebug(...args) {
    console.log('[Background]', new Date().toISOString(), ...args);
}

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
        // Check for HLS, DASH, and direct video files
        if (
            url.includes('.m3u8') || 
            url.includes('.mpd') || 
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
            
            // Add video - using 'network' source instead of 'webRequest' to better distinguish 
            // from page-detected videos for deduplication purposes
            addVideoToTab(details.tabId, {
                url: url,
                type: type,
                source: 'network', // Changed from 'webRequest' to be distinct from 'page' variants
                detectionTimestamp: new Date().toISOString()
            });
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
                source: video.source || 'page', // Ensure consistent 'page' source value
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
            // Ensure source is consistent
            if (!request.source || request.source === 'content_script') {
                request.source = 'page';
            }
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