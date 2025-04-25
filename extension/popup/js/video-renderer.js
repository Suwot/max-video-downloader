/**
 * @ai-guide-component VideoRenderer
 * @ai-guide-description UI component for video visualization
 * @ai-guide-responsibilities
 * - Renders detected video items in the popup UI
 * - Creates thumbnail previews from video metadata
 * - Formats video quality and format badges
 * - Implements selection UI for download options
 * - Manages video item interaction states
 * - Provides context menu functionality for video items
 * - Handles responsive layout for different screen sizes
 */

// popup/js/video-renderer.js

import { getFilenameFromUrl, formatResolution, formatDuration, normalizeUrl } from './utilities.js';
import { getScrollPosition, getAllGroupStates, setGroupState, getAllVideoGroups, getPosterFromCache, addPosterToCache } from './state.js';
import { groupVideosByType } from './video-processor.js';
import { handleDownload } from './download.js';
import { generatePreview } from './preview.js';
import { restoreScrollPosition } from './ui.js';
import { showQualityDialog } from './ui.js';
import { getStreamQualities } from './video-processor.js';

/**
 * Render a list of videos in the UI
 * @param {Array} videos - Videos to render
 */
export function renderVideos(videos) {
    const container = document.getElementById('videos');
    
    if (!videos || videos.length === 0) {
        container.innerHTML = `
            <div class="initial-message">
                No videos found on this page. Try playing a video first or refreshing.
            </div>
        `;
        return;
    }
    
    // Group videos by type
    const videoGroups = groupVideosByType(videos);
    
    // Create document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Create type groups
    for (const [type, typeVideos] of Object.entries(videoGroups)) {
        if (typeVideos.length === 0) continue;
        
        const group = createTypeGroup(type, typeVideos);
        fragment.appendChild(group);
    }
    
    container.innerHTML = '';
    container.appendChild(fragment);
    
    // Restore scroll position
    restoreScrollPosition(container, getScrollPosition());
}

/**
 * Create a group for a specific video type
 * @param {string} type - Video type (hls, dash, etc.)
 * @param {Array} videos - Videos of this type
 * @returns {HTMLElement} Group element
 */
export function createTypeGroup(type, videos) {
    const group = document.createElement('div');
    group.className = 'media-type-group';
    
    // Create header
    const header = document.createElement('div');
    header.className = `media-type-header ${type}`;
    
    const title = document.createElement('div');
    title.className = 'media-type-title';
    title.innerHTML = `
        ${type.toUpperCase()}
        <span class="media-type-count">${videos.length}</span>
    `;
    
    const toggle = document.createElement('div');
    toggle.className = 'media-type-toggle';
    toggle.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
        </svg>
    `;
    
    if (getAllGroupStates()[type]) {
        toggle.classList.add('collapsed');
    }
    
    header.append(title, toggle);
    
    // Create content
    const content = document.createElement('div');
    content.className = 'media-type-content';
    
    if (getAllGroupStates()[type]) {
        content.classList.add('collapsed');
    }
    
    // Add videos to group
    videos.forEach(video => {
        const videoElement = createVideoElement(video);
        content.appendChild(videoElement);
    });
    
    // Toggle event
    header.addEventListener('click', () => {
        toggle.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
        
        // Update and save state
        setGroupState(type, content.classList.contains('collapsed'));
    });
    
    group.append(header, content);
    return group;
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
    
    // Add duration display if available in video.mediaInfo
    if (video.mediaInfo?.duration) {
        const durationElement = document.createElement('div');
        durationElement.className = 'video-duration';
        durationElement.textContent = formatDuration(video.mediaInfo.duration);
        previewContainer.appendChild(durationElement);
    }
    
    // Add type badge to preview container
    const typeBadge = document.createElement('div');
    typeBadge.className = `type-badge ${video.type || 'unknown'}`;
    typeBadge.textContent = video.type ? video.type.toUpperCase() : 'UNKNOWN';
    previewContainer.appendChild(typeBadge);
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.style.display = 'block'; // Always show loader initially
    
    const regenerateButton = document.createElement('button');
    regenerateButton.className = 'regenerate-button hidden';
    regenerateButton.textContent = 'Regenerate';
    
    previewContainer.append(previewImage, loader, regenerateButton);
    previewColumn.appendChild(previewContainer);
    
    // Track if preview has been generated
    let previewGenerated = false;
    
    // Use cached poster if available
    if (getPosterFromCache(video.url)) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        };
        previewImage.src = getPosterFromCache(video.url);
        previewGenerated = true;
    }
    // If we already have a preview URL, use it
    else if (video.previewUrl) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
            
            // Cache the poster
            addPosterToCache(video.url, video.previewUrl);
        };
        previewImage.src = video.previewUrl;
        previewGenerated = true;
    } 
    // If we have a poster, use it directly
    else if (video.poster) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
            
            // Cache the poster
            addPosterToCache(video.url, video.poster);
        };
        previewImage.src = video.poster;
        previewGenerated = true;
    } 
    // No preview available yet
    else {
        // Only attempt to generate a preview if it's not a blob URL without poster
        if (!(video.type === 'blob' && !video.poster)) {
            generatePreview(video.url, loader, previewImage, regenerateButton);
        } else {
            // For blob URLs without a poster, still show the placeholder
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        }
    }
    
    // Show regenerate button if preview generation failed
    if (!previewGenerated && !loader.style.display) {
        regenerateButton.classList.remove('hidden');
    }
    
    regenerateButton.addEventListener('click', () => {
        regenerateButton.classList.add('hidden');
        loader.style.display = 'block';
        generatePreview(video.url, loader, previewImage, regenerateButton);
    });
    
    // Create info column
    const infoColumn = document.createElement('div');
    infoColumn.className = 'info-column';
    
    // Create title row
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    
    const title = document.createElement('h3');
    title.className = 'video-title';
    title.textContent = video.title || getFilenameFromUrl(video.url);
    
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
        tooltip.textContent = 'Copied!';
        
        // Position the tooltip
        copyButton.appendChild(tooltip);
        
        // Remove after 2 seconds
        setTimeout(() => {
            tooltip.remove();
        }, 2000);
    });
    
    titleRow.append(title, copyButton);
    
    // Create file info section
    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';

    // Create media type info
    const mediaTypeInfo = document.createElement('div');
    mediaTypeInfo.className = 'media-type-info';
    
    let mediaContentType = "Unknown";
    let codecDetails = [];
    
    if (video.mediaInfo) {
        if (video.mediaInfo.hasVideo && video.mediaInfo.hasAudio) {
            mediaContentType = "Video & Audio";
            if (video.mediaInfo.videoCodec) {
                codecDetails.push(`Video: ${video.mediaInfo.videoCodec.name}`);
            }
            if (video.mediaInfo.audioCodec) {
                codecDetails.push(`Audio: ${video.mediaInfo.audioCodec.name}`);
            }
        } else if (video.mediaInfo.hasVideo) {
            mediaContentType = "Video Only";
            if (video.mediaInfo.videoCodec) {
                codecDetails.push(`Codec: ${video.mediaInfo.videoCodec.name}`);
            }
        } else if (video.mediaInfo.hasAudio) {
            mediaContentType = "Audio Only";
            if (video.mediaInfo.audioCodec) {
                codecDetails.push(`Codec: ${video.mediaInfo.audioCodec.name}`);
                if (video.mediaInfo.audioCodec.channels) {
                    codecDetails.push(`${video.mediaInfo.audioCodec.channels} channels`);
                }
                if (video.mediaInfo.audioCodec.sampleRate) {
                    codecDetails.push(`${video.mediaInfo.audioCodec.sampleRate}Hz`);
                }
            }
        }
    } else {
        mediaContentType = video.type ? video.type.toUpperCase() : "Unknown";
    }
    
    let mediaIcon = '';
    if (mediaContentType === "Audio Only") {
        mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
    } else if (mediaContentType === "Video Only") {
        mediaIcon = '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>';
    } else {
        mediaIcon = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/><path d="M9 8h2v8H9zm4 0h2v8h-2z"/>';
    }
    
    mediaTypeInfo.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
            ${mediaIcon}
        </svg>
        <span>${mediaContentType}</span>
    `;

    // Create a separate container for media type info
    const mediaTypeContainer = document.createElement('div');
    mediaTypeContainer.className = 'media-type-container';
    mediaTypeContainer.appendChild(mediaTypeInfo);
    
    // Add codec details if available
    if (codecDetails.length > 0) {
        const codecInfo = document.createElement('div');
        codecInfo.className = 'codec-info';
        codecInfo.textContent = codecDetails.join(' • ');
        mediaTypeContainer.appendChild(codecInfo);
    }
    
    fileInfo.appendChild(mediaTypeContainer);
    
    // Resolution info
    const resolutionContainer = document.createElement('div');
    resolutionContainer.className = 'resolution-container';
    
    const resolutionInfo = document.createElement('div');
    resolutionInfo.className = 'resolution-info';
    
    // Use enhanced resolution formatting with codec info
    if (video.resolution) {
        const resolutionText = formatResolution(
            video.resolution.width,
            video.resolution.height,
            video.resolution.fps,
            video.resolution.bitrate,
            video.mediaInfo
        );
        resolutionInfo.textContent = resolutionText;
    } else {
        resolutionInfo.textContent = 'Resolution unknown';
    }
    
    resolutionContainer.appendChild(resolutionInfo);
    fileInfo.appendChild(resolutionContainer);
    
    // Progress bar (initially hidden)
    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressContainer.appendChild(progressBar);
    
    // For blob URLs, add warning about potential limitations
    if (video.type === 'blob') {
        const blobWarning = document.createElement('div');
        blobWarning.className = 'blob-warning';
        blobWarning.textContent = 'Blob URL: May not work for all sites';
        infoColumn.append(titleRow, fileInfo, blobWarning, progressContainer);
    } else {
        infoColumn.append(titleRow, fileInfo, progressContainer);
    }
    
    // Create download button 
    const downloadGroup = createVideoActions(video);
    infoColumn.appendChild(downloadGroup);
    
    element.append(previewColumn, infoColumn);
    
    return element;
}

function createVideoActions(video) {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'download-group';
    
    // Create quality selector if variants are available
    if (video.qualityVariants && video.qualityVariants.length > 0) {
        // Sort variants by resolution height (highest first)
        const sortedVariants = [...video.qualityVariants].sort((a, b) => 
            (b.height || 0) - (a.height || 0)
        );

        // Check if original quality matches the best quality variant
        const bestQuality = sortedVariants[0];
        const originalMatchesBest = video.resolution && bestQuality && (
            // Compare base URLs (without query params or hash)
            video.url.split('?')[0].split('#')[0] === bestQuality.url.split('?')[0].split('#')[0] ||
            // Or compare resolution if both have it
            (video.resolution.width === bestQuality.width &&
             video.resolution.height === bestQuality.height)
        );

        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';
        
        // Only add original quality if it doesn't match best variant
        if (!originalMatchesBest) {
            const mainQuality = document.createElement('option');
            mainQuality.value = video.url;
            mainQuality.textContent = video.resolution ? 
                `${video.resolution.width}x${video.resolution.height}` + (video.resolution.fps ? ` @${video.resolution.fps}fps` : '') :
                'Original Quality';
            qualitySelector.appendChild(mainQuality);
        }
        
        // Add sorted variant qualities
        sortedVariants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            option.textContent = variant.height ? 
                `${variant.width}x${variant.height}` + (variant.fps ? ` @${variant.fps}fps` : '') :
                'Alternative Quality';
            qualitySelector.appendChild(option);
        });

        actionsDiv.appendChild(qualitySelector);
    }
    
    // Create download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.dataset.url = video.url;
    downloadBtn.dataset.type = video.type;
    downloadBtn.textContent = 'Download';
    
    downloadBtn.addEventListener('click', async () => {
        const selectedUrl = actionsDiv.querySelector('.quality-selector')?.value || video.url;
        
        if (video.type === 'hls' || video.type === 'dash') {
            // Only fetch stream qualities if we don't have variants
            if (!video.qualityVariants) {
                const qualities = await getStreamQualities(selectedUrl);
                if (qualities && qualities.length > 0) {
                    const selectedQuality = await showQualityDialog(qualities);
                    if (!selectedQuality) return; // User canceled
                    handleDownload(downloadBtn, selectedQuality.url || selectedUrl, video.type);
                    return;
                }
            }
            handleDownload(downloadBtn, selectedUrl, video.type);
        } else {
            handleDownload(downloadBtn, selectedUrl, video.type);
        }
    });
    
    actionsDiv.appendChild(downloadBtn);
    return actionsDiv;
}