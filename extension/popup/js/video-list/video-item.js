// extension/popup/js/video-list/video-item.js

import { formatDuration } from '../utilities.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { renderTypeSpecificElements } from './video-type-renderers.js';
import { extractPreviewUrl } from './video-utils.js';

/**
 * Create a video element for the UI
 * @param {Object} video - Video data
 * @returns {HTMLElement} Video element
 */
export function createVideoElement(video) {
    const element = document.createElement('div');
    element.className = 'video-item';
    element.dataset.url = video.url;

    // Create preview column
    const previewColumn = document.createElement('div');
    previewColumn.className = 'preview-column';
    
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    
    const previewImage = document.createElement('img');
    previewImage.className = 'preview-image placeholder';
    previewImage.src = chrome.runtime.getURL('icons/video-placeholder.png');
    previewImage.alt = 'Video preview';

    // Get preview URL using utility function
    let previewUrl = extractPreviewUrl(video);

    // Add duration display if available in video.variants.metaJS
    if (video.variants) {
        const duration = video.variants[0].metaJS?.duration;
        const durationElement = document.createElement('div');
        durationElement.className = 'video-duration';
        durationElement.textContent = formatDuration(duration);
        previewContainer.appendChild(durationElement);
    }

    // Add type badge to preview container
    const typeBadge = document.createElement('div');
    typeBadge.className = `type-badge ${video.type || 'unknown'}`;
    typeBadge.textContent = video.type ? video.type.toUpperCase() : 'UNKNOWN';
    previewContainer.appendChild(typeBadge);

    // Add source badge (CS or BG)
    const sourceBadge = document.createElement('div');
    const sourceOrigin = video.source.includes('BG');
    sourceBadge.className = `source-badge ${sourceOrigin ? 'background' : 'content_script'}`;
    sourceBadge.textContent = sourceOrigin ? 'BG' : 'CS';
    previewContainer.appendChild(sourceBadge);

    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.style.display = 'block'; // Always show loader initially
    previewContainer.append(previewImage, loader);
    previewColumn.appendChild(previewContainer);

    if (previewUrl) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        };
        previewImage.src = previewUrl;

        // Add hover functionality for preview if available
        previewContainer.addEventListener('mouseenter', (event) => {
            showHoverPreview(previewUrl, event);
        });
        previewContainer.addEventListener('mousemove', (event) => {
            showHoverPreview(previewUrl, event);
        });
        previewContainer.addEventListener('mouseleave', hideHoverPreview);
    } else {
        // No preview available yet, keep loader or show placeholder
        if (video.type === 'blob' && !video.poster) {
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        }
    }

    // Add hover preview fallback for image (in case previewUrl is set later)
    previewImage.addEventListener('mouseenter', (event) => {
        showHoverPreview(previewUrl, event);
    });
    previewImage.addEventListener('mouseleave', hideHoverPreview);
    
    // Create info column
    const infoColumn = document.createElement('div');
    infoColumn.className = 'info-column';
    
    // Create title row
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    
    const title = document.createElement('h3');
    title.className = 'video-title';
    title.textContent = video.title || 'Untitled Video';
    
    // Add extracted badge for videos found in query parameters
    if (video.foundFromQueryParam) {
        const extractedBadge = document.createElement('span');
        extractedBadge.className = 'badge extracted';
        extractedBadge.innerHTML = '🔎 Extracted';
        title.appendChild(extractedBadge);
    }
    
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14">
            <path d="M16 1H4C3 1 2 2 2 3v14h2V3h12V1zm3 4H8C7 5 6 6 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
    `;
    
    copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(video.url);
        
        // Create a new tooltip element each time
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.textContent = 'Copied';
        
        // Position the tooltip
        copyButton.appendChild(tooltip);
        
        // Remove after 2 seconds
        setTimeout(() => {
            tooltip.remove();
        }, 2000);
    });
    
    titleRow.append(title, copyButton);

    // For blob URLs, add warning about potential limitations
    if (video.type === 'blob') {
        const blobWarning = document.createElement('div');
        blobWarning.className = 'blob-warning';
        blobWarning.textContent = 'Blob URL: for debug only';
        infoColumn.append(titleRow, blobWarning);
    } else {
        infoColumn.append(titleRow);
    }
    
    // Create type specific interactive elements
    const typeSpecificElements = renderTypeSpecificElements(video);
    infoColumn.appendChild(typeSpecificElements);
    
    element.append(previewColumn, infoColumn);
    
    return element;
}

