import { formatDuration } from '../utilities.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { renderTypeSpecificElements } from './video-type-renderers.js';
import { extractPreviewUrl } from './video-utils.js';

/**
 * Create a base download button with consistent styling
 * @returns {Object} Object containing buttonWrapper, downloadBtn and menuBtn
 */
export function createBaseDownloadButton() {
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
    
    return { buttonWrapper, downloadBtn, menuBtn };
}

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
    } else {
        const duration = video.metaFFprobe?.duration;
        const durationElement = document.createElement('div');
        durationElement.className = 'video-duration';
        durationElement.textContent = formatDuration(duration);
        previewContainer.appendChild(durationElement); 
    }

    // Add Status badge for Live and/or Encrypted
    if (video.isLive || video.isEncrypted) {
        const statusBadge = document.createElement('div');
        statusBadge.className = 'status-badge';
        
        // Add tooltip with encryption type if available
        if (video.isEncrypted && video.encryptionType) {
            statusBadge.title = `${video.encryptionType}`;
        } else if (video.isEncrypted) {
            statusBadge.title = 'Encrypted content';
        }
        
        // Add Live text if applicable
        if (video.isLive) {
            const liveText = document.createElement('span');
            liveText.className = 'live-text';
            liveText.textContent = 'LIVE';
            statusBadge.appendChild(liveText);
        }
        
        // Add Encrypted lock icon if applicable
        if (video.isEncrypted) {
            const lockIcon = document.createElement('span');
            lockIcon.className = 'lock-icon';
            lockIcon.innerHTML = `
                <svg viewBox="0 0 7 8" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6.25 3.5H5.875V2.375C5.875 1.06562 4.80937 0 3.5 0C2.19062 0 1.125 1.06562 1.125 2.375V3.5H0.75C0.335938 3.5 0 3.83594 0 4.25V7.25C0 7.66406 0.335938 8 0.75 8H6.25C6.66406 8 7 7.66406 7 7.25V4.25C7 3.83594 6.66406 3.5 6.25 3.5ZM4.625 3.5H2.375V2.375C2.375 1.75469 2.87969 1.25 3.5 1.25C4.12031 1.25 4.625 1.75469 4.625 2.375V3.5Z" fill="#DB6B67"/>
                </svg>
            `;
            statusBadge.appendChild(lockIcon);
        }
        
        previewContainer.appendChild(statusBadge);
    }
    
    // Add source badge (CS or BG)
    const sourceBadge = document.createElement('div');
    const sourceOrigin = video.source.includes('BG');
    sourceBadge.className = `source-badge ${sourceOrigin ? 'background' : 'content_script'}`;
    sourceBadge.textContent = sourceOrigin ? 'BG' : 'CS';
    previewContainer.appendChild(sourceBadge);

    const loader = document.createElement('div');
    loader.className = 'loader';
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

