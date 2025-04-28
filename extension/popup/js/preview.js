/**
 * @ai-guide-component PreviewGenerator
 * @ai-guide-description Generates and manages video thumbnails and previews
 * @ai-guide-responsibilities
 * - Requests thumbnail generation from the native host
 * - Manages preview image caching to avoid redundant generation
 * - Handles displaying previews in the UI
 * - Provides fallback mechanisms when preview generation fails
 * - Optimizes preview loading for better user experience
 * - Handles different preview formats based on video type
 */

import { addPosterToCache } from './state.js';
import { sendPortMessage } from './index.js';

// Track URLs that are currently being processed to prevent duplicate requests
const pendingPreviewRequests = new Set();

/**
 * Generate preview image for a video
 * @param {string} url - Video URL
 * @param {HTMLElement} loader - Loader element
 * @param {HTMLElement} previewImage - Preview image element
 * @param {HTMLElement} regenerateButton - Regenerate button element
 * @param {boolean} forceRegenerate - Whether to force regeneration even if request is pending
 */
export function generatePreview(url, loader, previewImage, regenerateButton, forceRegenerate = false) {
    // Skip if this URL is already being processed (unless force regenerate is true)
    if (pendingPreviewRequests.has(url) && !forceRegenerate) {
        console.log(`Preview generation already in progress for ${url}, skipping duplicate request`);
        return;
    }
    
    // Mark this URL as being processed
    pendingPreviewRequests.add(url);
    
    // Ensure loader is visible
    loader.style.display = 'block';
    
    // Get the current tab ID
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        
        // Use port communication instead of one-time message
        sendPortMessage({
            type: 'generatePreview',
            url: url,
            tabId: tabId // Pass tabId for caching
        });
        
        // Set up listener for preview response
        const previewListener = (event) => {
            const response = event.detail;
            
            // Make sure this is the response for our URL
            if (response.requestUrl === url) {
                // Remove listener once we've handled our response
                document.removeEventListener('preview-generated', previewListener);
                
                // Remove from pending requests
                pendingPreviewRequests.delete(url);
                
                if (response && response.previewUrl) {
                    // Add load handler before setting src
                    previewImage.onload = () => {
                        previewImage.classList.remove('placeholder');
                        previewImage.classList.add('loaded');
                        loader.style.display = 'none';
                        regenerateButton.classList.add('hidden');
                        
                        // Cache the poster
                        addPosterToCache(url, response.previewUrl);
                    };
                    
                    // Handle load errors
                    previewImage.onerror = () => {
                        console.error('Failed to load preview image');
                        loader.style.display = 'none';
                        regenerateButton.classList.remove('hidden');
                    };
                    
                    previewImage.src = response.previewUrl;
                } else {
                    loader.style.display = 'none';
                    regenerateButton.classList.remove('hidden');
                }
            }
        };
        
        // Add listener for the preview response event
        document.addEventListener('preview-generated', previewListener);
        
        // Add timeout to prevent infinite waiting
        setTimeout(() => {
            // If we're still waiting for this URL
            if (pendingPreviewRequests.has(url)) {
                document.removeEventListener('preview-generated', previewListener);
                pendingPreviewRequests.delete(url);
                
                if (loader.style.display !== 'none') {
                    loader.style.display = 'none';
                    regenerateButton.classList.remove('hidden');
                    console.error('Preview generation timed out');
                }
            }
        }, 30000); // 30 second timeout
    });
}