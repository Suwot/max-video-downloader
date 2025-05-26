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
    return elementsDiv;
}

/**
 * Render actions for direct video type
 * @param {Object} video - Direct video data
 * @returns {HTMLElement} Actions group element
 */
function renderDirectElements(video) {
    // Currently using the same UI as other types for direct videos
    // Will be enhanced in the future to show file info
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create quality selector if variants are available (rare for direct videos)
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
    return elementsDiv;
}
