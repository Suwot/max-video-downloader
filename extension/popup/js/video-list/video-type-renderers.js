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
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    elementsDiv.appendChild(downloadBtn);
    
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
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    elementsDiv.appendChild(downloadBtn);
    
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
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = video.url; // For direct videos, always use the main URL
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    elementsDiv.appendChild(downloadBtn);
    
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
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    elementsDiv.appendChild(downloadBtn);
    
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
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = elementsDiv.querySelector('.quality-selector')?.value || video.url;
        const videoData = createVideoMetadata(video);
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    elementsDiv.appendChild(downloadBtn);
    
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
