import { addPosterToCache } from './state.js';
import nativeConnection from './native-connection.js';

/**
 * Generate preview image for a video
 * @param {string} url - Video URL
 * @param {HTMLElement} loader - Loader element
 * @param {HTMLElement} previewImage - Preview image element
 * @param {HTMLElement} regenerateButton - Regenerate button element
 */
export async function generatePreview(url, loader, previewImage, regenerateButton) {
    // Ensure loader is visible
    loader.style.display = 'block';
    
    try {
        // Get the current tab ID
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        
        // Use native connection to generate preview
        const response = await nativeConnection.sendMessage({
            type: 'generatePreview',
            url: url,
            tabId: tabId // Pass tabId for caching
        });
        
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
    } catch (error) {
        console.error('Preview generation failed:', error);
        loader.style.display = 'none';
        regenerateButton.classList.remove('hidden');
    }
} 