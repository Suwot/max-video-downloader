import { formatDuration } from '../../shared/utils/video-utils.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { createCustomDropdown } from './dropdown.js';
import { createDownloadButton } from './download-button.js';
import { sendPortMessage } from '../communication.js';

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
    let previewUrl = video.previewUrl || video.poster;

    // Add duration display if available
    if (video.duration) {
        const durationElement = document.createElement('div');
        durationElement.className = 'video-duration';
        durationElement.textContent = formatDuration(video.duration);
        previewContainer.appendChild(durationElement);
    }

    // Add Status badge for Live and/or Encrypted
    if (video.isLive || video.isEncrypted) {
        const statusBadge = document.createElement('div');
        statusBadge.className = 'status-badge';
        
        // Set tooltip for encrypted content
        if (video.isEncrypted) {
            statusBadge.title = video.encryptionType ? 
                `Encryption: ${video.encryptionType}` : 
                'Encrypted content';
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

        // Add hover functionality for preview
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
    
    // Create info column
    const infoColumn = document.createElement('div');
    infoColumn.className = 'info-column';
    
    // Create title row
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    
    const title = document.createElement('h3');
    title.className = 'video-title item-title';
    title.textContent = video.title || 'Untitled Video';
    
    // Add extracted badge for videos found in query parameters
    if (video.foundFromQueryParam) {
        const extractedBadge = document.createElement('span');
        extractedBadge.className = 'badge extracted';
        extractedBadge.innerHTML = '🔎 Extracted';
        title.appendChild(extractedBadge);
    }
    
    // Dismiss (X) button
    const dismissButton = document.createElement('button');
    dismissButton.className = 'dismiss-button';
    dismissButton.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9.70396 1.70624C10.0946 1.31562 10.0946 0.681244 9.70396 0.290619C9.31333 -0.100006 8.67896 -0.100006 8.28833 0.290619L4.9977 3.58437L1.70396 0.293744C1.31333 -0.0968812 0.678955 -0.0968812 0.28833 0.293744C-0.102295 0.684369 -0.102295 1.31874 0.28833 1.70937L3.58208 4.99999L0.291455 8.29374C-0.0991699 8.68437 -0.0991699 9.31874 0.291455 9.70937C0.68208 10.1 1.31646 10.1 1.70708 9.70937L4.9977 6.41562L8.29146 9.70624C8.68208 10.0969 9.31646 10.0969 9.70708 9.70624C10.0977 9.31562 10.0977 8.68124 9.70708 8.29062L6.41333 4.99999L9.70396 1.70624Z"/>
        </svg>
    `;
    dismissButton.title = 'Dismiss';
    dismissButton.addEventListener('click', () => {
        // Send dismiss command to background
        if (video.type === 'blob') {
            sendPortMessage({
                command: 'dismissVideo',
                tabId: video.tabId,
                url: video.normalizedUrl
            });
        } else {
            sendPortMessage({
                command: 'dismissVideo',
                tabId: video.tabId,
                url: video.url
            });
        }

        // Update UI counters - check if group becomes empty after removal
        const group = document.querySelector(`.video-type-group[data-video-type="${video.type}"]`);
        const sectionCount = group.querySelector('.counter');
        const drawerCount = parseInt(sectionCount.textContent, 10);
        
        if (drawerCount > 1) {
            sectionCount.textContent = String(drawerCount - 1); // Update the count if needed
            element.remove(); // Just remove this video item
        } else {
            element.remove();
            group.style.display = 'none'; // hide the group if only one left

            const isLastVideo = document.querySelectorAll('.video-item').length === 0;
            const initMessage = document.querySelector('#videos-list .initial-message');
            isLastVideo ? initMessage.style.display = 'flex' : initMessage.style.display = 'none';
        }

        // update videos tab counter without state modifications
        const tabCounter = document.querySelector('.tab-button[data-tab-id="videos-tab"] .counter');
        const tabCount = parseInt(tabCounter.textContent, 10); 
        tabCounter.textContent = tabCount > 1 ? String(tabCount - 1) : '';

    });
    
    titleRow.append(title, dismissButton);

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
    const downloadActions = createDownloadActions(video);
    infoColumn.appendChild(downloadActions);

    element.append(previewColumn, infoColumn);
    
    return element;
}

/**
 * Create download actions for any video type
 * Universal function that handles all video types identically
 * @param {Object} video - Video data
 * @returns {HTMLElement} Actions group element
 */
function createDownloadActions(video) {
    const elementsDiv = document.createElement('div');
    elementsDiv.className = 'download-group';
    
    // Create dropdown (handles all video types: HLS, DASH, Direct, Blob)
    const dropdown = createCustomDropdown(video);
    
    elementsDiv.appendChild(dropdown);
    
    // Create download button with dropdown reference
    createDownloadButton(video, elementsDiv, dropdown);

    return elementsDiv;
}