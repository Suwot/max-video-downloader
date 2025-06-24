import { groupVideosByType, createTypeGroup } from './video-groups.js';
import { getVideos } from '../state.js';

/**
 * Render current videos from state
 */
export function renderVideos() {
    const videos = getVideos();
    const container = document.getElementById('videos');
    
    if (!videos || videos.length === 0) {
        container.innerHTML = `<div class="initial-message">
            <p>No videos found on the page.</p>
            <p>Play a video or Refresh the page.</p>
        </div>`;
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
                font-size: var(--font-body);
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
    
    // Update status badge (isLive, isEncrypted) if applicable
    const previewContainer = videoElement.querySelector('.preview-container');
    if (previewContainer) {
        // Remove any existing status badge
        const existingBadge = previewContainer.querySelector('.status-badge');
        if (existingBadge) {
            existingBadge.remove();
        }
        
        // Create new badge only if needed
        if (updatedVideo.isLive || updatedVideo.isEncrypted) {
            const statusBadge = document.createElement('div');
            statusBadge.className = 'status-badge';
            
            // Add tooltip with encryption type if available
            if (updatedVideo.isEncrypted && updatedVideo.encryptionType) {
                statusBadge.title = `${updatedVideo.encryptionType}`;
            } else if (updatedVideo.isEncrypted) {
                statusBadge.title = 'Encrypted content';
            }
            
            // Add Live text if applicable
            if (updatedVideo.isLive) {
                const liveText = document.createElement('span');
                liveText.className = 'live-text';
                liveText.textContent = 'LIVE';
                statusBadge.appendChild(liveText);
            }
            
            // Add Encrypted lock icon if applicable
            if (updatedVideo.isEncrypted) {
                const lockIcon = document.createElement('span');
                lockIcon.className = 'lock-icon';
                lockIcon.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                    </svg>
                `;
                statusBadge.appendChild(lockIcon);
            }
            
            previewContainer.appendChild(statusBadge);
        }
    }
}