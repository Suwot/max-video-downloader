/**
 * - Tracks and calculates download progress for direct, HLS, and DASH media types
 * - Selects optimal progress calculation strategy (size, duration, segment) based on available metadata
 * - Parses and aggregates FFmpeg output for real-time progress, speed, and segment tracking
 * - Smooths progress updates and batches UI notifications to minimize noise
 * - Estimates missing metadata (e.g., file size from bitrate/duration) and logs when critical data is missing
 * - Extracts and formats final download statistics from FFmpeg output
 * - Provides a unified interface for progress updates and cleanup
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
     * @param {boolean} options.audioOnly Whether this is an audio-only download
     * @param {boolean} options.subsOnly Whether this is a subtitles-only download
     */
    constructor(options = {}) {
        this.onProgress = options.onProgress || (() => {});
        this.downloadUrl = options.downloadUrl || null;
        this.type = options.type || 'direct';
        this.audioOnly = options.audioOnly || false;
        this.subsOnly = options.subsOnly || false;
        
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
        
        // For speed calculation - simplified for all types
        this.speedSamples = [];
        this.lastSegmentTime = Date.now();
        
        // Track which strategy we're using
        this.primaryStrategy = null;
        this.lockedCalculationMethod = null; // For dynamic strategy consistency
        
        // For tracking stream information from FFmpeg
        this.downloadStats = null;
        this.ffmpegFinalMessage = null; // Store FFmpeg final message after progress=end (for all outcomes)
        this.progressEndSeen = false; // Track if we've seen progress=end
        this.finalProcessedTime = null; // Store the final processed time from FFmpeg
        
        // For error line collection
        this.collectedErrorLines = []; // Store error lines throughout the process
        
        // Persistent state - accumulates all data over time
        this.currentState = {
            currentTime: 0,
            downloadedBytes: 0,
            currentSegment: 0
        };
        
        // For batching updates with strategy-gating
        this.updateTimer = null;
        this.lastUpdateTime = 0;
        this.fallbackUpdateTimer = null;
        
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

        // Check type-specific requirements and set primary strategy for logging
        switch (this.type) {
            case 'direct':
                // For audio-only downloads, prefer time-based strategy since file size represents the full video
                if (this.audioOnly && this.duration > 0) {
                    logDebug(`ProgressStrategy: Direct audio-only - time-based primary (${this.duration}s, ignoring video file size)`);
                    this.primaryStrategy = 'duration';
                } else if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: Direct media - size-based primary (${this.fileSizeBytes} bytes)`);
                    this.primaryStrategy = 'size';
                } else if (this.duration > 0) {
                    logDebug(`ProgressStrategy: Direct media - time-based fallback (${this.duration}s)`);
                    this.primaryStrategy = 'duration';
                } else {
                    logDebug('ProgressStrategy: Direct media - dynamic strategy from FFmpeg output');
                    this.primaryStrategy = 'dynamic';
                }
                return true;

            case 'hls':
                if (this.duration > 0) {
                    logDebug(`ProgressStrategy: HLS - time-based primary (${this.duration}s)`);
                    this.primaryStrategy = 'duration';
                } else if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: HLS - size-based fallback (${this.fileSizeBytes} bytes)`);
                    this.primaryStrategy = 'size';
                } else if (this.segmentCount > 0) {
                    logDebug(`ProgressStrategy: HLS - segment-based last resort (${this.segmentCount} segments)`);
                    this.primaryStrategy = 'segments';
                } else {
                    logDebug('ProgressStrategy: HLS - dynamic strategy from FFmpeg output');
                    this.primaryStrategy = 'dynamic';
                }
                return true;

            case 'dash':
                if (this.duration > 0) {
                    logDebug(`ProgressStrategy: DASH - time-based primary (${this.duration}s)`);
                    this.primaryStrategy = 'duration';
                } else if (this.fileSizeBytes > 0) {
                    logDebug(`ProgressStrategy: DASH - size-based fallback (${this.fileSizeBytes} bytes)`);
                    this.primaryStrategy = 'size';
                } else {
                    logDebug('ProgressStrategy: DASH - dynamic strategy from FFmpeg output');
                    this.primaryStrategy = 'dynamic';
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
        // Extract relevant data for ongoing progress
        const currentTime = data.currentTime || 0;
        const downloaded = data.downloadedBytes || 0;
        const currentSegment = data.currentSegment || this.currentSegment;
        
        // Keep track of segment changes (useful for HLS)
        const isNewSegment = currentSegment > this.currentSegment;
        if (isNewSegment) {
            this.currentSegment = currentSegment;
        }
        
        // Calculate progress using ONLY the primary strategy's data source
        let progress = 0;
        let progressInfo = {};
        
        switch (this.type) {
            case 'direct':
                // Use strategy-locked calculation to respect the chosen primary strategy
                progress = this.calculateStrategyProgress(currentTime, 0, downloaded);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0,
                    strategy: this.primaryStrategy
                };
                break;
                
            case 'hls':
                // Use strategy-locked calculation instead of multi-strategy fallback
                progress = this.calculateStrategyProgress(currentTime, currentSegment, downloaded);
                progressInfo = { 
                    currentTime,
                    totalDuration: this.duration || 0,
                    currentSegment,
                    totalSegments: this.segmentCount || 0,
                    strategy: this.primaryStrategy
                };
                break;
                
            case 'dash':
                progress = this.calculateStrategyProgress(currentTime, 0, downloaded);
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
        const speed = this.calculateSpeed(downloaded);
        
        // Direct progress calculation for ongoing updates
        let finalProgress;
        
        if (this.primaryStrategy === 'size' && this.fileSizeBytes > 0 && downloaded > 0) {
            // Direct size-based calculation for size strategy - most reliable method
            const exactProgress = (downloaded / this.fileSizeBytes) * 100;
            finalProgress = Math.min(99.9, exactProgress); // Cap at 99.9% until we get an explicit end marker
        } else {
            // Apply minimal smoothing for streaming formats or when no size available
            finalProgress = Math.min(99.9, smoothedProgress); 
        }
        
        // Round values immediately at source to avoid unnecessary precision
        const progressData = {
            progress: Math.round(finalProgress * 10) / 10, // Round to 1 decimal place
            speed: Math.round(speed),
            elapsedTime: (Date.now() - this.startTime) / 1000,
            type: this.type,
            strategy: this.primaryStrategy,
            downloadedBytes: downloaded,
            totalBytes: this.fileSizeBytes || null
        };
        
        // Round progressInfo values as well
        const roundedProgressInfo = {};
        if (progressInfo.currentTime) {
            roundedProgressInfo.currentTime = Math.round(progressInfo.currentTime);
        }
        if (progressInfo.totalDuration) {
            roundedProgressInfo.totalDuration = Math.round(progressInfo.totalDuration);
        }
        if (progressInfo.currentSegment) {
            roundedProgressInfo.currentSegment = progressInfo.currentSegment; // Keep as integer
        }
        if (progressInfo.totalSegments) {
            roundedProgressInfo.totalSegments = progressInfo.totalSegments; // Keep as integer
        }
        if (progressInfo.strategy) {
            roundedProgressInfo.strategy = progressInfo.strategy; // Keep as string
        }
        
        this.sendProgress({
            ...progressData,
            ...roundedProgressInfo
        });
    }

    /**
     * Calculate progress using ONLY the primary strategy's data source
     * This prevents jumping between different calculation methods
     * @param {number} currentTime Current playback time
     * @param {number} currentSegment Current segment number  
     * @param {number} downloadedBytes Bytes downloaded
     * @returns {number} Progress percentage (0-100)
     */
    calculateStrategyProgress(currentTime, currentSegment, downloadedBytes) {
        switch (this.primaryStrategy) {
            case 'duration':
                // ONLY use time-based calculation, ignore all other data
                if (this.duration > 0 && currentTime > 0) {
                    const effectiveTime = Math.min(currentTime, this.duration);
                    return (effectiveTime / this.duration) * 100;
                }
                return 0;
                
            case 'size':
                // ONLY use size-based calculation, ignore all other data
                if (this.fileSizeBytes > 0 && downloadedBytes > 0) {
                    return Math.min((downloadedBytes / this.fileSizeBytes) * 100, 100);
                }
                return 0;
                
            case 'segments':
                // ONLY use segment-based calculation, ignore all other data
                if (this.segmentCount > 0 && currentSegment > 0) {
                    const effectiveSegment = Math.min(currentSegment, this.segmentCount);
                    return (effectiveSegment / this.segmentCount) * 100;
                }
                return 0;
                
            case 'dynamic':
                // For dynamic strategy, use the first available data source in priority order
                // but once chosen, stick with it for the entire download
                if (!this.lockedCalculationMethod) {
                    // Determine calculation method on first use
                    if (this.duration > 0 && currentTime > 0) {
                        this.lockedCalculationMethod = 'duration';
                        this.primaryStrategy = 'duration'; // Update primary strategy for consistency
                    } else if (this.fileSizeBytes > 0 && downloadedBytes > 0) {
                        this.lockedCalculationMethod = 'size';
                        this.primaryStrategy = 'size'; // Update primary strategy for consistency
                    } else if (this.segmentCount > 0 && currentSegment > 0) {
                        this.lockedCalculationMethod = 'segments';
                        this.primaryStrategy = 'segments'; // Update primary strategy for consistency
                    } else {
                        return 0; // No data available yet
                    }
                }
                
                // Use the locked calculation method (recursive call with updated primaryStrategy)
                return this.calculateStrategyProgress(currentTime, currentSegment, downloadedBytes);
                
            default:
                return 0;
        }
    }
    /**
     * Legacy direct progress calculation with hardcoded priority (size → time)
     * NOTE: This is no longer used in the main flow. Direct types now use calculateStrategyProgress()
     * to respect the chosen primaryStrategy (important for audioOnly downloads).
     * Kept for debugging or fallback scenarios.
     * @param {number} downloadedBytes Bytes downloaded
     * @param {number} currentTime Current playback time
     * @returns {number} Progress percentage (0-100)
     */
    calculateDirectProgress(downloadedBytes, currentTime) {
        // Strategy 1 (Primary): Size-based - most accurate for direct downloads
        if (this.fileSizeBytes > 0 && downloadedBytes > 0) {
            return (downloadedBytes / this.fileSizeBytes) * 100;
        }
        
        // Strategy 2 (Fallback): Time-based - when no Content-Length available
        if (this.duration > 0 && currentTime > 0) {
            const effectiveTime = Math.min(currentTime, this.duration);
            return (effectiveTime / this.duration) * 100;
        }
        
        // No reliable data available
        return 0;
    }

    /**
     * Calculate download speed using 3-second rolling window
     * @param {number} downloaded Bytes downloaded (cumulative from FFmpeg)
     * @returns {number} Speed in bytes per second
     */
    calculateSpeed(downloaded) {
        const now = Date.now();
        
        // Remove samples older than 3 seconds
        this.speedSamples = this.speedSamples.filter(sample => 
            now - sample.timestamp <= 3000
        );
        
        // Add current sample
        this.speedSamples.push({
            bytes: downloaded,
            timestamp: now
        });
        
        // Need at least 2 samples to calculate speed
        if (this.speedSamples.length < 2) {
            return 0;
        }
        
        // Calculate speed over entire 3-second window
        const oldest = this.speedSamples[0];
        const newest = this.speedSamples[this.speedSamples.length - 1];
        
        const totalBytes = newest.bytes - oldest.bytes;
        const totalTime = (newest.timestamp - oldest.timestamp) / 1000;
        
        return totalTime > 0 ? totalBytes / totalTime : 0;
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
        // Always collect error lines throughout the process for later use
        this.collectErrorLines(output);
        
        // Capture final processed time before progress=end (for partial downloads)
        if (!this.progressEndSeen) {
            this.captureFinalProcessedTime(output);
        }
        
        // Handle final completion status and extract stats
        const progressStatus = output.match(/progress=(\w+)/);
        if (progressStatus && progressStatus[1] === 'end') {
            this.progressEndSeen = true;
            
            // Extract final download statistics
            const videoSizeMatch = output.match(/video:(\d+)kB/);
            const audioSizeMatch = output.match(/audio:(\d+)kB/);
            const subtitleSizeMatch = output.match(/subtitle:(\d+)kB/);
            const totalSizeMatch = output.match(/size=\s*(\d+)\s*kB/);
            const overheadMatch = output.match(/muxing overhead:\s*([\d.]+)%/);

            // Extract final bitrate (e.g., "bitrate= 131.5kbits/s" → 131500)
            const bitrateMatch = output.match(/bitrate=\s*([\d.]+)\s*kbits\/s/);
            
            this.downloadStats = {
                videoSize: videoSizeMatch ? parseInt(videoSizeMatch[1], 10) * 1024 : 0,
                audioSize: audioSizeMatch ? parseInt(audioSizeMatch[1], 10) * 1024 : 0,
                subtitleSize: subtitleSizeMatch ? parseInt(subtitleSizeMatch[1], 10) * 1024 : 0,
                totalSize: totalSizeMatch ? parseInt(totalSizeMatch[1], 10) * 1024 : 0,
                muxingOverhead: overheadMatch ? parseFloat(overheadMatch[1]) : 0,
                bitrateKbps: bitrateMatch ? Math.round(parseFloat(bitrateMatch[1])) : null
            };
            
            logDebug('ProgressStrategy: Detected end of processing with stats:', this.downloadStats);
            // Do not send progress: 100 - let the FFmpeg close event handle completion
            return;
        }
        
        // Capture ALL FFmpeg output after progress=end as final message (for all outcomes)
        if (this.progressEndSeen && output.trim()) {
            const trimmedOutput = output.trim();
            
            // Accumulate all output after progress=end
            if (!this.ffmpegFinalMessage) {
                this.ffmpegFinalMessage = '';
            }
            this.ffmpegFinalMessage += (this.ffmpegFinalMessage ? '\n' : '') + trimmedOutput;
            logDebug('ProgressStrategy: Captured FFmpeg final message:', trimmedOutput);
        }
        
        // Universal data parsing - only parse if we haven't seen progress=end yet
        if (!this.progressEndSeen) {
            this.parseAllData(output);
        }
    }
    
    /**
     * Universal data parsing - extracts all available data regardless of strategy
     * @param {string} output FFmpeg output
     */
    parseAllData(output) {
        let hasUpdate = false;
        let hasPrimaryUpdate = false;
        
        // Parse time information - always extract if available
        const outTimeUs = output.match(/out_time_us=(\d+)/);
        const outTimeMs = output.match(/out_time_ms=(\d+)/);
        const outTimeMatch = output.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);
        
        if (outTimeUs) {
            const timeInMicroseconds = parseInt(outTimeUs[1], 10);
            if (!isNaN(timeInMicroseconds)) {
                this.currentState.currentTime = timeInMicroseconds / 1000000;
                hasUpdate = true;
                // Check if this is primary data for our strategy
                if (this.primaryStrategy === 'duration' || this.primaryStrategy === 'dynamic') {
                    hasPrimaryUpdate = true;
                }
            }
        } else if (outTimeMs) {
            const timeInMicroseconds = parseInt(outTimeMs[1], 10);
            if (!isNaN(timeInMicroseconds)) {
                this.currentState.currentTime = timeInMicroseconds / 1000000;
                hasUpdate = true;
                if (this.primaryStrategy === 'duration' || this.primaryStrategy === 'dynamic') {
                    hasPrimaryUpdate = true;
                }
            }
        } else if (outTimeMatch) {
            const hours = parseInt(outTimeMatch[1], 10);
            const minutes = parseInt(outTimeMatch[2], 10);
            const seconds = parseFloat(outTimeMatch[3]);
            this.currentState.currentTime = hours * 3600 + minutes * 60 + seconds;
            hasUpdate = true;
            if (this.primaryStrategy === 'duration' || this.primaryStrategy === 'dynamic') {
                hasPrimaryUpdate = true;
            }
        }
        
        // Parse size information - only total_size= is available during progress
        const totalSize = output.match(/total_size=(\d+)/);
        
        if (totalSize) {
            const size = parseInt(totalSize[1], 10);
            if (!isNaN(size)) {
                this.currentState.downloadedBytes = size;
                hasUpdate = true;
                // Check if this is primary data for our strategy
                if (this.primaryStrategy === 'size' || this.primaryStrategy === 'dynamic') {
                    hasPrimaryUpdate = true;
                }
            }
        } else if (this.primaryStrategy === 'size' || this.primaryStrategy === 'dynamic') {
            // Only log warning if size is our primary strategy and we expected data
            if (output.includes('frame=') || output.includes('time=')) {
                logDebug('ProgressStrategy: Expected total_size= in FFmpeg progress output but not found:', output.substring(0, 100));
            }
        }
        
        // Parse segment information - always extract if available
        if (output.includes('Opening ') && output.includes(' for reading')) {
            const segment = this.parseSegment(output);
            if (segment !== null) {
                this.currentState.currentSegment = segment;
                hasUpdate = true;
                // Check if this is primary data for our strategy
                if (this.primaryStrategy === 'segments' || this.primaryStrategy === 'dynamic') {
                    hasPrimaryUpdate = true;
                }
            }
        }
        
        // Strategy-gated update scheduling
        if (hasPrimaryUpdate) {
            // Primary strategy data changed - schedule immediate update (respecting 250ms minimum)
            this.scheduleUpdate(true);
        } else if (hasUpdate) {
            // Non-primary data changed - schedule lower priority update
            this.scheduleUpdate(false);
        }
    }
    
    /**
     * Schedule a batched update with strategy-gating
     * @param {boolean} isPrimaryUpdate Whether this update contains primary strategy data
     */
    scheduleUpdate(isPrimaryUpdate = false) {
        const now = Date.now();
        
        if (isPrimaryUpdate) {
            // Primary strategy data changed - respect minimum interval but prioritize
            if (now - this.lastUpdateTime >= this.updateInterval) {
                // Send immediately if enough time has passed
                this.flushPendingUpdate();
                return;
            } else if (!this.updateTimer) {
                // Schedule for when minimum interval is reached
                const remainingTime = this.updateInterval - (now - this.lastUpdateTime);
                this.updateTimer = setTimeout(() => {
                    this.flushPendingUpdate();
                }, remainingTime);
            }
        } else {
            // Non-primary data changed - use fallback timer for UI responsiveness
            if (!this.fallbackUpdateTimer) {
                this.fallbackUpdateTimer = setTimeout(() => {
                    // Only send if we haven't sent a primary update recently
                    if (Date.now() - this.lastUpdateTime >= this.updateInterval) {
                        this.flushPendingUpdate();
                    }
                    this.fallbackUpdateTimer = null;
                }, this.updateInterval * 2); // Longer interval for non-primary updates
            }
        }
    }
    
    /**
     * Send accumulated update data
     */
    flushPendingUpdate() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        if (this.fallbackUpdateTimer) {
            clearTimeout(this.fallbackUpdateTimer);
            this.fallbackUpdateTimer = null;
        }
        
        this.lastUpdateTime = Date.now();
        
        // Always send complete current state
        this.update({ ...this.currentState });
    }

    /**
     * Parse segment information from FFmpeg output
     * @param {string} output FFmpeg output line
     * @returns {number|null} Segment number or null if not found
     */
    parseSegment(output) {
        // Look for FFmpeg opening a segment file for reading
        const segmentMatch = output.match(/Opening\s+['"]([^'"]*\.(ts|mp4|m4s|jpg|png))['"] for reading/);
        
        if (segmentMatch) {
            const url = segmentMatch[1];
            
            // FFmpeg processes segments sequentially, so we count each "Opening" event
            this.segmentCounter = (this.segmentCounter || 0) + 1;
            
            // logDebug(`ProgressStrategy: Processing segment ${this.segmentCounter}: ${url}`);
            return this.segmentCounter;
        }
        
        return null;
    }

    /**
     * Clean up timers and resources
     */
    cleanup() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        if (this.fallbackUpdateTimer) {
            clearTimeout(this.fallbackUpdateTimer);
            this.fallbackUpdateTimer = null;
        }
        
        // Don't flush pending updates during cleanup - 
        // we've already sent final completion status if download finished successfully
    }

    /**
     * Collect error lines from FFmpeg output for later use
     * @param {string} output FFmpeg output line
     */
    collectErrorLines(output) {
        const trimmedOutput = output.trim();
        if (!trimmedOutput) return;
        
        // Split output into lines and process each line separately
        const lines = trimmedOutput.split('\n');
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            // Collect lines starting with "Error" - these contain the most actionable information
            if (trimmedLine.startsWith('Error')) {
                // Avoid duplicates
                if (!this.collectedErrorLines.includes(trimmedLine)) {
                    this.collectedErrorLines.push(trimmedLine);
                    logDebug('ProgressStrategy: Collected error line:', trimmedLine);
                }
            }
        }
    }
    
    /**
     * Get derived error message from collected error lines
     * @returns {string|null} Consolidated error message or null if no errors collected
     */
    getDerivedErrorMessage() {
        if (!this.collectedErrorLines || this.collectedErrorLines.length === 0) {
            return null;
        }
        
        // Join all collected error lines with newlines
        return this.collectedErrorLines.join('\n');
    }
    
    /**
     * Capture the final processed time from FFmpeg progress output
     * This continuously updates until progress=end is seen
     * @param {string} output FFmpeg output
     */
    captureFinalProcessedTime(output) {
        // Parse time information - use the most precise format available
        const outTimeUs = output.match(/out_time_us=(\d+)/);
        const outTimeMs = output.match(/out_time_ms=(\d+)/);
        const outTimeMatch = output.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);

        if (outTimeUs) {
            const timeInMicroseconds = parseInt(outTimeUs[1], 10);
            if (!isNaN(timeInMicroseconds) && timeInMicroseconds > 0) {
                this.finalProcessedTime = Math.round(timeInMicroseconds / 1000000);
            }
        } else if (outTimeMs) {
            const timeInMilliseconds = parseInt(outTimeMs[1], 10);
            if (!isNaN(timeInMilliseconds) && timeInMilliseconds > 0) {
                this.finalProcessedTime = Math.round(timeInMilliseconds / 1000);
            }
        } else if (outTimeMatch) {
            const hours = parseInt(outTimeMatch[1], 10);
            const minutes = parseInt(outTimeMatch[2], 10);
            const seconds = parseFloat(outTimeMatch[3]);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            if (totalSeconds > 0) {
                this.finalProcessedTime = Math.round(totalSeconds);
            }
        }
    }
    
    /**
     * Get the final processed time (actual duration of processed content)
     * @returns {number|null} Final processed time in seconds or null if not available
     */
    getFinalProcessedTime() {
        return this.finalProcessedTime;
    }
}

module.exports = ProgressStrategy;
