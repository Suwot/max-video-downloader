import { getBaseUrl } from './utilities.js';
import { setVideoGroups } from './state.js';

/**
 * Check if two videos should be grouped together
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @returns {boolean} True if videos should be grouped
 */
export function shouldGroupVideos(video1, video2) {
    // Check if it's the same base URL (ignoring quality parameters)
    const baseUrl1 = getBaseUrl(video1.url);
    const baseUrl2 = getBaseUrl(video2.url);
    
    // Group together if same base URL and both have resolution info
    return (baseUrl1 === baseUrl2) && 
           video1.resolution && video2.resolution && 
           (video1.resolution.width !== video2.resolution.width || 
            video1.resolution.height !== video2.resolution.height);
}

/**
 * Group videos by resolution
 * @param {Array} videos - Videos to group
 * @returns {Array} Grouped videos
 */
export function groupVideos(videos) {
    const groupedVideos = [];
    const processed = new Set();
    
    // First pass: find groups
    for (let i = 0; i < videos.length; i++) {
        if (processed.has(i)) continue;
        
        const video = videos[i];
        const group = [video];
        processed.add(i);
        
        // Look for related videos
        for (let j = i + 1; j < videos.length; j++) {
            if (processed.has(j)) continue;
            
            const otherVideo = videos[j];
            if (shouldGroupVideos(video, otherVideo)) {
                group.push(otherVideo);
                processed.add(j);
            }
        }
        
        if (group.length > 1) {
            // Create a group entry
            const baseVideo = { ...group[0] };
            // Sort resolutions from highest to lowest
            baseVideo.resolutionOptions = group
                .sort((a, b) => {
                    if (!a.resolution || !b.resolution) return 0;
                    return (b.resolution.height - a.resolution.height);
                })
                .map(v => ({
                    url: v.url,
                    width: v.resolution?.width,
                    height: v.resolution?.height,
                    fps: v.resolution?.fps
                }));
            groupedVideos.push(baseVideo);
        } else {
            groupedVideos.push(video);
        }
    }
    
    return groupedVideos;
}

/**
 * Group videos by type (HLS, DASH, etc.)
 * @param {Array} videos - Videos to group
 * @returns {Object} Videos grouped by type
 */
export function groupVideosByType(videos) {
    const groups = {
        hls: [],
        dash: [],
        direct: [],
        audio: [],
        blob: [],
        unknown: []
    };
    
    if (!videos || videos.length === 0) return groups;
    
    videos.forEach(video => {
        const type = video.type || 'unknown';
        if (groups[type]) {
            groups[type].push(video);
        } else {
            groups.unknown.push(video);
        }
    });
    
    // Store in state for access elsewhere
    setVideoGroups(groups);
    
    return groups;
} 