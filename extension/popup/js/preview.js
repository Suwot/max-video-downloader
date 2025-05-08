/**
 * @ai-guide-component PreviewGenerator
 * @ai-guide-description Handles video preview image generation
 * @ai-guide-responsibilities
 * - Generates thumbnail previews for videos
 * - Communicates with background script for preview generation
 * - Manages preview caching and loading states
 * - Handles preview regeneration requests
 */

import { sendPortMessage } from './index.js';
// Import from VideoStateService instead of state.js
import { addPoster } from './services/video-state-service.js';

/**
 * Generate a preview image for a video
 * @param {string} url - Video URL
 * @param {HTMLElement} loader - Loader element
 * @param {HTMLImageElement} previewImage - Preview image element
 * @param {HTMLButtonElement} regenerateButton - Regenerate button element 
 * @param {boolean} forceRegenerate - Whether to force regeneration
 * @returns {Promise<Object>} Generated preview info
 */
export async function generatePreview(url, loader, previewImage, regenerateButton, forceRegenerate = false) {
    // Show loader, hide regenerate button
    if (loader) loader.style.display = 'block';
    if (regenerateButton) regenerateButton.classList.add('hidden');
    
    // Get current tab ID
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    
    if (!tabId) {
        console.error('Cannot determine active tab');
        if (loader) loader.style.display = 'none';
        if (regenerateButton) regenerateButton.classList.remove('hidden');
        return null;
    }
    
    // Send message to generate preview
    sendPortMessage({
        type: 'generatePreview',
        url: url,
        tabId: tabId,
        forceRegenerate: forceRegenerate
    });
    
    // Wait for response via event
    return new Promise((resolve, reject) => {
        let timeoutId;
        
        const handleResponse = (event) => {
            const response = event.detail;
            
            // Only process responses for our URL
            if (response.url === url) {
                clearTimeout(timeoutId);
                document.removeEventListener('preview-generated', handleResponse);
                
                if (response.previewUrl) {
                    // Update the image
                    if (previewImage) {
                        previewImage.onload = () => {
                            previewImage.classList.remove('placeholder');
                            previewImage.classList.add('loaded');
                            if (loader) loader.style.display = 'none';
                        };
                        previewImage.src = response.previewUrl;
                    }
                    
                    // Cache the preview URL
                    addPoster(url, response.previewUrl);
                    
                    resolve(response);
                } else {
                    // Preview generation failed
                    if (loader) loader.style.display = 'none';
                    if (regenerateButton) regenerateButton.classList.remove('hidden');
                    resolve(null);
                }
            }
        };
        
        // Set timeout for response
        timeoutId = setTimeout(() => {
            document.removeEventListener('preview-generated', handleResponse);
            // Preview generation timed out
            if (loader) loader.style.display = 'none';
            if (regenerateButton) regenerateButton.classList.remove('hidden');
            resolve(null);
        }, 10000);
        
        // Listen for response
        document.addEventListener('preview-generated', handleResponse);
    });
}