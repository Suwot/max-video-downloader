/**
 * - Handles video download requests 
 * - Communicates with native host for downloading
 * - Manages HLS/DASH download processes
 * - Tracks download progress and status
 * - Manages file naming and save paths
 * - Handles download error conditions
 * - Provides download quality selection options
 */

import { showError } from './ui.js';
import  { formatSize } from './video-list/video-utils.js';
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
export async function handleDownload(button, videoData = {}) {
    logger.debug(`Handling download for ${videoData.downloadUrl} with data:`, videoData);
    
    // Get the button wrapper
    const buttonWrapper = button.closest('.download-btn-wrapper');
    
    // Use unified state transition
    setDownloadingState(button, buttonWrapper, "Starting...");
    
    try {
        // For blob URLs, handle differently
        if (videoData.type === 'blob' && videoData.downloadUrl.startsWith('blob:')) {
            await handleBlobDownload(videoData.downloadUrl);
            resetDownloadingState(button, buttonWrapper);
            return;
        }
        
        // Create Chrome notification (UI responsibility)
        const notificationId = `download-${Date.now()}`;
        chrome.notifications.create(notificationId, {
            type: 'basic',
            iconUrl: '../../icons/48.png',
            title: 'Downloading Video',
            message: `Starting download: ${videoData.filename}`
        });
        
        // Store notification ID for cleanup
        button._notificationId = notificationId;
        
        // Get the existing background port connection
        const backgroundPort = getBackgroundPort();

        // Define our message handler for both progress updates and completion
        const handleDownloadMessages = (response) => {
            logger.debug('Download message:', response);
            
            // Match by downloadUrl OR masterUrl for HLS
            const urlToMatch = response.masterUrl || response.downloadUrl;
            const videoUrlToMatch = videoData.masterUrl || videoData.downloadUrl;
            
            if (urlToMatch !== videoUrlToMatch) return;
            
            // Handle progress updates
            if (response?.command === 'progress') {
                const progress = response.progress || 0;
                
                // Update notification every 10%
                if (Math.floor(progress / 10) > Math.floor((button._lastNotificationProgress || 0) / 10)) {
                    button._lastNotificationProgress = progress;
                    
                    let message = `Progress: ${Math.round(progress)}%`;
                    if (response.speedFormatted) {
                        message += ` - ${response.speedFormatted}`;
                    }
                    if (response.etaFormatted && response.eta > 0) {
                        message += ` - ETA: ${response.etaFormatted}`;
                    }
                    
                    chrome.notifications.update(notificationId, { message });
                }
                
                // Use unified progress update function
                updateDownloadButtonProgress(button, buttonWrapper, progress, response);
                
            } else if (response?.command === 'complete') {
                // Update notification
                let completionMessage = `Saved to: ${response.filename}`;
                if (response.downloadStats?.total) {
                    completionMessage += ` (${response.downloadStats.total})`;
                }
                
                chrome.notifications.update(notificationId, {
                    title: 'Download Complete',
                    message: completionMessage
                });
                
                // Use unified progress update function with completion state
                updateDownloadButtonProgress(button, buttonWrapper, 100, { state: 'complete' });
                
            } else if (response?.command === 'error') {
                // Update notification
                chrome.notifications.update(notificationId, {
                    title: 'Download Failed',
                    message: response.error
                });
                
                // Use unified progress update function with error state
                updateDownloadButtonProgress(button, buttonWrapper, 0, { state: 'error' });
                showError(response.error);
            }
        };
        
        // Add our message handler to the background port
        // This will be stored in the button to remove it later
        button._messageHandler = handleDownloadMessages;
        backgroundPort.onMessage.addListener(handleDownloadMessages);
        
        // Initiate a new download
        registerNewDownload(button, videoData);
        
    } catch (error) {
        logger.error('Download failed:', error);
        showError('Failed to start download from handleDownload');
        resetDownloadingState(button, buttonWrapper);
    }
}

/**
 * Register a new download with the background script
 * @param {HTMLElement} button - The download button
 * @param {Object} videoData - Video metadata
 */
async function registerNewDownload(button, videoData = {}) {
    try {
        // Get the port connection to the background script
        const port = getBackgroundPort();
        
        // Create message with all needed metadata aligned with native host expectations
        const message = {
            command: 'download',
            downloadUrl: videoData.downloadUrl,
            filename: videoData.filename,
            savePath: videoData.savePath || null,
            type: videoData.type, 
            preferredContainer: videoData.preferredContainer || null,
            originalContainer: videoData.originalContainer,
            audioOnly: videoData.audioOnly || false,
            streamSelection: videoData.streamSelection || null,
            masterUrl: videoData.masterUrl,
            duration: videoData.duration, // Pass duration for progress tracking
            fileSizeBytes: videoData.fileSizeBytes || null,
            segmentCount: videoData.segmentCount || null,
            headers: {}, // Will be filled by background script
            tabId: await getCurrentTabId()
        };
        
        logger.debug('Sending download request with params:', Object.keys(message).join(', '));
        
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
        showError('Failed to start download from registerNewDownload');
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
 * Check for active downloads when popup opens
 * Request active downloads list from background to restore UI state
 */
export async function checkForActiveDownloads() {
    logger.debug('Checking for active downloads to restore UI state...');
    
    // Get the port connection to the background script
    const port = getBackgroundPort();
    
    if (port) {
        // Request active downloads list for UI restoration
        port.postMessage({
            command: 'getActiveDownloads'
        });
        logger.debug('Requested active downloads list from background');
    } else {
        logger.error('Failed to get background port for active downloads check');
    }
    
    return true;
}

/**
 * Transition button to downloading state - unified function used by both click and restore flows
 * @param {HTMLElement} button - Download button element
 * @param {HTMLElement} buttonWrapper - Button wrapper element
 * @param {string} initialText - Initial text to display (default: "Starting...")
 */
function setDownloadingState(button, buttonWrapper, initialText = "Starting...") {
    // Store original content if not already stored
    if (!button._originalContent && button.innerHTML.includes('download-btn-icon')) {
        button._originalContent = button.innerHTML;
    }
    
    // Add downloading class to wrapper
    if (buttonWrapper) {
        buttonWrapper.classList.add('downloading');
    }
    
    // Disable button
    button.disabled = true;
    
    // Replace button content with single span structure
    button.innerHTML = `<span>${initialText}</span>`;
}

/**
 * Reset button to original state - unified function
 * @param {HTMLElement} button - Download button element
 * @param {HTMLElement} buttonWrapper - Button wrapper element
 */
function resetDownloadingState(button, buttonWrapper) {
    // Remove all state classes
    if (buttonWrapper) {
        buttonWrapper.classList.remove('downloading', 'complete', 'error');
        buttonWrapper.removeAttribute('style');
        
        // Clean up menu button
        const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
        if (menuBtn) {
            menuBtn.removeAttribute('style');
        }
    }
    
    // Reset button
    button.disabled = false;
    button.removeAttribute('style');
    
    // Restore original content
    if (button._originalContent) {
        button.innerHTML = button._originalContent;
    }
}

/**
 * Update button progress - unified function used by both flows
 * @param {HTMLElement} button - Download button element
 * @param {HTMLElement} buttonWrapper - Button wrapper element
 * @param {number} progress - Progress percentage
 * @param {Object} progressData - Additional progress data
 */
function updateDownloadButtonProgress(button, buttonWrapper, progress, progressData = {}) {
    progress = Math.max(0, Math.min(100, Math.round(progress)));
    
    // Update progress CSS variable
    if (buttonWrapper) {
        buttonWrapper.style.setProperty('--progress', `${progress}%`);
    }
    
    // Build display text
    let displayText = `${progress}%`;
    
    if (progressData.segmentProgress) {
        displayText += ` (${progressData.segmentProgress})`;
    }
    if (progressData.speed) {
        displayText += ` • ${formatSpeed(progressData.speed)}`;
    }
    if (progressData.eta && progressData.eta > 0 && progress < 100) {
        displayText += ` • ETA: ${formatTime(progressData.eta)}`;
    }
    
    // Update button text (now we know it's a single span)
    const textSpan = button.querySelector('span');
    if (textSpan) {
        textSpan.textContent = displayText;
    }
    
    // Handle completion
    if (progressData.state === 'complete' || progress >= 100) {
        if (buttonWrapper) {
            buttonWrapper.classList.remove('downloading');
            buttonWrapper.classList.add('complete');
        }
        if (textSpan) {
            textSpan.textContent = 'Complete!';
        }
        
        // Clean up message handler
        if (button._messageHandler) {
            const port = getBackgroundPort();
            if (port) {
                port.onMessage.removeListener(button._messageHandler);
            }
            button._messageHandler = null;
        }
        
        setTimeout(() => resetDownloadingState(button, buttonWrapper), 2000);
    } else if (progressData.state === 'error') {
        if (buttonWrapper) {
            buttonWrapper.classList.remove('downloading');
            buttonWrapper.classList.add('error');
        }
        if (textSpan) {
            textSpan.textContent = 'Error!';
        }
        
        // Clean up message handler
        if (button._messageHandler) {
            const port = getBackgroundPort();
            if (port) {
                port.onMessage.removeListener(button._messageHandler);
            }
            button._messageHandler = null;
        }
        
        setTimeout(() => resetDownloadingState(button, buttonWrapper), 1500);
    }
}

/**
 * Update download progress UI - unified entry point
 * @param {Object} video - Video being downloaded
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
export function updateDownloadProgress(video, progress, progressData = {}) {
    // Use masterUrl for HLS (video-item lookup) or downloadUrl for DASH/Direct
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    if (!lookupUrl) {
        logger.warn('No URL found for progress update:', { video, progressData });
        return;
    }
    
    // Find all video items with this URL (may be multiple due to expiration/refresh)
    const videoItems = document.querySelectorAll(`.video-item[data-url="${lookupUrl}"]`);
    if (videoItems.length === 0) {
        logger.warn('No video items found for URL:', lookupUrl);
        return;
    }
    
    logger.debug(`Updating progress for ${videoItems.length} video item(s) with URL:`, lookupUrl);
    
    // Update all matching video items
    videoItems.forEach(videoItem => {
        const buttonWrapper = videoItem.querySelector('.download-btn-wrapper');
        if (!buttonWrapper) {
            logger.warn('Download button wrapper not found in video item');
            return;
        }
        
        const downloadBtn = buttonWrapper.querySelector('.download-btn');
        if (!downloadBtn) {
            logger.warn('Download button not found in wrapper');
            return;
        }
        
        // Ensure button is in downloading state and set up message handler for ongoing updates
        if (!buttonWrapper.classList.contains('downloading')) {
            logger.debug('Transitioning button to downloading state for restored download:', lookupUrl);
            setDownloadingState(downloadBtn, buttonWrapper, `${Math.round(progress)}%`);
            
            // Set up message handler for ongoing progress updates (same as handleDownload)
            const backgroundPort = getBackgroundPort();
            if (backgroundPort && !downloadBtn._messageHandler) {
                const handleDownloadMessages = (response) => {
                    // Match on downloadUrl for progress updates (quality-specific for HLS)
                    const responseUrl = response.downloadUrl || response.masterUrl;
                    const targetUrl = progressData.downloadUrl || progressData.masterUrl;
                    
                    if (response?.command === 'progress' && responseUrl === targetUrl) {
                        updateDownloadButtonProgress(downloadBtn, buttonWrapper, response.progress || 0, response);
                        
                    } else if (response?.command === 'complete' && responseUrl === targetUrl) {
                        updateDownloadButtonProgress(downloadBtn, buttonWrapper, 100, { state: 'complete' });
                        
                    } else if (response?.command === 'error' && responseUrl === targetUrl) {
                        updateDownloadButtonProgress(downloadBtn, buttonWrapper, 0, { state: 'error' });
                        showError(response.error);
                    }
                };
                
                // Set up message handler
                downloadBtn._messageHandler = handleDownloadMessages;
                backgroundPort.onMessage.addListener(handleDownloadMessages);
                
                logger.debug('Set up message handler for restored download');
            }
            
            // Keep button enabled so user can restart if needed
            downloadBtn.disabled = false;
        }
        
        // Update progress using the same logic as handleDownload
        updateDownloadButtonProgress(downloadBtn, buttonWrapper, progress, progressData);
    });
}

// Removed duplicate functions - using unified approach above