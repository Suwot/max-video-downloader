/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utils/logger.js';
import { sendPortMessage } from '../communication.js';
import { getTabId } from '../state.js';
import { showError } from '../ui.js';
import { formatSize } from '../../shared/utils/video-utils.js';

const logger = createLogger('Download');

// Downloads management constants
const MAX_DOWNLOAD_HISTORY_ITEMS = 50;

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
        const isDash = elementsDiv.querySelector('[data-type="dash"]');
        const dropdownOption = isDash ?
            elementsDiv.querySelector('.selected-option .label') :
            elementsDiv.querySelector('.dropdown-option.selected .label');
        const selectedOptionOrigText = dropdownOption ? dropdownOption.textContent : '';

        const currentTabId = getTabId();
        const downloadMessage = {
            command: 'download',
            tabId: currentTabId,
            selectedOptionOrigText,
            ...videoData  // Spread all videoData properties instead of manual mapping
        };
        
        // Clone video item to downloads tab before sending request
        await cloneVideoItemToDownloads(elementsDiv, downloadMessage);
        
        // Send via communication service
        sendPortMessage(downloadMessage);
        
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
    logger.debug('Progress update received:', progressData.command, progressData.progress ? progressData.progress + '%' : 'No progress');
    
    // Orchestrate all UI updates
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    // Handle completion states
    if (progressData.command === 'download-success') {
        setTimeout(() => moveToHistory(progressData, 'success'), 3000);
    } else if (progressData.command === 'download-error') {
        setTimeout(() => moveToHistory(progressData, 'error', progressData.error), 4000);
    } else if (progressData.command === 'download-canceled') {
        setTimeout(() => moveToHistory(progressData, 'canceled'), 3000);
    }
    
    logger.debug('All UI elements updated for command:', progressData.command);
}

/**
 * Update download button state based on progress
 * Updates all matching elements in both videos tab and active downloads
 * @param {Object} progressData - Progress data from background
 */
function updateDownloadButton(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    // Target both videos container and active downloads (not history)
    const downloadBtnWrappers = document.querySelectorAll(
        `.videos-container .video-item[data-url="${lookupUrl}"] .download-btn-wrapper, ` +
        `.active-downloads .video-item[data-url="${lookupUrl}"] .download-btn-wrapper`
    );
    
    if (downloadBtnWrappers.length === 0) {
        logger.warn('Download button elements not found for URL:', lookupUrl);
        return;
    }
    
    // Update all matching elements
    downloadBtnWrappers.forEach(downloadBtnWrapper => {
        const downloadBtn = downloadBtnWrapper?.querySelector('.download-btn');
        const menuBtn = downloadBtnWrapper?.querySelector('.download-menu-btn');
        
        if (!downloadBtn || !menuBtn) {
            logger.warn('Download button sub-elements not found in wrapper');
            return;
        }
        
        updateSingleDownloadButton(downloadBtn, downloadBtnWrapper, progressData);
    });
}

/**
 * Update a single download button element with progress state
 * @param {HTMLElement} downloadBtn - The download button element
 * @param {HTMLElement} downloadBtnWrapper - The wrapper element
 * @param {Object} progressData - Progress data from background
 */
function updateSingleDownloadButton(downloadBtn, downloadBtnWrapper, progressData = {}) {

    switch (progressData.command) {
        case 'download-queued':
            // Update button to queued state
            downloadBtn.innerHTML = 'Queued...';
            downloadBtnWrapper.classList.add('queued');
            
            // Add queue cancellation handler
            downloadBtn.onclick = () => {
                logger.debug('Queue cancellation clicked for:', progressData.downloadUrl);
                handleQueueCancellation(progressData);
            };
            
            logger.debug('Download button set to queued state');
            break;
            
        case 'download-unqueued':
            // Show unqueued state briefly
            downloadBtn.innerHTML = 'Unqueued';
            downloadBtnWrapper.classList.remove('queued');
            downloadBtnWrapper.classList.add('unqueued');
            
            // Restore original state after 2 seconds
            setTimeout(() => {
                downloadBtn.innerHTML = DL_BTN_ORIG_HTML;
                downloadBtnWrapper.classList.remove('unqueued');
                // Restore download handler if available
                if (downloadBtn._downloadHandler) {
                    downloadBtn.onclick = downloadBtn._downloadHandler;
                } else {
                    downloadBtn.onclick = null;
                }
            }, 2000);

            logger.debug('Download button set to unqueued state');
            break;
            
        case 'download-progress':
            if (!downloadBtnWrapper.classList.contains('downloading')) {
                // Update button text and state
                downloadBtn.innerHTML = 'Stop';
                downloadBtnWrapper.classList.remove('queued'); // Clear any queue state
                downloadBtnWrapper.classList.add('downloading', 'stop-mode');
                
                // Add stop handler
                downloadBtn.onclick = () => {
                    logger.debug('Stop button clicked for:', progressData.downloadUrl);
                    handleDownloadCancellation(progressData);
                };
                
                logger.debug('Download button switched to Stop mode');
            }
            break;
            
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            // Restore original button state
            downloadBtn.innerHTML = DL_BTN_ORIG_HTML;
            downloadBtnWrapper.classList.remove('downloading', 'stop-mode', 'queued', 'unqueued');
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
 * Updates all matching elements in both videos tab and active downloads
 * @param {Object} progressData - Progress data
 */
function updateDropdown(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const progress = progressData.progress;

    // Target both videos container and active downloads (not history)
    const downloadGroups = document.querySelectorAll(
        `.videos-container .video-item[data-url="${lookupUrl}"] .download-group, ` +
        `.active-downloads .video-item[data-url="${lookupUrl}"] .download-group`
    );
    
    if (downloadGroups.length === 0) {
        logger.warn('Download group not found for URL:', lookupUrl, progressData);
        return;
    }
    
    // Update all matching elements
    downloadGroups.forEach(downloadGroup => {
        updateSingleDropdown(downloadGroup, progressData, progress);
    });
}

/**
 * Update a single dropdown element with progress state
 * @param {HTMLElement} downloadGroup - The download group element
 * @param {Object} progressData - Progress data
 * @param {number} progress - Progress percentage
 */
function updateSingleDropdown(downloadGroup, progressData = {}, progress) {
    const selectedOption = downloadGroup.querySelector('.selected-option');
    const dropdownOption = downloadGroup.querySelector(`.dropdown-option[data-url="${progressData.downloadUrl}"]`);

    switch (progressData.command) {
        case 'download-queued':
            // Update selected option for queued state
            if (selectedOption) {
                selectedOption.classList.add('queued');
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = 'Waiting in queue...';
            }
            
            // Update dropdown option for queued state
            if (dropdownOption) {
                dropdownOption.classList.add('queued');
            }
            
            logger.debug('Dropdown set to queued state');
            break;
            
        case 'download-unqueued':
            // Update selected option for unqueued state
            if (selectedOption) {
                selectedOption.classList.remove('queued');
                selectedOption.classList.add('unqueued');
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = 'Removed from queue';
                
                // Restore after 2 seconds
                setTimeout(() => restoreOriginalOption(selectedOption, progressData), 2000);
            }
            
            // Update dropdown option for unqueued state
            if (dropdownOption) {
                dropdownOption.classList.remove('queued');
                dropdownOption.classList.add('unqueued');
                setTimeout(() => {
                    dropdownOption.classList.remove('unqueued');
                }, 2000);
            }
            
            logger.debug('Dropdown set to unqueued state');
            break;
            
        case 'download-progress':
            // Update dropdown option background (no text change)
            if (dropdownOption) {
                dropdownOption.style.setProperty('--progress', `${progress}%`);
                dropdownOption.classList.remove('queued'); // Clear any queue state
                dropdownOption.classList.add('downloading');
            }

            // Update selected option (with progress text)
            if (selectedOption) {
                selectedOption.style.setProperty('--progress', `${progress}%`);
                selectedOption.classList.remove('queued'); // Clear any queue state
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
    textSpan.textContent = progressData.selectedOptionOrigText.split('•').slice(0, 2).join('•');

    // Clean up progress styling and all state classes
    selectedOption.classList.remove('downloading', 'complete', 'error', 'canceled', 'queued', 'unqueued');
    selectedOption.style.removeProperty('--progress');
    
    logger.debug('Restored original option:', progressData.selectedOptionOrigText);
}

/**
 * Handle download cancellation request
 * @param {string} downloadUrl - The download URL to cancel
 */
async function handleDownloadCancellation(progressData) {
    logger.debug('Requesting download cancellation for:', progressData.downloadUrl);
    
    try {
        sendPortMessage({
            command: 'cancel-download',
            downloadUrl: progressData.downloadUrl,
            masterUrl: progressData.masterUrl || null,
            selectedOptionOrigText: progressData.selectedOptionOrigText
        });
        
        logger.debug('Cancellation request sent to background');
        
    } catch (error) {
        logger.error('Failed to send cancellation request:', error);
        showError('Failed to cancel download');
    }
}

/**
 * Handle queue cancellation request (unqueue)
 * @param {string} downloadUrl - The download URL to remove from queue
 */
async function handleQueueCancellation(progressData) {
    logger.debug('Requesting queue cancellation for:', progressData.downloadUrl);
    
    try {
        sendPortMessage({
            command: 'cancel-download',
            downloadUrl: progressData.downloadUrl,
            masterUrl: progressData.masterUrl || null,
            selectedOptionOrigText: progressData.selectedOptionOrigText
        });
        
        logger.debug('Queue cancellation request sent to background');
        
    } catch (error) {
        logger.error('Failed to send queue cancellation request:', error);
        showError('Failed to cancel queued download');
    }
}

/**
 * Clone video item to downloads tab and store in local storage
 * @param {HTMLElement} elementsDiv - The video item element to clone
 * @param {Object} downloadData - Download metadata
 */
async function cloneVideoItemToDownloads(elementsDiv, downloadData) {
    try {
        // Find the video-item container
        const videoItem = elementsDiv.closest('.video-item');
        if (!videoItem) {
            logger.error('Could not find video-item container to clone');
            return;
        }

        // Clone the element (without event listeners)
        const clonedElement = videoItem.cloneNode(true);
        
        // Create download entry for storage
        const downloadEntry = {
            lookupUrl: downloadData.masterUrl || downloadData.downloadUrl,
            downloadUrl: downloadData.downloadUrl,
            masterUrl: downloadData.masterUrl || null,
            filename: downloadData.filename,
            elementHTML: clonedElement.outerHTML,
            timestamp: Date.now(),
            selectedOptionOrigText: downloadData.selectedOptionOrigText
        };

        // Store in active downloads
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        activeDownloads.push(downloadEntry);
        await chrome.storage.local.set({ downloads_active: activeDownloads });

        // Insert cloned element into downloads tab
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        activeDownloadsContainer.prepend(clonedElement);

    } catch (error) {
        logger.error('Error cloning video item to downloads:', error);
    }
}

/**
 * Restore active downloads from storage on popup reopen
 */
export async function restoreActiveDownloads() {
    try {
        const result = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = result.downloads_active || [];
        
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer || activeDownloads.length === 0) {
            return;
        }

        // Clear existing content
        activeDownloadsContainer.innerHTML = `<div class="initial-message">
                                <p>Ongoing downloads will appear here</p>
                            </div>`;

        // Restore each download element by prepending (reverse order to maintain chronological order)
        activeDownloads.reverse().forEach(downloadEntry => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = downloadEntry.elementHTML;
            const videoItem = tempDiv.firstElementChild;
            activeDownloadsContainer.prepend(videoItem);
        });

        logger.debug(`Restored ${activeDownloads.length} active downloads`);

    } catch (error) {
        logger.error('Error restoring active downloads:', error);
    }
}

/**
 * Move completed download to history and remove from active downloads
 * @param {Object} progressData - Progress data containing download info
 * @param {string} status - 'success' or 'error' or 'canceled'
 * @param {string} error - Error message if status is 'error'
 */
async function moveToHistory(progressData, status, error = null) {
    try {
        const lookupUrl = progressData.masterUrl || progressData.downloadUrl;

        // Remove from active downloads storage
        const activeResult = await chrome.storage.local.get(['downloads_active']);
        const activeDownloads = activeResult.downloads_active || [];
        const downloadEntry = activeDownloads.find(entry => entry.lookupUrl === lookupUrl);
        
        if (downloadEntry) {
            // Remove from active downloads array
            const updatedActiveDownloads = activeDownloads.filter(entry => entry.lookupUrl !== lookupUrl);
            await chrome.storage.local.set({ downloads_active: updatedActiveDownloads });

            // Only add to history if it's success or error (not canceled)
            if (status === 'success' || status === 'error') {
                // Add to history
                const historyResult = await chrome.storage.local.get(['downloads_history']);
                const history = historyResult.downloads_history || [];
                
                const historyEntry = {
                    ...downloadEntry,
                    progressData,
                    status,
                    error
                };

                logger.debug(`Moving download to history:`, historyEntry);

                history.unshift(historyEntry); // Add to beginning of array

                // Maintain history size limit
                if (history.length > MAX_DOWNLOAD_HISTORY_ITEMS) {
                    history.splice(MAX_DOWNLOAD_HISTORY_ITEMS);
                }

                await chrome.storage.local.set({ downloads_history: history });
                logger.debug(`Moved download to history with status: ${status}`);

                // Update history display
                await restoreDownloadsHistory();
            }

            // Remove from active downloads UI
            const activeDownloadsContainer = document.querySelector('.active-downloads');
            if (activeDownloadsContainer) {
                const videoItemToRemove = activeDownloadsContainer.querySelector(`[data-url="${lookupUrl}"]`);
                if (videoItemToRemove) {
                    videoItemToRemove.remove();
                }
            }
        }

    } catch (error) {
        logger.error('Error moving download to history:', error);
    }
}

/**
 * Restore downloads history from storage
 */
export async function restoreDownloadsHistory() {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        const history = result.downloads_history || [];
        
        const historyContainer = document.querySelector('.downloads-history');
        if (!historyContainer) {
            return;
        }

        // Clear existing content
        historyContainer.innerHTML = `<div class="initial-message">
                                <p>You don't have any downloads in history</p>
                            </div>`;

        if (history.length === 0) {
            return; // Keep initial message visible
        }

        // Restore each history item by prepending
        history.reverse().forEach(historyEntry => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = historyEntry.elementHTML;
            const videoItem = tempDiv.firstElementChild;
            
            if (videoItem) {
                // Add history status classes
                videoItem.classList.add('history-item', `history-${historyEntry.status}`);
                
                // Add completion timestamp
                const completedDate = new Date(historyEntry.progressData.completedAt).toLocaleString();
                const timestampDiv = document.createElement('div');
                timestampDiv.className = 'download-timestamp';
                timestampDiv.textContent = completedDate;
                videoItem.appendChild(timestampDiv);

                historyContainer.prepend(videoItem);
            }
        });

        logger.debug(`Restored ${history.length} history items`);

    } catch (error) {
        logger.error('Error restoring downloads history:', error);
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