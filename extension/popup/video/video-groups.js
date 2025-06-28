import { getGroupState, setGroupState } from '../index.js';
import { createVideoElement } from './video-item.js';

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
 * Create a group for a specific video type
 * @param {string} type - Video type (hls, dash, etc.)
 * @param {Array} videos - Videos of this type
 * @returns {Promise<HTMLElement>} Group element
 */
export async function createTypeGroup(type, videos) {
    const group = document.createElement('div');
    group.className = 'media-type-group';
    
    // Create header
    const header = document.createElement('div');
    header.className = `section-header collapsible ${type}`;
    const title = document.createElement('h2');
    title.className = 'section-title';
    title.innerHTML = `
        ${type.toUpperCase()}
        <span class="section-count">${videos.length}</span>
    `;
    const toggle = document.createElement('div');
    toggle.className = 'section-toggle';
    toggle.innerHTML = `
        <svg viewBox="0 0 20 20" width="16" height="16">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
        </svg>
    `;
    
    // Get current group state
    const isCollapsed = await getGroupState(type);
    if (isCollapsed) {
        toggle.classList.add('collapsed');
    }
    header.append(title, toggle);
    
    // Create content
    const content = document.createElement('div');
    content.className = 'media-type-content';
    if (isCollapsed) {
        content.classList.add('collapsed');
    }
    
    // Add videos to group
    videos.forEach(video => {
        const videoElement = createVideoElement(video, group);
        content.appendChild(videoElement);
    });
    
    // Toggle event
    header.addEventListener('click', async () => {
        toggle.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
        // Update and save state
        await setGroupState(type, content.classList.contains('collapsed'));
    });
    
    group.append(header, content);
    return group;
}
