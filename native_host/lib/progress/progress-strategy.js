/**
 * @ai-guide-component ProgressStrategy
 * @ai-guide-description Unified progress tracking for all media types
 * @ai-guide-responsibilities
 * - Calculates download progress based on media type
 * - Uses pre-parsed metadata from extension
 * - Supports direct media, HLS, and DASH formats
 * - Provides accurate progress without duplicate manifest parsing
 */

const { logDebug } = require('../../utils/logger');

/**
 * Unified progress strategy for all media types
 */
class ProgressStrategy {
    /**
     * Create a new progress strategy
     * @param {Object} options Configuration options
     * @param {Function} options.onProgress Callback for progress updates
     * @param {string} options.downloadUrl Media URL
     * @param {string} options.type Media type (direct, hls, dash)
     * @param {number} options.duration Media duration in seconds
     * @param {number} options.fileSizeBytes File size in bytes (from Content-Length or duration*bitrate calculation)
     * @param {number} options.segmentCount Number of segments in the manifest (for HLS/DASH)
     */
    constructor(options = {}) {
        this.onProgress = options.onProgress || (() => {});
        this.downloadUrl = options.downloadUrl || null;
        this.type = options.type || 'direct';
        
        // Extract relevant metadata
        this.duration = options.duration || 0;
        this.fileSizeBytes = options.fileSizeBytes || 0;
        this.segmentCount = options.segmentCount || 0;
        
        // For segment tracking
        this.currentSegment = 0;
        
        // For progress calculation and smoothing
        this.startTime = Date.now();
        this.lastBytes = 0;
        this.lastUpdate = 0;
        this.lastProgressValues = [];
        
        logDebug(`ProgressStrategy: Created for ${this.type} media`);
    }

    /**
     * Initialize the strategy - validate we have sufficient metadata
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        logDebug(`ProgressStrategy: Initializing for ${this.type} with:`, {
            downloadUrl: this.downloadUrl,
            duration: this.duration,
            fileSizeBytes: this.fileSizeBytes,
            segmentCount: this.segmentCount
        });
        
        // Validate we have the minimum required data
        if (!this.downloadUrl) {
            logDebug('ProgressStrategy: No download URL provided');
            return false;
        }

        // Check type-specific requirements
        switch (this.type) {
            case 'direct':
                // For direct, we either need file size or duration
                if (this.fileSizeBytes <= 0 && this.duration <= 0) {
                    logDebug('ProgressStrategy: Insufficient data for direct media tracking');
                    return false;
                }
                return true;

            case 'hls':
                // For HLS, we prioritize duration and segment info
                if (this.duration <= 0 && this.segmentCount <= 0) {
                    logDebug('ProgressStrategy: Insufficient data for HLS tracking');
                    return false;
                }
                return true;

            case 'dash':
                // For DASH, we prioritize duration
                if (this.duration <= 0 && this.fileSizeBytes <= 0) {
                    logDebug('ProgressStrategy: Insufficient data for DASH tracking');
                    return false;
                }
                return true;

            default:
                logDebug(`ProgressStrategy: Unknown media type: ${this.type}`);
                return false;
        }
    }

    /**
     * Update progress based on current data
     * @param {Object} data Progress data from FFmpeg output
     */
    update(data) {
        // Extract relevant data
        const currentTime = data.currentTime || 0;
        const downloaded = data.downloaded || 0;
        const currentSegment = data.currentSegment || this.currentSegment;
        
        // Update segment tracking
        if (currentSegment > this.currentSegment) {
            this.currentSegment = currentSegment;
        }
        
        // Calculate progress based on media type
        let progress = 0;
        let progressInfo = {};
        
        switch (this.type) {
            case 'direct':
                progress = this.calculateDirectProgress(downloaded, currentTime);
                progressInfo = { 
                    downloaded, 
                    size: this.fileSizeBytes || null 
                };
                break;
                
            case 'hls':
                progress = this.calculateHlsProgress(currentTime, currentSegment, downloaded);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0,
                    currentSegment,
                    totalSegments: this.segmentCount || 0
                };
                break;
                
            case 'dash':
                progress = this.calculateDashProgress(currentTime, downloaded);
                progressInfo = { 
                    currentTime, 
                    totalDuration: this.duration || 0,
                    downloaded
                };
                break;
        }
        
        // Apply smoothing to progress value
        const smoothedProgress = this.smoothProgress(progress);
        
        // Calculate speed
        const speed = this.calculateSpeed(downloaded);
        
        // Send progress update with additional information useful for the UI
        this.sendProgress({
            ...data,
            progress: Math.min(99.9, Math.round(smoothedProgress)), // Cap at 99.9% until complete
            speed,
            elapsedTime: (Date.now() - this.startTime) / 1000, // Elapsed time in seconds
            type: this.type,
            ...progressInfo
        });
    }

    /**
     * Calculate progress for direct media
     * @param {number} downloaded Bytes downloaded
     * @param {number} currentTime Current playback time
     * @returns {number} Progress percentage (0-100)
     */
    calculateDirectProgress(downloaded, currentTime) {
        // Priority 1: Use file size and downloaded bytes (most accurate)
        if (this.fileSizeBytes > 0 && downloaded > 0) {
            return (downloaded / this.fileSizeBytes) * 100;
        }
        
        // Priority 2: Use duration and current time
        if (this.duration > 0 && currentTime > 0) {
            return (currentTime / this.duration) * 100;
        }
        
        // No reliable progress data
        return 0;
    }

    /**
     * Calculate progress for HLS media
     * @param {number} currentTime Current playback time
     * @param {number} currentSegment Current segment number
     * @param {number} downloaded Bytes downloaded
     * @returns {number} Progress percentage (0-100)
     */
    calculateHlsProgress(currentTime, currentSegment, downloaded) {
        // Priority 1: Time-based tracking (as per your request)
        if (this.duration > 0 && currentTime > 0) {
            return (currentTime / this.duration) * 100;
        }
        
        // Priority 2: Segment-based tracking
        if (this.segmentCount > 0 && currentSegment > 0) {
            return (currentSegment / this.segmentCount) * 100;
        }
        
        // Priority 3: Size-based estimation if file size is known
        if (this.fileSizeBytes > 0 && downloaded > 0) {
            return (downloaded / this.fileSizeBytes) * 100;
        }
        
        // No reliable progress data
        return 0;
    }

    /**
     * Calculate progress for DASH media
     * @param {number} currentTime Current playback time
     * @param {number} downloaded Bytes downloaded
     * @returns {number} Progress percentage (0-100)
     */
    calculateDashProgress(currentTime, downloaded) {
        // Priority 1: Time-based calculation (as per your request)
        if (this.duration > 0 && currentTime > 0) {
            return (currentTime / this.duration) * 100;
        }
        
        // Priority 2: Size-based estimation
        if (this.fileSizeBytes > 0 && downloaded > 0) {
            return (downloaded / this.fileSizeBytes) * 100;
        }
        
        // No reliable progress data
        return 0;
    }

    /**
     * Calculate download speed
     * @param {number} downloaded Bytes downloaded
     * @returns {number} Speed in bytes per second
     */
    calculateSpeed(downloaded) {
        let speed = 0;
        
        if (downloaded > this.lastBytes) {
            const elapsedSecs = (Date.now() - this.startTime) / 1000;
            if (elapsedSecs > 0) {
                // Overall average speed
                const avgSpeed = downloaded / elapsedSecs;
                
                // Instantaneous speed (for last interval)
                let instantSpeed = 0;
                const intervalSecs = (Date.now() - this.lastUpdate) / 1000;
                if (this.lastBytes > 0 && intervalSecs > 0) {
                    instantSpeed = (downloaded - this.lastBytes) / intervalSecs;
                }
                
                // Use instantaneous speed if available, otherwise average
                speed = instantSpeed > 0 ? instantSpeed : avgSpeed;
            }
        }
        
        this.lastBytes = downloaded;
        this.lastUpdate = Date.now();
        
        return speed;
    }

    /**
     * Smooth progress values to prevent jumps
     * @param {number} progress Current progress value
     * @returns {number} Smoothed progress value
     */
    smoothProgress(progress) {
        // Add to history, keep last 5 values
        this.lastProgressValues.push(progress);
        if (this.lastProgressValues.length > 5) {
            this.lastProgressValues.shift();
        }
        
        // Calculate weighted average - give more weight to newer values
        let totalWeight = 0;
        let weightedSum = 0;
        
        for (let i = 0; i < this.lastProgressValues.length; i++) {
            // Weight increases with index (newer values get higher weight)
            const weight = i + 1;
            weightedSum += this.lastProgressValues[i] * weight;
            totalWeight += weight;
        }
        
        return totalWeight > 0 ? weightedSum / totalWeight : progress;
    }

    /**
     * Send progress update
     * @param {Object} data Progress data
     */
    sendProgress(data) {
        if (this.onProgress) {
            this.onProgress(data);
        }
    }

    /**
     * Process FFmpeg output to extract progress information
     * @param {string} output FFmpeg stdout/stderr output
     */
    processOutput(output) {
        // Extract relevant data from FFmpeg output
        const time = this.parseTime(output);
        const size = this.parseSize(output);
        const segment = this.parseSegment(output);
        
        let updateData = {};
        
        if (time !== null) {
            updateData.currentTime = time;
        }
        
        if (size !== null) {
            updateData.downloaded = size;
        }
        
        if (segment !== null) {
            updateData.currentSegment = segment;
        }
        
        // Only update if we have new data
        if (Object.keys(updateData).length > 0) {
            this.update(updateData);
        }
    }

    /**
     * Parse time information from FFmpeg output
     * @param {string} output FFmpeg output line
     * @returns {number|null} Time in seconds or null if not found
     */
    parseTime(output) {
        // Look for time=HH:MM:SS.MS pattern
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            return hours * 3600 + minutes * 60 + seconds;
        }
        return null;
    }

    /**
     * Parse size information from FFmpeg output
     * @param {string} output FFmpeg output line
     * @returns {number|null} Size in bytes or null if not found
     */
    parseSize(output) {
        // Look for size=   123kB pattern
        const sizeMatch = output.match(/size=\s*(\d+)(\w+)/);
        if (sizeMatch) {
            const value = parseInt(sizeMatch[1], 10);
            const unit = sizeMatch[2];
            
            switch (unit.toLowerCase()) {
                case 'kb': return value * 1024;
                case 'mb': return value * 1024 * 1024;
                case 'gb': return value * 1024 * 1024 * 1024;
                default: return value;
            }
        }
        return null;
    }

    /**
     * Parse segment information from FFmpeg output
     * @param {string} output FFmpeg output line
     * @returns {number|null} Segment number or null if not found
     */
    parseSegment(output) {
        // Method 1: Look for segment pattern in Opening URL messages
        // Example: Opening 'https://example.com/segment_10.ts' for reading
        const segmentMatch = output.match(/Opening ['"].*?[_\/](\d+)\.(ts|mp4|m4s)['"] for reading/);
        if (segmentMatch) {
            const segment = parseInt(segmentMatch[1], 10);
            if (!isNaN(segment) && segment > 0) {
                return segment;
            }
        }
        
        // Method 2: Look for index patterns in filenames
        // Example: Opening 'media_b1600000_7.ts'
        const indexMatch = output.match(/Opening ['"][^'"]*?_(\d+)\.(ts|mp4|m4s)['"] for reading/);
        if (!segmentMatch && indexMatch) {
            const index = parseInt(indexMatch[1], 10);
            if (!isNaN(index) && index > 0) {
                return index;
            }
        }
        
        return null;
    }
}

module.exports = ProgressStrategy;
