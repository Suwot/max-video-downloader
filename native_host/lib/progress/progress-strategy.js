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
        this.bitrate = options.bitrate || 0;
        this.ffprobeData = options.ffprobeData || null; // Store FFprobe data if provided
        
        // For segment tracking
        this.currentSegment = 0;
        
        // For progress calculation
        this.startTime = Date.now();
        this.lastBytes = 0;
        this.lastUpdate = 0;
        this.lastProcessedTime = 0;
        this.updateInterval = options.updateInterval || 250; // Use parent's update interval
        this.lastProgressValues = [];
        
        // For speed calculation
        this.segmentSizes = [];
        this.lastSegmentTime = Date.now();
        
        // For cumulative download tracking
        this.totalDownloaded = 0;
        this.downloadedPerSegment = {};
        
        // Track which strategy we're using
        this.primaryStrategy = null;
        
        // For tracking stream information from FFmpeg
        this.ffmpegStats = null;
        this.streamInfoCaptured = false;
        
        // Parse duration from FFprobe data if available (most reliable)
        if (this.ffprobeData && typeof this.ffprobeData === 'string') {
            // Extract duration from ffprobe output
            const durationMatch = this.ffprobeData.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1], 10);
                const minutes = parseInt(durationMatch[2], 10);
                const seconds = parseFloat(durationMatch[3]);
                this.probeDuration = hours * 3600 + minutes * 60 + seconds;
                
                // Use probe duration if it's more reliable
                if (this.probeDuration > 0 && (!this.duration || Math.abs(this.duration - this.probeDuration) > 1)) {
                    logDebug(`ProgressStrategy: Using FFprobe duration ${this.probeDuration}s instead of provided ${this.duration}s`);
                    this.duration = this.probeDuration;
                }
            }
            
            // Extract bitrate information if available
            const bitrateMatch = this.ffprobeData.match(/bitrate:\s*(\d+)\s*kb\/s/);
            if (bitrateMatch && !this.bitrate) {
                this.bitrate = parseInt(bitrateMatch[1], 10) * 1000; // Convert to bits/sec
            }
        }
        
        logDebug(`ProgressStrategy: Created for ${this.type} media with duration: ${this.duration}s, size: ${this.fileSizeBytes} bytes`);
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
            segmentCount: this.segmentCount,
            bitrate: this.bitrate
        });
        
        // Validate we have the minimum required data
        if (!this.downloadUrl) {
            logDebug('ProgressStrategy: No download URL provided');
            return false;
        }
        
        // If we have both duration and bitrate but no file size, we can estimate file size
        if (this.duration > 0 && this.bitrate > 0 && this.fileSizeBytes <= 0) {
            // Estimate file size from duration and bitrate (bits/sec * seconds / 8 = bytes)
            const estimatedSize = Math.ceil((this.bitrate * this.duration) / 8);
            logDebug(`ProgressStrategy: Estimating file size as ${estimatedSize} bytes based on duration and bitrate`);
            this.fileSizeBytes = estimatedSize;
        }

        // Check type-specific requirements and choose optimal strategy
        switch (this.type) {
            case 'direct':
                // For direct downloads, size is always the most accurate if available
                if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: Using FILE SIZE strategy (${this.fileSizeBytes} bytes) for direct media`);
                    this.primaryStrategy = 'size';
                } else if (this.duration > 0) {
                    logDebug(`ProgressStrategy: Using DURATION strategy (${this.duration}s) for direct media`);
                    this.primaryStrategy = 'duration';
                } else {
                    logDebug('ProgressStrategy: Insufficient data for direct media tracking - will use dynamic strategy');
                    this.primaryStrategy = 'dynamic'; // Will determine based on FFmpeg output
                    return true; // Still return true as FFmpeg will provide progress data
                }
                return true;

            case 'hls':
                // For HLS, prioritize strategies based on reliability
                if (this.duration > 0) {
                    logDebug(`ProgressStrategy: Using DURATION strategy (${this.duration}s) for HLS`);
                    this.primaryStrategy = 'duration';
                } else if (this.segmentCount > 0) {
                    logDebug(`ProgressStrategy: Using SEGMENT COUNT strategy (${this.segmentCount} segments) for HLS`);
                    this.primaryStrategy = 'segments';
                } else if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: Using FILE SIZE strategy (${this.fileSizeBytes} bytes) for HLS`);
                    this.primaryStrategy = 'size';
                } else {
                    logDebug('ProgressStrategy: Insufficient data for HLS tracking - will attempt to use FFmpeg output');
                    this.primaryStrategy = 'dynamic';
                    return true;
                }
                return true;

            case 'dash':
                // For DASH, choose optimal strategy
                if (this.duration > 0) {
                    logDebug(`ProgressStrategy: Using DURATION strategy (${this.duration}s) for DASH`);
                    this.primaryStrategy = 'duration';
                } else if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: Using FILE SIZE strategy (${this.fileSizeBytes} bytes) for DASH`);
                    this.primaryStrategy = 'size';
                } else {
                    logDebug('ProgressStrategy: Insufficient data for DASH tracking - will attempt to use FFmpeg output');
                    this.primaryStrategy = 'dynamic';
                    return true;
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
        const downloaded = data.downloadedBytes || 0;
        const currentSegment = data.currentSegment || this.currentSegment;
        
        // Handle direct vs. incremental downloaded bytes reporting from FFmpeg
        let effectiveDownloaded = downloaded;
        
        // If progress=end is received, use the final downloaded value directly
        if (data.progress === 100) {
            this.totalDownloaded = downloaded;
            effectiveDownloaded = downloaded;
        }
        // Otherwise for HLS/DASH, ensure we track cumulative bytes since FFmpeg reports per-segment
        else if (this.type !== 'direct' && downloaded > 0) {
            // Normal incremental tracking
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
            effectiveDownloaded = this.totalDownloaded;
        }
        
        // Keep track of segment changes (useful for HLS)
        const isNewSegment = currentSegment > this.currentSegment;
        if (isNewSegment) {
            this.currentSegment = currentSegment;
        }
        
        // Calculate progress based on media type using our simplified strategies
        let progress = 0;
        let progressInfo = {};
        
        switch (this.type) {
            case 'direct':
                progress = this.calculateDirectProgress(effectiveDownloaded, currentTime);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0
                };
                break;
                
            case 'hls':
                progress = this.calculateHlsProgress(currentTime, currentSegment, effectiveDownloaded);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0,
                    currentSegment,
                    totalSegments: this.segmentCount || 0,
                    strategy: this.primaryStrategy
                };
                break;
                
            case 'dash':
                progress = this.calculateDashProgress(currentTime, effectiveDownloaded);
                progressInfo = { 
                    currentTime, 
                    totalDuration: this.duration || 0,
                    strategy: this.primaryStrategy
                };
                break;
        }
        
        // Apply smoothing to progress value
        const smoothedProgress = this.smoothProgress(progress);
        
        // Calculate speed
        const speed = this.calculateSpeed(effectiveDownloaded);
        
        // Simple, direct progress calculation - no unnecessary complexities
        let finalProgress;
        
        if (data.progress === 100) {
            // Explicit completion signal from FFmpeg
            finalProgress = 100;
        } else if (this.primaryStrategy === 'size' && this.fileSizeBytes > 0 && effectiveDownloaded > 0) {
            // Direct size-based calculation for size strategy - most reliable method
            const exactProgress = (effectiveDownloaded / this.fileSizeBytes) * 100;
            finalProgress = Math.min(99.9, exactProgress); // Cap at 99.9% until we get an explicit end marker
        } else {
            // Apply minimal smoothing for streaming formats or when no size available
            finalProgress = Math.min(99.9, smoothedProgress); 
        }
        
        // Capture stream information for final summary once we're past 90%
        if ((finalProgress > 90 || data.progress === 100) && !this.streamInfoCaptured && data.ffmpegStats) {
            this.streamInfoCaptured = true;
            this.streamInfo = data.ffmpegStats;
        }
        
        // Send progress update with all relevant information useful for the UI
        const progressData = {
            progress: finalProgress,
            speed,
            elapsedTime: (Date.now() - this.startTime) / 1000,
            type: this.type,
            strategy: this.primaryStrategy,
            downloadedBytes: effectiveDownloaded,
            totalBytes: this.fileSizeBytes || null
        };

        // Include stream info in the final update
        if (data.progress === 100 && this.streamInfo) {
            progressData.streamInfo = this.streamInfo;
        }
        
        this.sendProgress({
            ...progressData,
            ...progressInfo
        });
    }

    /**
     * Calculate progress for direct media
     * @param {number} downloadedBytes Bytes downloaded
     * @param {number} currentTime Current playback time
     * @returns {number} Progress percentage (0-100)
     */
    calculateDirectProgress(downloadedBytes, currentTime) {
        // For direct media downloads, the calculation should be simple and reliable:
        
        // Strategy 1 (Most accurate): Use file size and downloaded bytes
        if (this.fileSizeBytes > 0 && downloadedBytes > 0) {
            return (downloadedBytes / this.fileSizeBytes) * 100;
        }
        
        // Strategy 2: Use duration and current time
        if (this.duration > 0 && currentTime > 0) {
            const effectiveTime = Math.min(currentTime, this.duration); // Cap at duration
            return (effectiveTime / this.duration) * 100;
        }
        
        // Strategy 3: If we have neither size nor duration, just return 0
        // FFmpeg will eventually send progress=end when completed
        return 0;
    }

    /**
     * Calculate progress for HLS media
     * @param {number} currentTime Current playback time
     * @param {number} currentSegment Current segment number
     * @param {number} downloadedBytes Bytes downloaded
     * @returns {number} Progress percentage (0-100)
     */
    calculateHlsProgress(currentTime, currentSegment, downloadedBytes) {
        // Simple, prioritized approach without excessive fallbacks
        
        // Strategy 1: Use time-based progress if we have valid time and duration
        if (this.primaryStrategy === 'duration' && this.duration > 0 && currentTime > 0) {
            const effectiveTime = Math.min(currentTime, this.duration);
            return (effectiveTime / this.duration) * 100;
        }
        
        // Strategy 2: Use segment-based progress if we have valid segment info
        if ((this.primaryStrategy === 'segments' || currentTime <= 0) && this.segmentCount > 0 && currentSegment > 0) {
            const effectiveSegment = Math.min(currentSegment, this.segmentCount);
            return (effectiveSegment / this.segmentCount) * 100;
        }
        
        // Strategy 3: Use size-based progress if we have file size info
        if ((this.primaryStrategy === 'size' || (currentTime <= 0 && currentSegment <= 0)) && 
            this.fileSizeBytes > 0 && downloadedBytes > 0) {
            return Math.min((downloadedBytes / this.fileSizeBytes) * 100, 100);
        }
        
        // If all else fails, calculate a reasonable estimate
        // For HLS, segment count is often the most reliable indicator
        if (this.segmentCount > 0 && currentSegment > 0) {
            return (currentSegment / this.segmentCount) * 100;
        }
        
        return 0;
    }

    /**
     * Calculate progress for DASH media
     * @param {number} currentTime Current playback time
     * @param {number} downloadedBytes Bytes downloaded
     * @returns {number} Progress percentage (0-100)
     */
    calculateDashProgress(currentTime, downloadedBytes) {
        // Log when current time exceeds duration for debugging
        if (this.duration > 0 && currentTime > this.duration) {
            logDebug(`ProgressStrategy: DASH - Current time (${currentTime.toFixed(2)}s) exceeds total duration (${this.duration}s)`);
        }
        
        // Priority 1: Time-based calculation (as per your request)
        if (this.duration > 0 && currentTime > 0) {
            // Cap current time at duration to prevent progress > 100%
            const effectiveTime = Math.min(currentTime, this.duration);
            return (effectiveTime / this.duration) * 100;
        }
        
        // Priority 2: Size-based estimation
        if (this.fileSizeBytes > 0 && downloadedBytes > 0) {
            return Math.min((downloadedBytes / this.fileSizeBytes) * 100, 100);
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
        // For direct downloads with size strategy, use exact progress with no smoothing
        // Size-based progress from FFmpeg's total_size is already reliable and accurate
        if (this.type === 'direct' && this.primaryStrategy === 'size' && this.fileSizeBytes > 0) {
            // No smoothing needed - FFmpeg provides consistent size updates
            return progress;
        }
        
        // For streaming media (HLS/DASH) where progress can be jumpy, apply minimal smoothing
        // Use exponential moving average with bias toward recent values
        if (this.type === 'hls' || this.type === 'dash') {
            // Only keep last 3 values for streaming formats
            this.lastProgressValues.push(progress);
            if (this.lastProgressValues.length > 3) {
                this.lastProgressValues.shift();
            }
            
            // Return raw value if we only have one sample
            if (this.lastProgressValues.length === 1) {
                return progress;
            }
            
            // Apply exponential weighting: 70% current, 30% previous average
            const previousAvg = this.lastProgressValues.slice(0, -1).reduce((sum, val) => sum + val, 0) / 
                               (this.lastProgressValues.length - 1);
            return progress * 0.7 + previousAvg * 0.3;
        }
        
        // Fallback smoothing for other cases (minimal, only 3 values)
        this.lastProgressValues.push(progress);
        if (this.lastProgressValues.length > 3) {
            this.lastProgressValues.shift();
        }
        
        // Simple average for fallback
        const sum = this.lastProgressValues.reduce((acc, val) => acc + val, 0);
        return sum / this.lastProgressValues.length;
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
        if (now - this.lastProcessedTime < this.updateInterval) {
            return;
        }
        
        // Extract FFmpeg progress indicators - direct key-value parsing
        const outTimeMs = output.match(/out_time_ms=(\d+)/);
        const outTimeMatch = output.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);
        const totalSize = output.match(/total_size=(\d+)/);
        const progressStatus = output.match(/progress=(\w+)/);
        const speedMatch = output.match(/speed=\s*([\d.]+)x/);
        const bitrateMatch = output.match(/bitrate=\s*([\d.]+)(kbit|kbits|mbit|mbits)\/s/i);
        
        // Track final summary information
        if (output.includes('global headers') || output.includes('muxing overhead')) {
            // This is the final stats summary from FFmpeg
            const videoSizeMatch = output.match(/video:(\d+)kB/);
            const audioSizeMatch = output.match(/audio:(\d+)kB/);
            const subtitleSizeMatch = output.match(/subtitle:(\d+)kB/);
            const overheadMatch = output.match(/muxing overhead:\s*([\d.]+)%/);
            
            this.ffmpegStats = {
                videoSize: videoSizeMatch ? parseInt(videoSizeMatch[1], 10) * 1024 : 0,
                audioSize: audioSizeMatch ? parseInt(audioSizeMatch[1], 10) * 1024 : 0,
                subtitleSize: subtitleSizeMatch ? parseInt(subtitleSizeMatch[1], 10) * 1024 : 0,
                muxingOverhead: overheadMatch ? parseFloat(overheadMatch[1]) : 0
            };
        }
        
        let updateData = {
            ffmpegStats: this.ffmpegStats
        };
        
        // Get time information (most reliable method)
        if (outTimeMs) {
            // Time in milliseconds is most precise
            const timeInMs = parseInt(outTimeMs[1], 10);
            if (!isNaN(timeInMs)) {
                updateData.currentTime = timeInMs / 1000; // convert to seconds
            }
        } else if (outTimeMatch) {
            // Fallback to HH:MM:SS.MS format
            const hours = parseInt(outTimeMatch[1], 10);
            const minutes = parseInt(outTimeMatch[2], 10);
            const seconds = parseFloat(outTimeMatch[3]);
            updateData.currentTime = hours * 3600 + minutes * 60 + seconds;
        }
        
        // Get total downloaded bytes
        if (totalSize) {
            const size = parseInt(totalSize[1], 10);
            if (!isNaN(size)) {
                updateData.downloadedBytes = size;
            }
        } else {
            // Fallback to traditional size parsing if total_size isn't available
            const size = this.parseSize(output);
            if (size !== null) {
                updateData.downloadedBytes = size;
            }
        }
        
        // Extract speed information - keeping this as it's useful for progress calculations
        // but we'll remove it before sending to the UI
        if (speedMatch) {
            const speedValue = parseFloat(speedMatch[1]);
            if (!isNaN(speedValue)) {
                // We keep track of this internally but don't expose it in the final progress data
                this._ffmpegSpeed = speedValue;
            }
        }
        
        // For HLS/DASH, we still need segment tracking
        if (this.type === 'hls' || this.type === 'dash') {
            const segment = this.parseSegment(output);
            if (segment !== null) {
                updateData.currentSegment = segment;
            }
        }
        
        // Check if we've reached the end
        if (progressStatus && progressStatus[1] === 'end') {
            updateData.progress = 100;
            logDebug('ProgressStrategy: Detected end of processing');
        }
        
        // Only update if we have new data
        if (Object.keys(updateData).length > 1) { // More than just ffmpegStats
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
        // This is now a fallback method - the primary time extraction happens in processOutput
        // Look for standard time=HH:MM:SS.MS pattern
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            
            // Basic sanity check
            if (this.duration > 0 && totalSeconds > this.duration * 1.05) {
                return Math.min(totalSeconds, this.duration);
            }
            
            return totalSeconds;
        }
        
        // Look for time in seconds pattern
        const timeSecsMatch = output.match(/time=\s*([\d.]+)/);
        if (timeSecsMatch) {
            const timeInSeconds = parseFloat(timeSecsMatch[1]);
            if (!isNaN(timeInSeconds) && timeInSeconds > 0) {
                return timeInSeconds;
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
        // Method 1: Look for direct size in bytes (e.g. "size= 186388kB")
        const sizeMatch = output.match(/size=\s*(\d+)(\w+)/);
        if (sizeMatch) {
            const value = parseInt(sizeMatch[1], 10);
            const unit = sizeMatch[2].toLowerCase();
            
            switch (unit) {
                case 'kb': return value * 1024;
                case 'mb': return value * 1024 * 1024;
                case 'gb': return value * 1024 * 1024 * 1024;
                default: return value;
            }
        }
        
        // Method 2: Look for detailed breakdown (e.g. "video:171667kB audio:13874kB")
        const videoSizeMatch = output.match(/video:(\d+)kB/);
        const audioSizeMatch = output.match(/audio:(\d+)kB/);
        const subtitleSizeMatch = output.match(/subtitle:(\d+)kB/);
        
        if (videoSizeMatch || audioSizeMatch) {
            let totalSize = 0;
            
            if (videoSizeMatch) {
                totalSize += parseInt(videoSizeMatch[1], 10) * 1024;
            }
            
            if (audioSizeMatch) {
                totalSize += parseInt(audioSizeMatch[1], 10) * 1024;
            }
            
            if (subtitleSizeMatch) {
                totalSize += parseInt(subtitleSizeMatch[1], 10) * 1024;
            }
            
            // Only return if we found at least one valid size
            if (totalSize > 0) {
                return totalSize;
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
