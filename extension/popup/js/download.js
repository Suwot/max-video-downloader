import { showError } from './utilities.js';
import { debounce } from './utilities.js';
import { downloadFile, onProgress } from './native-connection.js';
import nativeConnection from './native-connection.js';

// Collection of active downloads
const activeDownloads = new Map();

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
        // Get download progress container
        const videoItem = button.closest('.video-item');
        const progressContainer = videoItem.querySelector('.progress-container');
        const progressBar = progressContainer.querySelector('.progress-bar');
        
        // Show progress container
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        
        // Generate a unique download ID
        const downloadId = Date.now().toString();
        
        // Store download info
        activeDownloads.set(downloadId, {
            url,
            type,
            button,
            originalText,
            progressContainer,
            progressBar
        });
        
        // Register the progress handler for this download
        const removeProgressListener = onProgress((progressMessage) => {
            if (progressMessage.downloadId === downloadId) {
                updateDownloadProgress(downloadId, progressMessage.progress, progressMessage.message);
                
                // If download is complete, clean up
                if (progressMessage.progress >= 100 || progressMessage.status === 'completed') {
                    completeDownload(downloadId, true);
                    removeProgressListener();
                } else if (progressMessage.status === 'error') {
                    completeDownload(downloadId, false, progressMessage.error);
                    removeProgressListener();
                }
            }
        });
        
        // For blob URLs with blob: protocol, we need special handling
        if (type === 'blob' && url.startsWith('blob:')) {
            await handleBlobDownload(url, downloadId);
            return;
        }
        
        // Use native messaging for downloads
        try {
            // Check if type is audio and use appropriate download type
            const downloadType = type === 'audio' ? 'download' : 
                                (type === 'hls' || type === 'dash') ? 'downloadHLS' : 'download';
            
            const result = await downloadFile(url, type, { downloadId });
            
            if (result.error) {
                completeDownload(downloadId, false, result.error);
            } else if (result.status === 'started') {
                // Download has started successfully, but we'll wait for progress updates
                button.textContent = 'Downloading... 0%';
            } else {
                // Immediate completion (unlikely but possible)
                completeDownload(downloadId, true);
            }
        } catch (error) {
            // Fall back to direct native connection if downloadFile API fails
            console.warn('Native download failed via API, trying direct connection:', error);
            
            try {
                // Direct connection fallback
                const response = await nativeConnection.sendMessage({
                    type: downloadType,
                    url: url,
                    downloadId: downloadId
                });
                
                if (response.error) {
                    completeDownload(downloadId, false, response.error);
                } else if (response.status === 'started') {
                    button.textContent = 'Downloading... 0%';
                } else if (response.success) {
                    completeDownload(downloadId, true);
                }
            } catch (connectionError) {
                console.error('All native download methods failed:', connectionError);
                showError('Native download failed - check if the native application is installed');
                completeDownload(downloadId, false, connectionError.message);
            }
        }
    } catch (error) {
        console.error('Download failed:', error);
        showError('Failed to start download');
        resetDownloadButton(button, originalText);
    }
}

/**
 * Update download progress
 * @param {string} downloadId - Download ID
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Optional status message
 */
function updateDownloadProgress(downloadId, progress, message = null) {
    const download = activeDownloads.get(downloadId);
    if (!download) return;
    
    const { button, progressBar } = download;
    
    // Update progress bar
    progressBar.style.width = `${progress}%`;
    
    // Update button text
    if (message) {
        button.textContent = message;
    } else {
        button.textContent = `Downloading... ${Math.round(progress)}%`;
    }
}

/**
 * Complete download and reset UI
 * @param {string} downloadId - Download ID
 * @param {boolean} success - Whether download was successful
 * @param {string} error - Optional error message
 */
function completeDownload(downloadId, success, error = null) {
    const download = activeDownloads.get(downloadId);
    if (!download) return;
    
    const { button, originalText, progressContainer } = download;
    
    if (success) {
        // Show success state briefly
        button.textContent = 'Downloaded!';
        button.classList.add('success');
        
        // Reset button after delay
        setTimeout(() => {
            resetDownloadButton(button, originalText);
            progressContainer.style.display = 'none';
        }, 2000);
    } else {
        // Show error
        if (error) {
            showError(error);
        } else {
            showError('Download failed');
        }
        
        // Reset immediately
        resetDownloadButton(button, originalText);
        progressContainer.style.display = 'none';
    }
    
    // Remove from active downloads
    activeDownloads.delete(downloadId);
}

/**
 * Handle blob URL downloads via browser download API
 * @param {string} url - Blob URL
 * @param {string} downloadId - Download ID
 */
async function handleBlobDownload(url, downloadId) {
    try {
        updateDownloadProgress(downloadId, 10, 'Fetching blob...');
        
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch blob');
        
        updateDownloadProgress(downloadId, 50, 'Processing...');
        
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        updateDownloadProgress(downloadId, 75, 'Downloading...');
        
        // Use Chrome's download API
        chrome.downloads.download({
            url: blobUrl,
            filename: 'video_blob.mp4'
        }, (chromeDownloadId) => {
            if (chrome.runtime.lastError) {
                showError('Failed to download: ' + chrome.runtime.lastError.message);
                completeDownload(downloadId, false, chrome.runtime.lastError.message);
            } else {
                updateDownloadProgress(downloadId, 100, 'Downloaded!');
                completeDownload(downloadId, true);
            }
            
            // Clean up the blob URL
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        });
    } catch (error) {
        console.error('Blob download failed:', error);
        showError('Blob download failed - try using the copy URL button');
        completeDownload(downloadId, false, error.message);
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
    button.classList.remove('success');
} 