// Shared utility functions for video processing

// Format file size bytes to human readable format
export function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    // Different decimal precision based on size unit
    let decimals;
    switch (sizes[i]) {
        case 'GB':
            decimals = 2;
            break;
        case 'MB':
            decimals = 1;
            break;
        default: // KB and B
            decimals = 0;
    }
    
    return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

// Standardize video resolution to common formats
export function standardizeResolution(height) { 
    if (height >= 4320) return '4320p';
    if (height >= 2160) return '2160p';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
    if (height >= 240) return '240p';
    if (height >= 144) return '144p';
    return `${height}p`; // Fallback
}

// Format duration in seconds to HH:MM:SS or MM:SS format
export function formatDuration(seconds) {
    if (!seconds) return '';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// time formatter for dl progress
export function formatTime(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)} s`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')} m`;
    } else if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.round(seconds % 60);
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')} h`;
    } else {
        const days = Math.floor(seconds / 86400);
        return `${days} d`;
    }
}

// formats bitrate in kbps or Mbps
export function formatBitrate(kbps) {
    if (typeof kbps !== 'number' || isNaN(kbps)) return 'Unknown';
    if (kbps < 0) return 'Invalid';

    return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps} kbps`;
}

// Extract filename (without extension) from URL
export function getFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        let filename = urlObj.pathname.split('/').pop() || '';

        // Decode URI components
        try {
            filename = decodeURIComponent(filename);
        } catch (e) {
            // fallback: keep as-is
        }

        // Remove query parameters and fragments
        filename = filename.split(/[?#]/)[0];

        // Only proceed if it looks like a file
        if (!/\.\w{2,5}$/.test(filename)) {
            return 'video';
        }

        // Remove extension if present
        const dotIndex = filename.lastIndexOf('.');
        if (dotIndex > 0) {
            filename = filename.substring(0, dotIndex);
        }

        return filename || 'video';
    } catch (e) {
        return 'video';
    }
}

// Normalize URL to prevent duplicates
export function normalizeUrl(url) {
    // Quick return for empty URLs
    if (!url) return url;
    
    try {
        const urlObj = new URL(url);
        
        // Remove hash fragments - 100% safe, never affects server response
        urlObj.hash = '';
        
        // Special handling for Yandex streaming URLs - strip all query params
        if (urlObj.hostname === 'streaming.disk.yandex.net' && urlObj.pathname.startsWith('/hls/')) {
            urlObj.search = '';
            return urlObj.toString();
        }
        
        // Remove only 100% guaranteed safe tracking parameters for other URLs
        const safeToRemoveParams = [
            // UTM tracking parameters - universally safe to remove
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            // Click tracking IDs - safe to remove
            'fbclid', 'gclid', 'msclkid'
        ];
        
        safeToRemoveParams.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
            }
        });
        
        return urlObj.toString();
    } catch {
        return url;
    }
}

// Get base directory for a URL
export function getBaseDirectory(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
    } catch {
        return '';
    }
}

// Parse codec string to extract base codec identifiers. Codec string (e.g., "avc1.640028,mp4a.40.2")
export function parseCodecs(codecString) {
    if (!codecString) return [];
    
    return codecString.split(',')
        .map(codec => codec.trim().split('.')[0])
        .filter(codec => codec.length > 0);
}

// Format resolution with optional FPS
export function formatResolutionWithFps(resolution, fps) {
    const resString = typeof resolution === 'number' ? `${resolution}p` : resolution;
    return (fps && fps !== 30) ? `${resString}${fps}` : resString;
}

// Generate a short hash-based ID from a URL for UI matching
export function generateId(url) {
    // Simple hash function for consistent short IDs
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Convert to positive hex string and truncate to 8 characters
    return Math.abs(hash).toString(16).substring(0, 8);
}

/**
 * Build track label for video tracks
 * @param {Object} track - Track data
 * @param {string} type - Track type ('video', 'audio', 'subtitle')
 * @param {string} videoType - Video type ('hls', 'dash', 'direct')
 * @returns {string} Formatted track label
 */
export function buildTrackLabel(track, type, videoType) {
    if (type === 'video') {
        let res, fps, fileSizeBytes, codecs;
        
        if (videoType === 'hls' && track.metaJS) {
            // HLS video track structure
            res = track.metaJS.standardizedResolution || null;
            fps = track.metaJS.fps || null;
            fileSizeBytes = track.metaJS.estimatedFileSizeBytes;
            codecs = track.metaJS.codecs ? parseCodecs(track.metaJS.codecs).join(' & ') : null;
        } else if (videoType === 'dash') {
            // DASH video track structure
            res = track.standardizedResolution || null;
            fps = track.frameRate || null;
            fileSizeBytes = track.estimatedFileSizeBytes;
            codecs = track.codecs ? parseCodecs(track.codecs).join(' & ') : null;
        } else {
            // Direct video track structure
            res = track.standardizedResolution || null;
            fps = track.metaFFprobe?.fps || null;
            fileSizeBytes = track.fileSize || track.estimatedFileSizeBytes;
            codecs = track.codecs ? parseCodecs(track.codecs).join(' & ') : null;
            
            // For direct videos, try to get codec from FFprobe
            if (!codecs && track.metaFFprobe) {
                const videoCodec = track.metaFFprobe.videoCodec?.name;
                const audioCodec = track.metaFFprobe.audioCodec?.name;
                const audioChannels = track.metaFFprobe.audioCodec?.channels;
                
                if (videoCodec && audioCodec && audioChannels) {
                    codecs = `${videoCodec} & ${audioCodec} (${audioChannels}ch)`;
                } else if (videoCodec && audioCodec) {
                    codecs = `${videoCodec} & ${audioCodec}`;
                } else {
                    codecs = videoCodec || audioCodec || null;
                }
            }
        }
        
        const formattedResolution = formatResolutionWithFps(res, fps);
        const formattedSize = fileSizeBytes ? formatSize(fileSizeBytes) : null;
        
        return [formattedResolution, formattedSize, codecs]
            .filter(Boolean)
            .join(' • ') || 'Unknown Quality';
            
    } else if (type === 'audio') {
        let language, channels, fileSizeBytes, codecs;
        
        if (videoType === 'hls' && track.name !== undefined) {
            // HLS audio track structure
            language = track.default ? `${track.name || track.language}*` : 
                      (track.name || track.language);
            channels = track.channels || null;
            fileSizeBytes = null; // HLS audio tracks don't have individual file sizes
            codecs = null; // HLS audio codecs not specified in master
        } else {
            // DASH audio track structure
            language = track.default ? `${track.label || track.lang}*` : 
                      (track.label || track.lang);
            channels = track.channels ? `${track.channels}ch` : null;
            fileSizeBytes = track.estimatedFileSizeBytes;
            codecs = track.codecs ? parseCodecs(track.codecs)[0] : null;
        }
        
        const formattedSize = fileSizeBytes ? formatSize(fileSizeBytes) : null;
        
        return [language, channels, formattedSize, codecs]
            .filter(Boolean)
            .join(' • ');
            
    } else if (type === 'subtitle') {
        let language;
        
        if (videoType === 'hls' && track.name !== undefined) {
            // HLS subtitle track structure
            language = track.default ? `${track.name || track.language || 'Subtitle'}*` : 
                      (track.name || track.language || 'Subtitle');
        } else {
            // DASH subtitle track structure
            language = track.default ? `${track.label || track.lang || 'Subtitle'}*` : 
                      (track.label || track.lang || 'Subtitle');
        }
        
        return language;
    }
    
    return 'Unknown';
}