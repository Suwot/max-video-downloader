/**
 * Download Progress Handler - UI progress updates and state restoration
 * Handles progress mapping, UI updates, and download state restoration
 */

import { createLogger } from '../../shared/utils/logger.js';
import { sendPortMessage } from '../communication.js';
import { formatSize, formatTime } from '../../shared/utils/processing-utils.js';
import { renderHistoryItems } from './video-renderer.js';
import { VideoItemComponent } from './video-item-component.js';

const logger = createLogger('DownloadProgress');

/**
 * Pure orchestrator for download progress updates
 * Delegates to specialized UI update functions
 * @param {Object} progressData - Progress data from background
 */
export async function updateDownloadProgress(progressData = {}) {
    logger.debug('Progress update received:', progressData.command, progressData.progress ? progressData.progress + '%' : 'No progress');
    
    // Handle downloads tab creation for new downloads (efficient one-time events)
    if (progressData.command === 'download-queued' && progressData.videoData) {
        await createVideoItemInDownloads(progressData.videoData, 'queued', progressData.downloadId);
    } else if (progressData.command === 'download-started' && progressData.videoData) {
        // Smart UI updates: update existing queued items instead of creating duplicates
        const downloadId = progressData.downloadId;
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        
        // Check for existing item by downloadId first
        let existingItem = null;
        if (downloadId) {
            existingItem = activeDownloadsContainer?.querySelector(`.video-item[data-download-id="${downloadId}"]`);
        }
        
        if (existingItem) {
            // Update existing queued item to downloading state
            const component = existingItem._component;
            if (component && component.downloadButton) {
                component.downloadButton.updateState('starting');
            }
        } else {
            // Create new item (for direct downloads)
            await createVideoItemInDownloads(progressData.videoData, 'starting', downloadId);
        }
    }
    
    // Update ALL matching items in both tabs (videos and downloads)
    // The functions will naturally find and update only existing items
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    // Handle completion states for all downloads (original and re-downloads)
    if (progressData.command === 'download-success' || progressData.command === 'download-error' || progressData.command === 'download-canceled') {
        const shouldAddToHistory = progressData.command !== 'download-canceled';
        // Call immediately to remove from downloads-tab and prevent deduplication issues
        handleDownloadCompletion(progressData, shouldAddToHistory);
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
                        downloadId: downloadEntry.downloadId || downloadEntry.downloadUrl,
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
                            component.downloadButton.updateState('stopping');
                            cancelHandler();
                        }
                    });
                } else if (downloadEntry.status === 'queued') {
                    component.downloadButton.updateState('queued', {
                        text: 'Cancel',
                        handler: cancelHandler
                    });
                } else if (downloadEntry.status === 'stopping') {
                    component.downloadButton.updateState('stopping');
                } else {
                    // Unknown status, set to downloading as fallback
                    component.downloadButton.updateState('downloading', {
                        text: 'Stop',
                        handler: () => {
                            component.downloadButton.updateState('stopping');
                            cancelHandler();
                        }
                    });
                }
                
                logger.debug('Restored button state for:', lookupUrl, 'to', downloadEntry.status);
            }
        });
    });
}

/**
 * Find matching video elements - streamlined logic
 * downloadId match for downloads-tab, URL fallback for videos-tab
 * @param {Object} progressData - Progress data from background
 * @returns {Array} Array of matching video elements
 */
function findMatchingVideoElements(progressData = {}) {
    const downloadId = progressData.downloadId;
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    const allElements = [];
    const videoItems = document.querySelectorAll('.active-downloads .video-item, .videos-container .video-item');
    
    videoItems.forEach(item => {
        const itemDownloadId = item.dataset.downloadId;
        const itemUrl = item.dataset.url;
        
        // If item has downloadId, match only by downloadId (downloads-tab)
        if (itemDownloadId) {
            if (itemDownloadId === downloadId) {
                allElements.push(item);
            }
        } else {
            // If item has no downloadId, match by URL (videos-tab)
            if (itemUrl === lookupUrl) {
                allElements.push(item);
            }
        }
    });
    
    return allElements;
}

/**
 * Update download button state based on progress
 * Updates matching items using downloadId for precision, with URL fallback
 * @param {Object} progressData - Progress data from background
 */
function updateDownloadButton(progressData = {}) {
    const allElements = findMatchingVideoElements(progressData);
    
    if (allElements.length === 0) {
        logger.debug('No video elements found for download:', progressData.downloadUrl);
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
            downloadId: progressData.downloadId || progressData.downloadUrl,
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
            
        case 'download-progress':
            // Set to downloading state with stop functionality
            downloadButtonComponent.updateState('downloading', {
                text: 'Stop',
                handler: () => {
                    // Set stopping state instead of intermediary text
                    downloadButtonComponent.updateState('stopping');
                    cancelHandler();
                }
            });
            logger.debug('Component download button switched to Stop mode');
            break;
            
        case 'download-stopping':
            // Handle stopping state from background
            downloadButtonComponent.updateState('stopping');
            logger.debug('Component download button set to stopping state');
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
 * Uses downloadId for precision, with URL fallback
 * @param {Object} progressData - Progress data
 */
function updateDropdown(progressData = {}) {
    const progress = progressData.progress;
    const allElements = findMatchingVideoElements(progressData);
    
    // Get download groups from matching video elements
    const downloadGroups = allElements.map(videoElement => 
        videoElement.querySelector('.download-group')
    ).filter(Boolean);
    
    if (downloadGroups.length === 0) {
        logger.debug('No download group elements found for download:', progressData.downloadUrl);
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
 * @param {string} downloadId - Download ID for precise progress mapping
 */
async function createVideoItemInDownloads(videoData, initialState = 'default', downloadId = null) {
    try {
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer) {
            logger.error('Active downloads container not found');
            return;
        }

        // Create new video item component with initial state and download ID
        const videoComponent = new VideoItemComponent(videoData, initialState, downloadId);
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
        
        // Recreate video items from stored video data with proper initial states and downloadId
        activeDownloads.forEach(downloadEntry => {
            if (downloadEntry.videoData) {
                const initialState = downloadEntry.status || 'queued';
                const downloadId = downloadEntry.downloadId || null;
                const videoComponent = new VideoItemComponent(downloadEntry.videoData, initialState, downloadId);
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
        const downloadId = progressData.downloadId;
        const lookupUrl = progressData.masterUrl || progressData.downloadUrl;

        // IMMEDIATELY remove from downloads-tab using downloadId for precision
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (activeDownloadsContainer) {
            let videoItemToRemove = null;
            
            // Try to find by downloadId first, then fallback to URL
            if (downloadId) {
                videoItemToRemove = activeDownloadsContainer.querySelector(`[data-download-id="${downloadId}"]`);
            }
            if (!videoItemToRemove) {
                videoItemToRemove = activeDownloadsContainer.querySelector(`[data-url="${lookupUrl}"]`);
            }
            
            if (videoItemToRemove) {
                videoItemToRemove.remove();
                logger.debug(`Immediately removed from downloads-tab:`, downloadId || lookupUrl);
            }
            
            // Show initial message if no more active downloads remain
            const remainingVideoItems = activeDownloadsContainer.querySelectorAll('.video-item');
            const initialMessage = activeDownloadsContainer.querySelector('.initial-message');
            if (remainingVideoItems.length === 0 && initialMessage) {
                initialMessage.style.display = 'flex';
            }
        }

        // DELAYED reset of videos-tab button states (preserves existing UX)
        // Only for termination states that show temporary completion states
        if (['download-success', 'download-error', 'download-canceled'].includes(progressData.command)) {
            setTimeout(() => {
                resetVideosTabButtonStates(lookupUrl);
            }, 2000);
        }

        // Re-render history items incrementally if this was added to history
        if (addToHistory) {
            await renderHistoryItems(false);
        }

        logger.debug(`UI cleanup completed for ${progressData.command}:`, lookupUrl);

    } catch (error) {
        logger.error('Error handling download completion UI:', error);
    }
}

/**
 * Reset button states in videos-tab after completion state display
 * @param {string} lookupUrl - URL to find matching video items
 */
function resetVideosTabButtonStates(lookupUrl) {
    try {
        // Only target videos container (not downloads-tab)
        const videosElements = document.querySelectorAll(
            `.videos-container .video-item[data-url="${lookupUrl}"]`
        );
        
        videosElements.forEach(videoElement => {
            const component = videoElement._component;
            if (component && component.downloadButton) {
                // Reset to default state (same as auto-restore logic)
                component.downloadButton.updateState('default');
                logger.debug('Reset videos-tab button state to default:', lookupUrl);
            }
        });
    } catch (error) {
        logger.error('Error resetting videos-tab button states:', error);
    }
}