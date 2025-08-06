import { sendPortMessage } from '../communication.js';
import { createLogger } from '../../shared/utils/logger.js';
import { formatSize, formatDuration, formatBitrate } from '../../shared/utils/processing-utils.js';
import { VideoItemComponent } from './video-item.js';

const logger = createLogger('Video Renderer');

/**
 * Render videos using static group structure
 * @param {Array} videos - Videos array to render
 */
export async function renderVideos(videos = []) {
    const container = document.getElementById('videos-list');
    
    if (!videos || videos.length === 0) {
        // Hide all groups and show initial message
        container.querySelectorAll('.video-type-group').forEach(group => {
            group.style.display = 'none';
            // Clear count when hiding groups
            const sectionCount = group.querySelector('.counter');
            if (sectionCount) {
                sectionCount.textContent = '';
            }
            // Clear video items from DOM
            const content = group.querySelector('.section-content');
            if (content) {
                content.innerHTML = '';
            }
        });
        container.querySelector('.initial-message').style.display = 'flex';
        return;
    }
    
    // Group videos by type
    const videoGroups = groupVideosByType(videos);
    
    // Hide initial message
    container.querySelector('.initial-message').style.display = 'none';
    
    // Show and populate groups that have videos
    for (const [type, typeVideos] of Object.entries(videoGroups)) {
        const group = container.querySelector(`[data-video-type="${type}"]`);
        if (!group) continue;
        
        if (typeVideos.length > 0) {
            // Show group
            group.style.display = 'block';
            
            // Update section count - simple textContent update
            const sectionCount = group.querySelector('.counter');
            if (sectionCount) {
                sectionCount.textContent = typeVideos.length;
            }
            
            // Populate content
            const content = group.querySelector('.section-content');
            content.innerHTML = ''; // Clear previous items
            
            typeVideos.forEach(video => {
                const videoComponent = new VideoItemComponent(video, 'default');
                const videoElement = videoComponent.render();
                content.appendChild(videoElement);
            });
        } else {
            // Hide group if no videos and clear count
            group.style.display = 'none';
            const sectionCount = group.querySelector('.counter');
            if (sectionCount) {
                sectionCount.textContent = '';
            }
        }
    }
}

/**
 * Render downloads history from storage
 * @param {boolean} [fullRender=true] - If true, clears container and renders all items. If false, only prepends latest item.
 */
export async function renderHistoryItems(fullRender = true) {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        const history = result.downloads_history || [];
        const historyContainer = document.querySelector('.downloads-history');
        const initialMessage = historyContainer.querySelector('.initial-message');

        if (fullRender) {
            // Clear container completely and rebuild from scratch
            historyContainer.innerHTML = '<div class="initial-message"><p>You don\'t have any downloads in history</p></div>';
            
            if (history.length > 0) {
                // Hide initial message and render all history items
                const newInitialMessage = historyContainer.querySelector('.initial-message');
                newInitialMessage.style.display = 'none';
                
                history.forEach(historyEntry => {
                    const historyItem = createHistoryItemElement(historyEntry);
                    historyContainer.appendChild(historyItem);
                });
                
                logger.debug(`Full render: ${history.length} history items`);
            } else {
                // Show initial message when no history
                const newInitialMessage = historyContainer.querySelector('.initial-message');
                newInitialMessage.style.display = 'flex';
            }
            
            // Update section count (following same pattern as renderVideos)
            const sectionCount = document.querySelector('.downloads-history-section .counter');
            if (sectionCount) {
                sectionCount.textContent = history.length > 0 ? history.length : '';
            }
        } else {
            // Incremental render: prepend only the latest (first) item
            if (history.length > 0) {
                const latestEntry = history[0];
                const historyItem = createHistoryItemElement(latestEntry);
                
                // Hide initial message if visible and prepend new item
                if (initialMessage) {
                    initialMessage.style.display = 'none';
                }
                
                // Prepend new item
                historyContainer.prepend(historyItem);
                
                // Smart DOM management: keep DOM in sync with storage
                const currentHistoryItems = historyContainer.querySelectorAll('.history-item');
                
                // If DOM has more items than storage, remove excess from bottom
                if (currentHistoryItems.length > history.length) {
                    const excessCount = currentHistoryItems.length - history.length;
                    for (let i = 0; i < excessCount; i++) {
                        const lastItem = currentHistoryItems[currentHistoryItems.length - 1 - i];
                        if (lastItem) {
                            lastItem.remove();
                        }
                    }
                    logger.debug(`Incremental render: removed ${excessCount} excess items from DOM`);
                }
                
                logger.debug('Incremental render: prepended latest item');
            }
            
            // Update section count for incremental render
            const sectionCount = document.querySelector('.downloads-history-section .counter');
            if (sectionCount) {
                sectionCount.textContent = history.length > 0 ? history.length : '';
            }
        }
    } catch (error) {
        logger.error('Error rendering history items:', error);
    }
}

/**
 * Create history item element from final download data
 * @param {Object} progressData - Final download data from download-success/error
 * @returns {HTMLElement} History item element
 */
function createHistoryItemElement(progressData) {
    const historyItem = document.createElement('div');
    // create status variable to determine class
    const status = progressData.command === 'download-success' ? (progressData.isPartial ? 'partial' : 'success') : 'error';
    historyItem.className = `history-item history-${status}`;
    historyItem.setAttribute('data-completion', progressData.completedAt);

    // Format completion time
    const completedTime = progressData.completedAt ? 
        new Date(progressData.completedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }) : 'Unknown';

    // Extract host from pageUrl for display
    let pageHost = 'Unknown';
    let pageUrl = progressData.originalCommand?.videoData?.pageUrl;
    let pageTitle = progressData.originalCommand?.videoData?.pageTitle || pageUrl || '';
    let pageFavicon = progressData.originalCommand?.videoData?.pageFavicon;
    if (pageUrl) {
        try {
            const url = new URL(pageUrl);
            pageHost = url.hostname;
        } catch (e) {
            pageHost = progressData.pageUrl.substring(0, 20) + '...';
        }
    }

    // Build filename (fallback to downloadUrl if empty)
    const displayFilename = progressData.filename || 
        (progressData.downloadUrl ? progressData.downloadUrl.split('/').pop() : 'Unknown');

    // Build stats (only show available data)
    const statsHtml = buildStatsHtml(progressData);

    // Build error message for failed downloads
    const errorMessageHtml = progressData.command === 'download-error' && progressData.errorMessage 
        ? `<div class="error-message truncated" title="Click to expand">${progressData.errorMessage}</div>` 
        : '';

    // Build flags icons HTML
    const flagsHtml = buildFlagsHtml(progressData);

    historyItem.innerHTML = `
        <div class="history-header">
            <div class="completion-time">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-days w-3 h-3 flex-shrink-0" aria-hidden="true"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>
                ${completedTime}
            </div>
            ${flagsHtml ? `<div class="history-flags">${flagsHtml}</div>` : ''}
            <div class="page-info">
                ${pageFavicon ? `<img class="favicon" src="${pageFavicon}" alt="favicon">` : ''}
                <a class="page-url" target="_blank" href="${pageUrl}" title="${pageTitle}">${pageHost}</a>
            </div>
            <button class="history-delete-btn" title="Remove from history">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="var(--text-secondary-dark)" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9.70396 1.70624C10.0946 1.31562 10.0946 0.681244 9.70396 0.290619C9.31333 -0.100006 8.67896 -0.100006 8.28833 0.290619L4.9977 3.58437L1.70396 0.293744C1.31333 -0.0968812 0.678955 -0.0968812 0.28833 0.293744C-0.102295 0.684369 -0.102295 1.31874 0.28833 1.70937L3.58208 4.99999L0.291455 8.29374C-0.0991699 8.68437 -0.0991699 9.31874 0.291455 9.70937C0.68208 10.1 1.31646 10.1 1.70708 9.70937L4.9977 6.41562L8.29146 9.70624C8.68208 10.0969 9.31646 10.0969 9.70708 9.70624C10.0977 9.31562 10.0977 8.68124 9.70708 8.29062L6.41333 4.99999L9.70396 1.70624Z"/>
                </svg>
            </button>
        </div>
        <div class="filename">${displayFilename}</div>
        ${errorMessageHtml}
        <div class="history-footer">
            ${statsHtml ? `<div class="download-stats">${statsHtml}</div>` : ''}
            <div class="history-actions">
                <button class="history-retry-btn" data-tooltip="Retry download">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-rotate-ccw w-3 h-3" aria-hidden="true">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                            <path d="M3 3v5h5"></path>
                        </svg>
                </button>
                ${progressData.command === 'download-success' && progressData.path && !progressData.deleted ? `
                    <button class="history-delete-file-btn" data-tooltip="Delete file" data-file-path="${progressData.path}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-red)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2 w-3 h-3" aria-hidden="true">
                            <path d="M3 6h18"></path>
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                            <line x1="10" x2="10" y1="11" y2="17"></line>
                            <line x1="14" x2="14" y1="11" y2="17"></line>
                        </svg>
                    </button>
                ` : ''}
                ${progressData.command === 'download-success' && progressData.path ? `
                    <button class="history-folder-btn" data-tooltip="Show in folder" data-file-path="${progressData.path}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open w-3 h-3" aria-hidden="true">
                            <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                    ${!progressData.deleted ? `<button class="history-play-btn" data-tooltip="Open file" data-file-path="${progressData.path}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play w-3 h-3" aria-hidden="true">
                            <polygon points="6 3 20 12 6 21 6 3"></polygon>
                        </svg>
                    </button>` : ''}
                ` : ''}
             </div>
        </div>
    `;
// Build flags icons HTML for history item
function buildFlagsHtml(progressData) {
    const icons = [];
    if (progressData.isPartial) {
        icons.push(`
            <span class="history-flag-icon" data-tooltip="Partial Download">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-x2 lucide-file-x-2 w-3 h-3 flex-shrink-0 text-orange-500" aria-hidden="true"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="m8 12.5-5 5"></path><path d="m3 12.5 5 5"></path></svg>
            </span>
        `);
    }
    if (progressData.audioOnly) {
        icons.push(`
            <span class="history-flag-icon" data-tooltip="Extracted Audio">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-headphones w-3 h-3 flex-shrink-0 text-purple-500" aria-hidden="true"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"></path></svg>
            </span>
        `);
    }
    if (progressData.subsOnly) {
        icons.push(`
            <span class="history-flag-icon" data-tooltip="Extracted Subtitles">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-captions w-3 h-3 flex-shrink-0 text-cyan-500" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="3" ry="3"></rect><path d="M6 16h5M14 16h2M6 12h2M11 12h4"></path></svg>
            </span>
        `);
    }
    if (progressData.isRedownload) {
        icons.push(`
            <span class="history-flag-icon" data-tooltip="Redownloaded">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-rotate-ccw w-3 h-3 flex-shrink-0 text-blue-500" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
            </span>
        `);
    }
    if (progressData.isLive) {
        icons.push(`
            <span class="history-flag-text live-flag">LIVE REC</span>
        `);
    }
    if (progressData.deleted) {
        icons.push(`
            <span class="history-flag-text deleted-flag">DELETED</span>
        `);
    }
    return icons.join('');
}

    // Add delete functionality
    const deleteBtn = historyItem.querySelector('.history-delete-btn');
    deleteBtn.addEventListener('click', () => deleteHistoryItem(progressData.completedAt));

    // Add click-to-expand functionality for error messages
    const errorMessage = historyItem.querySelector('.error-message');
    if (errorMessage) {
        errorMessage.addEventListener('click', () => {
            errorMessage.classList.toggle('truncated');
            errorMessage.title = errorMessage.classList.contains('truncated') ? 'Click to expand' : 'Click to collapse';
        });
    }

    // Add file system operation handlers (only for successful downloads)
    if (progressData.command === 'download-success' && progressData.path) {
        const playBtn = historyItem.querySelector('.history-play-btn');
        const folderBtn = historyItem.querySelector('.history-folder-btn');
        const deleteFileBtn = historyItem.querySelector('.history-delete-file-btn');
        
        if (playBtn) {
            playBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filePath = playBtn.getAttribute('data-file-path');
                const completedAt = parseInt(historyItem.getAttribute('data-completion'), 10);
                logger.debug('Opening file:', filePath);
                
                sendPortMessage({
                    command: 'fileSystem',
                    operation: 'openFile',
                    params: { filePath },
                    completedAt: completedAt
                });
            });
        }
        
        if (folderBtn) {
            folderBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filePath = folderBtn.getAttribute('data-file-path');
                const isDeleted = historyItem.querySelector('.deleted-flag') !== null;
                const completedAt = parseInt(historyItem.getAttribute('data-completion'), 10);
                
                logger.debug('Showing file in folder:', filePath, 'deleted:', isDeleted);
                
                sendPortMessage({
                    command: 'fileSystem',
                    operation: 'showInFolder',
                    params: { filePath, openFolderOnly: isDeleted },
                    completedAt: completedAt
                });
            });
        }
        
        if (deleteFileBtn) {
            deleteFileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filePath = deleteFileBtn.getAttribute('data-file-path');
                const completedAt = parseInt(historyItem.getAttribute('data-completion'), 10);
                logger.debug('Deleting file:', filePath, completedAt);
                
                sendPortMessage({
                    command: 'fileSystem',
                    operation: 'deleteFile',
                    params: { filePath },
                    completedAt: completedAt
                });
            });
        }
    }

    // Add retry handler for failed downloads
    if (progressData.originalCommand) {
        const retryBtn = historyItem.querySelector('.history-retry-btn');
        
        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                logger.debug('Retrying download with original command:', progressData.originalCommand);
                
                // Send original command with isRedownload flag (videoData already included from native host)
                const retryCommand = {
                    ...progressData.originalCommand,
                    selectedOptionOrigText: progressData.selectedOptionOrigText,
                    isRedownload: true
                    // videoData is already in originalCommand from native host (robust approach)
                };
                
                sendPortMessage(retryCommand);
            });
        }
    }

    return historyItem;
}

/**
 * Build stats HTML for history item (only show available data)
 * @param {Object} progressData - Final download data
 * @returns {string} Stats HTML or empty string
 */
function buildStatsHtml(progressData) {
    const stats = [];
    
    // Type badge from progressData.type (bubble style)
    if (progressData.type) {
        stats.push(`
            <span class="type-badge">
                ${progressData.type.toUpperCase()}
            </span>
        `);
    }
    
    // Quality or bitrate (white circle)
    if (progressData.audioOnly && progressData.downloadStats?.bitrateKbps) {
        const bitrate = formatBitrate(progressData.downloadStats.bitrateKbps);
        stats.push(`
            <span class="quality">
                <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                    <circle cx="3" cy="3" r="3" fill="var(--text-primary-dark)"/>
                </svg>
                ${bitrate}
            </span>
        `);
    } else if (progressData.subsOnly) {
        stats.push(`
            <span class="quality">
                <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                    <circle cx="3" cy="3" r="3" fill="var(--text-primary-dark)"/>
                </svg>
                Subs
            </span>
        `);
    } else if (progressData.selectedOptionOrigText) {
        const advancedDropdown = progressData.selectedOptionOrigText.includes('≈')
        const qualityText = advancedDropdown ? 
            progressData.selectedOptionOrigText.split('≈')[0]?.trim() : 
            progressData.selectedOptionOrigText.split('•')[0]?.trim();

        if (qualityText) {
            let displayQuality = qualityText;
            let tooltipAttr = '';
            
            // If contains ≈, extract quality and tooltip info (DASH-style)
            if (advancedDropdown) {
                const parenMatch = qualityText.match(/^([^(]+)\s*(\(.+\))?$/);
                if (parenMatch) {
                    displayQuality = parenMatch[1].trim();
                    if (parenMatch[2]) {
                        tooltipAttr = ` data-tooltip="${parenMatch[2].slice(1, -1)}"`;
                    }
                }
            }

            stats.push(`
                <span class="quality"${tooltipAttr}>
                    <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                        <circle cx="3" cy="3" r="3" fill="var(--text-primary-dark)"/>
                    </svg>
                    ${displayQuality}
                </span>
            `);
        }
    }

    // File size from downloadStats (green circle)
    if (progressData.downloadStats?.totalSize) {
        const totalSize = formatSize(progressData.downloadStats.totalSize);
        const hasDetailedSizes = progressData.downloadStats.videoSize && progressData.downloadStats.audioSize;
        
        if (hasDetailedSizes) {
            const videoSize = formatSize(progressData.downloadStats.videoSize);
            const audioSize = formatSize(progressData.downloadStats.audioSize);
            stats.push(`
                <span class="filesize" data-tooltip="Video: ${videoSize}, Audio: ${audioSize}">
                    <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                        <circle cx="3" cy="3" r="3" fill="var(--color-green)"/>
                    </svg>
                    ${totalSize}
                </span>
            `);
        } else {
            stats.push(`
                <span class="filesize">
                    <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                        <circle cx="3" cy="3" r="3" fill="var(--color-green)"/>
                    </svg>
                    ${totalSize}
                </span>
            `);
        }
    }
    
    // Duration (orange circle)
    if (progressData.duration) {
        const duration = formatDuration(progressData.duration);
        stats.push(`
            <span class="duration">
                <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                    <circle cx="3" cy="3" r="3" fill="var(--color-orange)"/>
                </svg>
                ${duration}
            </span>
        `);
    }
    
    return stats.join('');
}



/**
 * Delete a specific history item from storage and UI
 * @param {string} lookupUrl - URL to identify the history item to delete
 */
async function deleteHistoryItem(completedAt) {
    try {
        // Remove from storage
        const result = await chrome.storage.local.get(['downloads_history']);
        const history = result.downloads_history || [];
        
        const updatedHistory = history.filter(entry => {
            const entryCompletedAt = entry.completedAt;
            return entryCompletedAt !== completedAt;
        });
        
        await chrome.storage.local.set({ downloads_history: updatedHistory });
        
        // Remove from UI and manage initial message visibility
        const historyContainer = document.querySelector('.downloads-history');
        const historyItem = historyContainer.querySelector(`[data-completion="${completedAt}"]`);
        if (historyItem) {
            historyItem.remove();
        }
        
        // Show initial message if no more history items remain
        const remainingHistoryItems = historyContainer.querySelectorAll('.history-item');
        const initialMessage = historyContainer.querySelector('.initial-message');
        if (remainingHistoryItems.length === 0 && initialMessage) {
            initialMessage.style.display = 'flex';
        }
        
        // Update section count after deletion (following same pattern as renderVideos)
        const sectionCount = document.querySelector('.downloads-history-section .counter');
        if (sectionCount) {
            sectionCount.textContent = updatedHistory.length > 0 ? updatedHistory.length : '';
        }
        
        logger.debug('Deleted history item:', completedAt);
        
    } catch (error) {
        logger.error('Error deleting history item:', error);
    }
}

/**
 * Group videos by type for display
 * @param {Array} videos - The videos to group
 * @returns {Object} Grouped videos by type
 */
export function groupVideosByType(videos) {
    // Initialize video groups
    const groups = {
        hls: [],
        dash: [],
        direct: [],
        unknown: []
    };

    // Group videos by type
    videos.forEach(video => {
        if (!video || !video.url) return;
        
        const type = video.type || 'unknown';
        
        // Add to appropriate group
        if (type === 'hls') {
            groups.hls.push(video);
        } else if (type === 'dash') {
            groups.dash.push(video);
        } else if (type === 'direct') {
            groups.direct.push(video);
        } else {
            groups.unknown.push(video);
        }
    });
    
    return groups;
}

/**
 * Add a new video to the UI (prepend to appropriate group)
 * @param {Object} video - Video object to add
 */
export async function addVideoToUI(video) {
    try {
        const container = document.getElementById('videos-list');
        const group = container.querySelector(`[data-video-type="${video.type}"]`);
        
        if (!group) {
            logger.warn(`[ADD] No group found for video type: ${video.type}`);
            return;
        }
        
        // Hide initial message if it's shown
        const initialMessage = container.querySelector('.initial-message');
        if (initialMessage) {
            initialMessage.style.display = 'none';
        }
        
        // Show the group
        group.style.display = 'block';
        
        // Get the videos container within the group
        const groupBody = group.querySelector('.section-content');
        if (!groupBody) {
            logger.warn(`[ADD] No section content found for video type: ${video.type}`);
            return;
        }
        
        // Create video element
        const videoComponent = new VideoItemComponent(video, 'default');
        const videoElement = videoComponent.render();
        
        // Prepend to the group (newest first)
        groupBody.insertBefore(videoElement, groupBody.firstChild);
        
        logger.debug(`[ADD] Added video to UI: ${video.normalizedUrl}`);
        
    } catch (error) {
        logger.error('[ADD] Error adding video to UI:', error);
    }
}

/**
 * Update video flags without full re-render
 * @param {string} videoUrl - Video URL to update
 * @param {Object} video - Updated video object with flags
 */
export function updateVideoFlags(videoUrl, video) {
    logger.debug(`[FLAG] Updating flags for video/-s`, videoUrl, video);
    try {
        const container = document.getElementById('videos-list');
        const existingElement = container.querySelector(`.video-item[data-url="${videoUrl}"]`);
        
        if (!existingElement) {
            logger.debug(`[FLAG] Video element not found for flag update: ${videoUrl}`);
            return false;
        }
        
        const previewContainer = existingElement.querySelector('.preview-container');
        const previewImage = existingElement.querySelector('.preview-image');
        
        // Handle preview generation flag
        if ('generatingPreview' in video) {
            if (video.generatingPreview) {
                if (previewContainer) previewContainer.classList.add('loading');
                if (previewImage) previewImage.classList.add('generating');
            } else {
                if (previewContainer) previewContainer.classList.remove('loading');
                if (previewImage) previewImage.classList.remove('generating');
            }
        }
        
        // Handle preview URL update
        if (video.previewUrl && previewImage) {
            if (previewContainer) previewContainer.classList.add('has-preview');
            previewImage.onload = () => {
                previewImage.classList.remove('placeholder');
                previewImage.classList.add('loaded');
                if (previewContainer) previewContainer.classList.remove('loading');
            };
            previewImage.src = video.previewUrl;
        }
        
        // Handle processing flag (could add visual indicators later)
        if ('processing' in video) {
            // For now, just log - can add visual indicators later
            logger.debug(`[FLAG] Processing flag updated for ${videoUrl}:`, {
                processing: video.processing
            });
        }
        
        logger.debug(`[FLAG] Updated flags for video: ${videoUrl}`);
        return true;
        
    } catch (error) {
        logger.error('[FLAG] Error updating video flags:', error);
        return false;
    }
}

/**
 * Update an existing video in the UI
 * @param {string} videoUrl - Video URL to update
 * @param {Object} video - Updated video object
 * @param {string} [updateType='structural'] - Type of update: 'flags' or 'structural'
 */
export async function updateVideoInUI(videoUrl, video, updateType = 'structural') {
	logger.debug(`[UPD] received updateType: ${updateType} for url: ${videoUrl}, video:`, video);
    try {
        // For flag-only updates, use selective update
        if (updateType === 'flag') {
            const success = updateVideoFlags(videoUrl, video);
            if (success) {
                logger.debug(`[UPD] Updated flags for video: ${videoUrl}`);
                return;
            }
            // Fall back to full update if flag update failed
            logger.debug(`[UPD] Flag update failed, falling back to full update: ${videoUrl}`);
        }
        
        // Full structural update
        const container = document.getElementById('videos-list');
        const existingElement = container.querySelector(`.video-item[data-url="${videoUrl}"]`);
        
        if (!existingElement) {
            logger.debug(`[UPD] Video element not found for update: ${videoUrl}, skipping update.`);
            return;
        }
        
        // Create new element
        const videoComponent = new VideoItemComponent(video, 'default');
        const newElement = videoComponent.render();
        
        // Replace the existing element
        existingElement.parentNode.replaceChild(newElement, existingElement);
        
        logger.debug(`[UPD] Updated video in UI: ${videoUrl} (${updateType})`);
        
    } catch (error) {
        logger.error('[UPD] Error updating video in UI:', error);
    }
}

/**
 * Remove a video from the UI
 * @param {string} videoUrl - Video URL to remove
 */
export async function removeVideoFromUI(videoUrl) {
    try {
        const container = document.getElementById('videos-list');
        const existingElement = container.querySelector(`.video-item[data-url="${videoUrl}"]`);
        
        if (!existingElement) {
            logger.debug(`[RM] Video element not found for removal: ${videoUrl}`);
            return;
        }
        
        const group = existingElement.closest('.video-type-group');
        existingElement.remove();
        
        // Check if group is now empty
        if (group) {
            const groupBody = group.querySelector('.section-content');
            if (groupBody && groupBody.children.length === 0) {
                group.style.display = 'none';
            }
        }
        
        // Check if all groups are empty and show initial message
        const allGroups = container.querySelectorAll('.video-type-group');
        const hasVisibleGroups = Array.from(allGroups).some(g => g.style.display !== 'none');
        
        if (!hasVisibleGroups) {
            const initialMessage = container.querySelector('.initial-message');
            if (initialMessage) {
                initialMessage.style.display = 'flex';
            }
        }
        
        logger.debug(`[RM] Removed video from UI: ${videoUrl}`);
        
    } catch (error) {
        logger.error('[RM] Error removing video from UI:', error);
    }
}

/**
 * Update specific history item to show deleted state
 * @param {string} completedAt - Completion timestamp to identify the history item
 */
export function updateHistoryItemDeleted(completedAt) {
    const historyContainer = document.querySelector('.downloads-history');
    const historyItem = historyContainer.querySelector(`.history-item[data-completion="${completedAt}"]`);
    
    if (!historyItem) {
        logger.debug('History item not found for deleted file update:', completedAt);
        return;
    }
    
    // Add deleted flag to history-flags section
    const historyFlags = historyItem.querySelector('.history-flags');
    if (historyFlags) {
        // Check if deleted flag already exists
        if (!historyFlags.querySelector('.deleted-flag')) {
            const deletedFlag = document.createElement('span');
            deletedFlag.className = 'history-flag-text deleted-flag';
            deletedFlag.textContent = 'DELETED';
            historyFlags.appendChild(deletedFlag);
        }
    } else {
        // Create history-flags section if it doesn't exist
        const historyHeader = historyItem.querySelector('.history-header');
        const pageInfo = historyHeader.querySelector('.page-info');
        
        const historyFlagsDiv = document.createElement('div');
        historyFlagsDiv.className = 'history-flags';
        
        const deletedFlag = document.createElement('span');
        deletedFlag.className = 'history-flag-text deleted-flag';
        deletedFlag.textContent = 'DELETED';
        historyFlagsDiv.appendChild(deletedFlag);
        
        // Insert before page-info
        historyHeader.insertBefore(historyFlagsDiv, pageInfo);
    }
    
    // Remove delete button
    const deleteFileBtn = historyItem.querySelector('.history-delete-file-btn');
    if (deleteFileBtn) {
        deleteFileBtn.remove();
    }

    // Remove open file button
    const playBtn = historyItem.querySelector('.history-play-btn');
    if (playBtn) {
        playBtn.remove();
    }

    logger.debug('Updated history item with deleted flag:', completedAt);
}