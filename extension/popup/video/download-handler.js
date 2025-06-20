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
 * Pure orchestrator for download progress updates
 * Delegates to specialized UI update functions
 * @param {Object} progressData - Progress data from background
 */
export function updateDownloadProgress(progressData = {}) {
    logger.debug('Progress update received:', progressData.command, progressData.progress + '%');
    
    // Orchestrate all UI updates
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    logger.debug('All UI elements updated for progress:', progressData.progress + '%');
}

/**
 * Update download button state based on progress
 * @param {Object} progressData - Progress data from background
 */
function updateDownloadButton(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const downloadBtnWrapper = document.querySelector(`.video-item[data-url="${lookupUrl}"] .download-btn-wrapper`);
    const downloadBtn = downloadBtnWrapper?.querySelector('.download-btn');
    const menuBtn = downloadBtnWrapper?.querySelector('.download-menu-btn');
    
    if (!downloadBtn || !menuBtn) {
        logger.warn('Download button elements not found for URL:', lookupUrl);
        return;
    }

    switch (progressData.command) {
        case 'download-progress':
            if (!downloadBtnWrapper.classList.contains('downloading')) {
                // Update button text and state
                downloadBtn.innerHTML = 'Stop';
                downloadBtnWrapper.classList.add('downloading', 'stop-mode');
                
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
            downloadBtnWrapper.classList.remove('downloading', 'stop-mode');
            downloadBtn.onclick = null; // Remove stop handler
            
            logger.debug('Download button restored to original state');
            break;
    }
}

/**
 * Update entire dropdown (selected-option + dropdown-option) during download
 * Consolidates all dropdown-related UI updates in one place
 * @param {Object} progressData - Progress data
 */
function updateDropdown(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const progress = progressData.progress;

    // Single DOM query for the dropdown container
    const downloadGroup = document.querySelector(`.video-item[data-url="${lookupUrl}"] .download-group`);
    if (!downloadGroup) {
        logger.warn('Download group not found for URL:', lookupUrl);
        return;
    }

    const selectedOption = downloadGroup.querySelector('.selected-option');
    const dropdownOption = document.querySelector(`.dropdown-option[data-url="${progressData.downloadUrl}"]`);

    switch (progressData.command) {
        case 'download-progress':
            // Update dropdown option background (no text change)
            if (dropdownOption) {
                dropdownOption.style.setProperty('--progress', `${progress}%`);
                dropdownOption.classList.add('downloading');
            }

            // Update selected option (with progress text)
            if (selectedOption) {
                selectedOption.style.setProperty('--progress', `${progress}%`);
                selectedOption.classList.add('downloading');

                // Build progress display text
                let displayText = `${progress}%`;
                if (progressData.currentSegment) {
                    displayText += ` (${progressData.currentSegment}/${progressData.totalSegments})`;
                }
                if (progressData.speed) {
                    displayText += ` • ${formatSize(progressData.speed)}/s`;
                }
                if (progressData.eta && progressData.eta > 0 && progress < 100) {
                    displayText += ` • ${formatTime(progressData.eta)}`;
                }

                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = displayText;
            }

            logger.debug('Dropdown progress updated:', progress + '%');
            break;
            
        case 'download-success':
            // Handle dropdown option completion
            if (dropdownOption) {
                dropdownOption.classList.add('complete');
                setTimeout(() => {
                    dropdownOption.classList.remove('downloading', 'complete');
                    dropdownOption.style.removeProperty('--progress');
                }, 2000);
            }

            // Handle selected option completion
            if (selectedOption) {
                selectedOption.classList.add('complete');
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = 'Completed!';
                setTimeout(() => restoreOriginalOption(selectedOption, progressData), 2000);
            }
            break;
            
        case 'download-error':
            // Handle dropdown option error
            if (dropdownOption) {
                dropdownOption.classList.add('error');
                setTimeout(() => {
                    dropdownOption.classList.remove('downloading', 'error');
                    dropdownOption.style.removeProperty('--progress');
                }, 3000);
            }

            // Handle selected option error
            if (selectedOption) {
                selectedOption.classList.add('error');
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = 'Error';
                setTimeout(() => restoreOriginalOption(selectedOption, progressData), 3000);
            }
            break;
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