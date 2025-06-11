// Type-specific renderers for different video types

import { createVideoMetadata } from './video-utils.js';
import { handleDownload } from '../download.js';
import { createCustomDropdown } from './custom-dropdown.js';

/**
 * Create type-specific video actions based on video type
 * @param {Object} video - Video data
 * @returns {HTMLElement} Actions group element
 */
export function renderTypeSpecificElements(video) {
    switch (video.type) {
        case 'hls':
            return renderHlsElements(video);
        case 'dash':
            return renderDashElements(video);
        case 'direct':
            return renderDirectElements(video);
        case 'blob':
            return renderBlobElements(video);
        default:
            return renderGenericElements(video);
    }
}

/**
 * Creates a styled download button with menu
 * @param {Object} video - The video object
 * @param {HTMLElement} elementsDiv - The parent container
 * @returns {Array} - Array containing [downloadBtn, menuBtn, buttonWrapper]
 */
function createDownloadButtonWithMenu(video, elementsDiv) {
    // Create button wrapper
    const buttonWrapper = document.createElement('div');
    buttonWrapper.className = 'download-btn-wrapper';
    
    // Create main download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    
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
    
    // Create menu button (three dots)
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
    
    // Return all elements including the wrapper for state management
    return [downloadBtn, menuBtn, buttonWrapper];
}

/**
 * Render actions for HLS video type
 * @param {Object} video - HLS video data
 * @returns {HTMLElement} Actions group element
 */
function renderHlsElements(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality dropdown if variants are available
    if (video.variants && video.variants.length > 0) {
        // Create custom dropdown instead of standard select
        const dropdown = createCustomDropdown({
            type: 'hls',
            variants: video.variants,
            initialSelection: video.variants[0],
            onChange: (selected) => {
                // Update download button with selected URL
                const downloadBtn = elementsDiv.querySelector('.download-btn');
                if (downloadBtn && selected.url) {
                    downloadBtn.dataset.selectedUrl = selected.url;
                }
            }
        });
        
        elementsDiv.appendChild(dropdown);
    }
    
    // Create download button with menu
    const [downloadBtn, menuBtn, buttonWrapper] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        // Get selected URL from custom dropdown
        const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
        const selectedUrl = dropdown?.dataset.url || video.url;
        const fileSizeBytes = dropdown?.dataset.filesize || null;

        const videoData = createVideoMetadata(video);
        videoData.downloadUrl = selectedUrl;
        videoData.fileSizeBytes = fileSizeBytes;

        handleDownload(downloadBtn, videoData);
    });

    return elementsDiv;
}

/**
 * Render actions for DASH video type
 * @param {Object} video - DASH video data
 * @returns {HTMLElement} Actions group element
 */
function renderDashElements(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Prepare tracks data for DASH
    const tracks = {
        videoTracks: video.videoTracks || [],
        audioTracks: video.audioTracks || [],
        subtitleTracks: video.subtitleTracks || []
    };
    
    // Create dropdown with track selection
    const dropdown = createCustomDropdown({
        type: 'dash',
        tracks: tracks,
        initialSelection: {
            selectedVideo: tracks.videoTracks?.[0]?.id,
            selectedAudio: tracks.audioTracks?.[0]?.id,
            selectedSubs: tracks.subtitleTracks?.[0]?.id
        },
        onChange: (selection) => {
            // Update download button with track map
            const downloadBtn = elementsDiv.querySelector('.download-btn');
            if (downloadBtn && selection.trackMap) {
                downloadBtn.dataset.trackMap = selection.trackMap;
            }
        }
    });
    
    elementsDiv.appendChild(dropdown);
    
    // Create download button with menu
    const [downloadBtn, menuBtn, buttonWrapper] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        // Get track map from custom dropdown
        const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
        const streamSelection = dropdown?.dataset.trackMap;
        const container = dropdown?.dataset.container;
        const totalFileSizeBytes = dropdown?.dataset.totalFileSize;

        const videoData = createVideoMetadata(video);
        videoData.streamSelection = streamSelection || null;
        videoData.originalContainer = container || null;
        videoData.downloadUrl = video.url; // Use main URL for DASH
        videoData.fileSizeBytes = totalFileSizeBytes;

        handleDownload(downloadBtn, videoData);
    });
    
    return elementsDiv;
}

/**
 * Render actions for direct video type
 * @param {Object} video - Direct video data
 * @returns {HTMLElement} Actions group element
 */
function renderDirectElements(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create custom dropdown with just one option
    const dropdown = createCustomDropdown({
        type: 'direct',
        variants: [video],
        initialSelection: video
    });
    
    elementsDiv.appendChild(dropdown);
    
    // Create download button with menu
    const [downloadBtn, menuBtn, buttonWrapper] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const dropdown = elementsDiv.querySelector('.custom-dropdown .selected-option');
        const fileSizeBytes = dropdown?.dataset.filesize || null;
        
        const videoData = createVideoMetadata(video);
        videoData.downloadUrl = video.url; // Use main URL for direct videos
        videoData.fileSizeBytes = fileSizeBytes;

        handleDownload(downloadBtn, videoData);
    });

    return elementsDiv;
}

/**
 * Render actions for blob video type
 * @param {Object} video - Blob video data
 * @returns {HTMLElement} Actions group element
 */
function renderBlobElements(video) {
    // We'll use the same approach as direct videos
    return renderDirectElements(video);
}

/**
 * Render actions for generic/unknown video type
 * @param {Object} video - Video data
 * @returns {HTMLElement} Actions group element
 */
function renderGenericElements(video) {
    // We'll use the same approach as direct videos
    return renderDirectElements(video);
}