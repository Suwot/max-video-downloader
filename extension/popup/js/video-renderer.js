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

import { getFilenameFromUrl, formatDuration, normalizeUrl } from './utilities.js';
import { getAllGroupStates, setGroupState } from './services/group-state-service.js';
import { videoStateService } from './services/video-state-service.js';
import { handleDownload } from './download.js';
import { showQualityDialog } from './ui.js';
import { sendPortMessage } from './index.js';

// Cache the hover preview elements for better performance
let hoverPreviewContainer = null;
let hoverPreviewImg = null;

/**
 * Initialize hover preview elements
 */
function initHoverPreview() {
    if (!hoverPreviewContainer) {
        hoverPreviewContainer = document.getElementById('preview-hover');
        hoverPreviewImg = document.getElementById('hover-preview-img');
    }
}

/**
 * Show hover preview at specific position
 * @param {string} previewUrl - URL of the full-size preview image
 * @param {MouseEvent} event - Mouse event to position the preview
 */
export function showHoverPreview(previewUrl, event) {
    initHoverPreview();
    
    // Only proceed if we have both the container and a valid preview URL
    if (!hoverPreviewContainer || !hoverPreviewImg || !previewUrl) return;
    
    // Set the image source
    hoverPreviewImg.src = previewUrl;
    
    // Position the preview near the cursor but within viewport bounds
    const rect = hoverPreviewContainer.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Initial positioning
    let left = event.clientX + 10;
    let top = event.clientY - 10;
    
    // Adjust horizontal position if it goes off screen
    if (left + rect.width > viewportWidth - 20) {
        left = event.clientX - rect.width - 10;
    }
    
    // Adjust vertical position if it goes off screen
    if (top + rect.height > viewportHeight - 20) {
        top = viewportHeight - rect.height - 20;
    }
    
    // Make sure we don't go off the top or left either
    left = Math.max(10, left);
    top = Math.max(10, top);
    
    // Apply the position
    hoverPreviewContainer.style.left = `${left}px`;
    hoverPreviewContainer.style.top = `${top}px`;
    
    // Show the preview
    hoverPreviewContainer.style.display = 'block';
    
    // Use requestAnimationFrame to ensure display property change takes effect before adding the visible class
    requestAnimationFrame(() => {
        hoverPreviewContainer.classList.add('visible');
    });
}

/**
 * Hide the hover preview
 */
export function hideHoverPreview() {
    if (hoverPreviewContainer) {
        // First remove the visible class to trigger transition
        hoverPreviewContainer.classList.remove('visible');
        
        // Then hide after transition completes
        setTimeout(() => {
            hoverPreviewContainer.style.display = 'none';
        }, 200); // Matching the transition duration
    }
}

/**
 * Group videos by type for display
 * @param {Array} videos - The videos to group
 * @returns {Object} Grouped videos by type
 */
export function groupVideosByType(videos) {
    // Initialize video groups
    const groups = {
        hls: [],
        dash: [],
        direct: [],
        blob: [],
        unknown: []
    };

    // Group videos by type
    videos.forEach(video => {
        if (!video || !video.url) return;
        
        const type = video.type || 'unknown';
        
        // Add to appropriate group
        if (type === 'hls') {
            groups.hls.push(video);
        } else if (type === 'dash') {
            groups.dash.push(video);
        } else if (type === 'blob') {
            groups.blob.push(video);
        } else if (type === 'direct') {
            groups.direct.push(video);
        } else {
            groups.unknown.push(video);
        }
    });
    
    return groups;
}

/**
 * Render a list of videos in the UI
 * @param {Array} videos - Videos to render
 */
export async function renderVideos(videos) {
    const container = document.getElementById('videos');
        
    if (!videos || videos.length === 0) {
        // Use the shared function for showing "no videos" message
        // This ensures consistent UI and proper theming
        const { showNoVideosMessage } = await import('./ui.js');
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

    // Add source badge (content_script or background)
    const sourceBadge = document.createElement('div');
    sourceBadge.className = `source-badge ${video.source || 'background'}`;
    sourceBadge.textContent = video.source === 'content_script' ? 'CS' : 'BG';
    previewContainer.appendChild(sourceBadge);
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.style.display = 'block'; // Always show loader initially
    
    previewContainer.append(previewImage, loader);
    previewColumn.appendChild(previewContainer);
    
    // Track if preview has been generated
    let previewGenerated = false;
    
    // If we already have a preview URL, use it
    if (video.previewUrl) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        };
        previewImage.src = video.previewUrl;
        previewGenerated = true;
        
        // Add hover functionality for preview if available
        previewContainer.addEventListener('mouseenter', (event) => {
            if (video.previewUrl) {
                showHoverPreview(video.previewUrl, event);
            }
        });
        
        previewContainer.addEventListener('mousemove', (event) => {
            if (video.previewUrl) {
                showHoverPreview(video.previewUrl, event);
            }
        });
        
        previewContainer.addEventListener('mouseleave', () => {
            hideHoverPreview();
        });
    } 

    // If we have a poster, use it directly
    else if (video.poster) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        };
        previewImage.src = video.poster;
        previewGenerated = true;
        
        // Add hover functionality for poster if available
        previewContainer.addEventListener('mouseenter', (event) => {
            if (video.poster) {
                showHoverPreview(video.poster, event);
            }
        });
        
        previewContainer.addEventListener('mousemove', (event) => {
            if (video.poster) {
                showHoverPreview(video.poster, event);
            }
        });
        
        previewContainer.addEventListener('mouseleave', () => {
            hideHoverPreview();
        });
    } 
    // No preview available yet
    else {
        // Keep the loader spinning until a preview becomes available
        if (video.type === 'blob' && !video.poster) {
            // For blob URLs without a poster, still show the placeholder instead of trying to generate
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        }
    }
    
    // Add hover preview functionality
    previewImage.addEventListener('mouseenter', (event) => {
        showHoverPreview(video.previewUrl || video.poster, event);
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
            
            // Add codec info if available
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
        
        if (video.type === 'hls' || video.type === 'dash') {
            // Only fetch stream qualities if we don't have variants
            if (!video.variants || video.variants.length === 0) {
                const qualities = await videoStateService.fetchStreamQualities(selectedUrl);
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

/**
 * Update a video element with the latest video data
 * This is a unified handler for all video updates (preview and/or metadata)
 * @param {string} url - Video URL
 * @param {Object} updatedVideo - Complete updated video object or just mediaInfo
 * @param {boolean} [isMetadataOnly=false] - If true, updatedVideo is treated as mediaInfo object
 */
export function updateVideoElement(url, updatedVideo, isMetadataOnly = false) {
    if (!url || !updatedVideo) return;
    
    // Find the video element by URL
    const videoElement = document.querySelector(`.video-item[data-url="${CSS.escape(url)}"]`);
    if (!videoElement) return;
    
    // Handle metadata-only updates (for backward compatibility)
    if (isMetadataOnly) {
        // In this case, updatedVideo is actually just mediaInfo
        updateVideoMetadataUI(videoElement, updatedVideo);
        console.log(`Updated metadata for video: ${url}`);
        return;
    }
    
    // Special handling for variants - log detailed information
    if (updatedVideo.isVariant) {
        const mediaInfoFieldCount = updatedVideo.mediaInfo ? Object.keys(updatedVideo.mediaInfo).length : 0;
        console.log(`Updating UI for variant with ${mediaInfoFieldCount} mediaInfo fields: ${url}`);
    }
    
    // 1. Update preview image if we have one
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
    
    // 2. Update metadata information
    if (updatedVideo.mediaInfo) {
        // Check if this is a variant and log details about its mediaInfo
        if (updatedVideo.isVariant) {
            const videoDataElement = videoElement.querySelector('.video-data');
            if (videoDataElement) {
                // Log what fields we have in the variant's mediaInfo
                const mediaInfoKeys = Object.keys(updatedVideo.mediaInfo);
                console.log(`Variant ${url} has mediaInfo fields: ${mediaInfoKeys.join(', ')}`);
            }
        }
        
        // Use the shared helper function to update UI with full mediaInfo
        // Pass the entire video object for context
        updateVideoMetadataUI(videoElement, updatedVideo.mediaInfo, updatedVideo);
    }
}

/**
 * Update metadata for a rendered video element when it becomes available
 * @param {string} url - Video URL to update
 * @param {Object} mediaInfo - Media information object with codec details
 * @deprecated Use updateVideoElement with isMetadataOnly=true instead
 */
export function updateVideoMetadata(url, mediaInfo) {
    // Call the unified update function with the metadata-only flag
    updateVideoElement(url, mediaInfo, true);
}

/**
 * Helper function to update the metadata UI elements in a video card
 * @param {HTMLElement} videoElement - The video element to update
 * @param {Object} mediaInfo - Media information object with codec details
 * @param {Object} [videoData] - Complete video object (optional)
 * @returns {void}
 */
function updateVideoMetadataUI(videoElement, mediaInfo, videoData = null) {
    if (!videoElement || !mediaInfo) return;
    
    // Additional debugging for variants
    if (videoData && videoData.isVariant) {
        console.log(`updateVideoMetadataUI for variant: ${videoData.url}`);
        console.log('MediaInfo keys:', Object.keys(mediaInfo));
    }
    
    // Find UI elements in this video card
    const codecInfo = videoElement.querySelector('.codec-info');
    let codecDetails = [];
    
    // Update media type info in UI (Video & Audio, Video Only, Audio Only)
    let mediaContentType = "Unknown";
    let mediaIcon = '';
    
    if (mediaInfo) {
        if (mediaInfo.hasVideo && mediaInfo.hasAudio) {
            mediaContentType = "Video & Audio";
            mediaIcon = '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>';
            
            // Video codec information - handle both nested and flat structures
            if (mediaInfo.videoCodec) {
                if (typeof mediaInfo.videoCodec === 'object') {
                    codecDetails.push(`Video: ${mediaInfo.videoCodec.name || 'Unknown'}`);
                } else {
                    codecDetails.push(`Video: ${mediaInfo.videoCodec}`);
                }
            } else if (mediaInfo.videoCodecName) {
                codecDetails.push(`Video: ${mediaInfo.videoCodecName}`);
            }
            
            // Audio codec information - handle both nested and flat structures
            if (mediaInfo.audioCodec) {
                codecDetails.push(`Audio: ${mediaInfo.audioCodec.name}`);
                if (mediaInfo.audioCodec.channels) {
                    codecDetails.push(`${mediaInfo.audioCodec.channels} channels`);
                }
            }
        } else if (mediaInfo.hasVideo) {
            mediaContentType = "Video Only";
            mediaIcon = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/><path d="M9 8h2v8H9zm4 0h2v8h-2z"/>';
            
            if (mediaInfo.videoCodec) {
                codecDetails.push(`Codec: ${mediaInfo.videoCodec.name}`);
            }
        } else if (mediaInfo.hasAudio) {
            mediaContentType = "Audio Only";
            mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4s4-1.79 4-4V7h4V3h-6z"/>';
            
            if (mediaInfo.audioCodec) {
                codecDetails.push(`Codec: ${mediaInfo.audioCodec.name}`);
                if (mediaInfo.audioCodec.channels) {
                    codecDetails.push(`${mediaInfo.audioCodec.channels} channels`);
                }
                if (mediaInfo.audioCodec.sampleRate) {
                    codecDetails.push(`${mediaInfo.audioCodec.sampleRate}Hz`);
                }
            }
        }
        
        // Update the media content type icon and label
        const mediaTypeInfo = videoElement.querySelector('.media-type-info');
        if (mediaTypeInfo) {
            mediaTypeInfo.innerHTML = `
                <svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
                    ${mediaIcon}
                </svg>
                <span>${mediaContentType}</span>
            `;
        }
        
        // Update codec info
        if (codecInfo) {
            if (codecDetails.length > 0) {
                codecInfo.textContent = codecDetails.join(' • ');
                codecInfo.classList.remove('loading');
            } else {
                codecInfo.textContent = 'Codec information unavailable';
                codecInfo.classList.remove('loading');
            }
        }
        
        // Update duration if available
        if (variant.metaJS.duration) {
            let durationElement = videoElement.querySelector('.video-duration');
            if (!durationElement) {
                // Create duration element if it doesn't exist
                const previewContainer = videoElement.querySelector('.preview-container');
                if (previewContainer) {
                    durationElement = document.createElement('div');
                    durationElement.className = 'video-duration';
                    durationElement.textContent = formatDuration(variant.metaJS.duration);
                    previewContainer.appendChild(durationElement);
                }
            } else {
                // Update existing duration element
                durationElement.textContent = formatDuration(variant.metaJS.duration);
            }
        }
        
        // Update resolution info if available
        const resolutionInfo = videoElement.querySelector('.resolution-info');
        if (resolutionInfo) {
            // Get the best resolution information available from various sources
            let width = null, height = null;
            
            // Extract width and height from the most reliable source
            if (mediaInfo.width && mediaInfo.height) {
                width = mediaInfo.width;
                height = mediaInfo.height;
            } else if (videoData && videoData.resolution) {
                width = videoData.resolution.width;
                height = videoData.resolution.height;
            } else if (videoData && videoData.width && videoData.height) {
                width = videoData.width;
                height = videoData.height;
            }
            
            // Handle both loading and already-loaded states
            if (width && height) {
                resolutionInfo.classList.remove('loading');
                resolutionInfo.textContent = `${width}x${height}`;
                
                // Add fps info from multiple possible sources
                let fps = null;
                if (mediaInfo.fps) {
                    fps = mediaInfo.fps;
                } else if (mediaInfo.fps) {
                    fps = mediaInfo.fps;
                } else if (mediaInfo.videoCodec && mediaInfo.videoCodec.fps) {
                    fps = mediaInfo.videoCodec.fps;
                } else if (videoData && videoData.fps) {
                    fps = videoData.fps;
                } else if (videoData && videoData.resolution && videoData.resolution.fps) {
                    fps = videoData.resolution.fps;
                }
                
                if (fps) {
                    resolutionInfo.textContent += ` ${fps}fps`;
                }
            }
        }
        
        // Update quality selector dropdown if it exists
        const qualitySelector = videoElement.querySelector('.quality-selector');
        if (qualitySelector && qualitySelector.options.length > 0) {
            // Get the best resolution information available from various sources
            let width = null, height = null;
            
            // Extract width and height from the most reliable source
            if (mediaInfo.width && mediaInfo.height) {
                width = mediaInfo.width;
                height = mediaInfo.height;
            } else if (videoData && videoData.resolution) {
                width = videoData.resolution.width;
                height = videoData.resolution.height;
            } else if (videoData && videoData.width && videoData.height) {
                width = videoData.width;
                height = videoData.height;
            }
            
            // Check if the first option is "Original Quality" and we have resolution info
            if ((qualitySelector.options[0].textContent === 'Original Quality' || 
                 qualitySelector.options[0].textContent.includes('Resolution') ||
                 qualitySelector.options[0].textContent.includes('p')) && 
                height) {
                
                // Create more descriptive label with actual quality
                let qualityLabel = `${height}p`;
                
                // Add fps info from multiple possible sources
                let fps = null;
                if (mediaInfo.fps) {
                    fps = mediaInfo.fps;
                } else if (mediaInfo.fps) {
                    fps = mediaInfo.fps;
                } else if (mediaInfo.videoCodec && mediaInfo.videoCodec.fps) {
                    fps = mediaInfo.videoCodec.fps;
                } else if (videoData && videoData.fps) {
                    fps = videoData.fps;
                } else if (videoData && videoData.resolution && videoData.resolution.fps) {
                    fps = videoData.resolution.fps;
                }
                
                if (fps) {
                    qualityLabel += ` ${fps}fps`;
                }
                if (mediaInfo.hasAudio === false) {
                    qualityLabel += ' (no audio)';
                }
                
                // Update the option text
                qualitySelector.options[0].textContent = qualityLabel;
            }
        }
    }
}