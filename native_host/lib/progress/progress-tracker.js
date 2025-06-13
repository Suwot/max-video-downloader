/**
 * - Delegates progress calculation to ProgressStrategy
 * - Provides UI-friendly formatting for progress data
 * - Manages initialization and cleanup for progress tracking
 * - Serves as a clean interface between download manager and progress strategy
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
     * @param {number} options.updateInterval Update interval in ms (passed to strategy)
     * @param {boolean} options.debug Enable debug logging
     */
    constructor(options = {}) {
        this.strategy = null;
        this.onProgress = options.onProgress || (() => {});
        this.debug = options.debug || false;
        this.updateInterval = options.updateInterval || 250;

        // Store URLs for progress mapping
        this.masterUrl = null;
        this.downloadUrl = null;
    }

    /**
     * Initialize the progress tracker
     * @param {Object} fileInfo Information about the file being downloaded
     * @param {string} fileInfo.downloadUrl File URL
     * @param {string} fileInfo.masterUrl Master playlist URL (for HLS/DASH)
     * @param {string} fileInfo.type Media type (direct, hls, dash)
     * @param {number} fileInfo.duration Media duration in seconds
     * @param {number} fileInfo.fileSizeBytes File size in bytes
     * @param {number} fileInfo.bitrate Media bitrate in bits per second
     * @param {number} fileInfo.segmentCount Number of segments
     * @param {string} fileInfo.ffprobeOutput Optional FFprobe output for more accurate metadata
     */
    async initialize(fileInfo) {
        this.fileInfo = fileInfo;
        
        // Store URLs for progress mapping
        this.masterUrl = fileInfo.masterUrl || null;
        this.downloadUrl = fileInfo.downloadUrl || null;
        
        logDebug('Progress tracker initializing for:', fileInfo.downloadUrl);
        logDebug('Media type:', fileInfo.type);
        
        // Create progress strategy with our callback wrapper
        this.strategy = new ProgressStrategy({
            onProgress: this.handleProgress.bind(this),
            updateInterval: this.updateInterval,
            ffprobeData: fileInfo.ffprobeOutput,
            ...fileInfo
        });
        
        // Initialize strategy
        const success = await this.strategy.initialize();
        
        if (!success) {
            logDebug('Failed to initialize progress strategy, will use basic tracking');
            return false;
        }
        
        logDebug('Progress strategy initialized successfully');
        return true;
    }

    /**
     * Process FFmpeg output - delegates directly to strategy
     * @param {string} output FFmpeg stderr output
     */
    processOutput(output) {
        if (this.strategy) {
            this.strategy.processOutput(output);
        }
    }

    /**
     * Handle progress update from strategy and add UI formatting
     * @param {Object} data Progress data from strategy
     */
    handleProgress(data) {
        // Add URL mapping for UI
        if (this.masterUrl) {
            data.masterUrl = this.masterUrl;
        }
        if (this.downloadUrl) {
            data.downloadUrl = this.downloadUrl;
        }
        
        // Add ETA calculation if we have sufficient data
        if (data.progress > 0 && data.speed > 0 && data.downloadedBytes > 0) {
            let totalBytes = data.totalBytes;
            
            // Estimate total bytes from progress if not available
            if (!totalBytes || totalBytes <= 0) {
                totalBytes = data.downloadedBytes / (data.progress / 100);
            }
            
            const remainingBytes = Math.max(0, totalBytes - data.downloadedBytes);
            data.eta = remainingBytes / data.speed; // ETA in seconds
        }
        
        // Add formatted values for UI display
        if (data.speed) {
            data.speedFormatted = this.formatSpeed(data.speed);
        }
        
        if (data.downloadedBytes) {
            data.downloadedFormatted = this.formatBytes(data.downloadedBytes);
        }
        
        if (data.totalBytes) {
            data.totalBytesFormatted = this.formatBytes(data.totalBytes);
        }
        
        if (data.currentTime && data.totalDuration) {
            data.timeRemaining = data.totalDuration - data.currentTime;
            data.timeRemainingFormatted = this.formatTime(data.timeRemaining);
            data.currentTimeFormatted = this.formatTime(data.currentTime);
            data.totalDurationFormatted = this.formatTime(data.totalDuration);
        }
        
        if (data.eta) {
            data.etaFormatted = this.formatTime(data.eta);
        }
        
        if (this.debug) {
            logDebug('Progress update:', data);
        }
        
        // Send formatted data to callback
        this.onProgress(data);
    }
    
    /**
     * Get formatted download statistics
     * @returns {Object|null} Formatted download statistics or null if not available
     */
    getDownloadStats() {
        if (!this.strategy || !this.strategy.downloadStats) {
            return null;
        }
        
        const stats = this.strategy.downloadStats;
        const downloadStats = {};
        
        if (stats.videoSize) {
            downloadStats.video = this.formatBytes(stats.videoSize);
        }
        
        if (stats.audioSize) {
            downloadStats.audio = this.formatBytes(stats.audioSize);
        }
        
        if (stats.subtitleSize) {
            downloadStats.subtitle = this.formatBytes(stats.subtitleSize);
        }
        
        if (stats.totalSize) {
            downloadStats.total = this.formatBytes(stats.totalSize);
        }
        
        if (stats.muxingOverhead) {
            downloadStats.muxingOverhead = `${stats.muxingOverhead.toFixed(2)}%`;
        }
        
        return Object.keys(downloadStats).length ? downloadStats : null;
    }
    
    /**
     * Clean up resources
     */
    cleanup() {
        if (this.strategy) {
            this.strategy.cleanup();
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
        if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0 
            ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
            : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
}

module.exports = ProgressTracker;