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

import { getFilenameFromUrl, formatResolution, formatDuration, normalizeUrl } from './utilities.js';
import { getAllGroupStates, setGroupState, getAllVideoGroups, getPosterFromCache, addPosterToCache } from './state.js';
import { groupVideosByType } from './video-processor.js';
import { handleDownload } from './download.js';
import { generatePreview } from './preview.js';
import { showQualityDialog } from './ui.js';
import { getStreamQualities } from './video-processor.js';

/**
 * Final validation to ensure tracking pixels and similar unwanted content isn't rendered
 * @param {Object} video - Video object to validate
 * @returns {boolean} Whether the video is valid for rendering
 */
function isValidVideoForRendering(video) {
    if (!video || !video.url) return false;
    
    // If the video was explicitly found from a query parameter, always trust it
    // This means content_script.js already extracted a legitimate video URL from a tracking pixel
    if (video.foundFromQueryParam === true) {
        return true;
    }
    
    try {
        // Skip blob URLs which should already be properly validated
        if (video.url.startsWith('blob:')) return true;
        
        const urlObj = new URL(video.url);
        
        // Reject ping.gif and other tracking pixels directly
        if (video.url.includes('ping.gif') || video.url.includes('jwpltx.com')) {
            return false;
        }
        
        // Check for image extensions that shouldn't be rendered as videos
        const badExtensions = /\.(gif|png|jpg|jpeg|webp|bmp|svg)(\?|$)/i;
        if (badExtensions.test(urlObj.pathname)) {
            // Only allow HLS and DASH videos that were already validated
            if (video.type === 'hls' || video.type === 'dash') {
                return true;
            }
            return false;
        }
        
        // Known tracking/analytics endpoints that shouldn't be rendered
        const trackingPatterns = [
            /\/ping/i, 
            /\/track/i, 
            /\/pixel/i, 
            /\/telemetry/i,
            /\/analytics/i,
            /\/stats/i,
            /\/metrics/i,
            /jwpltx/i
        ];
        
        // Only apply tracking pattern check if this isn't a specific video type we trust
        if (video.type !== 'hls' && video.type !== 'dash' && 
            trackingPatterns.some(pattern => 
                pattern.test(urlObj.pathname) || pattern.test(urlObj.hostname)
            )) {
            return false;
        }
        
        return true;
    } catch (e) {
        console.error('Error validating video for rendering:', e, video);
        return false;
    }
}

/**
 * Get the current scroll position from the videos container
 * Local replacement for the removed state.js function
 * @returns {number} Current scroll position
 */
function getScrollPosition() {
    const container = document.getElementById('videos');
    return container ? container.scrollTop : 0;
}

/**
 * Render a list of videos in the UI
 * @param {Array} videos - Videos to render
 */
export async function renderVideos(videos) {
    const container = document.getElementById('videos');
    
    // Apply final validation filter to ensure we don't show invalid videos
    videos = videos ? videos.filter(isValidVideoForRendering) : [];
    
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
            
            .detection-timestamp {
                position: absolute;
                bottom: 20px;
                right: 2px;
                background-color: rgba(0, 0, 0, 0.6);
                color: #fff;
                font-size: 9px;
                padding: 1px 3px;
                border-radius: 3px;
                font-family: monospace;
                z-index: 5;
                cursor: help;
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
    
    // Add source badge (content_script or background)
    const sourceBadge = document.createElement('div');
    sourceBadge.className = `source-badge ${video.source || 'background'}`;
    sourceBadge.textContent = video.source === 'content_script' ? 'CS' : 'BG';
    previewContainer.appendChild(sourceBadge);
    
    // Add detection timestamp badge if available (for debugging duplicates)
    if (video.detectionTimestamp) {
        const timestampBadge = document.createElement('div');
        timestampBadge.className = 'detection-timestamp';
        // Format timestamp for display
        const timestampDate = new Date(video.detectionTimestamp);
        const formattedTime = timestampDate.toLocaleTimeString(undefined, { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            fractionalSecondDigits: 3
        });
        timestampBadge.title = `Detected at: ${video.detectionTimestamp}`;
        timestampBadge.textContent = formattedTime;
        previewContainer.appendChild(timestampBadge);
    }
    
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
        // Don't manually request preview generation - it's now handled in the background
        // Just keep the loader spinning until a preview becomes available
        if (video.type === 'blob' && !video.poster) {
            // For blob URLs without a poster, still show the placeholder instead of trying to generate
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
        generatePreview(video.url, loader, previewImage, regenerateButton, true); // Use true for forceRegenerate
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
        mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4s4-1.79 4-4V7h4V3h-6z"/>';
    } else if (mediaContentType === "Video Only") {
        mediaIcon = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/><path d="M9 8h2v8H9zm4 0h2v8h-2z"/>';
    } else {
        mediaIcon = '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>';
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
    
    // Add source indicator to media type container
    const sourceInfo = document.createElement('div');
    sourceInfo.className = `source-info ${video.source || 'background'}`;
    sourceInfo.textContent = video.source === 'content_script' ? 'From Page' : 'From Background';
    mediaTypeContainer.appendChild(sourceInfo);
    
    // Always create codec-info element even if we don't have codec details yet
    const codecInfo = document.createElement('div');
    codecInfo.className = 'codec-info';
    
    if (codecDetails.length > 0) {
        codecInfo.textContent = codecDetails.join(' • ');
    } else {
        // Add a placeholder that will be replaced when metadata is loaded
        codecInfo.textContent = 'Loading codec info...';
        codecInfo.classList.add('loading');
    }
    
    mediaTypeContainer.appendChild(codecInfo);
    fileInfo.appendChild(mediaTypeContainer);
    
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
            
            // Create more descriptive label
            let qualityLabel = 'Original Quality';
            if (video.resolution) {
                qualityLabel = `${video.resolution.height}p`;
                if (video.resolution.fps) {
                    qualityLabel += ` ${video.resolution.fps}fps`;
                }
                if (video.mediaInfo?.hasAudio === false) {
                    qualityLabel += ' (no audio)';
                }
            }
            mainQuality.textContent = qualityLabel;
            qualitySelector.appendChild(mainQuality);
        }
        
        // Add sorted variant qualities with improved labels
        sortedVariants.forEach(variant => {
            const option = document.createElement('option');
            option.value = variant.url;
            
            // Create user-friendly quality label
            let qualityLabel = variant.height ? `${variant.height}p` : 'Alternative Quality';
            
            // Add fps if available
            if (variant.fps) {
                qualityLabel += ` ${variant.fps}fps`;
            }
            
            // Add bandwidth info for better comparison
            if (variant.bandwidth) {
                const mbps = (variant.bandwidth / 1000000).toFixed(1);
                if (mbps > 0) {
                    qualityLabel += ` (${mbps} Mbps)`;
                }
            }
            
            // Add codec info if available
            if (variant.codecs) {
                // Extract main codec name without profile details
                const mainCodec = variant.codecs.split('.')[0];
                if (mainCodec && !qualityLabel.includes(mainCodec)) {
                    qualityLabel += ` - ${mainCodec}`;
                }
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