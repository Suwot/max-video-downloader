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


/**
 * Generate preview image for a video
 * @param {string} url - Video URL
 * @param {HTMLElement} loader - Loader element
 * @param {HTMLElement} previewImage - Preview image element
 * @param {HTMLElement} regenerateButton - Regenerate button element
 */
export function generatePreview(url, loader, previewImage, regenerateButton) {
    // Ensure loader is visible
    loader.style.display = 'block';
    
    // Get the current tab ID
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        
        chrome.runtime.sendMessage({
            type: 'generatePreview',
            url: url,
            tabId: tabId // Pass tabId for caching
        }, response => {
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
        });
    });
}