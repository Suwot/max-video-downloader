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
        this.lastNetworkSpeedCheck = Date.now();
        this.networkSpeedSamples = [];
        this.confidenceAdjustment = 1.0; // Multiplier for confidence based on consistency
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
                
                // Enhanced dynamic weighting algorithm
                // 1. Base weights on download ratio (time elapsed / total duration)
                // 2. Consider network stability (more stable = more weight on size-based)
                // 3. Smooth transition from time to size-based as download progresses
                const downloadRatio = safeTime / totalDuration;
                
                // Calculate network stability factor (0-1)
                const networkStability = this.calculateNetworkStability();
                
                // Enhanced weight calculation with network stability factor
                // Start with more emphasis on time (more reliable early on)
                // Gradually shift to size-based as we progress and if network is stable
                const timeWeight = Math.max(0.3, 0.8 - (downloadRatio * 0.5) - (networkStability * 0.2));
                const sizeWeight = 1.0 - timeWeight;
                
                // Calculate weighted progress
                progress = (timeProgress * timeWeight) + (sizeProgress * sizeWeight);
                
                // Higher confidence when we have both time and size data, adjusted by network stability
                this.confidenceLevel = Math.min(0.95, (0.6 + (downloadRatio * 0.3)) * this.confidenceAdjustment);
                
                // Debug log for weighted progress
                logDebug(`Enhanced adaptive progress: time=${Math.round(timeProgress)}%, size=${Math.round(sizeProgress)}%, ` +
                         `weighted=${Math.round(progress)}%, weights=[time:${timeWeight.toFixed(2)}, size:${sizeWeight.toFixed(2)}], ` +
                         `networkStability=${networkStability.toFixed(2)}, confidence=${this.confidenceLevel.toFixed(2)}`);
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
                // Improved estimation formula with adaptive multiplier
                // The multiplier decreases as we download more, making our estimate more confident
                const progressRatio = Math.min(0.9, elapsedSecs / 180); // Max out at 3 minutes (180 sec)
                const estimationMultiplier = 1.8 - (progressRatio * 0.6); // Starts at 1.8, decreases to 1.2
                
                const estimatedTotalTime = (downloaded / this.avgBitrate) * estimationMultiplier;
                progress = Math.min(95, (elapsedSecs / estimatedTotalTime) * 100);
                
                // Increase confidence as we progress
                this.confidenceLevel = Math.min(0.7, 0.4 + (progressRatio * 0.3));
                
                logDebug(`Enhanced bitrate estimation: progress=${Math.round(progress)}%, ` +
                        `multiplier=${estimationMultiplier.toFixed(2)}, confidence=${this.confidenceLevel.toFixed(2)}`);
            } else {
                // In the first 5 seconds, use a logarithmic scale for better UX
                progress = Math.min(30, 10 * Math.log10(1 + 9 * elapsedSecs / 5));
                this.confidenceLevel = 0.3;
            }
        }
        // Last resort: use time elapsed since start
        else {
            const elapsedSecs = (Date.now() - this.startTime) / 1000;
            // Enhanced logarithmic scale gives a better sense of progress
            // More responsive in the beginning, slows down after initial burst
            progress = Math.min(95, 25 * Math.log10(1 + 10 * elapsedSecs / 60));
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
        let totalVariation = 0;
        let lastBitrate = null;
        
        for (let i = 1; i < this.dataPoints.length; i++) {
            const prev = this.dataPoints[i-1];
            const curr = this.dataPoints[i];
            
            const timeDiff = curr.time - prev.time;
            const bytesDiff = curr.bytes - prev.bytes;
            
            if (timeDiff > 0) {
                const bitrate = bytesDiff / timeDiff;
                
                // Enhanced outlier detection
                // 1. Absolute maximum cap (100MB/s is unreasonable for most connections)
                const maxReasonableBitrate = 100 * 1024 * 1024; // 100MB/s
                
                // 2. Relative to previous values with adaptive threshold
                const isOutlier = 
                    bitrate <= 0 || 
                    bitrate > maxReasonableBitrate ||
                    (bitrates.length > 0 && bitrate > 5 * Math.max(...bitrates)) ||
                    (lastBitrate && (bitrate > lastBitrate * 10 || bitrate < lastBitrate * 0.1));
                
                if (!isOutlier) {
                    bitrates.push(bitrate);
                    
                    // Calculate variation for network stability
                    if (lastBitrate) {
                        const variation = Math.abs(bitrate - lastBitrate) / Math.max(bitrate, lastBitrate);
                        totalVariation += variation;
                    }
                    
                    lastBitrate = bitrate;
                } else {
                    logDebug(`Filtered outlier bitrate: ${(bitrate / 1024 / 1024).toFixed(2)}MB/s`);
                }
            }
        }
        
        if (bitrates.length > 0) {
            // Calculate weighted average with emphasis on more recent points
            // but also taking overall trend into account
            const recentWeight = 0.7; // 70% weight on recent samples
            const trendWeight = 0.3;  // 30% weight on overall trend
            
            // Recent average (last 30% of samples)
            const recentCount = Math.max(1, Math.ceil(bitrates.length * 0.3));
            const recentBitrates = bitrates.slice(-recentCount);
            const recentAvg = recentBitrates.reduce((a, b) => a + b, 0) / recentBitrates.length;
            
            // Overall trend with weighted average
            const totalWeight = bitrates.length * (bitrates.length + 1) / 2;
            let weightedSum = 0;
            
            bitrates.forEach((bitrate, index) => {
                const weight = index + 1;
                weightedSum += bitrate * weight;
            });
            
            const trendAvg = weightedSum / totalWeight;
            
            // Combine recent and trend
            this.avgBitrate = (recentAvg * recentWeight) + (trendAvg * trendWeight);
            
            // Update network speed samples for stability calculation
            this.updateNetworkSpeedSamples(this.avgBitrate);
            
            // Calculate confidence adjustment based on bitrate variation
            if (bitrates.length > 1) {
                const avgVariation = totalVariation / (bitrates.length - 1);
                // Lower confidence if there's high variation
                this.confidenceAdjustment = Math.max(0.8, 1.0 - avgVariation);
            }
            
            logDebug(`Enhanced average bitrate: ${(this.avgBitrate / 1024).toFixed(1)} KB/s from ${bitrates.length} points. ` +
                     `Recent: ${(recentAvg / 1024).toFixed(1)} KB/s, Trend: ${(trendAvg / 1024).toFixed(1)} KB/s, ` +
                     `Confidence adjustment: ${this.confidenceAdjustment.toFixed(2)}`);
        }
    }
    
    /**
     * Update network speed samples for stability calculation
     * @param {number} speed Current speed in bytes/second
     */
    updateNetworkSpeedSamples(speed) {
        const now = Date.now();
        
        // Only sample once every 2 seconds to avoid noise
        if (now - this.lastNetworkSpeedCheck < 2000) {
            return;
        }
        
        this.lastNetworkSpeedCheck = now;
        this.networkSpeedSamples.push(speed);
        
        // Keep history limited
        if (this.networkSpeedSamples.length > 10) {
            this.networkSpeedSamples.shift();
        }
    }
    
    /**
     * Calculate network stability factor (0-1)
     * Higher value means more stable network speed
     * @returns {number} Stability factor between 0-1
     */
    calculateNetworkStability() {
        if (this.networkSpeedSamples.length < 3) {
            return 0.5; // Default to medium stability with few samples
        }
        
        // Calculate coefficient of variation (standard deviation / mean)
        const mean = this.networkSpeedSamples.reduce((a, b) => a + b, 0) / this.networkSpeedSamples.length;
        
        if (mean === 0) return 0.5;
        
        const variance = this.networkSpeedSamples.reduce((acc, speed) => {
            const diff = speed - mean;
            return acc + (diff * diff);
        }, 0) / this.networkSpeedSamples.length;
        
        const stdDev = Math.sqrt(variance);
        const cv = stdDev / mean; // Coefficient of variation
        
        // Convert to stability (lower cv = higher stability)
        // cv of 0 means perfect stability (1.0)
        // cv of 1 or higher means poor stability (0.0)
        const stability = Math.max(0, Math.min(1, 1 - cv));
        
        return stability;
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
        
        // Try to extract duration information with improved regex patterns
        if (!this.totalDuration) {
            // Standard format: Duration: 00:12:34.56
            let durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
            
            // Alternative formats
            if (!durationMatch) {
                // Format: duration=123.45
                durationMatch = output.match(/duration=(\d+\.\d+)/);
                if (durationMatch) {
                    this.totalDuration = parseFloat(durationMatch[1]);
                    logDebug('Found duration (alt format 1):', this.totalDuration, 'seconds');
                    return;
                }
                
                // Format: Duration: 123.45 s
                durationMatch = output.match(/Duration:\s*(\d+\.\d+)\s*s/);
                if (durationMatch) {
                    this.totalDuration = parseFloat(durationMatch[1]);
                    logDebug('Found duration (alt format 2):', this.totalDuration, 'seconds');
                    return;
                }
            } else {
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