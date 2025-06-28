import { groupVideosByType, createTypeGroup } from './video-groups.js';
import { getVideos, getTabId } from '../state.js';
import { sendPortMessage } from '../communication.js';
import { createLogger } from '../../shared/utils/logger.js';
import { formatSize, formatDuration } from '../../shared/utils/video-utils.js';

const logger = createLogger('Video Renderer');

/**
 * Render current videos from state
 */
export async function renderVideos() {
    const videos = getVideos();
    const container = document.getElementById('videos-list');
    
    if (!videos || videos.length === 0) {
        container.innerHTML = `<div class="initial-message">
            <p>No videos found on the page.</p>
            <p>Play a video or Refresh the page.</p>
        </div>`;
        return;
    }
    
    // Group videos by type
    const videoGroups = groupVideosByType(videos);
    
    // Create document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Create type groups (now async)
    for (const [type, typeVideos] of Object.entries(videoGroups)) {
        if (typeVideos.length === 0) continue;
        
        const group = await createTypeGroup(type, typeVideos);
        fragment.appendChild(group);
    }
    
    container.innerHTML = `<div class="initial-message">
            <p>No videos found on the page.</p>
            <p>Play a video or Refresh the page.</p>
        </div>`;
    container.prepend(fragment);

    // Request cache stats and download progress restoration
    sendPortMessage({ command: 'getPreviewCacheStats' });    
    sendPortMessage({ command: 'getDownloadProgress' }); // Restore download progress during rerender

    // Add CSS for the extracted badge and timestamp if it doesn't exist
    if (!document.getElementById('custom-badges-style')) {
        const style = document.createElement('style');
        style.id = 'custom-badges-style';
        style.textContent = `
            .badge.extracted {
                display: inline-block;
                background-color: #2196F3;
                color: white;
                font-size: var(--font-body);
                padding: 2px 6px;
                border-radius: 10px;
                margin-left: 8px;
                vertical-align: middle;
                font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }
}

/**
 * Render downloads history from storage
 */
export async function renderHistoryItems() {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        const history = result.downloads_history || [];

        if (history.length > 0) {
            const historyContainer = document.querySelector('.downloads-history');
            // Create history items from progressData and insert before initial message
            const initialMessage = historyContainer.querySelector('.initial-message');
            history.forEach(historyEntry => {
                const historyItem = createHistoryItemElement(historyEntry);
                if (initialMessage) {
                    historyContainer.insertBefore(historyItem, initialMessage);
                } else {
                    historyContainer.appendChild(historyItem);
                }
            });

            logger.debug(`Rendered ${history.length} history items`);
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
    historyItem.className = `history-item history-${progressData.command === 'download-success' ? 'success' : 'error'}`;
    historyItem.setAttribute('data-completion', progressData.completedAt);

    // Format completion time
    const completedTime = progressData.completedAt ? 
        new Date(progressData.completedAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }) : 'Unknown';

    // Extract host from pageUrl for display
    let pageHost = 'Unknown';
    let pageTitle = progressData.pageUrl || '';
    if (progressData.pageUrl) {
        try {
            const url = new URL(progressData.pageUrl);
            pageHost = url.hostname;
            pageTitle = progressData.pageUrl;
        } catch (e) {
            pageHost = progressData.pageUrl.substring(0, 20) + '...';
        }
    }

    // Build filename (fallback to downloadUrl if empty)
    const displayFilename = progressData.filename || 
        (progressData.downloadUrl ? progressData.downloadUrl.split('/').pop() : 'Unknown');

    // Build stats (only show available data)
    const statsHtml = buildStatsHtml(progressData);

    historyItem.innerHTML = `
        <div class="history-header">
            <div class="completion-time">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-days w-3 h-3 flex-shrink-0" aria-hidden="true"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path><path d="M16 18h.01"></path></svg>
                ${completedTime}
            </div>
            <div class="page-info">
                ${progressData.pageFavicon ? `<img class="favicon" src="${progressData.pageFavicon}" alt="">` : ''}
                <a class="page-url" target="_blank" href="${pageTitle}" title="${pageTitle}">${pageHost}</a>
            </div>
            <button class="history-delete-btn" title="Remove from history">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="var(--text-secondary-dark)" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9.70396 1.70624C10.0946 1.31562 10.0946 0.681244 9.70396 0.290619C9.31333 -0.100006 8.67896 -0.100006 8.28833 0.290619L4.9977 3.58437L1.70396 0.293744C1.31333 -0.0968812 0.678955 -0.0968812 0.28833 0.293744C-0.102295 0.684369 -0.102295 1.31874 0.28833 1.70937L3.58208 4.99999L0.291455 8.29374C-0.0991699 8.68437 -0.0991699 9.31874 0.291455 9.70937C0.68208 10.1 1.31646 10.1 1.70708 9.70937L4.9977 6.41562L8.29146 9.70624C8.68208 10.0969 9.31646 10.0969 9.70708 9.70624C10.0977 9.31562 10.0977 8.68124 9.70708 8.29062L6.41333 4.99999L9.70396 1.70624Z"/>
                </svg>
            </button>
        </div>
        <div class="filename">${displayFilename}</div>
        ${statsHtml ? `<div class="download-stats">${statsHtml}</div>` : ''}
    `;

    // Add delete functionality
    const deleteBtn = historyItem.querySelector('.history-delete-btn');
    deleteBtn.addEventListener('click', () => deleteHistoryItem(progressData.completedAt));

    return historyItem;
}

/**
 * Build stats HTML for history item (only show available data)
 * @param {Object} progressData - Final download data
 * @returns {string} Stats HTML or empty string
 */
function buildStatsHtml(progressData) {
    const stats = [];
    
    // Quality from selectedOptionOrigText (white circle)
    if (progressData.selectedOptionOrigText) {
        const quality = progressData.selectedOptionOrigText.split('•')[0]?.trim();
        if (quality) {
            stats.push(`
                <span class="quality">
                    <svg width="4" height="4" viewBox="0 0 6 6" fill="none">
                        <circle cx="3" cy="3" r="3" fill="var(--text-primary-dark)"/>
                    </svg>
                    ${quality}
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
                <span class="filesize" title="Video: ${videoSize}, Audio: ${audioSize}">
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
        
        // Remove from UI
        const historyContainer = document.querySelector('.downloads-history');
        const historyItem = historyContainer.querySelector(`[data-completion="${completedAt}"]`);
        if (historyItem) {
            historyItem.remove();
        }
        
        logger.debug('Deleted history item:', completedAt);
        
    } catch (error) {
        logger.error('Error deleting history item:', error);
    }
}