import { getMediaInfo } from './native-connection.js';

/**
 * Video Model class for handling video metadata
 */
export class VideoModel {
    constructor(data = {}) {
        this.id = data.id || crypto.randomUUID();
        this.title = data.title || '';
        this.url = data.url || '';
        this.thumbnail = data.thumbnail || '';
        this.duration = data.duration || 0;
        this.format = data.format || '';
        this.filesize = data.filesize || 0;
        this.resolution = data.resolution || '';
        this.bitrate = data.bitrate || 0;
        this.audioOnly = data.audioOnly || false;
        this.videoOnly = data.videoOnly || false;
        this.codec = data.codec || '';
        this.container = data.container || '';
        this.source = data.source || '';
        this.alternativeUrls = data.alternativeUrls || [];
        this.metadata = data.metadata || {};
        this.createdAt = data.createdAt || Date.now();
    }

    /**
     * Update video properties
     * @param {Object} data - Video data
     */
    update(data) {
        Object.assign(this, data);
    }

    /**
     * Clone the video model
     * @returns {VideoModel} Cloned model
     */
    clone() {
        return new VideoModel(this);
    }

    /**
     * Get video type
     * @returns {string} Video type (audio|video|both)
     */
    getType() {
        if (this.audioOnly) return 'audio';
        if (this.videoOnly) return 'video';
        return 'both';
    }

    /**
     * Get formatted duration
     * @returns {string} Formatted duration
     */
    getFormattedDuration() {
        if (!this.duration) return '00:00';
        
        const totalSeconds = Math.floor(this.duration);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Get formatted filesize
     * @returns {string} Formatted filesize
     */
    getFormattedFilesize() {
        if (!this.filesize) return 'Unknown size';
        
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = this.filesize;
        let i = 0;
        
        while (size >= 1024 && i < sizes.length - 1) {
            size /= 1024;
            i++;
        }
        
        return `${size.toFixed(2)} ${sizes[i]}`;
    }

    /**
     * Check if video is audio-only based on various indicators
     * @returns {boolean} True if audio-only
     */
    isAudioOnly() {
        // If already determined
        if (this.audioOnly) return true;
        
        // Check URL patterns
        const audioPatterns = [
            /audio_only/i,
            /_audio\./i,
            /\.mp3$/i,
            /\.m4a$/i,
            /\.aac$/i,
            /\.ogg$/i,
            /\.opus$/i,
            /\.wav$/i
        ];
        
        if (audioPatterns.some(pattern => pattern.test(this.url))) {
            return true;
        }
        
        // Check metadata
        if (this.metadata.streams) {
            const hasAudio = this.metadata.streams.some(stream => stream.codec_type === 'audio');
            const hasVideo = this.metadata.streams.some(stream => stream.codec_type === 'video');
            if (hasAudio && !hasVideo) return true;
        }
        
        // Check container type
        const audioContainers = ['mp3', 'aac', 'ogg', 'opus', 'wav', 'm4a'];
        if (this.container && audioContainers.includes(this.container.toLowerCase())) {
            return true;
        }
        
        return false;
    }

    /**
     * Get appropriate file extension based on format
     * @returns {string} File extension
     */
    getFileExtension() {
        // Use container if available
        if (this.container) {
            return this.container.toLowerCase();
        }
        
        // Extract from URL
        const urlMatch = this.url.match(/\.([a-zA-Z0-9]{3,4})(?:\?|$)/);
        if (urlMatch) {
            return urlMatch[1].toLowerCase();
        }
        
        // Default based on audio/video type
        if (this.isAudioOnly()) {
            return 'mp3';
        }
        
        return 'mp4';
    }

    /**
     * Convert to a plain object for storage
     * @returns {Object} Plain object
     */
    toObject() {
        return {
            id: this.id,
            title: this.title,
            url: this.url,
            thumbnail: this.thumbnail,
            duration: this.duration,
            format: this.format,
            filesize: this.filesize,
            resolution: this.resolution,
            bitrate: this.bitrate,
            audioOnly: this.audioOnly || this.isAudioOnly(),
            videoOnly: this.videoOnly,
            codec: this.codec,
            container: this.container,
            source: this.source,
            alternativeUrls: this.alternativeUrls,
            metadata: this.metadata,
            createdAt: this.createdAt
        };
    }

    /**
     * Create from a plain object
     * @param {Object} obj - Plain object
     * @returns {VideoModel} Video model
     */
    static fromObject(obj) {
        return new VideoModel(obj);
    }

    /**
     * Create from array of plain objects
     * @param {Array} arr - Array of plain objects
     * @returns {Array<VideoModel>} Array of video models
     */
    static fromArray(arr) {
        return Array.isArray(arr) ? arr.map(obj => VideoModel.fromObject(obj)) : [];
    }
}

export default VideoModel; 