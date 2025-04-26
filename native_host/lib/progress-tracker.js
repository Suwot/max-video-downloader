/**
 * @ai-guide-component ProgressTracker
 * @ai-guide-description Tracks download progress using various strategies
 * @ai-guide-responsibilities
 * - Calculates download progress percentage for different media types
 * - Implements strategy pattern for different progress tracking methods
 * - Provides accurate progress reporting for the UI
 * - Handles different file types (direct media, HLS/DASH streams)
 * - Falls back gracefully between different calculation methods
 */

// lib/progress-tracker.js
const { logDebug } = require('../utils/logger');

/**
 * Progress Tracker class - manages tracking download progress using different strategies
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
        this.strategies = {};
        this.debug = options.debug || false;
    }

    /**
     * Register a progress calculation strategy
     * @param {string} name Strategy name
     * @param {Object} strategyClass Strategy class
     */
    registerStrategy(name, strategyClass) {
        this.strategies[name] = strategyClass;
    }

    /**
     * Set the active strategy
     * @param {string} name Strategy name
     * @param {Object} options Strategy configuration options
     * @returns {boolean} Success status
     */
    setStrategy(name, options = {}) {
        if (!this.strategies[name]) {
            logDebug(`Progress strategy '${name}' not found`);
            return false;
        }

        try {
            this.strategy = new this.strategies[name]({
                onProgress: this.handleProgress.bind(this),
                ...options
            });
            
            logDebug(`Set progress tracking strategy to: ${name}`);
            return true;
        } catch (error) {
            logDebug(`Error creating strategy '${name}':`, error);
            return false;
        }
    }

    /**
     * Initialize the progress tracker
     * @param {Object} fileInfo Information about the file being downloaded
     * @param {string} fileInfo.url File URL
     * @param {string} fileInfo.type Media type (direct, hls, dash)
     */
    async initialize(fileInfo) {
        this.fileInfo = fileInfo;
        this.startTime = Date.now();
        this.lastBytes = 0;
        
        // Select best strategy based on media type
        await this.selectBestStrategy(fileInfo);
        
        // Send initial progress
        this.update({
            progress: 0,
            speed: 0,
            downloaded: 0,
            size: 0
        });
        
        logDebug('Progress tracker initialized for:', fileInfo.url);
    }

    /**
     * Select the best strategy based on media type and availability
     * @param {Object} fileInfo File information
     */
    async selectBestStrategy(fileInfo) {
        const { url, type } = fileInfo;
        
        // Choose strategy based on media type
        if (type === 'hls' || type === 'dash') {
            logDebug(`Streaming media (${type}) detected, skipping content-length strategy`);
            
            // Important: Try segment tracking FIRST for streaming media
            logDebug(`STRATEGY: Attempting to use segment tracking strategy first for ${type}`);
            if (await this.tryStrategy('segment', { url, type })) {
                logDebug('STRATEGY: Successfully initialized segment tracking strategy');
                return;
            }
            logDebug('STRATEGY: Segment tracking strategy failed or unavailable');
            
            // Then try adaptive bitrate as fallback
            logDebug(`STRATEGY: Falling back to adaptive bitrate strategy for ${type}`);
            if (await this.tryStrategy('adaptive-bitrate', { url, type })) {
                logDebug('STRATEGY: Using adaptive bitrate strategy for streaming media');
                return;
            }
            logDebug('STRATEGY: Adaptive bitrate strategy failed or unavailable');
            
            // Last resort: time-based
            logDebug(`STRATEGY: Falling back to time-based strategy for ${type}`);
            if (await this.tryStrategy('time-based', { url, type })) {
                logDebug('STRATEGY: Using time-based strategy for streaming media');
                return;
            }
            logDebug('STRATEGY: All strategies failed for streaming media');
        } else {
            // For non-streaming media, try content-length first
            if (await this.tryStrategy('content-length', { url, type })) {
                logDebug('Using content-length strategy for direct media');
                return;
            }
            
            // Fall back to adaptive bitrate
            if (await this.tryStrategy('adaptive-bitrate', { url, type })) {
                logDebug('Using adaptive bitrate strategy for direct media');
                return;
            }
            
            // Last resort: time-based
            if (await this.tryStrategy('time-based', { url, type })) {
                logDebug('Using time-based strategy for direct media');
                return;
            }
        }
        
        logDebug('No suitable progress strategy found, using default');
        // If all else fails, use a dummy strategy
        this.setStrategy('default', { url, type });
    }

    /**
     * Try to use a specific strategy
     * @param {string} name Strategy name
     * @param {Object} options Options to pass to the strategy
     * @returns {boolean} Success status
     */
    async tryStrategy(name, options) {
        if (!this.strategies[name]) {
            logDebug(`STRATEGY: Strategy '${name}' not registered`);
            return false;
        }
        
        logDebug(`STRATEGY: Attempting to initialize '${name}' strategy`);
        
        try {
            const success = this.setStrategy(name, options);
            if (!success) {
                logDebug(`STRATEGY: Failed to set '${name}' strategy`);
                return false;
            }
            
            if (this.strategy.initialize) {
                logDebug(`STRATEGY: Calling initialize() for '${name}' strategy`);
                try {
                    const initResult = await this.strategy.initialize(options);
                    logDebug(`STRATEGY: Initialize '${name}' returned: ${initResult}`);
                    return initResult;
                } catch (initError) {
                    logDebug(`STRATEGY: Error during '${name}' initialization:`, initError);
                    return false;
                }
            }
            return success;
        } catch (error) {
            logDebug(`STRATEGY: Error creating '${name}' strategy:`, error);
            return false;
        }
    }

    /**
     * Update progress based on FFmpeg output
     * @param {string} output FFmpeg stderr output
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
        // Calculate speed if not provided
        if (!data.speed && data.downloaded > this.lastBytes) {
            const elapsedSecs = (Date.now() - this.startTime) / 1000;
            if (elapsedSecs > 0) {
                // Overall average speed
                data.speed = data.downloaded / elapsedSecs;
                
                // Instantaneous speed (if we have last bytes)
                if (this.lastBytes > 0 && elapsedSecs > 1) {
                    const instantSpeed = (data.downloaded - this.lastBytes) * (1000 / (Date.now() - this.lastUpdate));
                    data.speed = instantSpeed > 0 ? instantSpeed : data.speed;
                }
            }
        }
        
        this.lastBytes = data.downloaded || this.lastBytes;
        
        // Add estimated time remaining if we have enough info
        if (typeof data.progress === 'number' && data.progress > 0 && data.speed > 0) {
            const totalBytes = data.downloaded / (data.progress / 100);
            const remainingBytes = totalBytes - data.downloaded;
            data.eta = remainingBytes / data.speed; // ETA in seconds
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
     * Register the standard progress tracking strategies
     */
    static registerDefaultStrategies(tracker) {
        // Import strategies
        const ContentLengthStrategy = require('./progress/content-length-strategy');
        const AdaptiveBitrateStrategy = require('./progress/adaptive-bitrate-strategy');
        const TimeBasedStrategy = require('./progress/time-based-strategy');
        const SegmentTrackingStrategy = require('./progress/segment-tracking-strategy');
        
        // Create a simple default strategy that just passes through progress data
        class DefaultStrategy {
            constructor(options = {}) {
                this.onProgress = options.onProgress || (() => {});
            }
            
            initialize() {
                return Promise.resolve(true);
            }
            
            update(data) {
                if (this.onProgress) {
                    this.onProgress(data);
                }
            }
            
            processOutput() {
                // No-op
            }
        }
        
        // Register strategies
        tracker.registerStrategy('content-length', ContentLengthStrategy);
        tracker.registerStrategy('adaptive-bitrate', AdaptiveBitrateStrategy);
        tracker.registerStrategy('segment', SegmentTrackingStrategy);
        tracker.registerStrategy('time-based', TimeBasedStrategy);
        tracker.registerStrategy('default', DefaultStrategy);
        
        return tracker;
    }
}

// Export the progress tracker
module.exports = ProgressTracker;