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
import { videoStateService } from './services/video-state-service.js';
import { getBackgroundPort } from './index.js';
import { createlogger } from './utilities/logger.js';

const logger = createLogger('Download');

let downloadPort = null;

/**
 * Handle download button click
 * @param {HTMLElement} button - Download button
 * @param {string} url - Video URL
 * @param {string} type - Video type
 * @param {Object} videoData - Additional video metadata
 */
export async function handleDownload(button, url, type, videoData = {}) {
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
        
        // Create a new port connection for download progress
        downloadPort = chrome.runtime.connect({ name: 'download_progress' });
        
        // Immediately register interest in this download URL
        downloadPort.postMessage({
            action: 'registerForDownload',
            downloadUrl: url
        });
        
        // Set up message listener
        downloadPort.onMessage.addListener((response) => {
            logger.debug('Download message:', response); // Debug log
            
            // Handle progress updates
            if (response?.type === 'progress') {
                // Only process this progress message if it's for the URL we're handling
                if (response.url !== url) {
                    return; // Ignore progress for other downloads
                }
                
                const progress = response.progress || 0;
                
                // Update button background to show progress
                button.style.backgroundImage = `linear-gradient(to right, #1565C0 ${progress}%, #1976D2 ${progress}%)`;
                
                // Update text with enhanced information
                let text = `${Math.round(progress)}%`;
                
                // Add segment information if available
                if (response.segmentProgress) {
                    text += ` (${response.segmentProgress})`;
                }
                
                // Add speed information
                if (response.speed) {
                    text += ` • ${formatSpeed(response.speed)}`;
                }
                
                // Add ETA if available
                if (response.eta && response.eta > 0 && progress < 100) {
                    text += ` • ETA: ${formatTime(response.eta)}`;
                }
                
                button.querySelector('span').textContent = text;
                
                // Adjust confidence through color saturation if available
                if (response.confidence !== undefined && response.confidence !== null) {
                    // Higher confidence = more vivid blue
                    const saturation = 50 + Math.round(response.confidence * 50);
                    const lightness = 50 - Math.round(response.confidence * 10);
                    const startColor = `hsl(210, ${saturation}%, ${lightness}%)`;
                    const endColor = `hsl(210, ${saturation-10}%, ${lightness+5}%)`;
                    button.style.backgroundImage = `linear-gradient(to right, ${startColor} ${progress}%, ${endColor} ${progress}%)`;
                }
                
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
            logger.debug('Port disconnected'); // Debug log
            downloadPort = null;
            resetDownloadState();
        });
        
        // Initiate a new download
        registerNewDownload(url, type, button, videoData);
        
    } catch (error) {
        logger.error('Download failed:', error);
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

/**
 * Register a new download with the background script
 */
async function registerNewDownload(url, type, button, videoData = {}) {
    try {
        // Get the port connection to the background script
        const port = getBackgroundPort();
        
        // Create message with all needed metadata
        const message = {
            type: type === 'hls' ? 'downloadHLS' : 'download',
            url: url,
            manifestUrl: url, // Pass the manifest URL for better segment tracking
            tabId: await getCurrentTabId(), // Pass tabId for proper tracking
            title: videoData.title || null, // Pass video title for better filenames
            originalContainer: videoData.originalContainer || null, // Pass container format
            originalUrl: videoData.originalUrl || null, // Pass original URL if embedded
            foundFromQueryParam: videoData.foundFromQueryParam || false // Indicate if extracted
        };
        
        // If we have a port connection to background, use it
        if (port) {
            logger.debug('Initiating download via port connection');
            port.postMessage(message);
        } else {
            // Fall back to one-time message
            logger.debug('Initiating download via one-time message');
            chrome.runtime.sendMessage(message);
        }
    } catch (error) {
        logger.error('Failed to register new download:', error);
        showError('Failed to start download');
        throw error;
    }
}

// Helper function to get current tab ID
async function getCurrentTabId() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        return tabs[0]?.id || -1;
    } catch (e) {
        logger.error('Error getting current tab ID:', e);
        return -1;
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
        logger.error('Blob download failed:', error);
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
            const qualities = await videoStateService.fetchStreamQualities(video.url);
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
                    updateDownloadProgress(video, msg.progress, msg);
                } else if (msg.success) {
                    resolve(msg);
                    port.disconnect();
                } else if (msg.error) {
                    reject(new Error(msg.error));
                    port.disconnect();
                }
            });
            
            // Get the port connection to the background script
            const backgroundPort = getBackgroundPort();
            
            // Start download using background port if available, otherwise use one-time message
            if (backgroundPort) {
                backgroundPort.postMessage({
                    type: video.type === 'hls' ? 'downloadHLS' : 'download',
                    url: downloadUrl,
                    filename: video.filename,
                    quality: quality ? {
                        resolution: quality.resolution,
                        codecs: quality.codecs,
                        bitrate: quality.bandwidth || quality.videoBitrate
                    } : null,
                    tabId: getCurrentTabId()
                });
            } else {
                chrome.runtime.sendMessage({
                    type: video.type === 'hls' ? 'downloadHLS' : 'download',
                    url: downloadUrl,
                    filename: video.filename,
                    quality: quality ? {
                        resolution: quality.resolution,
                        codecs: quality.codecs,
                        bitrate: quality.bandwidth || quality.videoBitrate
                    } : null,
                    tabId: getCurrentTabId()
                });
            }
        });
    } catch (error) {
        showError(`Failed to start download: ${error.message}`);
        throw error;
    }
}

/**
 * Check for active downloads when popup opens
 * Requests active downloads list from background script
 */
export async function checkForActiveDownloads() {
    logger.debug('Checking for active downloads...');
    
    // Get the port connection to the background script
    const port = getBackgroundPort();
    
    if (port) {
        // Request active downloads list
        port.postMessage({
            action: 'getActiveDownloads'
        });
        
        // Background will respond with activeDownloadsList message
        // This is handled in the port message listener in index.js
    } else {
        logger.error('Failed to get background port for active downloads check');
    }
    
    return true;
}

/**
 * Update download progress UI with enhanced information
 * @param {Object} video - Video being downloaded
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
export function updateDownloadProgress(video, progress, progressData = {}) {
    const downloadBtn = document.querySelector(`[data-url="${video.url}"]`);
    if (!downloadBtn) {
        // Try with originalUrl if available
        if (progressData.originalUrl) {
            const altBtn = document.querySelector(`[data-url="${progressData.originalUrl}"]`);
            if (altBtn) {
                updateDownloadButtonProgress(altBtn, progress, progressData);
            }
        }
        return;
    }

    updateDownloadButtonProgress(downloadBtn, progress, progressData);
}

/**
 * Update a specific download button with progress information
 * @param {HTMLElement} button - The download button element
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
function updateDownloadButtonProgress(button, progress, progressData = {}) {
    // Ensure progress is between 0 and 100
    progress = Math.max(0, Math.min(100, Math.round(progress)));
    
    // Create progress container if it doesn't exist
    let progressContainer = button.querySelector('.progress-container');
    if (!progressContainer) {
        // Replace button content with progress UI
        button.innerHTML = '';
        
        progressContainer = document.createElement('div');
        progressContainer.className = 'progress-container';
        
        // Create main progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        
        // Create progress fill
        const progressFill = document.createElement('div');
        progressFill.className = 'progress-fill';
        progressBar.appendChild(progressFill);
        
        // Create progress text
        const progressText = document.createElement('div');
        progressText.className = 'progress-text';
        
        // Create progress info
        const progressInfo = document.createElement('div');
        progressInfo.className = 'progress-info';
        
        // Add elements to container
        progressContainer.appendChild(progressBar);
        progressContainer.appendChild(progressText);
        progressContainer.appendChild(progressInfo);
        button.appendChild(progressContainer);
        
        // Add progress styles if not already added
        if (!document.getElementById('progress-styles')) {
            const style = document.createElement('style');
            style.id = 'progress-styles';
            style.textContent = `
                .progress-container {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .progress-bar {
                    width: 100%;
                    height: 8px;
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    background: #90CAF9;
                    border-radius: 4px;
                    width: 0%;
                    transition: width 0.3s ease;
                }
                .progress-text {
                    font-weight: bold;
                    text-align: center;
                    color: white;
                    font-size: 14px;
                }
                .progress-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.8);
                }
                .download-complete .progress-fill {
                    background: #81C784;
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    // Get progress elements
    const progressFill = progressContainer.querySelector('.progress-fill');
    const progressText = progressContainer.querySelector('.progress-text');
    const progressInfo = progressContainer.querySelector('.progress-info');
    
    // Update progress bar
    progressFill.style.width = `${progress}%`;
    
    // Format progress text
    let statusText = `Downloading ${progress}%`;
    if (progress >= 100) {
        statusText = 'Download Complete';
        button.classList.add('download-complete');
    } else if (progressData.segmentProgress) {
        // Add segment information if available
        statusText += ` (${progressData.segmentProgress})`;
    }
    
    progressText.textContent = statusText;
    
    // Format detailed progress information
    let speedText = '';
    let etaText = '';
    
    if (progressData.speed) {
        speedText = formatSpeed(progressData.speed);
    }
    
    if (progressData.eta && progressData.eta > 0 && progress < 100) {
        etaText = formatTime(progressData.eta);
    }
    
    // Update detailed info
    if (speedText || etaText) {
        progressInfo.innerHTML = '';
        if (speedText) {
            const speedElement = document.createElement('span');
            speedElement.textContent = speedText;
            progressInfo.appendChild(speedElement);
        }
        
        if (etaText) {
            const etaElement = document.createElement('span');
            etaElement.textContent = `ETA: ${etaText}`;
            progressInfo.appendChild(etaElement);
        }
    }
    
    // Add confidence indicator if available (for debugging)
    if (progressData.confidence !== undefined && progressData.confidence !== null) {
        // Higher confidence = more saturated color
        const saturation = 50 + Math.round(progressData.confidence * 50);
        progressFill.style.background = `hsl(210, ${saturation}%, 60%)`;
    }
    
    // Display quality information if available
    if (progressData.quality && !button.querySelector('.quality-indicator')) {
        const quality = progressData.quality;
        
        // Create quality indicator
        const qualityIndicator = document.createElement('div');
        qualityIndicator.className = 'quality-indicator';
        
        // Format quality label based on available data
        let qualityText = '';
        if (quality.height) {
            qualityText = `${quality.height}p`;
            if (quality.fps && quality.fps > 30) {
                qualityText += `@ ${quality.fps}`;
            }
        } else if (quality.resolution) {
            qualityText = quality.resolution;
        } else if (quality.label) {
            qualityText = quality.label;
        } else {
            qualityText = 'Custom';
        }
        
        qualityIndicator.textContent = qualityText;
        
        // Add styles for quality indicator
        if (!document.getElementById('quality-indicator-styles')) {
            const style = document.createElement('style');
            style.id = 'quality-indicator-styles';
            style.textContent = `
                .quality-indicator {
                    position: absolute;
                    top: -8px;
                    right: -8px;
                    background: #ff9800;
                    color: white;
                    padding: 2px 5px;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: bold;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                }
            `;
            document.head.appendChild(style);
        }
        
        // Add to button
        button.style.position = 'relative';
        button.appendChild(qualityIndicator);
    }
}