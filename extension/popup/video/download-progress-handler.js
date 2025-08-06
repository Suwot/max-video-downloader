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
        // Check if item already exists (from restoration)
        const downloadId = progressData.downloadId;
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        const existingItem = downloadId ? 
            activeDownloadsContainer?.querySelector(`.video-item[data-download-id="${downloadId}"]`) : null;
            
        if (!existingItem) {
            await createVideoItemInDownloads(progressData, 'queued');
            logger.debug('Created new queued download item:', downloadId);
        } else {
            logger.debug('Download item already exists, skipping creation:', downloadId);
        }
    } else if (progressData.command === 'filename-resolved') {
        // Handle filename resolution update
        const downloadId = progressData.downloadId;
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        
        if (downloadId) {
            const existingItem = activeDownloadsContainer?.querySelector(`.video-item[data-download-id="${downloadId}"]`);
            if (existingItem && existingItem._component) {
                existingItem._component.updateResolvedFilename(progressData.resolvedFilename);
                logger.debug('Updated resolved filename for download:', downloadId, progressData.resolvedFilename);
            }
        }
    } else if (progressData.command === 'download-started' && progressData.videoData) {
        // Smart UI updates: update existing items instead of creating duplicates
        const downloadId = progressData.downloadId;
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        
        // Check for existing item by downloadId first
        let existingItem = null;
        if (downloadId) {
            existingItem = activeDownloadsContainer?.querySelector(`.video-item[data-download-id="${downloadId}"]`);
        }
        
        if (existingItem) {
            // Update existing item to starting state with cancel handler
            const component = existingItem._component;
            if (component && component.downloadButton) {
                // Create cancel handler for immediate cancellation
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
                
                component.downloadButton.updateState('starting', {
                    text: 'Starting...',
                    handler: cancelHandler
                });
            }
            logger.debug('Updated existing download item to starting state with cancel handler:', downloadId);
        } else {
            // Only create new item if none exists (shouldn't happen with proper restoration)
            logger.debug('Creating new download item for started download:', downloadId);
            await createVideoItemInDownloads(progressData, 'starting');
        }
    }
    
    // Update ALL matching items in both tabs (videos and downloads)
    // The functions will naturally find and update only existing items
    updateDownloadButton(progressData);
    updateDropdown(progressData);
    
    // Handle completion states for all downloads (original and re-downloads)
    if (progressData.command === 'download-success' || progressData.command === 'download-error' || progressData.command === 'download-canceled') {
        // Use the addedToHistory flag from background instead of making UI decision
        const addedToHistory = progressData.addedToHistory || false;
        
        // Stop elapsed time timer for this download
        if (progressData.downloadId) {
            stopElapsedTimeTimer(progressData.downloadId);
        }
        
        // Call immediately to remove from downloads-tab and prevent deduplication issues
        handleDownloadCompletion(progressData, addedToHistory);
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
                } else if (downloadEntry.status === 'starting') {
                    component.downloadButton.updateState('starting', {
                        text: 'Starting...',
                        handler: cancelHandler
                    });
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
            
        case 'download-started':
            // Set to starting state with cancel functionality
            downloadButtonComponent.updateState('starting', {
                text: 'Starting...',
                handler: cancelHandler
            });
            logger.debug('Component download button set to starting state with cancel handler');
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
        updateSingleDropdown(downloadGroup, progressData);
    });
}

/**
 * Update a single dropdown element with progress state
 * @param {HTMLElement} downloadGroup - The download group element
 * @param {Object} progressData - Progress data
 * @param {number} progress - Progress percentage
 */
function updateSingleDropdown(downloadGroup, progressData = {}) {
	const progress = progressData.progress;
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
                selectedOption.classList.remove('queued'); // Clear any queue state
                selectedOption.classList.add('downloading');
                
                // Handle livestream vs regular download progress
                if (progressData.isLive) {
                    // Livestream: show continuous activity animation and stats
                    selectedOption.classList.add('livestream');
                    selectedOption.style.setProperty('--progress', '100%'); // Full bar with animation
                    
                    // Build livestream display text with recording indicator
                    let displayText = '';
                    if (progressData.elapsedTime) {
                        displayText += `${formatTime(progressData.elapsedTime)}`;
                    }
                    if (progressData.downloadedBytes) {
                        displayText += displayText ? ` • ${formatSize(progressData.downloadedBytes)}` : formatSize(progressData.downloadedBytes);
                    }
                    if (progressData.speed) {
                        displayText += displayText ? ` • ${formatSize(progressData.speed)}/s` : `${formatSize(progressData.speed)}/s`;
                    }
                    
                    const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                    // Just update text content - CSS ::before will handle the indicator
                    textSpan.textContent = displayText;
                    selectedOption.classList.add('has-recording-indicator');
                } else {
                    // Regular download: show percentage progress
                    selectedOption.classList.remove('livestream');
                    selectedOption.style.setProperty('--progress', `${progress}%`);
                    
                    // Build VOD progress display text: progress • size downloaded • eta
                    let displayText = `${progress}%`;
                    
                    // Add segment info for 0% progress
                    if (progress === 0 && progressData.currentSegment && progressData.totalSegments) {
                        displayText += ` (${progressData.currentSegment}/${progressData.totalSegments})`;
                    }
                    
                    // Add downloaded size
                    if (progressData.downloadedBytes) {
                        displayText += ` • ${formatSize(progressData.downloadedBytes)}`;
                    }
                    
                    // Add ETA
                    if (progressData.eta && progressData.eta > 0 && progress < 100) {
                        displayText += ` • ${formatTime(progressData.eta)}`;
                    }

                    const textSpan = selectedOption.querySelector('span:first-child') || selectedOption;
                    textSpan.textContent = displayText;
                }
                
                // Update tooltip data attributes for hover display (skip for livestreams)
                if (!progressData.isLive) {
                    updateProgressTooltip(selectedOption, progressData);
                }
            }

            // Remove queued from dropdown-option when download starts
            if (dropdownOption) {
                dropdownOption.classList.remove('queued');
                if (progressData.isLive) {
                    dropdownOption.classList.add('livestream');
                    dropdownOption.style.setProperty('--progress', '100%');
                } else {
                    dropdownOption.classList.remove('livestream');
                    dropdownOption.style.setProperty('--progress', `${progress}%`);
                }
                dropdownOption.classList.add('downloading');
            }

            logger.debug('Dropdown progress updated:', progress + '%');
            break;
            
        case 'download-success':
        case 'download-error':
        case 'download-canceled':
            // Clean restore - NO final state coloring as requested
            if (selectedOption) {
                selectedOption.classList.remove('downloading', 'queued', 'livestream', 'has-recording-indicator');
                selectedOption.style.removeProperty('--progress');
                
                // Clear tooltip data
                clearProgressTooltip(selectedOption);
                
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
async function createVideoItemInDownloads(downloadRequestOrVideoData, initialState = 'default') {
    try {
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer) {
            logger.error('Active downloads container not found');
            return;
        }

        // Create new video item component in simple mode for downloads tab
        const videoComponent = new VideoItemComponent(downloadRequestOrVideoData, initialState, null, 'simple');
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
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer) {
            return;
        }

        // Clear existing content
        activeDownloadsContainer.innerHTML = `<div class="initial-message">
                                <p>Ongoing downloads will appear here</p>
                            </div>`;

        // Request active downloads from background service worker
        // This will trigger both activeDownloadsData and any pending progress updates
        await sendPortMessage({ command: 'getActiveDownloads' });
        
        // The actual restoration will happen in handleActiveDownloadsData
        // when the background responds with activeDownloadsData message
        
    } catch (error) {
        logger.error('Error requesting active downloads:', error);
    }
}

/**
 * Handle active downloads data from background and restore UI
 */
export function handleActiveDownloadsData(activeDownloads) {
    try {
        const activeDownloadsContainer = document.querySelector('.active-downloads');
        if (!activeDownloadsContainer) {
            return;
        }

        const initialMessage = activeDownloadsContainer.querySelector('.initial-message');

        if (activeDownloads.length === 0) {
            // Show initial message when no active downloads
            if (initialMessage) {
                initialMessage.style.display = 'flex';
            }
            return;
        }

        // Hide initial message and restore downloads
        if (initialMessage) {
            initialMessage.style.display = 'none';
        }
        
        // Recreate video items from unified data (includes both download info and progress)
        activeDownloads.forEach(downloadEntry => {
            if (downloadEntry.videoData) {
                const initialState = downloadEntry.status || 'queued';
                const videoComponent = new VideoItemComponent(downloadEntry, initialState, null, 'simple');
                const videoElement = videoComponent.render();
                activeDownloadsContainer.appendChild(videoElement);
                
                // Apply any existing progress data immediately
                if (downloadEntry.progressData && downloadEntry.progressData.progress !== undefined) {
                    // Update progress immediately if available
                    updateDownloadButton(downloadEntry.progressData);
                    updateDropdown(downloadEntry.progressData);
                }
                
                // Clear any stale timers for this downloadId (in case of popup reopen)
                if (downloadEntry.downloadId) {
                    stopElapsedTimeTimer(downloadEntry.downloadId);
                }
            } else {
                logger.warn('Download entry missing videoData, skipping:', downloadEntry.downloadUrl);
            }
        });

        logger.debug(`Restored ${activeDownloads.length} active downloads from in-memory Map`);
        
        // Restore button states for ongoing downloads in videos tab
        restoreDownloadStates(activeDownloads);

    } catch (error) {
        logger.error('Error handling active downloads data:', error);
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
/**
 *
 Update progress tooltip data attributes on selected-option element
 * @param {HTMLElement} selectedOption - The selected-option element
 * @param {Object} progressData - Progress data from native host
 */
function updateProgressTooltip(selectedOption, progressData) {
    // No tooltips for live downloads - only for VOD
    if (progressData.isLive) {
        return; // Skip tooltip for livestreams
    }
    
    // Build compact tooltip content for VOD downloads only
    const parts = [];
    // VOD tooltip: segments • speed • elapsed time
    
    // Add segment info
    if (progressData.progress !== 0 && progressData.currentSegment && progressData.totalSegments) {
        parts.push(`${progressData.currentSegment}/${progressData.totalSegments} chunks`);
    }
    
    // Add speed
    if (progressData.speed) {
        parts.push(`${formatSize(progressData.speed)}/s`);
    }
    
    // Elapsed time - use UI calculation if we have startTime, otherwise fallback to progressData
    let elapsedSeconds;
    if (progressData.downloadStartTime) {
        elapsedSeconds = Math.round((Date.now() - progressData.downloadStartTime) / 1000);
        // Start timer for continuous updates
        if (progressData.downloadId) {
            const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
            startElapsedTimeTimer(progressData.downloadId, progressData.downloadStartTime, lookupUrl);
        }
    } else {
        elapsedSeconds = progressData.elapsedTime || 0;
    }
    
    if (elapsedSeconds > 0) {
        parts.push(formatTime(elapsedSeconds));
    }
    
    // Set single tooltip content attribute
    selectedOption.setAttribute('data-tooltip-content', parts.join(' • '));
    
    // Keep quality for potential future use (but don't display)
    selectedOption.setAttribute('data-tooltip-quality', 
        progressData.selectedOptionOrigText || 'Unknown');
    
    // Add tooltip class for CSS styling
    selectedOption.classList.add('has-progress-tooltip');
}

/**
 * Clear progress tooltip data from selected-option element
 * @param {HTMLElement} selectedOption - The selected-option element
 */
function clearProgressTooltip(selectedOption) {
    selectedOption.removeAttribute('data-tooltip-content');
    selectedOption.removeAttribute('data-tooltip-quality');
    selectedOption.classList.remove('has-progress-tooltip');
}

// Map to track elapsed time timers: downloadId -> {timer, startTime}
const elapsedTimeTimers = new Map();

/**
 * Start elapsed time timer for a download
 * @param {string} downloadId - Download ID
 * @param {number} downloadStartTime - Download start timestamp
 * @param {string} lookupUrl - Lookup URL for videos-tab mapping (masterUrl || downloadUrl)
 */
function startElapsedTimeTimer(downloadId, downloadStartTime, lookupUrl) {
    // Clear existing timer if any
    stopElapsedTimeTimer(downloadId);
    
    // Start new timer that updates every second
    const timer = setInterval(() => {
        updateElapsedTimeForDownload(downloadId, downloadStartTime, lookupUrl);
    }, 1000);
    
    elapsedTimeTimers.set(downloadId, { timer, downloadStartTime, lookupUrl });
}

/**
 * Stop elapsed time timer for a download
 * @param {string} downloadId - Download ID
 */
function stopElapsedTimeTimer(downloadId) {
    const timerData = elapsedTimeTimers.get(downloadId);
    if (timerData) {
        clearInterval(timerData.timer);
        elapsedTimeTimers.delete(downloadId);
    }
}

/**
 * Update elapsed time display for a specific download
 * @param {string} downloadId - Download ID
 * @param {number} downloadStartTime - Download start timestamp
 * @param {string} lookupUrl - Lookup URL for videos-tab mapping
 */
function updateElapsedTimeForDownload(downloadId, downloadStartTime, lookupUrl) {
    const elapsedSeconds = Math.round((Date.now() - downloadStartTime) / 1000);
    
    // Find elements in downloads-tab (which has data-download-id)
    const downloadsTabElements = document.querySelectorAll(`[data-download-id="${downloadId}"] .selected-option.has-progress-tooltip`);
    downloadsTabElements.forEach(selectedOption => {
        updateTooltipElapsedTime(selectedOption, elapsedSeconds);
    });
    
    // Find elements in videos-tab (which uses data-url for lookup)
    if (lookupUrl) {
        const videosTabElements = document.querySelectorAll(`[data-url="${lookupUrl}"] .selected-option.has-progress-tooltip`);
        videosTabElements.forEach(selectedOption => {
            updateTooltipElapsedTime(selectedOption, elapsedSeconds);
        });
    }
}

/**
 * Update just the elapsed time part of an existing tooltip
 * @param {HTMLElement} selectedOption - The selected-option element
 * @param {number} elapsedSeconds - Elapsed time in seconds
 */
function updateTooltipElapsedTime(selectedOption, elapsedSeconds) {
    const currentContent = selectedOption.getAttribute('data-tooltip-content') || '';
    const parts = currentContent.split(' • ');
    
    // Replace or add elapsed time (always last part)
    const elapsedTimeText = formatTime(elapsedSeconds);
    if (parts.length > 0 && (parts[parts.length - 1].includes(' s') || parts[parts.length - 1].includes(' m') || parts[parts.length - 1].includes(' h') || parts[parts.length - 1].includes(' d'))) {
        // Replace existing elapsed time
        parts[parts.length - 1] = elapsedTimeText;
    } else {
        // Add elapsed time
        parts.push(elapsedTimeText);
    }
    
    selectedOption.setAttribute('data-tooltip-content', parts.join(' • '));
}

/**
 * Clean up all elapsed time timers (called on popup close)
 */
export function cleanupAllElapsedTimeTimers() {
    elapsedTimeTimers.forEach((timerData, downloadId) => {
        clearInterval(timerData.timer);
    });
    elapsedTimeTimers.clear();
}