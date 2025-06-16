/**
 * Download Button Component
 * Handles download button creation and type-specific click handlers
 */

import { createVideoMetadata } from '../../shared/utilities/video-utils.js';
import { handleDownload } from './download-handler.js';

/**
 * Creates a download button with menu for any video type
 * Handles type-specific data extraction and click behavior
 * @param {Object} video - Video object
 * @param {HTMLElement} elementsDiv - Parent container for the button
 * @returns {Array} - Array containing [downloadBtn, menuBtn, buttonWrapper]
 */
export function createDownloadButton(video, elementsDiv) {
    // Create button wrapper
    const buttonWrapper = document.createElement('div');
    buttonWrapper.className = 'download-btn-wrapper';
    
    // Create main download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    
    // Add download icon and text
    const iconSpan = document.createElement('span');
    iconSpan.className = 'download-btn-icon';
    iconSpan.innerHTML = `
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg">
            <g clip-path="url(#clip0_43_340)">
                <path d="M5.0625 0.5625C5.0625 0.251367 4.81113 0 4.5 0C4.18887 0 3.9375 0.251367 3.9375 0.5625V4.82871L2.64727 3.53848C2.42754 3.31875 2.0707 3.31875 1.85098 3.53848C1.63125 3.7582 1.63125 4.11504 1.85098 4.33477L4.10098 6.58477C4.3207 6.80449 4.67754 6.80449 4.89727 6.58477L7.14727 4.33477C7.36699 4.11504 7.36699 3.7582 7.14727 3.53848C6.92754 3.31875 6.5707 3.31875 6.35098 3.53848L5.0625 4.82871V0.5625ZM1.125 6.1875C0.504492 6.1875 0 6.69199 0 7.3125V7.875C0 8.49551 0.504492 9 1.125 9H7.875C8.49551 9 9 8.49551 9 7.875V7.3125C9 6.69199 8.49551 6.1875 7.875 6.1875H6.09082L5.29453 6.98379C4.85508 7.42324 4.14316 7.42324 3.70371 6.98379L2.90918 6.1875H1.125ZM7.59375 7.17188C7.70564 7.17188 7.81294 7.21632 7.89206 7.29544C7.97118 7.37456 8.01562 7.48186 8.01562 7.59375C8.01562 7.70564 7.97118 7.81294 7.89206 7.89206C7.81294 7.97118 7.70564 8.01562 7.59375 8.01562C7.48186 8.01562 7.37456 7.97118 7.29544 7.89206C7.21632 7.81294 7.17188 7.70564 7.17188 7.59375C7.17188 7.48186 7.21632 7.37456 7.29544 7.29544C7.37456 7.21632 7.48186 7.17188 7.59375 7.17188Z" fill="#FAFAFA"/>
            </g>
            <defs>
                <clipPath id="clip0_43_340">
                    <path d="M0 0H9V9H0V0Z" fill="white"/>
                </clipPath>
            </defs>
        </svg>
    `;
    const textSpan = document.createElement('span');
    textSpan.textContent = 'Download';
    downloadBtn.appendChild(iconSpan);
    downloadBtn.appendChild(textSpan);
    
    // Create menu button (three dots) - ready for future options
    const menuBtn = document.createElement('button');
    menuBtn.className = 'download-menu-btn';
    menuBtn.title = 'More options';
    
    // Add SVG dots
    menuBtn.innerHTML = `
        <svg width="10" height="16" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="5" cy="5" r="1" fill="#FAFAFA"/>
            <circle cx="5" cy="8" r="1" fill="#FAFAFA"/>
            <circle cx="5" cy="11" r="1" fill="#FAFAFA"/>
        </svg>
    `;
    
    // Add buttons to wrapper
    buttonWrapper.appendChild(downloadBtn);
    buttonWrapper.appendChild(menuBtn);
    
    // Add wrapper to parent
    elementsDiv.appendChild(buttonWrapper);
    
    // Set up type-specific click handler
    setupDownloadHandler(downloadBtn, video, elementsDiv);
    
    // TODO: Set up menu button click handler for future options
    // menuBtn.addEventListener('click', () => showDownloadMenu(video, menuBtn));
    
    return [downloadBtn, menuBtn, buttonWrapper];
}

/**
 * Set up download click handler based on video type
 * @param {HTMLElement} downloadBtn - Download button element
 * @param {Object} video - Video object
 * @param {HTMLElement} elementsDiv - Parent container
 */
function setupDownloadHandler(downloadBtn, video, elementsDiv) {
    // Skip blob videos (no download capability)
    if (video.type === 'blob') {
        return;
    }
    
    downloadBtn.addEventListener('click', async () => {
        const videoData = createVideoMetadata(video);
        
        // Type-specific data extraction
        switch (video.type) {
            case 'hls':
                extractHlsData(videoData, video, elementsDiv);
                break;
            case 'dash':
                extractDashData(videoData, video, elementsDiv);
                break;
            case 'direct':
            default:
                extractDirectData(videoData, video, elementsDiv);
                break;
        }
        
        handleDownload(downloadBtn, videoData);
    });
}

/**
 * Extract HLS-specific download data
 * @param {Object} videoData - Video metadata object to populate
 * @param {Object} video - Original video object
 * @param {HTMLElement} elementsDiv - Parent container
 */
function extractHlsData(videoData, video, elementsDiv) {
    // Get selected URL from custom dropdown
    const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
    const selectedUrl = dropdown?.dataset.url || video.url;
    const fileSizeBytes = dropdown?.dataset.filesize || null;

    videoData.downloadUrl = selectedUrl;
    videoData.fileSizeBytes = fileSizeBytes;
}

/**
 * Extract DASH-specific download data
 * @param {Object} videoData - Video metadata object to populate
 * @param {Object} video - Original video object
 * @param {HTMLElement} elementsDiv - Parent container
 */
function extractDashData(videoData, video, elementsDiv) {
    // Get track map from custom dropdown
    const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
    const streamSelection = dropdown?.dataset.trackMap;
    const container = dropdown?.dataset.container;
    const totalFileSizeBytes = dropdown?.dataset.totalfilesize;

    videoData.streamSelection = streamSelection || null;
    videoData.originalContainer = container || null;
    videoData.downloadUrl = video.url; // Use main URL for DASH
    videoData.fileSizeBytes = totalFileSizeBytes;
}

/**
 * Extract direct video download data
 * @param {Object} videoData - Video metadata object to populate
 * @param {Object} video - Original video object
 * @param {HTMLElement} elementsDiv - Parent container
 */
function extractDirectData(videoData, video, elementsDiv) {
    const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
    const fileSizeBytes = dropdown?.dataset.filesize || null;
    
    videoData.downloadUrl = video.url; // Use main URL for direct videos
    videoData.fileSizeBytes = fileSizeBytes;
}
