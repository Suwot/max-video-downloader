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
import { createLogger } from '../../js/utilities/logger.js';

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
    // Store the complete original HTML content of the button
    const originalContent = button.innerHTML;
    button.disabled = true;
    
    // Get the button wrapper to apply downloading class
    const buttonWrapper = button.closest('.download-btn-wrapper');
    if (buttonWrapper) {
        buttonWrapper.classList.add('downloading');
    }
    
    // Set initial state
    button.innerHTML = '<span>Starting...</span>';
    
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
                
                // Update button progress using CSS variable
                if (buttonWrapper) {
                    buttonWrapper.style.setProperty('--progress', `${progress}%`);
                }
                
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
                // Store original content before changing it, if not already stored
                if (!button._originalContent && button.innerHTML.includes('download-btn-icon')) {
                    button._originalContent = originalContent;
                }
                
                // Use unified state transition logic
                const updateButtonToComplete = () => {
                    if (buttonWrapper) {
                        buttonWrapper.classList.remove('downloading');
                        buttonWrapper.classList.add('complete');
                    }
                    
                    // Complete cleanup of ALL inline styles to let the CSS classes handle appearance
                    button.removeAttribute('style'); // Remove entire style attribute
                    
                    // Also clear style from menu button to ensure both are handled the same way
                    const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
                    if (menuBtn) {
                        menuBtn.removeAttribute('style');
                    }
                    
                    button.querySelector('span').textContent = 'Complete!';
                    
                    // Reset after delay using the same timer for everything
                    setTimeout(() => resetDownloadState(), 2000);
                };
                
                updateButtonToComplete();
                
            } else if (response?.error) {
                // Store original content before changing it, if not already stored
                if (!button._originalContent && button.innerHTML.includes('download-btn-icon')) {
                    button._originalContent = originalContent;
                }
                
                // Use unified state transition logic
                if (buttonWrapper) {
                    buttonWrapper.classList.remove('downloading');
                    buttonWrapper.classList.add('error');
                }
                
                // Update text content
                button.style.removeProperty('backgroundImage');
                const span = button.querySelector('span');
                if (span) span.textContent = 'Error!';
                
                showError(response.error);
                
                // Use a short delay before resetting to show the error state
                setTimeout(() => resetDownloadState(), 1500);
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
        
        // Create a unified reset function that handles all elements in one go
        const performReset = () => {
            if (buttonWrapper) {
                // Reset all classes
                buttonWrapper.classList.remove('downloading', 'complete', 'error');
                buttonWrapper.removeAttribute('style'); // Remove all inline styles from wrapper
            }
            
            button.disabled = false;
            // Remove ALL inline styles completely for a clean state
            button.removeAttribute('style');
            
            // Also clean the menu button for consistency
            if (buttonWrapper) {
                const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
                if (menuBtn) {
                    menuBtn.removeAttribute('style');
                }
            }
            
            // Restore the original content with download icon and text
            button.innerHTML = originalContent;
        };
        
        // Applying a small delay for better user experience
        setTimeout(performReset, 1000);
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
            title: videoData.title || videoData.metadata?.title || null, // Pass video title for better filenames
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
    
    // Get button wrapper and add downloading class if not already present
    const buttonWrapper = button.closest('.download-btn-wrapper');
    if (buttonWrapper && !buttonWrapper.classList.contains('downloading')) {
        buttonWrapper.classList.add('downloading');
    }
    
    // Set progress CSS variable on the wrapper
    if (buttonWrapper) {
        buttonWrapper.style.setProperty('--progress', `${progress}%`);
    }
    
    // Store original button content if not already stored
    if (!button._originalContent && button.innerHTML.includes('download-btn-icon')) {
        button._originalContent = button.innerHTML;
    }
    
    // Unified state handling function
    const updateButtonState = (state, text) => {
        if (!buttonWrapper) return;
        
        // Update wrapper classes
        buttonWrapper.classList.remove('downloading', 'complete', 'error');
        if (state) {
            buttonWrapper.classList.add(state);
            
            // When changing to complete or error state, clean up all inline styles
            if (state === 'complete' || state === 'error') {
                // Remove ALL inline styles from the button
                button.removeAttribute('style');
                
                // Also clean the menu button to ensure unified appearance
                const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
                if (menuBtn) {
                    menuBtn.removeAttribute('style');
                }
            }
        }
        
        // Create or update text content
        let textElement = button.querySelector('span');
        if (!textElement) {
            textElement = document.createElement('span');
            button.innerHTML = '';
            button.appendChild(textElement);
        }
        textElement.textContent = text;
        
        // If complete or error, set a timeout to restore original state
        if (state === 'complete' || state === 'error') {
            const originalContent = button._originalContent;
            
            // Using a single timeout for all state transitions
            setTimeout(() => {
                if (buttonWrapper) {
                    // Single operation to update all states
                    buttonWrapper.classList.remove('downloading', 'complete', 'error');
                    buttonWrapper.removeAttribute('style'); // Remove all wrapper styles
                    
                    // Complete cleanup of all buttons
                    button.removeAttribute('style');
                    
                    const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
                    if (menuBtn) {
                        menuBtn.removeAttribute('style');
                    }
                    
                    // Restore original content with download icon
                    if (originalContent) {
                        button.innerHTML = originalContent;
                    }
                }
            }, 2000);
        }
    };
    
    // Check for state information
    if (progressData.state === 'complete') {
        updateButtonState('complete', 'Complete!');
        return;
    } else if (progressData.state === 'error') {
        updateButtonState('error', 'Error!');
        return;
    } else {
        updateButtonState('downloading', null); // Just ensure the downloading class is there
    }
    
    // Create or update text content for progress
    let textElement = button.querySelector('span');
    if (!textElement) {
        textElement = document.createElement('span');
        button.innerHTML = '';
        button.appendChild(textElement);
    }
    
    // Update text with enhanced information
    let text = `${Math.round(progress)}%`;
    
    // Add segment information if available
    if (progressData.segmentProgress) {
        text += ` (${progressData.segmentProgress})`;
    }
    
    // Add speed information
    if (progressData.speed) {
        text += ` • ${formatSpeed(progressData.speed)}`;
    }
    
    // Add ETA if available
    if (progressData.eta && progressData.eta > 0 && progress < 100) {
        text += ` • ${formatTime(progressData.eta)}`;
    }
    
    textElement.textContent = text;
    
    // If progress is 100% but no state is set, assume completion
    if (progress >= 100 && buttonWrapper) {
        // Use our unified state handling function
        setTimeout(() => {
            updateButtonState('complete', 'Complete!');
        }, 500);
    }
}