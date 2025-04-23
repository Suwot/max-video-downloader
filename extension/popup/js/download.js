import { showError } from './utilities.js';
import { debounce } from './utilities.js';

let downloadPort = null;

/**
 * Handle download button click
 * @param {HTMLElement} button - Download button
 * @param {string} url - Video URL
 * @param {string} type - Video type
 */
export async function handleDownload(button, url, type) {
    const originalText = button.textContent;
    button.disabled = true;
    
    // Get the progress container and bar
    const videoItem = button.closest('.video-item');
    const progressContainer = videoItem.querySelector('.progress-container');
    const progressBar = progressContainer.querySelector('.progress-bar');
    
    // Create progress info container
    const progressInfo = document.createElement('div');
    progressInfo.className = 'progress-info';
    progressContainer.appendChild(progressInfo);
    
    // Show progress elements
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    
    try {
        // For blob URLs, handle differently
        if (type === 'blob' && url.startsWith('blob:')) {
            await handleBlobDownload(url);
            resetDownloadState();
            return;
        }
        
        // Create a new port connection for this download
        downloadPort = chrome.runtime.connect({ name: 'download_progress' });
        
        // Set up message listener
        downloadPort.onMessage.addListener((response) => {
            console.log('Progress update:', response);
            
            if (response?.type === 'progress') {
                // Update progress bar
                progressBar.style.width = `${response.progress}%`;
                
                // Update progress info with speed and ETA
                const progressText = [];
                
                if (response.speed) {
                    progressText.push(`${formatSpeed(response.speed)}`);
                }
                
                if (response.eta) {
                    progressText.push(`ETA: ${formatTime(response.eta)}`);
                }
                
                if (response.size) {
                    progressText.push(`Size: ${formatSize(response.size)}`);
                }
                
                if (response.downloaded) {
                    progressText.push(`${formatSize(response.downloaded)} downloaded`);
                }
                
                progressInfo.textContent = progressText.join(' • ');
                button.textContent = `${response.progress}%`;
            } else if (response?.success) {
                button.textContent = 'Complete!';
                setTimeout(() => resetDownloadState(), 2000);
            } else if (response?.error) {
                showError(response.error);
                resetDownloadState();
            }
        });
        
        downloadPort.onDisconnect.addListener(() => {
            console.log('Port disconnected');
            downloadPort = null;
            resetDownloadState();
        });
        
        // Send download request
        console.log('Sending download request:', url);
        chrome.runtime.sendMessage({
            type: type === 'hls' ? 'downloadHLS' : 'download',
            url: url
        });
        
    } catch (error) {
        console.error('Download failed:', error);
        showError('Failed to start download');
        resetDownloadState();
    }
    
    function resetDownloadState() {
        if (downloadPort) {
            downloadPort.disconnect();
            downloadPort = null;
        }
        button.disabled = false;
        button.textContent = originalText;
        progressContainer.style.display = 'none';
        progressBar.style.width = '0%';
        progressInfo.remove();
    }
}

// Format file size in human readable form
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Format speed in human readable form
function formatSpeed(bytesPerSecond) {
    return `${formatSize(bytesPerSecond)}/s`;
}

// Format time in human readable form
function formatTime(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${minutes}m ${secs}s`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
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