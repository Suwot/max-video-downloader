/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utils/logger.js';
import { getBackgroundPort } from '../index.js';
import { showError } from '../ui.js';
import { formatSize } from '../../shared/utils/video-utils.js';

const logger = createLogger('Download');

const DL_BTN_ORIG_HTML = `<span class="download-btn-icon">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg">
            <g clip-path="url(#clip0_43_340)">
                <path d="M5.0625 0.5625C5.0625 0.251367 4.81113 0 4.5 0C4.18887 0 3.9375 0.251367 3.9375 0.5625V4.82871L2.64727 3.53848C2.42754 3.31875 2.0707 3.31875 1.85098 3.53848C1.63125 3.7582 1.63125 4.11504 1.85098 4.33477L4.10098 6.58477C4.3207 6.80449 4.67754 6.80449 4.89727 6.58477L7.14727 4.33477C7.36699 4.11504 7.36699 3.7582 7.14727 3.53848C6.92754 3.31875 6.5707 3.31875 6.35098 3.53848L5.0625 4.82871V0.5625ZM1.125 6.1875C0.504492 6.1875 0 6.69199 0 7.3125V7.875C0 8.49551 0.504492 9 1.125 9H7.875C8.49551 9 9 8.49551 9 7.875V7.3125C9 6.69199 8.49551 6.1875 7.875 6.1875H6.09082L5.29453 6.98379C4.85508 7.42324 4.14316 7.42324 3.70371 6.98379L2.90918 6.1875H1.125ZM7.59375 7.17188C7.70564 7.17188 7.81294 7.21632 7.89206 7.29544C7.97118 7.37456 8.01562 7.48186 8.01562 7.59375C8.01562 7.70564 7.97118 7.81294 7.89206 7.89206C7.81294 7.97118 7.70564 8.01562 7.59375 8.01562C7.48186 8.01562 7.37456 7.97118 7.29544 7.89206C7.21632 7.81294 7.17188 7.70564 7.17188 7.59375C7.17188 7.48186 7.21632 7.37456 7.29544 7.29544C7.37456 7.21632 7.48186 7.17188 7.59375 7.17188Z" fill="#FAFAFA"></path>
            </g>
            <defs>
                <clipPath id="clip0_43_340">
                    <path d="M0 0H9V9H0V0Z" fill="white"></path>
                </clipPath>
            </defs>
        </svg>
    </span><span>Download</span>`;

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
                
                // Add stop handler
                downloadBtn.onclick = () => {
                    logger.debug('Stop button clicked for:', progressData.downloadUrl);
                    handleDownloadCancellation(progressData.downloadUrl);
                };
                
                logger.debug('Download button switched to Stop mode');
            }
            break;
            
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            // Restore original button state
            downloadBtn.innerHTML = DL_BTN_ORIG_HTML;
            downloadBtnWrapper.classList.remove('downloading', 'stop-mode');
            // Restore download handler if available
            if (downloadBtn._downloadHandler) {
                downloadBtn.onclick = downloadBtn._downloadHandler;
            } else {
                downloadBtn.onclick = null;
            }
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
            
        case 'download-canceled':
            // Handle dropdown option cancellation
            if (dropdownOption) {
                dropdownOption.classList.add('canceled');
                setTimeout(() => {
                    dropdownOption.classList.remove('downloading', 'canceled');
                    dropdownOption.style.removeProperty('--progress');
                }, 2000);
            }

            // Handle selected option cancellation
            if (selectedOption) {
                selectedOption.classList.add('canceled');
                selectedOption.classList.remove('downloading');
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = 'Canceled';
                setTimeout(() => restoreOriginalOption(selectedOption, progressData), 2000);
            }
            break;
            
        case 'download-error':
            // Handle dropdown option error
            if (dropdownOption) {
                dropdownOption.classList.add('error');
                selectedOption.classList.remove('downloading');
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
    selectedOption.classList.remove('downloading', 'complete', 'error', 'canceled');
    selectedOption.style.removeProperty('--progress');
    
    logger.debug('Restored original option:', progressData.selectedOptionOrigText);
}

/**
 * Handle download cancellation request
 * @param {string} downloadUrl - The download URL to cancel
 */
async function handleDownloadCancellation(downloadUrl) {
    logger.debug('Requesting download cancellation for:', downloadUrl);
    
    try {
        const port = getBackgroundPort();
        if (!port) {
            throw new Error('No connection to background script');
        }
        
        port.postMessage({
            command: 'cancel-download',
            downloadUrl: downloadUrl
        });
        
        logger.debug('Cancellation request sent to background');
        
    } catch (error) {
        logger.error('Failed to send cancellation request:', error);
        showError('Failed to cancel download');
    }
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