// extension/popup/js/video-list/video-type-renderers.js
// Type-specific renderers for different video types

import { formatQualityLabel, createVideoMetadata } from './video-utils.js';
import { handleDownload } from '../download.js';

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
 * @returns {Array} - Array containing [downloadBtn, menuBtn]
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
    
    // Add three dots
    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'dots';
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('div');
        dot.className = 'dot';
        dotsContainer.appendChild(dot);
    }
    menuBtn.appendChild(dotsContainer);
    
    // Add buttons to wrapper
    buttonWrapper.appendChild(downloadBtn);
    buttonWrapper.appendChild(menuBtn);
    
    // Add wrapper to parent
    elementsDiv.appendChild(buttonWrapper);
    
    return [downloadBtn, menuBtn];
}

/**
 * Render actions for HLS video type
 * @param {Object} video - HLS video data
 * @returns {HTMLElement} Actions group element
 */
function renderHlsElements(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality selector if variants are available
    if (video.variants && video.variants.length > 0) {
        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';

        // Render variants
        video.variants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            option.textContent = formatQualityLabel(variant);
            qualitySelector.appendChild(option);
        });

        elementsDiv.appendChild(qualitySelector);
    }
    
    // Create download button with menu
    const [downloadBtn, menuBtn] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    // Add "More Details" toggle button
    // const detailsToggle = createDetailsToggle(video, 'hls');
    // elementsDiv.appendChild(detailsToggle);
    
    return elementsDiv;
}

/**
 * Render actions for DASH video type
 * @param {Object} video - DASH video data
 * @returns {HTMLElement} Actions group element
 */
function renderDashElements(video) {
    // Currently using the same UI as HLS for DASH videos
    // Will be enhanced in the future to support video/audio/subtitle selections
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality selector if variants are available
    if (video.variants && video.variants.length > 0) {
        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';

        // Render variants
        video.variants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            option.textContent = formatQualityLabel(variant);
            qualitySelector.appendChild(option);
        });

        elementsDiv.appendChild(qualitySelector);
    }
    
    // Create download button with menu
    const [downloadBtn, menuBtn] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    // Add "More Details" toggle button
    // const detailsToggle = createDetailsToggle(video, 'dash');
    // elementsDiv.appendChild(detailsToggle);
    
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
    
    // Create quality selector with a single option showing current quality
    const qualitySelector = document.createElement('select');
    qualitySelector.className = 'quality-selector';
    
    // Create a single option with formatted quality info
    const option = document.createElement('option');
    option.value = video.url;
    
    // Format quality label using existing utility function
    let qualityText = formatQualityLabel(video);

    // Fallback if no quality text was generated
    if (!qualityText || qualityText === "Alternative Quality") {
        qualityText = "Direct Media";
    }
    
    option.textContent = qualityText;
    qualitySelector.appendChild(option);
    elementsDiv.appendChild(qualitySelector);
    
    // Create download button with menu
    const [downloadBtn, menuBtn] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = video.url; // For direct videos, always use the main URL
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    // Uncomment to enable details toggle
    // const detailsToggle = createDetailsToggle(video, 'direct');
    // elementsDiv.appendChild(detailsToggle);
    
    return elementsDiv;
}

/**
 * Render actions for blob video type
 * @param {Object} video - Blob video data
 * @returns {HTMLElement} Actions group element
 */
function renderBlobElements(video) {
    // Currently using the same UI as other types for blob videos
    // Will be enhanced in the future for blob-specific features
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality selector if variants are available (rare for blob videos)
    if (video.variants && video.variants.length > 0) {
        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';

        // Render variants
        video.variants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            option.textContent = formatQualityLabel(variant);
            qualitySelector.appendChild(option);
        });

        elementsDiv.appendChild(qualitySelector);
    }
    
    // Create download button with menu
    const [downloadBtn, menuBtn] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    // Add "More Details" toggle button
    // const detailsToggle = createDetailsToggle(video, 'blob');
    // elementsDiv.appendChild(detailsToggle);
    
    return elementsDiv;
}

/**
 * Render actions for generic/unknown video type
 * @param {Object} video - Video data
 * @returns {HTMLElement} Actions group element
 */
function renderGenericElements(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality selector if variants are available
    if (video.variants && video.variants.length > 0) {
        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';

        // Render variants
        video.variants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            option.textContent = formatQualityLabel(variant);
            qualitySelector.appendChild(option);
        });

        elementsDiv.appendChild(qualitySelector);
    }
    
    // Create download button with menu
    const [downloadBtn, menuBtn] = createDownloadButtonWithMenu(video, elementsDiv);
    
    // Set up download functionality
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    // Add "More Details" toggle button
    // const detailsToggle = createDetailsToggle(video, 'generic');
    // elementsDiv.appendChild(detailsToggle);
    
    return elementsDiv;
}

/**
 * Creates a toggle button and container for displaying detailed video information
 * @param {Object} video - The video object
 * @param {string} videoType - Type of video (hls, dash, direct, blob, generic)
 * @returns {HTMLElement} - The details toggle container
 */
function createDetailsToggle(video, videoType) {
    const container = document.createElement('div');
    container.className = 'details-toggle-container';
    
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'details-toggle-btn';
    toggleBtn.innerHTML = 'More details <span class="arrow-icon">▼</span>';
    toggleBtn.dataset.expanded = 'false';
    
    // Create details drawer (initially hidden)
    const detailsDrawer = document.createElement('div');
    detailsDrawer.className = `details-drawer ${videoType}`;
    detailsDrawer.style.display = 'none';
    
    // Toggle functionality
    toggleBtn.addEventListener('click', () => {
        const isExpanded = toggleBtn.dataset.expanded === 'true';
        
        if (isExpanded) {
            // Collapse
            detailsDrawer.style.display = 'none';
            toggleBtn.dataset.expanded = 'false';
            toggleBtn.innerHTML = 'More details <span class="arrow-icon">▼</span>';
        } else {
            // Expand
            if (detailsDrawer.children.length === 0) {
                // Render details content on first open
                renderDetailsContent(detailsDrawer, video, videoType);
            }
            detailsDrawer.style.display = 'block';
            toggleBtn.dataset.expanded = 'true';
            toggleBtn.innerHTML = 'Hide details <span class="arrow-icon">▲</span>';
        }
    });
    
    container.appendChild(toggleBtn);
    container.appendChild(detailsDrawer);
    
    return container;
}

/**
 * Renders the content of the details drawer based on video type
 * @param {HTMLElement} container - The details drawer container
 * @param {Object} video - The video object
 * @param {string} videoType - Type of video
 */
export function renderDetailsContent(container, video, videoType) {
    // Create a heading
    const heading = document.createElement('h4');
    heading.className = 'details-heading';
    heading.textContent = `${videoType.toUpperCase()} Video Details`;
    container.appendChild(heading);
    
    // Create a pre element to display the JSON data
    const jsonPre = document.createElement('pre');
    jsonPre.className = 'json-content';
    
    // Format JSON for better readability
    const jsonData = JSON.stringify(video, null, 2);
    jsonPre.textContent = jsonData;
    
    // Add to container
    container.appendChild(jsonPre);
    
    // In the future, each video type can have custom rendering here
    // switch(videoType) {
    //     case 'hls':
    //         renderHlsDetails(container, video);
    //         break;
    //     case 'dash':
    //         renderDashDetails(container, video);
    //         break;
    //     // etc.
    // }
}
