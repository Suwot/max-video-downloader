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
        const downloadBtnOrigHTML = downloadButton?.innerHTML;

        if (downloadButton) {
            downloadButton.innerHTML = 'Starting...';
            logger.debug('Download button set to Starting...');
        }

        // selected-option original text
        const selectedOption = elementsDiv.querySelector('.selected-option .label');
        const selectedOptionOrigText = selectedOption ? selectedOption.textContent : ''; 

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
            downloadBtnOrigHTML,
            selectedOptionOrigText
        });
        
        logger.debug('Download request sent to background');
        
    } catch (error) {
        logger.error('Download failed:', error);
        showError('Failed to start download');
    }
}

/**
 * Update download button state based on progress
 * @param {Object} progressData - Progress data from background
 */
function updateDownloadButton(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const downloadBtn = document.querySelector(`.video-item[data-url="${lookupUrl}"] .download-btn`);
    
    if (!downloadBtn) {
        logger.warn('Download button not found for URL:', lookupUrl);
        return;
    }

    switch (progressData.command) {
        case 'download-progress':
            if (!downloadBtn.classList.contains('downloading')) {
                downloadBtn.innerHTML = 'Stop';
                downloadBtn.classList.add('downloading', 'stop-mode');
                downloadBtn.style.backgroundColor = '#d32f2f';
                
                // Add stop handler (empty for now)
                downloadBtn.onclick = () => {
                    logger.debug('Stop button clicked - handler not implemented yet');
                    // TODO: Implement stop functionality
                };
                
                logger.debug('Download button switched to Stop mode');
            }
            break;
            
        case 'download-success':
        case 'download-error':
            // Restore original button state
            downloadBtn.innerHTML = progressData.downloadBtnOrigHTML || 'Download';
            downloadBtn.classList.remove('downloading', 'stop-mode');
            downloadBtn.style.removeProperty('background-color');
            downloadBtn.onclick = null; // Remove stop handler
            logger.debug('Download button restored to original state');
            break;
    }
}

/**
 * Update dropdown option background during download
 * @param {Object} progressData - Progress data
 */
function updateDropdownOption(progressData = {}) {
    const lookupUrl = progressData.downloadUrl;
    const dropdownOption = document.querySelector(`.dropdown-option[data-url="${lookupUrl}"]`);
    
    if (!dropdownOption) {
        logger.warn('Dropdown option not found for URL:', lookupUrl);
        return;
    }

    switch (progressData.command) {
        case 'download-progress':
            // Set progress background without changing text
            dropdownOption.style.setProperty('--progress', `${progressData.progress}%`);
            dropdownOption.classList.add('downloading');
            logger.debug('Dropdown option progress updated:', progressData.progress + '%');
            break;
            
        case 'download-success':
            dropdownOption.classList.add('complete');
            setTimeout(() => {
                dropdownOption.classList.remove('downloading', 'complete');
                dropdownOption.style.removeProperty('--progress');
            }, 2000);
            break;
            
        case 'download-error':
            dropdownOption.classList.add('error');
            setTimeout(() => {
                dropdownOption.classList.remove('downloading', 'error');
                dropdownOption.style.removeProperty('--progress');
            }, 3000);
            break;
    }
}

/**
 * Update download progress UI - maps progress to selected option
 * @param {Object} video - Video being downloaded  
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
export function updateDownloadProgress(progressData = {}) {
    logger.debug('Progress update received:', progressData.command, progressData.progress + '%');
    
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const progress = progressData.progress;

    const downloadGroup = document.querySelector(`.video-item[data-url="${lookupUrl}"] .download-group`);
    if (!downloadGroup) {
        logger.warn('Download group not found for URL:', lookupUrl);
        return;
    }

    const selectedOption = downloadGroup.querySelector('.selected-option');

    // Update all UI elements
    updateDownloadButton(progressData);
    updateDropdownOption(progressData);

    if (!selectedOption) {
        logger.warn('Selected option not found');
        return;
    }

    // Update selected option (existing logic)
    selectedOption.style.setProperty('--progress', `${progress}%`);
    selectedOption.classList.add('downloading');

    let displayText = `${progress}%`;

    if (progressData.currentSegment) {
        displayText += ` (${progressData.currentSegment}/${progressData.totalSegments})`;
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
    if (progressData.command === 'download-success' || progressData.success !== undefined) {
        selectedOption.classList.add('complete');
        textSpan.textContent = 'Completed!';
        setTimeout(() => restoreOriginalOption(selectedOption, progressData), 2000);
    } else if (progressData.command === 'download-error' || progressData.error) {
        selectedOption.classList.add('error');
        textSpan.textContent = 'Error';
        setTimeout(() => restoreOriginalOption(selectedOption, progressData), 3000);
    }
}

/**
 * Restore original option from dropdown by finding matching data-url
 */
function restoreOriginalOption(selectedOption, progressData = {}) {
    const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
    textSpan.textContent = progressData.selectedOptionOrigText;

    // Clean up progress styling
    selectedOption.classList.remove('downloading', 'complete', 'error');
    selectedOption.style.removeProperty('--progress');
    
    logger.debug('Restored original option:', progressData.selectedOptionOrigText);
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