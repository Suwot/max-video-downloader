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
     * @param {number} options.fileSizeBytes File size in bytes (from Content-Length or fileSizeBytes)
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
        this.lastProcessedTime = 0;
        this.updateInterval = options.updateInterval || 250; // Use parent's update interval
        this.lastProgressValues = [];
        
        // For HLS segment-based speed calculation
        this.segmentSizes = [];
        this.lastSegmentTime = Date.now();
        
        // For cumulative download tracking
        this.totalDownloaded = 0;
        this.downloadedPerSegment = {};
        
        // Track which strategy we're using
        this.primaryStrategy = null;
        this.fallbackToStrategy = null;
        
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
                if (this.fileSizeBytes > 0) {
                    logDebug('ProgressStrategy: Using FILE SIZE strategy for direct media');
                    this.primaryStrategy = 'size';
                } else if (this.duration > 0) {
                    logDebug('ProgressStrategy: Using DURATION strategy for direct media');
                    this.primaryStrategy = 'duration';
                } else {
                    logDebug('ProgressStrategy: Insufficient data for direct media tracking');
                    return false;
                }
                return true;

            case 'hls':
                // For HLS, determine and log the primary strategy
                if (this.duration > 0) {
                    logDebug('ProgressStrategy: Using DURATION strategy for HLS');
                    this.primaryStrategy = 'duration';
                } else if (this.segmentCount > 0) {
                    logDebug('ProgressStrategy: Using SEGMENT COUNT strategy for HLS');
                    this.primaryStrategy = 'segments';
                } else if (this.fileSizeBytes > 0) {
                    logDebug('ProgressStrategy: Using FILE SIZE strategy for HLS');
                    this.primaryStrategy = 'size';
                } else {
                    logDebug('ProgressStrategy: Insufficient data for HLS tracking');
                    return false;
                }
                return true;

            case 'dash':
                // For DASH, determine and log the primary strategy
                if (this.duration > 0) {
                    logDebug('ProgressStrategy: Using DURATION strategy for DASH');
                    this.primaryStrategy = 'duration';
                } else if (this.fileSizeBytes > 0) {
                    logDebug('ProgressStrategy: Using FILE SIZE strategy for DASH');
                    this.primaryStrategy = 'size';
                } else {
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
        
        // Track cumulative downloaded bytes for HLS/DASH
        if (this.type !== 'direct' && downloaded > 0) {
            // If this is a new segment, add to total
            if (!this.downloadedPerSegment[currentSegment]) {
                this.downloadedPerSegment[currentSegment] = downloaded;
                this.totalDownloaded += downloaded;
            } else if (downloaded > this.downloadedPerSegment[currentSegment]) {
                // If we have more data for an existing segment
                const diff = downloaded - this.downloadedPerSegment[currentSegment];
                this.downloadedPerSegment[currentSegment] = downloaded;
                this.totalDownloaded += diff;
            }
        }
        
        // Keep track of segment changes
        const isNewSegment = currentSegment > this.currentSegment;
        if (isNewSegment) {
            this.currentSegment = currentSegment;
            logDebug(`ProgressStrategy: Detected new segment ${currentSegment}/${this.segmentCount}`);
            
            // For HLS: Record segment change time
            if (this.type === 'hls') {
                const now = Date.now();
                const segmentTime = (now - this.lastSegmentTime) / 1000;
                this.lastSegmentTime = now;
            }
        }
        
        // For direct downloads, use the downloaded amount directly
        const effectiveDownloaded = this.type === 'direct' ? downloaded : this.totalDownloaded;
        
        // Calculate progress based on media type
        let progress = 0;
        let progressInfo = {};
        
        switch (this.type) {
            case 'direct':
                progress = this.calculateDirectProgress(effectiveDownloaded, currentTime);
                progressInfo = { 
                    downloaded: effectiveDownloaded, 
                    size: this.fileSizeBytes || null,
                    totalFileSize: this.fileSizeBytes || null
                };
                break;
                
            case 'hls':
                progress = this.calculateHlsProgress(currentTime, currentSegment, effectiveDownloaded);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0,
                    currentSegment,
                    totalSegments: this.segmentCount || 0,
                    downloaded: effectiveDownloaded,
                    strategy: this.primaryStrategy,
                    fallbackStrategy: this.fallbackToStrategy,
                    totalFileSize: this.fileSizeBytes || null
                };
                break;
                
            case 'dash':
                progress = this.calculateDashProgress(currentTime, effectiveDownloaded);
                progressInfo = { 
                    currentTime, 
                    totalDuration: this.duration || 0,
                    downloaded: effectiveDownloaded,
                    strategy: this.primaryStrategy,
                    fallbackStrategy: this.fallbackToStrategy,
                    totalFileSize: this.fileSizeBytes || null
                };
                break;
        }
        
        // Apply smoothing to progress value
        const smoothedProgress = this.smoothProgress(progress);
        
        // Calculate speed
        const speed = this.calculateSpeed(effectiveDownloaded);
        
        // Send progress update with additional information useful for the UI
        this.sendProgress({
            ...data,
            progress: Math.min(99.9, Math.round(smoothedProgress)), // Cap at 99.9% until complete
            speed,
            elapsedTime: (Date.now() - this.startTime) / 1000, // Elapsed time in seconds
            type: this.type,
            strategy: this.primaryStrategy,
            fallbackStrategy: this.fallbackToStrategy,
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
        let progress = 0;
        this.fallbackToStrategy = null;
        
        // Use the primary strategy determined during initialization
        switch (this.primaryStrategy) {
            case 'duration':
                if (this.duration > 0 && currentTime > 0) {
                    progress = (currentTime / this.duration) * 100;
                } else if (this.duration > 0 && this.segmentCount > 0 && currentSegment > 0) {
                    // Duration strategy selected but timestamps aren't parsing correctly
                    // Fallback to segment-based with time estimation
                    const estimatedTime = (currentSegment / this.segmentCount) * this.duration;
                    progress = (estimatedTime / this.duration) * 100;
                    this.fallbackToStrategy = 'segments-estimated';
                    logDebug(`ProgressStrategy: Duration strategy with invalid timestamps, falling back to segment estimation. Progress: ${progress.toFixed(2)}%`);
                }
                break;
                
            case 'segments':
                if (this.segmentCount > 0 && currentSegment > 0) {
                    progress = (currentSegment / this.segmentCount) * 100;
                }
                break;
                
            case 'size':
                if (this.fileSizeBytes > 0 && downloaded > 0) {
                    progress = (downloaded / this.fileSizeBytes) * 100;
                }
                break;
        }
        
        // When progress is too low or not calculated, try fallback methods
        if (progress <= 0) {
            // Try the other methods in priority order
            if (this.primaryStrategy !== 'segments' && this.segmentCount > 0 && currentSegment > 0) {
                progress = (currentSegment / this.segmentCount) * 100;
                this.fallbackToStrategy = 'segments';
                logDebug(`ProgressStrategy: Falling back to segment-based progress. Progress: ${progress.toFixed(2)}%`);
            } else if (this.primaryStrategy !== 'size' && this.fileSizeBytes > 0 && downloaded > 0) {
                progress = (downloaded / this.fileSizeBytes) * 100;
                this.fallbackToStrategy = 'size';
                logDebug(`ProgressStrategy: Falling back to size-based progress. Progress: ${progress.toFixed(2)}%`);
            } else if (this.primaryStrategy !== 'duration' && this.duration > 0 && currentTime > 0) {
                progress = (currentTime / this.duration) * 100;
                this.fallbackToStrategy = 'duration';
                logDebug(`ProgressStrategy: Falling back to duration-based progress. Progress: ${progress.toFixed(2)}%`);
            }
        }
        
        return progress;
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
        const now = Date.now();
        
        if (downloaded > this.lastBytes) {
            // For HLS: Use segment-based speed calculation to avoid wild fluctuations
            if (this.type === 'hls' && this.currentSegment > 0) {
                // Store segment size information for averaging
                const bytesDownloadedSinceLastUpdate = downloaded - this.lastBytes;
                
                if (bytesDownloadedSinceLastUpdate > 0) {
                    this.segmentSizes.push({
                        bytes: bytesDownloadedSinceLastUpdate,
                        timestamp: now
                    });
                    
                    // Keep only the last 5 segments for averaging
                    if (this.segmentSizes.length > 5) {
                        this.segmentSizes.shift();
                    }
                }
                
                // Calculate average speed over multiple segments
                if (this.segmentSizes.length > 0) {
                    let totalBytes = 0;
                    const earliestTimestamp = this.segmentSizes[0].timestamp;
                    
                    this.segmentSizes.forEach(segment => {
                        totalBytes += segment.bytes;
                    });
                    
                    const totalTimeSeconds = Math.max(0.1, (now - earliestTimestamp) / 1000);
                    speed = totalBytes / totalTimeSeconds;
                } else {
                    // Fallback to overall average if we don't have segment data yet
                    const elapsedSecs = Math.max(0.1, (now - this.startTime) / 1000);
                    speed = downloaded / elapsedSecs;
                }
            } else {
                // For direct and DASH: Calculate using overall and recent speed
                // Overall average speed
                const elapsedSecs = Math.max(0.1, (now - this.startTime) / 1000);
                const avgSpeed = downloaded / elapsedSecs;
                
                // Instantaneous speed (for last interval)
                let instantSpeed = 0;
                const intervalSecs = Math.max(0.1, (now - this.lastUpdate) / 1000);
                if (this.lastBytes > 0) {
                    instantSpeed = (downloaded - this.lastBytes) / intervalSecs;
                }
                
                // Use instantaneous speed if available, otherwise average
                speed = instantSpeed > 0 ? instantSpeed : avgSpeed;
            }
        }
        
        // Update state for next calculation
        this.lastBytes = downloaded;
        this.lastUpdate = now;
        
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
        const now = Date.now();
        
        // Rate-limit updates based on updateInterval
        // This ensures we respect the parent's update interval
        if (now - this.lastProcessedTime < this.updateInterval) {
            return;
        }
        
        // Extract relevant data from FFmpeg output
        const time = this.parseTime(output);
        const size = this.parseSize(output);
        const segment = this.parseSegment(output);
        
        // Check for timestamp errors and log them for diagnosis
        if (output.includes("Invalid timestamps")) {
            const timestampErrorMatch = output.match(/Invalid timestamps.*pts=(\d+), dts=(\d+), size=(\d+)/);
            if (timestampErrorMatch && this.primaryStrategy === 'duration') {
                logDebug(`ProgressStrategy: Detected invalid timestamps (pts=${timestampErrorMatch[1]}, dts=${timestampErrorMatch[2]})`);
            }
        }
        
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
        
        // Special handling for HLS with duration strategy when timestamps aren't working
        if (this.type === 'hls' && this.primaryStrategy === 'duration' && 
            this.segmentCount > 0 && segment !== null && 
            (time === null || time === 0)) {
            
            // No valid timestamp, but we have segment info - use that to estimate time position
            if (this.duration > 0) {
                const estimatedTime = (segment / this.segmentCount) * this.duration;
                updateData.currentTime = estimatedTime;
                logDebug(`ProgressStrategy: Using estimated time position: ${estimatedTime.toFixed(2)}s at segment ${segment}/${this.segmentCount}`);
            }
        }
        
        // Only update if we have new data
        if (Object.keys(updateData).length > 0) {
            this.lastProcessedTime = now;
            this.update(updateData);
        }
    }

    /**
     * Parse time information from FFmpeg output
     * @param {string} output FFmpeg output line
     * @returns {number|null} Time in seconds or null if not found
     */
    parseTime(output) {
        // Method 1: Look for standard time=HH:MM:SS.MS pattern
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            return hours * 3600 + minutes * 60 + seconds;
        }
        
        // Method 2: Look for time in seconds pattern (sometimes used by FFmpeg)
        const timeSecsMatch = output.match(/time=\s*([\d.]+)/);
        if (timeSecsMatch) {
            const timeInSeconds = parseFloat(timeSecsMatch[1]);
            if (!isNaN(timeInSeconds) && timeInSeconds > 0) {
                return timeInSeconds;
            }
        }
        
        // Method 3: Check for PTS time in FFmpeg output
        const ptsMatch = output.match(/pts=([\d.]+)/);
        if (ptsMatch) {
            const pts = parseFloat(ptsMatch[1]);
            if (!isNaN(pts) && pts > 0) {
                // PTS is often in a different timescale, might need adjustment
                // This is a simplistic approach - might need tuning
                return pts / 90000; // Common timescale for MPEG-TS
            }
        }
        
        // Method 4: Extract from DTS if available
        const dtsMatch = output.match(/dts=([\d.]+)/);
        if (dtsMatch) {
            const dts = parseFloat(dtsMatch[1]);
            if (!isNaN(dts) && dts > 0) {
                return dts / 90000; // Common timescale for MPEG-TS
            }
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
        
        // Method 3: Extract segment number from more complex patterns
        // Example: Opening 'manifest-audio_0_q7BAv3mA_WbaG9LKN=112000-video_0_q7BAv3mA_Uql258jy=5099752-1.ts'
        const complexMatch = output.match(/Opening ['"][^'"]*?-(\d+)\.(ts|mp4|m4s)['"] for reading/);
        if (complexMatch) {
            const segment = parseInt(complexMatch[1], 10);
            if (!isNaN(segment) && segment > 0) {
                logDebug(`ProgressStrategy: Detected segment ${segment} from complex pattern`);
                return segment;
            }
        }
        
        return null;
    }
}

module.exports = ProgressStrategy;
