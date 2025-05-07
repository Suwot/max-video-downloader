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
// Import new video store - for now we'll use both systems in parallel
import videoStoreAdapter from './background/services/temp/video-store-adapter.js';

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
            
            const videoInfo = {
                url: url,
                type: type,
                source: 'network', // Using 'network' consistently for webRequest detected videos
                detectionTimestamp: new Date().toISOString()
            };
            
            // Add to both systems - will gradually transition to just using videoStore
            addVideoToTab(details.tabId, videoInfo);
            
            // Also add to our new store through the adapter
            videoStoreAdapter.addVideoToStore(details.tabId, videoInfo);
        }
    },
    { urls: ["<all_urls>"] }
);

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle video detection from content script 
    if (request.action === 'newVideoDetected' && request.videos && request.videos.length > 0) {
        const tabId = sender?.tab?.id || request.tabId; // Accept tabId from message too for testing
        if (!tabId) return false;
        
        console.log(`Received ${request.videos.length} new videos from content script for tab ${tabId}`);
        
        // Process each video through both pipelines
        request.videos.forEach(video => {
            const videoInfo = {
                url: video.url,
                type: video.type,
                source: video.source || 'page', // Ensure consistent 'page' source value
                poster: video.poster,
                title: video.title,
                foundFromQueryParam: video.foundFromQueryParam || false,
                originalUrl: video.originalUrl,
                detectionTimestamp: new Date().toISOString()
            };
            
            // Add to both systems
            addVideoToTab(tabId, videoInfo);
            
            // Also add to our new store
            videoStoreAdapter.addVideoToStore(tabId, videoInfo);
        });
        
        // Notify popup about the update - ensures popup immediately refreshes its UI
        try {
            chrome.runtime.sendMessage({
                action: 'videoStateUpdated',
                tabId: tabId
            });
        } catch (error) {
            // Popup might not be open, which is fine
            console.log('Error notifying popup:', error.message);
        }
        
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
            
            // Add to both systems
            addVideoToTab(tabId, request);
            
            // Also add to our new store
            videoStoreAdapter.addVideoToStore(tabId, request);
            
            // Notify popup about the update
            try {
                chrome.runtime.sendMessage({
                    action: 'videoStateUpdated',
                    tabId: tabId
                });
            } catch (error) {
                // Popup might not be open, which is fine
                console.log('Error notifying popup:', error.message);
            }
        }
        return false;
    }
    
    // Handle popup opened message to register active popups for updates
    if (request.action === 'popupOpened' && request.tabId) {
        console.log(`Popup opened for tab ${request.tabId}, registering for updates`);
        
        // Register this popup with the video store adapter
        videoStoreAdapter.registerActivePopup(request.tabId);
        
        // No need for response
        return false;
    }
    
    // Handle popup closed message (optional, we also track this on tabs.onRemoved)
    if (request.action === 'popupClosed' && request.tabId) {
        console.log(`Popup closed for tab ${request.tabId}, unregistering`);
        
        // Unregister this popup from the video store adapter
        videoStoreAdapter.unregisterActivePopup(request.tabId);
        
        // No need for response
        return false;
    }
    
    // New handler for fetching videos directly from the store
    if (request.action === 'getVideosFromStore') {
        const tabId = request.tabId;
        if (tabId) {
            // Get videos from the new store (properly filtered)
            const videos = videoStoreAdapter.getVideosForTab(tabId);
            
            // Log the filtering to match the original system's format
            console.log(`[Video Manager] ${new Date().toISOString()} Filtered videos for tab ${tabId}: ${videos.length}`);
            
            sendResponse({ videos });
            return true; // We're handling this asynchronously
        }
    }
    
    // New handler for clearing videos for a tab
    if (request.action === 'clearVideosForTab') {
        const tabId = request.tabId;
        if (tabId) {
            // Clear videos from the new store
            videoStoreAdapter.cleanupForTab(tabId);
            
            // TODO: Also clear from old system when fully transitioning
            
            sendResponse({ success: true });
            return true;
        }
    }
    
    return false;
});

logDebug('Background script initialized with new video store');

// Listen for when the service worker is about to be suspended
chrome.runtime.onSuspend.addListener(() => {
  console.log('Background going to sleep...');
});