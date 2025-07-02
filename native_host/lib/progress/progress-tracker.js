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
     * @param {boolean} fileInfo.audioOnly Whether this is an audio-only download
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
     * Handle progress update from strategy and add URL mapping
     * @param {Object} data Progress data from strategy (already rounded)
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
            data.eta = Math.round(remainingBytes / data.speed); // Round ETA calculation
        }
        
        // Add rounded timeRemaining if we have duration data
        if (data.currentTime && data.totalDuration) {
            data.timeRemaining = Math.round(data.totalDuration - data.currentTime);
        }
        
        if (this.debug) {
            logDebug('Progress update:', data);
        }
        
        // Send data to callback (no additional rounding needed)
        this.onProgress(data);
    }
    
    /**
     * Get download statistics without formatting
     * @returns {Object|null} Raw download statistics or null if not available
     */
    getDownloadStats() {
        if (!this.strategy || !this.strategy.downloadStats) {
            return null;
        }
        
        const stats = this.strategy.downloadStats;
        const downloadStats = {};
        
        if (stats.videoSize) {
            downloadStats.videoSize = stats.videoSize;
        }
        
        if (stats.audioSize) {
            downloadStats.audioSize = stats.audioSize;
        }
        
        if (stats.subtitleSize) {
            downloadStats.subtitleSize = stats.subtitleSize;
        }
        
        if (stats.totalSize) {
            downloadStats.totalSize = stats.totalSize;
        }
        
        if (stats.muxingOverhead) {
            downloadStats.muxingOverhead = stats.muxingOverhead;
        }

        if (stats.bitrateKbps) {
            downloadStats.bitrateKbps = stats.bitrateKbps;
        }
        
        return Object.keys(downloadStats).length ? downloadStats : null;
    }
    
    // FFmpeg final message or null if not available
    getFFmpegFinalMessage() {
        if (!this.strategy || !this.strategy.ffmpegFinalMessage) {
            return null;
        }
        
        return this.strategy.ffmpegFinalMessage.trim();
    }
    
    /**
     * Get media duration
     * @returns {number|null} Duration in seconds or null if not available
     */
    getDuration() {
        // Return duration from fileInfo (which includes both initial and probed duration)
        return this.fileInfo?.duration || null;
    }
    
    /**
     * Get derived error message from collected error lines
     * @returns {string|null} Consolidated error message or null if no errors collected
     */
    getDerivedErrorMessage() {
        if (!this.strategy || !this.strategy.getDerivedErrorMessage) {
            return null;
        }
        
        const derivedError = this.strategy.getDerivedErrorMessage();
        return derivedError ? derivedError.trim() : null;
    }
    
    /**
     * Clean up resources
     */
    cleanup() {
        if (this.strategy) {
            this.strategy.cleanup();
        }
    }
}

module.exports = ProgressTracker;