/**
 * @ai-guide-component ProgressTracker
 * @ai-guide-description Tracks download progress using a unified strategy
 * @ai-guide-responsibilities
 * - Calculates download progress percentage for different media types
 * - Provides accurate progress reporting for the UI
 * - Handles different file types (direct media, HLS/DASH streams)
 * - Uses extension-provided metadata for efficient progress tracking
 */

const { logDebug } = require('../../utils/logger');
const ProgressStrategy = require('./progress-strategy');

/**
 * Progress Tracker class - manages tracking download progress
 */
class ProgressTracker {
    /**
     * Create a new progress tracker
     * @param {Object} options Configuration options
     * @param {Function} options.onProgress Callback for progress updates
     */
    constructor(options = {}) {
        this.strategy = null;
        this.onProgress = options.onProgress || (() => {});
        this.lastUpdate = 0;
        this.updateInterval = options.updateInterval || 250; // Default 250ms between updates
        this.startTime = Date.now();
        this.lastBytes = 0;
        this.debug = options.debug || false;
    }

    /**
     * Initialize the progress tracker
     * @param {Object} fileInfo Information about the file being downloaded
     * @param {string} fileInfo.downloadUrl File URL
     * @param {string} fileInfo.type Media type (direct, hls, dash)
     * @param {number} fileInfo.duration Media duration in seconds
     * @param {number} fileInfo.fileSizeBytes File size in bytes
     * @param {number} fileInfo.bitrate Media bitrate in bits per second
     * @param {number} fileInfo.segmentCount Number of segments
     * @param {number} fileInfo.segmentDuration Average segment duration
     * @param {string} fileInfo.ffprobeOutput Optional FFprobe output for more accurate metadata
     */
    async initialize(fileInfo) {
        this.fileInfo = fileInfo;
        this.startTime = Date.now();
        this.lastBytes = 0;
        
        logDebug('Progress tracker initializing for:', fileInfo.downloadUrl);
        logDebug('Media type:', fileInfo.type);
        
        // Extract FFprobe output if available
        let ffprobeData = null;
        if (fileInfo.ffprobeOutput) {
            ffprobeData = fileInfo.ffprobeOutput;
        }
        // For direct videos, check if we have duration/bitrate from ffprobe but no size
        else if (fileInfo.type === 'direct' && fileInfo.probeDuration > 0 && !fileInfo.fileSizeBytes) {
            // If we have a probe duration and bitrate but no size, we can estimate it
            if (fileInfo.bitrate > 0) {
                const estimatedSize = Math.ceil((fileInfo.bitrate * fileInfo.probeDuration) / 8);
                logDebug(`Progress tracker: Estimated file size ${estimatedSize} bytes based on probe duration and bitrate`);
                fileInfo.fileSizeBytes = estimatedSize;
            }
        }
        
        // Create progress strategy
        this.strategy = new ProgressStrategy({
            onProgress: this.handleProgress.bind(this),
            updateInterval: this.updateInterval,
            ffprobeData,
            ...fileInfo
        });
        
        // Initialize strategy
        const success = await this.strategy.initialize();
        
        if (!success) {
            logDebug('Failed to initialize progress strategy, will use basic tracking');
        } else {
            logDebug('Progress strategy initialized successfully');
        }
        
        // Send initial progress
        this.update({
            progress: 0,
            speed: 0,
            downloaded: 0,
            size: fileInfo.fileSizeBytes || 0,
            totalBytes: fileInfo.fileSizeBytes || 0,
            totalDuration: fileInfo.duration || 0,
            type: fileInfo.type
        });

        logDebug('Progress tracker initialized for:', fileInfo.downloadUrl);
        return success;
    }

    /**
     * Update progress based on current data
     * @param {Object} progressData Progress data
     */
    update(progressData) {
        const now = Date.now();
        
        // Rate limit updates
        if (now - this.lastUpdate < this.updateInterval) {
            return;
        }
        
        this.lastUpdate = now;
        
        // If we have an active strategy, use it
        if (this.strategy && this.strategy.update) {
            this.strategy.update(progressData);
        } else {
            // Otherwise pass through data directly
            this.handleProgress(progressData);
        }
    }

    /**
     * Process FFmpeg output to extract progress information
     * @param {string} output FFmpeg stderr output
     */
    processOutput(output) {
        if (this.strategy && this.strategy.processOutput) {
            this.strategy.processOutput(output);
        }
    }

    /**
     * Handle progress update from strategy
     * @param {Object} data Progress data
     */
    handleProgress(data) {
        // Add estimated time remaining if we have enough info
        if (typeof data.progress === 'number' && data.progress > 0 && data.speed > 0 && data.downloaded > 0) {
            let totalBytes;
            
            // Direct access to totalBytes when available
            if (data.totalBytes && data.totalBytes > 0) {
                totalBytes = data.totalBytes;
            } else if (data.size && data.size > 0) {
                totalBytes = data.size;
            } else if (data.totalFileSize && data.totalFileSize > 0) {
                totalBytes = data.totalFileSize;
            } else {
                // Only use progress-based estimation if we don't have better data
                totalBytes = data.downloaded / (data.progress / 100);
            }
            
            const remainingBytes = Math.max(0, totalBytes - data.downloaded);
            data.eta = remainingBytes / data.speed; // ETA in seconds
        }
        
        // Add useful formatted values for UI display
        if (data.speed) {
            data.speedFormatted = this.formatSpeed(data.speed);
        }
        
        if (data.downloaded) {
            data.downloadedFormatted = this.formatBytes(data.downloaded);
        }
        
        if (data.totalBytes) {
            data.totalBytesFormatted = this.formatBytes(data.totalBytes);
        } else if (data.size) {
            data.totalBytesFormatted = this.formatBytes(data.size);
        }
        
        // Add FFmpeg-specific formatted information
        if (data.ffmpegSpeed) {
            data.ffmpegSpeedFormatted = `${data.ffmpegSpeed.toFixed(1)}x`;
        }
        
        if (data.bitrate) {
            data.bitrateFormatted = `${Math.round(data.bitrate / 1000)} kbps`;
        }
        
        // Format stream stats for the final message if available
        if (data.streamInfo) {
            data.streamStats = {};
            
            if (data.streamInfo.videoSize) {
                data.streamStats.video = this.formatBytes(data.streamInfo.videoSize);
            }
            
            if (data.streamInfo.audioSize) {
                data.streamStats.audio = this.formatBytes(data.streamInfo.audioSize);
            }
            
            if (data.streamInfo.subtitleSize) {
                data.streamStats.subtitle = this.formatBytes(data.streamInfo.subtitleSize);
            }
            
            if (data.streamInfo.muxingOverhead) {
                data.streamStats.muxingOverhead = `${data.streamInfo.muxingOverhead.toFixed(2)}%`;
            }
        }
        
        if (data.currentTime && data.totalDuration) {
            data.timeRemaining = data.totalDuration - data.currentTime;
            data.timeRemainingFormatted = this.formatTime(data.timeRemaining);
            data.currentTimeFormatted = this.formatTime(data.currentTime);
            data.totalDurationFormatted = this.formatTime(data.totalDuration);
        }
        
        if (this.debug) {
            logDebug('Progress update:', data);
        }
        
        // Call the progress callback
        if (this.onProgress) {
            this.onProgress(data);
        }
    }
    
    /**
     * Format bytes to human readable string
     * @param {number} bytes Bytes
     * @returns {string} Formatted string
     */
    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }
    
    /**
     * Format speed to human readable string
     * @param {number} bytesPerSecond Bytes per second
     * @returns {string} Formatted string
     */
    formatSpeed(bytesPerSecond) {
        return `${this.formatBytes(bytesPerSecond)}/s`;
    }
    
    /**
     * Format time to human readable string
     * @param {number} seconds Time in seconds
     * @returns {string} Formatted string
     */
    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0 
            ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
            : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
}

// Export the progress tracker
module.exports = ProgressTracker;