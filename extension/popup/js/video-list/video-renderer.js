import { groupVideosByType, createTypeGroup } from './video-groups.js';

/**
 * Render a list of videos in the UI
 * @param {Array} videos - Videos to render
 */
export async function renderVideos(videos) {
    const container = document.getElementById('videos');
    
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
 * Update a video element with the latest video data
 * This is a unified handler for all video updates (preview and/or metadata)
 * @param {string} url - Video URL
 * @param {Object} updatedVideo - Complete updated video object
 * @param {boolean} [isMetadataOnly=false] - If true, updatedVideo is treated as mediaInfo object
 */
export async function updateVideoElement(url, updatedVideo, isMetadataOnly = false) {
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
                    
                    // Import the hover preview functions if needed
                    const { showHoverPreview, hideHoverPreview } = await import('./preview-hover.js');
                    
                    previewContainer.addEventListener('mouseenter', (event) => showHoverPreview(newPreviewUrl, event));
                    previewContainer.addEventListener('mousemove', (event) => showHoverPreview(newPreviewUrl, event));
                    previewContainer.addEventListener('mouseleave', hideHoverPreview);
                }
            }
        }
    }
    
    // Update details drawer if it's open
    const detailsDrawer = videoElement.querySelector('.details-drawer');
    const toggleBtn = videoElement.querySelector('.details-toggle-btn');
    
    if (detailsDrawer && toggleBtn && toggleBtn.dataset.expanded === 'true') {
        // Get the video type from the details drawer or fallback to the type badge
        const videoTypeBadge = videoElement.querySelector('.type-badge');
        const videoType = videoTypeBadge ? videoTypeBadge.textContent.toLowerCase() : 'unknown';
        
        // Clear the drawer and rerender with updated data
        detailsDrawer.innerHTML = '';
        
        // Import the function to render details content
        const { renderDetailsContent } = await import('./video-type-renderers.js');
        renderDetailsContent(detailsDrawer, updatedVideo, videoType);
    }
}

