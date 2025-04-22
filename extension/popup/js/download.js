import { showError } from './utilities.js';
import { debounce } from './utilities.js';

/**
 * Handle download button click
 * @param {HTMLElement} button - Download button
 * @param {string} url - Video URL
 * @param {string} type - Video type
 */
export async function handleDownload(button, url, type) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Downloading...';
    
    try {
        // For blob URLs with blob: protocol, we need special handling
        if (type === 'blob' && url.startsWith('blob:')) {
            await handleBlobDownload(url);
            setTimeout(() => resetDownloadButton(button, originalText), 2000);
            return;
        }
        
        // Regular video files can be downloaded with the native host
        const messageType = (type === 'hls' || type === 'dash') ? 'downloadHLS' : 'download';
        
        chrome.runtime.sendMessage({
            type: messageType,
            url: url
        }, response => {
            if (response && response.success) {
                setTimeout(() => resetDownloadButton(button, originalText), 2000);
            } else if (response && response.error) {
                showError(response.error);
                resetDownloadButton(button, originalText);
            }
            // Ignore progress updates - we just stay in "Downloading..." state
        });
        
    } catch (error) {
        console.error('Download failed:', error);
        showError('Failed to start download');
        resetDownloadButton(button, originalText);
    }
}

/**
 * Handle blob URL downloads via browser download API
 * @param {string} url - Blob URL
 */
async function handleBlobDownload(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch blob');
        
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        // Use Chrome's download API
        chrome.downloads.download({
            url: blobUrl,
            filename: 'video_blob.mp4'
        }, downloadId => {
            if (chrome.runtime.lastError) {
                showError('Failed to download: ' + chrome.runtime.lastError.message);
            }
            
            // Clean up the blob URL
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        });
        
    } catch (error) {
        console.error('Blob download failed:', error);
        showError('Blob download failed - try using the copy URL button');
        throw error; // Re-throw for the caller to reset button state
    }
}

/**
 * Reset download button state
 * @param {HTMLElement} button - Download button
 * @param {string} originalText - Original button text
 */
function resetDownloadButton(button, originalText) {
    button.disabled = false;
    button.textContent = originalText;
} 