/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utils/logger.js';
import { getBackgroundPort } from '../index.js';
import { showError } from '../ui.js';
import { formatSize } from '../../shared/utils/video-utils.js';

const logger = createLogger('Download');

/**
 * Handle download button click - streamlined version
 * @param {HTMLElement} button - Download button
 * @param {Object} videoData - Video metadata
 */
export async function handleDownload(elementsDiv, videoData = {}) {
    logger.debug('Initiating download for:', videoData.downloadUrl);
    
    try {     
        // Get current tab ID
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id || -1;

        // save original content of download button and substitute it to "Starting..."
        const downloadButton = elementsDiv.querySelector('.download-btn'); 
        const originalDownloadBtnHTML = downloadButton?.innerHTML;

        if (downloadButton) downloadButton.innerHTML = 'Starting...';

        // selected-option original text
        const selectedOption = elementsDiv.querySelector('.selected-option .label');
        const originalSelectedOptionText = selectedOption ? selectedOption.textContent : ''; 

        // Send download request to background (NHS handles everything)
        const port = getBackgroundPort();
        if (!port) {
            throw new Error('No connection to background script');
        }
        
        port.postMessage({
            command: 'download',
            downloadUrl: videoData.downloadUrl,
            filename: videoData.filename,
            savePath: videoData.savePath || null,
            type: videoData.type,
            fileSizeBytes: videoData.fileSizeBytes || null,
            segmentCount: videoData.segmentCount || null,
            preferredContainer: videoData.preferredContainer || null,
            originalContainer: videoData.originalContainer || 'mp4',
            audioOnly: videoData.audioOnly || false,
            streamSelection: videoData.streamSelection || null,
            masterUrl: videoData.masterUrl || null,
            duration: videoData.duration || null,
            tabId: tabId,
            originalDownloadBtnHTML,
            originalSelectedOptionText
        });
        
        logger.debug('Download request sent to background');
        
    } catch (error) {
        logger.error('Download failed:', error);
        showError('Failed to start download');
    }
}

/**
 * Check for active downloads when popup opens
 */
export async function checkForActiveDownloads() {
    logger.debug('Requesting active downloads from background...');
    
    const port = getBackgroundPort();
    if (port) {
        port.postMessage({ command: 'getActiveDownloads' });
    } else {
        logger.error('No background connection for active downloads check');
    }
}

/**
 * Update download progress UI - maps progress to selected option
 * @param {Object} video - Video being downloaded  
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
export function updateDownloadProgress(video, progressData = {}) {
    const progress = progressData.progress;
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    if (!lookupUrl) {
        logger.warn('No lookup URL for progress update:', progressData);
        return;
    }
    
    // Find video items matching this download
    const videoItems = document.querySelectorAll(`.video-item[data-url="${lookupUrl}"]`);
    if (videoItems.length === 0) {
        logger.debug('No video items found for URL:', lookupUrl);
        return;
    }
    
    logger.debug(`Mapping progress to ${videoItems.length} video item(s)`, progress + '%');
    
    // Update each matching video item
    videoItems.forEach(videoItem => {
        const selectedOption = videoItem.querySelector('.selected-option');
        
        if (selectedOption) {
            updateSelectedOptionProgress(selectedOption, progressData);
        }
    });
}

/**
 * Update selected option progress
 */
function updateSelectedOptionProgress(selectedOption, progressData = {}) {
    const progress = Math.max(0, Math.min(100, Math.round(progressData.progress)));

    // Set CSS progress variable
    selectedOption.style.setProperty('--progress', `${progress}%`);
    selectedOption.classList.add('downloading');

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

    // Update the text content
    const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
    textSpan.textContent = displayText;

    // Handle completion or error
    if (progressData.success !== undefined || progress >= 100) {
        selectedOption.classList.add('complete');
        textSpan.textContent = 'Completed!';
        setTimeout(() => restoreOriginalOption(selectedOption, progressData), 2000);
    } else if (progressData.error) {
        selectedOption.classList.add('error');
        textSpan.textContent = 'Error';
        setTimeout(() => restoreOriginalOption(selectedOption, progressData), 3000);
    }
}

/**
 * Restore original option from dropdown by finding matching data-url
 */
function restoreOriginalOption(selectedOption, progressData = {}) {
    const videoItem = selectedOption.closest('.video-item');
    if (!videoItem) return;

    const downloadUrl = progressData.downloadUrl;
    const originalOption = videoItem.querySelector(`.dropdown-option[data-url="${downloadUrl}"]`);
    if (!originalOption) return;

    // Restore the original text and remove progress classes
    const originalText = originalOption.textContent || originalOption.innerText;
    const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
    textSpan.textContent = originalText;

    // Clean up progress styling
    selectedOption.classList.remove('downloading', 'complete', 'error');
    selectedOption.style.removeProperty('--progress');
    
    logger.debug('Restored original option:', originalText);
}

// Helper functions
function formatSpeed(bytesPerSecond) {
    return `${formatSize(bytesPerSecond)}/s`;
}

function formatTime(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return `${minutes}m ${Math.round(seconds % 60)}s`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
}
