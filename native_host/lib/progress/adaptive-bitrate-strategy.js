/**
 * @ai-guide-component AdaptiveBitrateStrategy
 * @ai-guide-description Progress tracking based on adaptive bitrate estimation
 * @ai-guide-responsibilities
 * - Analyzes download speed and media duration to estimate total size
 * - Provides reasonably accurate progress reporting for streaming media
 * - Adapts to changing network conditions during download
 * - Serves as a reliable fallback when content-length is unavailable
 */

// lib/progress/adaptive-bitrate-strategy.js
const BaseProgressStrategy = require('./base-strategy');
const { logDebug } = require('../../utils/logger');

/**
 * Progress strategy that uses adaptive bitrate estimation
 */
class AdaptiveBitrateStrategy extends BaseProgressStrategy {
    /**
     * Create a new adaptive bitrate strategy
     * @param {Object} options Configuration options
     */
    constructor(options) {
        super(options);
        this.estimatedTotalSize = null;
        this.dataPoints = [];
        this.lastTimeReported = 0;
        this.lastSizeReported = 0;
        this.avgBitrate = null;
    }

    /**
     * Initialize the strategy
     * @param {Object} options Options object
     * @returns {Promise<boolean>} True if successful
     */
    async initialize(options = {}) {
        // Try to get duration from options or fetch it
        if (options.duration) {
            this.totalDuration = options.duration;
            this.confidenceLevel = 0.6;
        } else if (options.url) {
            try {
                // We'll get duration dynamically as FFmpeg processes the media
                this.confidenceLevel = 0.4;
            } catch (error) {
                logDebug('Error fetching duration:', error);
            }
        }
        
        return true;
    }

    /**
     * Update progress based on FFmpeg output data
     * @param {Object} data Progress data
     */
    update(data) {
        // Extract relevant data
        const currentTime = data.currentTime || 0;
        const downloaded = data.downloaded || 0;
        const totalDuration = data.totalDuration || this.totalDuration;

        // Store current time and downloaded bytes
        if (currentTime > 0) {
            this.lastTimeReported = currentTime;
        }
        
        if (downloaded > 0) {
            this.lastSizeReported = downloaded;
        }
        
        // Update total duration if we received it
        if (totalDuration && totalDuration > 0) {
            this.totalDuration = totalDuration;
        }
        
        // If we have current time and downloaded bytes, add a data point
        if (currentTime > 5 && downloaded > 0) {
            this.dataPoints.push({
                time: currentTime,
                bytes: downloaded,
                timestamp: Date.now()
            });
            
            // Keep dataPoints manageable - keep more recent points
            if (this.dataPoints.length > 15) {
                this.dataPoints.shift();
            }
            
            // Also record bitrate for our base class
            this.recordBitrate(currentTime, downloaded);
        }
        
        // Calculate progress
        let progress = this.calculateProgress(currentTime, downloaded, totalDuration);
        
        // Smooth progress to avoid jumps
        progress = this.smoothProgress(progress);
        
        // Send progress update
        this.sendProgress({
            ...data,
            progress: Math.round(progress)
        });
    }
    
    /**
     * Calculate progress based on time, downloaded bytes and duration
     * @param {number} currentTime Current playback time in seconds
     * @param {number} downloaded Downloaded bytes
     * @param {number} totalDuration Total duration in seconds
     * @returns {number} Progress percentage (0-100)
     */
    calculateProgress(currentTime, downloaded, totalDuration) {
        // Calculate adaptive bitrate only if we have multiple data points
        if (this.dataPoints.length >= 2) {
            this.calculateAdaptiveBitrate();
        }
        
        let progress = 0;
        
        // If we have duration, we can calculate progress based on time
        if (totalDuration && totalDuration > 0 && currentTime > 0) {
            // Don't allow currentTime to exceed totalDuration
            const safeTime = Math.min(currentTime, totalDuration);
            const timeProgress = (safeTime / totalDuration) * 100;
            
            // If we have a bitrate estimate, we can be more accurate with a hybrid approach
            if (this.avgBitrate && this.avgBitrate > 0 && downloaded > 0) {
                this.estimatedTotalSize = totalDuration * this.avgBitrate;
                const sizeProgress = (downloaded / this.estimatedTotalSize) * 100;
                
                // Improved weighting formula that gives more weight to time early on
                // and transitions to size-based progress as we download more
                // This creates a more natural and consistent progress experience
                
                // Weight formula: Start with emphasis on time-based progress (80/20)
                // and gradually transition to a more balanced approach (40/60)
                // as we get further into the download
                const downloadRatio = safeTime / totalDuration;
                const timeWeight = Math.max(0.4, 0.8 - (downloadRatio * 0.4));
                const sizeWeight = 1.0 - timeWeight;
                
                // Calculate weighted progress
                progress = (timeProgress * timeWeight) + (sizeProgress * sizeWeight);
                
                // Higher confidence when we have both time and size data
                this.confidenceLevel = Math.min(0.9, 0.6 + (currentTime / totalDuration) * 0.3);
                
                // Debug log for weighted progress
                logDebug(`Adaptive progress: time=${Math.round(timeProgress)}%, size=${Math.round(sizeProgress)}%, ` +
                         `weighted=${Math.round(progress)}%, weights=[time:${timeWeight.toFixed(2)}, size:${sizeWeight.toFixed(2)}], ` +
                         `confidence=${this.confidenceLevel.toFixed(2)}`);
            } else {
                // Fall back to time-based progress if we don't have a good bitrate estimate
                progress = timeProgress;
                
                // Slightly higher confidence since we have duration
                this.confidenceLevel = Math.min(0.75, 0.5 + (currentTime / totalDuration) * 0.25);
                logDebug(`Time-based progress: ${Math.round(progress)}%, confidence=${this.confidenceLevel.toFixed(2)}`);
            }
        }
        // If we don't have duration but have downloaded bytes and bitrate, estimate progress
        else if (this.avgBitrate && this.avgBitrate > 0 && downloaded > 0) {
            // Use elapsed time since start to estimate progress
            const elapsedSecs = (Date.now() - this.startTime) / 1000;
            if (elapsedSecs > 5) { // Only use this method after 5 seconds
                // Improved estimation formula that's more conservative
                const estimatedTotalTime = (downloaded / this.avgBitrate) * 1.5; // Reduced multiplier from 2 to 1.5
                progress = Math.min(95, (elapsedSecs / estimatedTotalTime) * 100);
                this.confidenceLevel = 0.5; // Moderate confidence without duration
                logDebug(`Bitrate estimation progress: ${Math.round(progress)}%, confidence=0.5`);
            } else {
                // In the first 5 seconds, use a logarithmic scale for better UX
                progress = Math.min(30, 10 * Math.log10(1 + 9 * elapsedSecs / 5));
                this.confidenceLevel = 0.3;
            }
        }
        // Last resort: use time elapsed since start
        else {
            const elapsedSecs = (Date.now() - this.startTime) / 1000;
            // Logarithmic scale gives a better sense of progress
            // Faster initial progress to give better feedback
            progress = Math.min(95, 30 * Math.log10(1 + 9 * elapsedSecs / 60));
            this.confidenceLevel = 0.3;
            logDebug(`Elapsed time progress: ${Math.round(progress)}%, elapsed=${Math.round(elapsedSecs)}s, confidence=0.3`);
        }
        
        // Never exceed 99.9% until we're actually done
        return Math.min(99.9, Math.max(0, progress));
    }
    
    /**
     * Calculate adaptive bitrate based on data points
     */
    calculateAdaptiveBitrate() {
        if (this.dataPoints.length < 2) {
            return;
        }
        
        // Sort data points by time
        this.dataPoints.sort((a, b) => a.time - b.time);
        
        // Calculate bitrates between consecutive data points
        const bitrates = [];
        
        for (let i = 1; i < this.dataPoints.length; i++) {
            const prev = this.dataPoints[i-1];
            const curr = this.dataPoints[i];
            
            const timeDiff = curr.time - prev.time;
            const bytesDiff = curr.bytes - prev.bytes;
            
            if (timeDiff > 0) {
                const bitrate = bytesDiff / timeDiff;
                // Filter out obvious outliers (sudden huge increases)
                if (bitrate > 0 && (bitrates.length === 0 || bitrate < 10 * (bitrates[bitrates.length-1] || bitrate))) {
                    bitrates.push(bitrate);
                }
            }
        }
        
        if (bitrates.length > 0) {
            // Calculate weighted average (more recent values have higher weight)
            const totalWeight = bitrates.length * (bitrates.length + 1) / 2;
            let weightedSum = 0;
            
            bitrates.forEach((bitrate, index) => {
                const weight = index + 1;
                weightedSum += bitrate * weight;
            });
            
            this.avgBitrate = weightedSum / totalWeight;
            
            logDebug(`Calculated average bitrate: ${(this.avgBitrate / 1024).toFixed(1)} KB/s from ${bitrates.length} data points`);
        }
    }
    
    /**
     * Process FFmpeg output to extract progress information
     * @param {string} output FFmpeg stdout/stderr output
     */
    processOutput(output) {
        // Try to extract time and size information from FFmpeg output
        const time = this.parseTime(output);
        const size = this.parseSize(output);
        
        let updateData = {};
        
        if (time !== null) {
            updateData.currentTime = time;
        }
        
        if (size !== null) {
            updateData.downloaded = size;
        }
        
        // Only update if we have new data
        if (Object.keys(updateData).length > 0) {
            this.update(updateData);
        }
        
        // Try to extract duration information
        if (!this.totalDuration) {
            const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1], 10);
                const minutes = parseInt(durationMatch[2], 10);
                const seconds = parseFloat(durationMatch[3]);
                this.totalDuration = hours * 3600 + minutes * 60 + seconds;
                logDebug('Found duration:', this.totalDuration, 'seconds');
            }
        }
    }
}

module.exports = AdaptiveBitrateStrategy;