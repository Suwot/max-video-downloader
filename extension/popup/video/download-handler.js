/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utils/logger.js';
import { sendPortMessage } from '../communication.js';
import { showError } from '../ui.js';
import { formatSize, formatTime } from '../../shared/utils/video-utils.js';
import { renderHistoryItems } from './video-renderer.js';
import { setButtonState, restoreButtonState, setButtonIntermediaryState } from './download-button.js';

const logger = createLogger('Download');

// Downloads management constants
const MAX_DOWNLOAD_HISTORY_ITEMS = 50;

/**
 * Handle download button click - streamlined version
 * @param {HTMLElement} button - Download button
 * @param {Object} videoData - Video metadata
 */
export async function handleDownload(elementsDiv, videoData = {}) {
    logger.debug('Initiating download for:', videoData.downloadUrl);
    
    try {     
        // Store original text for restoration
        const isDash = elementsDiv.querySelector('[data-type="dash"]');
        const dropdownOption = isDash ?
            elementsDiv.querySelector('.selected-option .label') :
            elementsDiv.querySelector('.dropdown-option.selected .label');
        const selectedOptionOrigText = dropdownOption ? dropdownOption.textContent : '';

        const downloadMessage = {
            command: 'download',
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
    
    // Skip video item UI updates for re-downloads (they don't have video items in the videos tab)
    if (progressData.isRedownload) {
        logger.debug('🔄 Re-download progress - skipping video item UI updates');
        // Handle completion states for re-downloads (active downloads UI only)
        if (progressData.command === 'download-success' || progressData.command === 'download-error' || progressData.command === 'download-canceled') {
            const shouldAddToHistory = progressData.command !== 'download-canceled';
            setTimeout(() => handleDownloadCompletion(progressData, shouldAddToHistory), 2000);
        } else if (progressData.command === 'download-unqueued') {
            handleDownloadCompletion(progressData, false);
        }
        return;
    }
    
    // Orchestrate all UI updates for original downloads
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    // Handle completion states - unified cleanup with conditional timing and history
    if (progressData.command === 'download-success' || progressData.command === 'download-error' || progressData.command === 'download-canceled') {
        // Delayed cleanup - success/error with history, canceled without history
        const shouldAddToHistory = progressData.command !== 'download-canceled';
        setTimeout(() => handleDownloadCompletion(progressData, shouldAddToHistory), 2000);
    } else if (progressData.command === 'download-unqueued') {
        // Immediate cleanup without history addition (unqueued is not a final state, just removal)
        handleDownloadCompletion(progressData, false);
    }
    
    logger.debug('All UI elements updated for command:', progressData.command);
}

/**
 * Update download button state based on progress
 * Downloads-first: always update active downloads, optionally update videos if present
 * @param {Object} progressData - Progress data from background
 */
function updateDownloadButton(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    // Always target active downloads (global)
    const downloadsElements = document.querySelectorAll(
        `.active-downloads .video-item[data-url="${lookupUrl}"]`
    );
    
    // Optionally target videos container (contextual)
    const videosElements = document.querySelectorAll(
        `.videos-container .video-item[data-url="${lookupUrl}"]`
    );
    
    const allElements = [...downloadsElements, ...videosElements];
    
    if (allElements.length === 0) {
        logger.debug('No video elements found for URL:', lookupUrl);
        return;
    }
    
    // Update all matching elements using unified state manager
    allElements.forEach(elementsDiv => {
        updateSingleDownloadButtonState(elementsDiv, progressData);
    });
}

/**
 * Update a single download button element using unified state management
 * @param {HTMLElement} elementsDiv - The video item container element
 * @param {Object} progressData - Progress data from background
 */
function updateSingleDownloadButtonState(elementsDiv, progressData = {}) {
    // Create cancel handler for all cancel-able states
    const cancelHandler = () => {
        const cancelMessage = {
            command: 'cancel-download',
            type: progressData.type,
            downloadUrl: progressData.downloadUrl,
            masterUrl: progressData.masterUrl || null,
            selectedOptionOrigText: progressData.selectedOptionOrigText
        };
        sendPortMessage(cancelMessage);
    };

    switch (progressData.command) {
        case 'download-queued':
            setButtonState(elementsDiv, 'queued', {
                text: 'Cancel',
                handler: cancelHandler
            });
            logger.debug('Download button set to queued state');
            break;
            
        case 'download-unqueued':
            setButtonState(elementsDiv, 'default', {
                text: 'Unqueued',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Download button set to unqueued state');
            break;
            
        case 'download-progress':
            // Only set to downloading state on first progress message
            setButtonState(elementsDiv, 'downloading', {
                text: 'Stop',
                handler: () => {
                    setButtonIntermediaryState(elementsDiv, 'Stopping...');
                    cancelHandler();
                }
            });
            logger.debug('Download button switched to Stop mode');
            break;
            
        case 'download-success':
            setButtonState(elementsDiv, 'success', {
                text: 'Completed!',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Download button set to success state');
            break;
            
        case 'download-error':
            setButtonState(elementsDiv, 'error', {
                text: 'Error',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Download button set to error state');
            break;
            
        case 'download-canceled':
            setButtonState(elementsDiv, 'canceled', {
                text: 'Canceled',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Download button set to canceled state');
            break;
    }
}

/**
 * Update entire dropdown (selected-option + dropdown-option) during download
 * Downloads-first: always update active downloads, optionally update videos if present
 * @param {Object} progressData - Progress data
 */
function updateDropdown(progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    const progress = progressData.progress;

    // Always target active downloads (global)
    const downloadsElements = document.querySelectorAll(
        `.active-downloads .video-item[data-url="${lookupUrl}"] .download-group`
    );
    
    // Optionally target videos container (contextual)
    const videosElements = document.querySelectorAll(
        `.videos-container .video-item[data-url="${lookupUrl}"] .download-group`
    );
    
    const downloadGroups = [...downloadsElements, ...videosElements];
    
    if (downloadGroups.length === 0) {
        logger.debug('No download group elements found for URL:', lookupUrl);
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
            // Color dropdown option yellow to show queued quality
            if (dropdownOption) {
                dropdownOption.classList.add('queued');
            }
            logger.debug('Dropdown option set to queued state');
            break;
            
        case 'download-unqueued':
            // Remove queued coloring
            if (dropdownOption) {
                dropdownOption.classList.remove('queued');
            }
            logger.debug('Dropdown option unqueued state');
            break;
            
        case 'download-progress':
            // Update selected-option with progress bar AND text
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

            // Remove queued from dropdown-option when download starts
            if (dropdownOption) {
                dropdownOption.classList.remove('queued');
                dropdownOption.style.setProperty('--progress', `${progress}%`);
                dropdownOption.classList.add('downloading');
            }

            logger.debug('Dropdown progress updated:', progress + '%');
            break;
            
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            // Clean restore - NO final state coloring as requested
            if (selectedOption) {
                selectedOption.classList.remove('downloading', 'queued');
                selectedOption.style.removeProperty('--progress');
                
                // Restore original text
                const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                textSpan.textContent = progressData.selectedOptionOrigText?.split('•').slice(0, 2).join('•') || textSpan.textContent;
            }

            if (dropdownOption) {
                dropdownOption.classList.remove('downloading', 'queued');
                dropdownOption.style.removeProperty('--progress');
            }
            
            logger.debug('Dropdown restored to original state');
            break;
    }
}

/**
 * Clone video item to downloads tab (UI only, no storage)
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
        
        // Add elementHTML to downloadData for storage by Download Manager
        downloadData.elementHTML = clonedElement.outerHTML;

        // Insert cloned element into downloads tab and manage initial message visibility
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        const initialMessage = activeDownloadsContainer.querySelector('.initial-message');
        
        // Hide initial message and append the element
        if (initialMessage) {
            initialMessage.style.display = 'none';
        }
        activeDownloadsContainer.appendChild(clonedElement);
        
        logger.debug('Cloned video item to downloads UI');

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
        if (!activeDownloadsContainer) {
            return;
        }

        // Clear existing content
        activeDownloadsContainer.innerHTML = `<div class="initial-message">
                                <p>Ongoing downloads will appear here</p>
                            </div>`;

        const initialMessage = activeDownloadsContainer.querySelector('.initial-message');

        if (activeDownloads.length === 0) {
            // Show initial message when no active downloads
            initialMessage.style.display = 'flex';
            return;
        }

        // Hide initial message and restore downloads
        initialMessage.style.display = 'none';
        
        // Restore full HTML elements as stored (unified with original cloning logic)
        activeDownloads.forEach(downloadEntry => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = downloadEntry.elementHTML;
            const videoItem = tempDiv.firstElementChild;
            activeDownloadsContainer.appendChild(videoItem);
        });

        logger.debug(`Restored ${activeDownloads.length} active downloads`);

    } catch (error) {
        logger.error('Error restoring active downloads:', error);
    }
}

/**
 * Handle download completion with unified cleanup logic (UI only)
 * @param {Object} progressData - Progress data containing download info
 * @param {boolean} addToHistory - Whether to add this download to history (now handled by DM)
 */
async function handleDownloadCompletion(progressData, addToHistory = false) {
    try {
        const lookupUrl = progressData.masterUrl || progressData.downloadUrl;

        // Remove from active downloads UI and manage initial message visibility
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (activeDownloadsContainer) {
            const videoItemToRemove = activeDownloadsContainer.querySelector(`[data-url="${lookupUrl}"]`);
            if (videoItemToRemove) {
                videoItemToRemove.remove();
            }
            
            // Show initial message if no more active downloads remain
            const remainingVideoItems = activeDownloadsContainer.querySelectorAll('.video-item');
            const initialMessage = activeDownloadsContainer.querySelector('.initial-message');
            if (remainingVideoItems.length === 0 && initialMessage) {
                initialMessage.style.display = 'flex';
            }
        }

        logger.debug(`UI cleanup completed for ${progressData.command}:`, lookupUrl);

        // Re-render history items incrementally if this was added to history
        if (addToHistory) {
            await renderHistoryItems(false);
        }

    } catch (error) {
        logger.error('Error handling download completion UI:', error);
    }
}