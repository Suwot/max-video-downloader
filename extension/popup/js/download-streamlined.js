/**
 * Streamlined Download Module - UI side only
 * Sends download requests and maps progress to UI elements
 */

import { createLogger } from '../../shared/utilities/logger.js';
import { getBackgroundPort } from './index.js';
import { showError } from './ui.js';
import { formatSize } from '../../shared/utilities/video-utils.js';

const logger = createLogger('Download');

/**
 * Handle download button click - streamlined version
 * @param {HTMLElement} button - Download button
 * @param {Object} videoData - Video metadata
 */
export async function handleDownload(button, videoData = {}) {
    logger.debug('Initiating download for:', videoData.downloadUrl);
    
    const buttonWrapper = button.closest('.download-btn-wrapper');
    setDownloadingState(button, buttonWrapper, "Starting...");
    
    try {     
        // Get current tab ID
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id || -1;
        
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
            tabId: tabId
        });
        
        logger.debug('Download request sent to background');
        
    } catch (error) {
        logger.error('Download failed:', error);
        resetDownloadingState(button, buttonWrapper);
        showError('Failed to start download');
    }
}

/**
 * Check for active downloads when popup opens
 */
export async function checkForActiveDownloads() {
    logger.debug('Requesting active downloads from background...');
    
    const port = getBackgroundPort();
    if (port) {
        port.postMessage({ command: 'getActiveDownloads' });
    } else {
        logger.error('No background connection for active downloads check');
    }
}

/**
 * Update download progress UI - maps progress to buttons
 * @param {Object} video - Video being downloaded  
 * @param {number} progress - Download progress (0-100)
 * @param {Object} progressData - Additional progress data
 */
export function updateDownloadProgress(video, progress, progressData = {}) {
    const lookupUrl = progressData.masterUrl || progressData.downloadUrl;
    
    if (!lookupUrl) {
        logger.warn('No lookup URL for progress update:', progressData);
        return;
    }
    
    // Find video items matching this download
    const videoItems = document.querySelectorAll(`.video-item[data-url="${lookupUrl}"]`);
    if (videoItems.length === 0) {
        logger.debug('No video items found for URL:', lookupUrl);
        return;
    }
    
    logger.debug(`Mapping progress to ${videoItems.length} video item(s)`, progress + '%');
    
    // Update each matching video item
    videoItems.forEach(videoItem => {
        const button = videoItem.querySelector('.download-btn');
        const buttonWrapper = videoItem.querySelector('.download-btn-wrapper');
        
        if (button && buttonWrapper) {
            updateDownloadButtonProgress(button, buttonWrapper, progress, progressData);
        }
    });
}

/**
 * Transition button to downloading state
 */
function setDownloadingState(button, buttonWrapper, initialText = "Starting...") {

    if (buttonWrapper) {
        buttonWrapper.classList.add('downloading');
    }
    
    button.disabled = false;
    button.innerHTML = `<span>${initialText}</span>`;
}

/**
 * Reset button to original state
 */
function resetDownloadingState(button, buttonWrapper) {
    if (buttonWrapper) {
        buttonWrapper.classList.remove('downloading', 'complete', 'error');
        buttonWrapper.removeAttribute('style');
    }
    
    button.disabled = false;
    button.removeAttribute('style');
    
    button.innerHTML = `
    <span class="download-btn-icon">
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
    </span>
    <span>Download</span>
    `;
}

/**
 * Update button progress
 */
function updateDownloadButtonProgress(button, buttonWrapper, progress, progressData = {}) {
    progress = Math.max(0, Math.min(100, Math.round(progress)));

    if (buttonWrapper) {
        if (!buttonWrapper.classList.contains('downloading')) {
            buttonWrapper.classList.add('downloading');
        }
        buttonWrapper.style.setProperty('--progress', `${progress}%`);
    }

    let displayText = `${progress}%`;

    if (progressData.segmentProgress) {
        displayText += ` (${progressData.segmentProgress})`;
    }
    if (progressData.speed) {
        displayText += ` • ${formatSpeed(progressData.speed)}`;
    }
    if (progressData.eta && progressData.eta > 0 && progress < 100) {
        displayText += ` • ETA: ${formatTime(progressData.eta)}`;
    }

    // Always replace button content with a single span for progress
    button.innerHTML = `<span>${displayText}</span>`;

    // Handle completion
    if (progressData.success !== undefined || progress >= 100) {
        if (buttonWrapper) {
            buttonWrapper.classList.add('complete');
        }
        button.innerHTML = `<span>Completed!</span>`;
        setTimeout(() => resetDownloadingState(button, buttonWrapper), 2000);
    } else if (progressData.error) {
        if (buttonWrapper) {
            buttonWrapper.classList.add('error');
        }
        button.innerHTML = `<span>Error</span>`;
        setTimeout(() => resetDownloadingState(button, buttonWrapper), 3000);
    }
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
