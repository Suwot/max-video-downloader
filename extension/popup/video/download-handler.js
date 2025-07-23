/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utils/logger.js';
import { sendPortMessage } from '../communication.js';
import { showError } from '../ui-utils.js';
import { formatSize, formatTime } from '../../shared/utils/processing-utils.js';
import { renderHistoryItems } from './video-renderer.js';
import { VideoItemComponent } from './video-item-component.js';

const logger = createLogger('Download');

/**
 * Handle download button click - streamlined version with video data context
 * @param {HTMLElement} elementsDiv - Elements container
 * @param {Object} videoData - Video metadata with container context
 */
export async function handleDownload(elementsDiv, videoData = {}) {
    logger.debug('Initiating download for:', videoData.downloadUrl);
    
    try {     
        // Use provided selectedOptionOrigText or extract from DOM (backward compatibility)
        let selectedOptionOrigText = videoData.selectedOptionOrigText;
        if (!selectedOptionOrigText) {
            const isDash = elementsDiv.querySelector('[data-type="dash"]');
            const dropdownOption = isDash ?
                elementsDiv.querySelector('.selected-option .label') :
                elementsDiv.querySelector('.dropdown-option.selected .label');
            selectedOptionOrigText = dropdownOption ? dropdownOption.textContent : '';
        }

        const downloadMessage = {
            command: 'download',
            selectedOptionOrigText,
            ...videoData  // Spread all videoData properties including containerContext
        };
        
        // Background will handle creating downloads tab items when download starts
        
        // Send via communication service
        sendPortMessage(downloadMessage);
        
        logger.debug('Download request sent to background with video data context');
        
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
export async function updateDownloadProgress(progressData = {}) {
    logger.debug('Progress update received:', progressData.command, progressData.progress ? progressData.progress + '%' : 'No progress');
    
    // Handle downloads tab creation for new downloads (efficient one-time events)
    if (progressData.command === 'download-queued' && progressData.videoData) {
        await createVideoItemInDownloads(progressData.videoData, 'queued');
    } else if (progressData.command === 'download-started' && progressData.videoData) {
        // Simple dedup: only create if item doesn't exist yet (handles queued → started transitions)
        const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        const existingItem = activeDownloadsContainer?.querySelector(`.video-item[data-url="${lookupUrl}"]`);
        
        if (!existingItem) {
            await createVideoItemInDownloads(progressData.videoData, 'starting');
        }
    }
    
    // Update ALL matching items in both tabs (videos and downloads)
    // The functions will naturally find and update only existing items
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    // Handle completion states for all downloads (original and re-downloads)
    if (progressData.command === 'download-success' || progressData.command === 'download-error' || progressData.command === 'download-canceled') {
        const shouldAddToHistory = progressData.command !== 'download-canceled';
        setTimeout(() => handleDownloadCompletion(progressData, shouldAddToHistory), 2000);
    } else if (progressData.command === 'download-unqueued') {
        handleDownloadCompletion(progressData, false);
    }
    
    logger.debug('All UI elements updated for command:', progressData.command);
}

/**
 * Restore download button states for ongoing downloads when popup reopens
 * @param {Array} activeDownloads - Array of active download entries from storage
 */
export function restoreDownloadStates(activeDownloads = []) {
    if (activeDownloads.length === 0) return;
    
    logger.debug('Restoring download states for', activeDownloads.length, 'active downloads');
    
    activeDownloads.forEach(downloadEntry => {
        const lookupUrl = downloadEntry.masterUrl || downloadEntry.downloadUrl;
        
        // Find matching video items in videos tab
        const videosElements = document.querySelectorAll(
            `.videos-container .video-item[data-url="${lookupUrl}"]`
        );
        
        videosElements.forEach(videoElement => {
            const component = videoElement._component;
            if (component && component.downloadButton) {
                // Set to downloading state for ongoing downloads
                const cancelHandler = () => {
                    const cancelMessage = {
                        command: 'cancel-download',
                        type: downloadEntry.type,
                        downloadUrl: downloadEntry.downloadUrl,
                        masterUrl: downloadEntry.masterUrl || null,
                        selectedOptionOrigText: downloadEntry.selectedOptionOrigText
                    };
                    sendPortMessage(cancelMessage);
                };
                
                if (downloadEntry.status === 'downloading') {
                    component.downloadButton.updateState('downloading', {
                        text: 'Stop',
                        handler: () => {
                            component.downloadButton.setIntermediaryText('Stopping...');
                            cancelHandler();
                        }
                    });
                } else if (downloadEntry.status === 'queued') {
                    component.downloadButton.updateState('queued', {
                        text: 'Cancel',
                        handler: cancelHandler
                    });
                }
                
                logger.debug('Restored button state for:', lookupUrl, 'to', downloadEntry.status);
            }
        });
    });
}

/**
 * Update download button state based on progress
 * Updates ALL matching items in both videos and downloads tabs
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
    
    // Update all matching elements using component-aware state manager
    allElements.forEach(videoElement => {
        updateSingleDownloadButtonState(videoElement, progressData);
    });
}

/**
 * Update a single download button element using component-aware state management
 * @param {HTMLElement} videoElement - The video item element
 * @param {Object} progressData - Progress data from background
 */
function updateSingleDownloadButtonState(videoElement, progressData = {}) {
    // All video elements now use component-based approach
    const component = videoElement._component;
    if (component && component.downloadButton) {
        updateComponentButtonState(component.downloadButton, progressData);
    } else {
        logger.warn('Video element missing component reference:', progressData.downloadUrl);
    }
}

/**
 * Update button state using new component approach
 * @param {Object} downloadButtonComponent - Download button component
 * @param {Object} progressData - Progress data from background
 */
function updateComponentButtonState(downloadButtonComponent, progressData = {}) {
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
            downloadButtonComponent.updateState('queued', {
                text: 'Cancel',
                handler: cancelHandler
            });
            logger.debug('Component download button set to queued state');
            break;
            
        case 'download-unqueued':
            // Immediately restore to default state for unqueued
            downloadButtonComponent.updateState('default');
            logger.debug('Component download button restored to default (unqueued)');
            break;
            
        case 'download-progress':
            // Set to downloading state with stop functionality
            downloadButtonComponent.updateState('downloading', {
                text: 'Stop',
                handler: () => {
                    downloadButtonComponent.setIntermediaryText('Stopping...');
                    cancelHandler();
                }
            });
            logger.debug('Component download button switched to Stop mode');
            break;
            
        case 'download-success':
            // Show success state briefly with auto-restore (like old system)
            downloadButtonComponent.updateState('success', {
                text: 'Completed!',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Component download button set to success state');
            break;
            
        case 'download-error':
            // Show error state briefly with auto-restore (like old system)
            downloadButtonComponent.updateState('error', {
                text: 'Error',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Component download button set to error state');
            break;
            
        case 'download-canceled':
            // Show canceled state briefly with auto-restore (like old system)
            downloadButtonComponent.updateState('canceled', {
                text: 'Canceled',
                autoRestore: true,
                autoRestoreDelay: 2000
            });
            logger.debug('Component download button set to canceled state');
            break;
    }
}

// Legacy button state function removed - all items now use components

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
 * Create video item in downloads tab from video data
 * @param {Object} videoData - Raw video data
 * @param {string} initialState - Initial download state
 */
async function createVideoItemInDownloads(videoData, initialState = 'default') {
    try {
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer) {
            logger.error('Active downloads container not found');
            return;
        }

        // Create new video item component with initial state
        const videoComponent = new VideoItemComponent(videoData, initialState);
        const videoElement = videoComponent.render();
        
        // Hide initial message and append the element (queue order: oldest first)
        const initialMessage = activeDownloadsContainer.querySelector('.initial-message');
        if (initialMessage) {
            initialMessage.style.display = 'none';
        }
        
        // Append to end for proper queue order (oldest downloads at top)
        activeDownloadsContainer.appendChild(videoElement);
        
        logger.debug('Created video item in downloads tab with state:', initialState);

    } catch (error) {
        logger.error('Error creating video item in downloads:', error);
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
        
        // Recreate video items from stored video data with proper initial states
        activeDownloads.forEach(downloadEntry => {
            if (downloadEntry.videoData) {
                const initialState = downloadEntry.status || 'queued';
                const videoComponent = new VideoItemComponent(downloadEntry.videoData, initialState);
                const videoElement = videoComponent.render();
                activeDownloadsContainer.appendChild(videoElement);
            } else {
                logger.warn('Download entry missing videoData, skipping:', downloadEntry.downloadUrl);
            }
        });

        logger.debug(`Restored ${activeDownloads.length} active downloads`);
        
        // Restore button states for ongoing downloads in videos tab
        restoreDownloadStates(activeDownloads);

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