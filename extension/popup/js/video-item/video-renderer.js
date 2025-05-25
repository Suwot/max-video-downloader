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
 * - Filters out tracking pixels while preserving extracted media URLs
 * - Displays visual indicator for videos extracted from query parameters
 * - Applies consistent validation rules for video rendering
 * - Provides specialized UI for different video types and formats
 */

// popup/js/video-renderer.js

import { getFilenameFromUrl, formatDuration } from '../utilities.js';
import { getAllGroupStates, setGroupState } from '../services/group-state-service.js';
import { videoStateService } from '../services/video-state-service.js';
import { handleDownload } from '../download.js';
import { showQualityDialog } from '../ui.js';
import { sendPortMessage } from '../index.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { groupVideosByType, createTypeGroup } from './video-groups.js';

/**
 * Render a list of videos in the UI
 * @param {Array} videos - Videos to render
 */
export async function renderVideos(videos) {
    const container = document.getElementById('videos');
        
    if (!videos || videos.length === 0) {
        // Use the shared function for showing "no videos" message
        // This ensures consistent UI and proper theming
        const { showNoVideosMessage } = await import('../ui.js');
        showNoVideosMessage();
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
    
    // Add CSS for the extracted badge and timestamp if it doesn't exist
    if (!document.getElementById('custom-badges-style')) {
        const style = document.createElement('style');
        style.id = 'custom-badges-style';
        style.textContent = `
            .badge.extracted {
                display: inline-block;
                background-color: #2196F3;
                color: white;
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 10px;
                margin-left: 8px;
                vertical-align: middle;
                font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }
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

    // Unified preview selection logic
    let previewUrl = null;
    if (Array.isArray(video.variants) && video.variants.length > 0 && video.variants[0].previewUrl) {
        previewUrl = video.variants[0].previewUrl;
    } else if (video.previewUrl) {
        previewUrl = video.previewUrl;
    } else if (video.poster) {
        previewUrl = video.poster;
    }

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
    title.textContent = video.title || getFilenameFromUrl(video.url);
    
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
    if (video.variants && video.variants.length > 0) {
        // Create quality selector only if we have actual variants
        const qualitySelector = document.createElement('select');
        qualitySelector.className = 'quality-selector';

        // Simply render each variant as provided without sorting or special processing
        video.variants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            
            // Create user-friendly quality label
            let qualityLabel = '';
            
            // Get height info
            let height = variant.metaJS?.height || null;
            
            if (height) {
                qualityLabel = `${height}p`;
            } else {
                qualityLabel = 'Alternative Quality';
            }
            
            // Add fps if available
            let fps = variant.metaJS?.fps || variant.metaFFprobe?.fps || null;
            if (fps) {
                qualityLabel += ` @${fps}fps`;
            }
            
            // Add bandwidth info if available
            let bandwidth = variant.metaJS?.averageBandwidth || variant.metaJS?.bandwidth || null;
            if (bandwidth) {
                const mbps = (bandwidth / 1000000).toFixed(1);
                if (mbps > 0) {
                    qualityLabel += ` (${mbps} Mbps)`;
                }
            }
            
            // Add estimated size info if available
            let estimatedFileSizeBytes = variant.metaJS?.estimatedFileSizeBytes || null;
            if (estimatedFileSizeBytes) {
                const mb = (estimatedFileSizeBytes / 1000000).toFixed(1);
                qualityLabel += ` (~${mb} MB)`;
            }

            option.textContent = qualityLabel;
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
        
        // Create video metadata object with essential properties for download
        const videoData = {
            title: video.title,
            originalContainer: video.originalContainer,
            originalUrl: video.originalUrl,
            foundFromQueryParam: video.foundFromQueryParam
        };
        
        handleDownload(downloadBtn, selectedUrl, video.type, videoData);
    });
    
    actionsDiv.appendChild(downloadBtn);
    return actionsDiv;
}

/**
 * Update a video element with the latest video data
 * This is a unified handler for all video updates (preview and/or metadata)
 * @param {string} url - Video URL
 * @param {Object} updatedVideo - Complete updated video object
 * @param {boolean} [isMetadataOnly=false] - If true, updatedVideo is treated as mediaInfo object
 */
export function updateVideoElement(url, updatedVideo, isMetadataOnly = false) {
    if (!url || !updatedVideo) return;
    
    // Find the video element by URL
    const videoElement = document.querySelector(`.video-item[data-url="${CSS.escape(url)}"]`);
    if (!videoElement) return;
  
    // Update preview image if we have one
    if (updatedVideo.previewUrl) {
        const previewImage = videoElement.querySelector('.preview-image');
        const loader = videoElement.querySelector('.loader');
        const previewContainer = videoElement.querySelector('.preview-container');
        
        if (previewImage) {
            // Only update if the src is different
            if (previewImage.src !== updatedVideo.previewUrl) {
                previewImage.onload = () => {
                    previewImage.classList.remove('placeholder');
                    previewImage.classList.add('loaded');
                    if (loader) loader.style.display = 'none';
                };
                previewImage.src = updatedVideo.previewUrl;
                
                // Add hover functionality for the newly loaded preview
                if (previewContainer) {
                    // Remove any existing listeners to avoid duplicates
                    const newPreviewUrl = updatedVideo.previewUrl;
                    previewContainer.addEventListener('mouseenter', (event) => showHoverPreview(newPreviewUrl, event));
                    previewContainer.addEventListener('mousemove', (event) => showHoverPreview(newPreviewUrl, event));
                    previewContainer.addEventListener('mouseleave', hideHoverPreview);
                }
            }
        }
    }
}

