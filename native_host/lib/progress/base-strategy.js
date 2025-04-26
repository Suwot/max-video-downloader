/**
 * @ai-guide-component BaseProgressStrategy
 * @ai-guide-description Base class for all progress tracking strategies
 * @ai-guide-responsibilities
 * - Provides common interface for all progress tracking strategies
 * - Handles basic progress data processing
 * - Implements core strategy pattern functionality
 */

// lib/progress/base-strategy.js
const { logDebug } = require('../../utils/logger');

/**
 * Base class for all progress tracking strategies
 */
class BaseProgressStrategy {
    /**
     * Create a new progress strategy
     * @param {Object} options Configuration options
     * @param {Function} options.onProgress Progress callback function
     */
    constructor(options = {}) {
        this.onProgress = options.onProgress || (() => {});
        this.lastUpdate = Date.now();
        this.updateInterval = options.updateInterval || 250;
        this.url = options.url;
        this.type = options.type;
        this.debug = options.debug || false;
        
        // Track state for progress calculation
        this.startTime = Date.now();
        this.lastBytes = 0;
        this.totalSize = null;
        this.totalDuration = null;
        this.bitrateHistory = [];
        this.progressHistory = [];
        this.confidenceLevel = 0; // 0-1: how confident we are in our progress calculation
    }

    /**
     * Initialize the strategy with any async operations
     * @param {Object} options Optional configuration parameters
     * @returns {Promise<boolean>} Success indicator
     */
    async initialize(options = {}) {
        // To be implemented by subclasses
        return true;
    }

    /**
     * Update progress based on new data
     * @param {Object} data Progress data from FFmpeg
     */
    update(data) {
        // To be implemented by subclasses
        this.sendProgress({
            progress: 0,
            speed: 0,
            downloaded: 0,
            ...data
        });
    }

    /**
     * Process raw FFmpeg output
     * @param {string} output Raw FFmpeg stderr output
     */
    processOutput(output) {
        // To be implemented by subclasses
    }

    /**
     * Send progress update through callback
     * @param {Object} data Progress data
     */
    sendProgress(data) {
        const now = Date.now();
        
        // Add confidence level to progress data
        data.confidence = this.confidenceLevel;
        
        // Send progress update through callback
        if (this.onProgress) {
            this.onProgress(data);
        }
        
        // Record progress history for smoothing
        this.progressHistory.push({
            time: now,
            progress: data.progress,
            bytes: data.downloaded
        });
        
        // Keep history limited to avoid memory issues
        if (this.progressHistory.length > 20) {
            this.progressHistory.shift();
        }
        
        // Debug log
        if (this.debug) {
            logDebug(`[${this.constructor.name}] Progress: ${data.progress}%, Confidence: ${this.confidenceLevel}`);
        }
    }

    /**
     * Calculate smoothed progress to avoid jumps
     * @param {number} newProgress Raw new progress value
     * @returns {number} Smoothed progress value
     */
    smoothProgress(newProgress) {
        if (this.progressHistory.length === 0) {
            return newProgress;
        }
        
        // Use weighted average with more weight on newer values
        const totalWeight = this.progressHistory.length * (this.progressHistory.length + 1) / 2;
        let weightedSum = 0;
        
        this.progressHistory.forEach((entry, index) => {
            const weight = index + 1;
            weightedSum += entry.progress * weight;
        });
        
        // Add the new value with highest weight
        const newWeight = this.progressHistory.length + 1;
        weightedSum += newProgress * newWeight;
        
        return weightedSum / (totalWeight + newWeight);
    }

    /**
     * Parse time from FFmpeg output
     * @param {string} output FFmpeg output
     * @returns {number|null} Time in seconds or null if not found
     */
    parseTime(output) {
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+.\d+)/);
        if (timeMatch) {
            const [_, hours, minutes, seconds] = timeMatch;
            return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
        }
        
        // Alternative format (seconds.ms)
        const altTimeMatch = output.match(/time=(\d+).(\d+)/);
        if (altTimeMatch) {
            return parseFloat(altTimeMatch[1] + '.' + altTimeMatch[2]);
        }
        
        return null;
    }

    /**
     * Parse size from FFmpeg output
     * @param {string} output FFmpeg output
     * @returns {number|null} Size in bytes or null if not found
     */
    parseSize(output) {
        // Match "size=   12345kB"
        const sizeMatch = output.match(/size=\s*(\d+)kB/);
        if (sizeMatch) {
            return parseInt(sizeMatch[1]) * 1024;
        }
        
        // Alternative format with MB
        const altSizeMatch = output.match(/size=\s*(\d+(\.\d+)?)([kM])B/);
        if (altSizeMatch) {
            const size = parseFloat(altSizeMatch[1]);
            if (altSizeMatch[3] === 'M') {
                return size * 1024 * 1024;
            }
            return size * 1024;
        }
        
        return null;
    }

    /**
     * Record bitrate for estimation purposes
     * @param {number} timeInSeconds Current time position
     * @param {number} bytesDownloaded Bytes downloaded
     */
    recordBitrate(timeInSeconds, bytesDownloaded) {
        if (timeInSeconds > 0 && bytesDownloaded > 0) {
            const bitrate = bytesDownloaded / timeInSeconds;
            this.bitrateHistory.push({
                time: Date.now(),
                bitrate: bitrate
            });
            
            // Keep history limited
            if (this.bitrateHistory.length > 10) {
                this.bitrateHistory.shift();
            }
        }
    }

    /**
     * Get average bitrate from history
     * @returns {number} Average bitrate in bytes per second
     */
    getAverageBitrate() {
        if (this.bitrateHistory.length === 0) {
            return 0;
        }
        
        // Calculate weighted average with more weight on recent values
        const totalWeight = this.bitrateHistory.length * (this.bitrateHistory.length + 1) / 2;
        let weightedSum = 0;
        
        this.bitrateHistory.forEach((entry, index) => {
            const weight = index + 1;
            weightedSum += entry.bitrate * weight;
        });
        
        return weightedSum / totalWeight;
    }
}

module.exports = BaseProgressStrategy;