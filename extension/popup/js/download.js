/**
 * @ai-guide-component DownloadHandler
 * @ai-guide-description Manages video download operations
 * @ai-guide-responsibilities
 * - Handles video download requests 
 * - Communicates with native host for downloading
 * - Manages HLS/DASH download processes
 * - Tracks download progress and status
 * - Manages file naming and save paths
 * - Handles download error conditions
 * - Provides download quality selection options
 */

// popup/js/download.js
import { showError } from './utilities.js';
import { debounce } from './utilities.js';
import { showQualityDialog } from './ui.js';
import { getStreamQualities } from './video-processor.js';

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
    
    // Set initial state
    button.innerHTML = '<span>Starting...</span>';
    button.style.backgroundImage = `linear-gradient(to right, #1565C0 0%, #1976D2 0%)`;
    
    try {
        // For blob URLs, handle differently
        if (type === 'blob' && url.startsWith('blob:')) {
            await handleBlobDownload(url);
            resetDownloadState();
            return;
        }
        
        // Create a new port connection
        downloadPort = chrome.runtime.connect({ name: 'download_progress' });
        
        // Set up message listener
        downloadPort.onMessage.addListener((response) => {
            console.log('Download progress:', response); // Debug log
            
            if (response?.type === 'progress') {
                const progress = response.progress || 0;
                
                // Update button background to show progress
                button.style.backgroundImage = `linear-gradient(to right, #1565C0 ${progress}%, #1976D2 ${progress}%)`;
                
                // Update text with progress and speed
                let text = `${progress}%`;
                if (response.speed) {
                    text += ` • ${formatSpeed(response.speed)}`;
                }
                button.querySelector('span').textContent = text;
                
            } else if (response?.success) {
                // Show complete state
                button.style.backgroundImage = 'none';
                button.style.backgroundColor = '#43A047';
                button.querySelector('span').textContent = 'Complete!';
                
                // Reset after delay
                setTimeout(() => resetDownloadState(), 2000);
                
            } else if (response?.error) {
                showError(response.error);
                resetDownloadState();
            }
        });
        
        downloadPort.onDisconnect.addListener(() => {
            console.log('Port disconnected'); // Debug log
            downloadPort = null;
            resetDownloadState();
        });
        
        // Send download request
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
        button.style.backgroundImage = 'none';
        button.style.backgroundColor = '#1976D2';
        button.innerHTML = originalText;
    }
}

function updateProgress(button, progress) {
    // Ensure progress is between 0 and 100
    progress = Math.max(0, Math.min(100, progress));
    
    // Update background gradient
    if (progress < 100) {
        button.style.backgroundImage = `linear-gradient(to right, #1565C0 ${progress}%, #1976D2 ${progress}%)`;
    } else {
        button.style.backgroundImage = 'none';
        button.style.backgroundColor = '#43A047';
    }
}

function resetDownloadState(button, originalText) {
    if (downloadPort) {
        downloadPort.disconnect();
        downloadPort = null;
    }
    button.disabled = false;
    button.style.backgroundImage = 'none';
    button.style.backgroundColor = '#1976D2';
    button.innerHTML = originalText;
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

/**
 * Start download with quality selection
 * @param {Object} video - Video object to download
 * @returns {Promise} Download progress
 */
export async function startDownload(video) {
    try {
        let downloadUrl = video.url;
        let quality = null;

        // Get available qualities for HLS/DASH streams
        if (video.type === 'hls' || video.type === 'dash') {
            const qualities = await getStreamQualities(video.url);
            if (qualities && qualities.length > 0) {
                // Show quality selection dialog
                quality = await showQualityDialog(qualities);
                if (!quality) {
                    // User canceled quality selection
                    return null;
                }
                downloadUrl = quality.url || video.url;
            }
        }

        // Create port for progress updates
        const port = chrome.runtime.connect({ name: 'download_progress' });
        
        // Set up progress handling
        return new Promise((resolve, reject) => {
            port.onMessage.addListener((msg) => {
                if (msg.type === 'progress') {
                    // Update progress UI
                    updateDownloadProgress(video, msg.progress);
                } else if (msg.success) {
                    resolve(msg);
                    port.disconnect();
                } else if (msg.error) {
                    reject(new Error(msg.error));
                    port.disconnect();
                }
            });
            
            // Start download
            chrome.runtime.sendMessage({
                type: video.type === 'hls' ? 'downloadHLS' : 'download',
                url: downloadUrl,
                filename: video.filename,
                quality: quality ? {
                    resolution: quality.resolution,
                    codecs: quality.codecs,
                    bitrate: quality.bandwidth || quality.videoBitrate
                } : null
            });
        });
    } catch (error) {
        showError(`Failed to start download: ${error.message}`);
        throw error;
    }
}

/**
 * Update download progress UI
 * @param {Object} video - Video being downloaded
 * @param {number} progress - Download progress (0-100)
 */
function updateDownloadProgress(video, progress) {
    const downloadBtn = document.querySelector(`[data-url="${video.url}"]`);
    if (!downloadBtn) return;

    // Ensure progress is between 0 and 100
    progress = Math.max(0, Math.min(100, progress));
    
    // Log the progress update to debug
    console.log(`Updating progress for ${video.url}: ${progress}%`);
    
    // Update button text
    downloadBtn.textContent = `Downloading ${Math.round(progress)}%`;
    
    // Update button style to show progress
    if (progress < 100) {
        downloadBtn.style.backgroundImage = `linear-gradient(to right, #1565C0 ${progress}%, #1976D2 ${progress}%)`;
    } else {
        downloadBtn.style.backgroundImage = 'none';
        downloadBtn.style.backgroundColor = '#43A047';
        downloadBtn.textContent = 'Download Complete';
        downloadBtn.classList.add('complete');
    }
}