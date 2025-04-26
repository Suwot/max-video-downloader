/**
 * @ai-guide-component TimeBasedStrategy
 * @ai-guide-description Fallback progress tracking based on elapsed time
 * @ai-guide-responsibilities
 * - Provides a last-resort fallback for progress estimation
 * - Uses logarithmic scale for more natural progression
 * - Works without any media-specific information
 */

// lib/progress/time-based-strategy.js
const BaseProgressStrategy = require('./base-strategy');
const { logDebug } = require('../../utils/logger');

/**
 * Progress strategy that uses elapsed time as a fallback
 */
class TimeBasedStrategy extends BaseProgressStrategy {
    /**
     * Create a new time-based strategy
     * @param {Object} options Configuration options
     */
    constructor(options) {
        super(options);
        this.startTime = Date.now();
        this.estimatedDuration = options.estimatedDuration || 60; // Default 60 seconds
        this.confidenceLevel = 0.3; // Low confidence
    }

    /**
     * Initialize with estimated duration if possible
     * @returns {Promise<boolean>} Success indicator
     */
    async initialize() {
        logDebug('Initializing time-based progress strategy');
        return true;
    }

    /**
     * Update progress based on elapsed time
     * @param {Object} data Additional progress data
     */
    update(data) {
        const elapsedSecs = (Date.now() - this.startTime) / 1000;
        
        // Logarithmic scale for time progress gives a better feel
        // - Starts slower, accelerates in the middle, never reaches 100%
        let progress;
        
        if (data.currentTime && this.totalDuration) {
            // If we have media time information, use it
            progress = Math.min(99, (data.currentTime / this.totalDuration) * 100);
            this.confidenceLevel = 0.5;
        } else {
            // Otherwise use system time with logarithmic curve
            progress = Math.min(95, 20 * Math.log10(1 + 9 * elapsedSecs / 60));
            this.confidenceLevel = 0.3;
            
            // If it's taking too long, increase progress more steadily to give feedback
            if (elapsedSecs > 120) { // After 2 minutes
                progress = Math.min(95, 50 + (elapsedSecs - 120) / 12); // Adds ~5% per minute
            }
        }
        
        // Smooth progress for better UX
        const smoothedProgress = this.smoothProgress(progress);
        
        this.sendProgress({
            ...data,
            progress: Math.round(smoothedProgress),
            elapsedTime: elapsedSecs
        });
    }

    /**
     * Process FFmpeg output to extract any useful information
     * @param {string} output FFmpeg stderr output
     */
    processOutput(output) {
        // Try to extract time and duration information from FFmpeg output
        const time = this.parseTime(output);
        if (time) {
            this.update({ currentTime: time });
        }
        
        // Look for duration information
        if (!this.totalDuration) {
            const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1], 10);
                const minutes = parseInt(durationMatch[2], 10);
                const seconds = parseFloat(durationMatch[3]);
                this.totalDuration = hours * 3600 + minutes * 60 + seconds;
                
                // Update estimated duration
                this.estimatedDuration = this.totalDuration;
                logDebug('Found duration for time-based strategy:', this.totalDuration);
            }
        }
        
        const size = this.parseSize(output);
        if (size) {
            this.update({ downloaded: size });
        }
    }
}

module.exports = TimeBasedStrategy;