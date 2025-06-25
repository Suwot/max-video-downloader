import { groupVideosByType, createTypeGroup } from './video-groups.js';
import { getVideos } from '../state.js';

/**
 * Render current videos from state
 */
export async function renderVideos() {
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
    
    // Create type groups (now async)
    for (const [type, typeVideos] of Object.entries(videoGroups)) {
        if (typeVideos.length === 0) continue;
        
        const group = await createTypeGroup(type, typeVideos);
        fragment.appendChild(group);
    }
    
    container.innerHTML = `<div class="initial-message">
            <p>No videos found on the page.</p>
            <p>Play a video or Refresh the page.</p>
        </div>`;
    container.prepend(fragment);
    
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