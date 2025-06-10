/**
 * @ai-guide-component SegmentTrackingStrategy
 * @ai-guide-description Progress tracking based on HLS/DASH segment counting
 * @ai-guide-responsibilities
 * - Analyzes streaming manifests to count segments
 * - Calculates progress based on segment download tracking
 * - Provides accurate progress tracking for streaming media
 * - Works with HLS (.m3u8) and DASH (.mpd) formats
 */

// lib/progress/segment-tracking-strategy.js
const BaseProgressStrategy = require('./base-strategy');
const ManifestParser = require('./manifest-parser');
const { logDebug } = require('../../utils/logger');

/**
 * Progress strategy that tracks segments in HLS/DASH streams
 */
class SegmentTrackingStrategy extends BaseProgressStrategy {
    /**
     * Create a new segment tracking strategy
     * @param {Object} options Configuration options
     */
    constructor(options) {
        super(options);
        this.manifestInfo = null;
        this.currentSegment = 0;
        this.totalSegments = 0;
        this.estimatedTotalSize = null;
        this.byteRatioFactor = 1.0; // Scale factor for byte-to-segment ratio
        this.lastSegmentUpdateTime = Date.now();
    }

    /**
     * Initialize the strategy
     * @param {Object} options Options object
     * @returns {Promise<boolean>} True if successful
     */
    async initialize(options = {}) {
        if (!this.downloadUrl) {
            logDebug('SEGMENT-TRACKING ERROR: No URL provided');
            return false;
        }
        
        if (!this.type) {
            logDebug('SEGMENT-TRACKING ERROR: No media type provided');
            return false;
        }
        
        if (this.type !== 'hls' && this.type !== 'dash') {
            logDebug(`SEGMENT-TRACKING ERROR: Unsupported media type: ${this.type}, must be 'hls' or 'dash'`);
            return false;
        }
        
        try {
            logDebug(`SEGMENT-TRACKING: Initializing for ${this.type} manifest at ${this.downloadUrl}`);
            
            const parser = new ManifestParser();
            this.manifestInfo = await parser.parse(this.downloadUrl, this.type);
            
            if (!this.manifestInfo) {
                logDebug('SEGMENT-TRACKING ERROR: Manifest parser returned null, likely failed to fetch or parse manifest');
                return false;
            }
            
            // Log all manifest info for debugging
            logDebug('SEGMENT-TRACKING: Manifest info received:', JSON.stringify(this.manifestInfo, null, 2));
            
            // For master playlists, we need to parse the highest quality variant
            if (this.manifestInfo.isMaster && this.manifestInfo.variants && this.manifestInfo.variants.length > 0) {
                // Sort by bandwidth (highest first)
                const sortedVariants = this.manifestInfo.variants.sort((a, b) => b.bandwidth - a.bandwidth);
                const highestQualityVariant = sortedVariants[0];
                
                logDebug(`SEGMENT-TRACKING: Using highest quality variant with bandwidth ${highestQualityVariant.bandwidth}`);
                logDebug(`SEGMENT-TRACKING: Variant URL: ${highestQualityVariant.url}`);
                
                // Parse the highest quality variant
                this.manifestInfo = await parser.parse(highestQualityVariant.url, this.type);
                if (!this.manifestInfo) {
                    logDebug('SEGMENT-TRACKING ERROR: Failed to parse variant manifest');
                    return false;
                }
            }
            
            // For success, we need either segment count or duration + bandwidth
            if (this.manifestInfo.segmentCount > 0) {
                this.totalSegments = this.manifestInfo.segmentCount;
                logDebug(`SEGMENT-TRACKING: Successfully initialized with ${this.totalSegments} segments`);
                this.confidenceLevel = 0.8; // High confidence with segment count
                return true;
            }
            
            if (this.manifestInfo.totalDuration > 0 && this.manifestInfo.bandwidth > 0) {
                // We can estimate total size based on duration and bandwidth
                this.totalDuration = this.manifestInfo.totalDuration;
                this.estimatedTotalSize = (this.manifestInfo.totalDuration * this.manifestInfo.bandwidth) / 8; // Convert bits to bytes
                
                logDebug(`SEGMENT-TRACKING: Initialized with duration ${this.totalDuration}s and bitrate ${this.manifestInfo.bandwidth/1000}kbps`);
                logDebug(`SEGMENT-TRACKING: Estimated total size: ${this.estimatedTotalSize} bytes (${Math.round(this.estimatedTotalSize/1024/1024)}MB)`);
                this.confidenceLevel = 0.7; // Good confidence with duration and bitrate
                return true;
            }
            
            logDebug('SEGMENT-TRACKING ERROR: Insufficient information for segment tracking');
            logDebug('SEGMENT-TRACKING ERROR: Need either segment count or both duration and bandwidth');
            
            // Report what was missing
            if (this.manifestInfo.segmentCount <= 0) {
                logDebug('SEGMENT-TRACKING ERROR: Missing segment count in manifest');
            }
            if (this.manifestInfo.totalDuration <= 0) {
                logDebug('SEGMENT-TRACKING ERROR: Missing or invalid duration in manifest');
            }
            if (this.manifestInfo.bandwidth <= 0) {
                logDebug('SEGMENT-TRACKING ERROR: Missing or invalid bandwidth in manifest');
            }
            
            return false;
        } catch (error) {
            logDebug('SEGMENT-TRACKING ERROR: Exception during initialization:', error.message);
            logDebug('SEGMENT-TRACKING ERROR: Stack trace:', error.stack);
            return false;
        }
    }

    /**
     * Update progress based on current segment and downloaded bytes
     * @param {Object} data Progress data from FFmpeg output
     */
    update(data) {
        // Extract relevant data
        const currentTime = data.currentTime || 0;
        const downloaded = data.downloaded || 0;
        const currentSegment = data.currentSegment || this.currentSegment;
        
        // Track downloaded bytes for bitrate calculation
        if (downloaded > this.lastBytes) {
            this.lastBytes = downloaded;
        }
        
        // If we have a specific segment update from FFmpeg, use it
        if (currentSegment > this.currentSegment) {
            this.currentSegment = currentSegment;
            this.lastSegmentUpdateTime = Date.now();
        }
        // Otherwise, if we have segment count, estimate current segment based on time
        else if (this.totalSegments > 0 && this.manifestInfo.totalDuration > 0 && currentTime > 0) {
            // Calculate the expected current segment based on time position
            // Be conservative by using floor instead of round to avoid overestimating
            const expectedSegment = Math.floor((currentTime / this.manifestInfo.totalDuration) * this.totalSegments);
            
            // Only update if it's an increase
            if (expectedSegment > this.currentSegment) {
                this.currentSegment = expectedSegment;
                this.lastSegmentUpdateTime = Date.now();
            }
            
            // Calculate segment-based progress
            const segmentProgress = Math.min(99.9, (this.currentSegment / this.totalSegments) * 100);
            
            // If we also have downloaded bytes, we can do a more accurate hybrid calculation
            if (downloaded > 0 && this.estimatedTotalSize) {
                const byteProgress = Math.min(99.9, (downloaded / this.estimatedTotalSize) * 100);
                
                // Adaptive blending based on confidence
                // Start with more weight on segment-based, gradually shift to byte-based
                const downloadRatio = Math.min(1.0, currentTime / this.manifestInfo.totalDuration);
                const segmentWeight = Math.max(0.3, 0.7 - (downloadRatio * 0.4));
                const byteWeight = 1.0 - segmentWeight;
                
                const hybridProgress = (segmentProgress * segmentWeight) + (byteProgress * byteWeight);
                
                // As we progress, increase confidence
                this.confidenceLevel = Math.min(0.95, 0.7 + (downloadRatio * 0.25));
                
                logDebug(`Hybrid progress: segments=${Math.round(segmentProgress)}%, bytes=${Math.round(byteProgress)}%, ` +
                        `hybrid=${Math.round(hybridProgress)}%, weights=[segments:${segmentWeight.toFixed(2)}, bytes:${byteWeight.toFixed(2)}], ` +
                        `confidence=${this.confidenceLevel.toFixed(2)}`);
                
                this.sendProgress({
                    ...data,
                    progress: Math.round(hybridProgress),
                    segmentProgress: this.currentSegment + '/' + this.totalSegments
                });
                return;
            }
            
            // If we don't have byte data, use segment-based progress
            this.confidenceLevel = Math.min(0.9, 0.7 + (currentTime / this.manifestInfo.totalDuration) * 0.2);
            
            logDebug(`Segment progress: ${Math.round(segmentProgress)}%, segments=${this.currentSegment}/${this.totalSegments}, confidence=${this.confidenceLevel.toFixed(2)}`);
            
            this.sendProgress({
                ...data,
                progress: Math.round(segmentProgress),
                segmentProgress: this.currentSegment + '/' + this.totalSegments
            });
            return;
        }
        
        // If we don't have segment count but have duration and bitrate, use time-based progress with bitrate adjustment
        if (this.manifestInfo && this.manifestInfo.totalDuration > 0 && this.manifestInfo.bandwidth > 0 && currentTime > 0) {
            // Calculate expected total size from duration and bitrate
            // and calculate progress based on downloaded bytes
            if (downloaded > 0) {
                // Update byte ratio factor based on actual download data
                if (currentTime > 10) { // Only after 10 seconds to have meaningful data
                    // Calculate actual bytes per second
                    const actualBytesPerSecond = downloaded / currentTime;
                    // Calculate expected bytes per second from manifest
                    const expectedBytesPerSecond = this.manifestInfo.bandwidth / 8; // bits to bytes
                    
                    // Adjust our ratio factor if there's a significant difference
                    if (expectedBytesPerSecond > 0 && actualBytesPerSecond > 0) {
                        // Use a slow-moving average to avoid overcorrecting
                        this.byteRatioFactor = 0.9 * this.byteRatioFactor + 0.1 * (actualBytesPerSecond / expectedBytesPerSecond);
                        logDebug(`Adjusted byte ratio: ${this.byteRatioFactor.toFixed(2)}`);
                    }
                }
                
                // Calculate estimated total size with our correction factor
                this.estimatedTotalSize = (this.manifestInfo.totalDuration * this.manifestInfo.bandwidth / 8) * this.byteRatioFactor;
                const progress = Math.min(99.9, (downloaded / this.estimatedTotalSize) * 100);
                
                // As download progresses, increase confidence
                const downloadRatio = currentTime / this.manifestInfo.totalDuration;
                this.confidenceLevel = Math.min(0.9, 0.6 + downloadRatio * 0.3);
                
                logDebug(`Bitrate-based progress: ${Math.round(progress)}%, downloaded=${downloaded}, estimated=${Math.round(this.estimatedTotalSize)}, confidence=${this.confidenceLevel.toFixed(2)}`);
                
                this.sendProgress({
                    ...data,
                    progress: Math.round(this.smoothProgress(progress))
                });
                return;
            }
            
            // Fall back to time-based if we don't have reliable byte data
            const progress = Math.min(99.9, (currentTime / this.manifestInfo.totalDuration) * 100);
            
            this.confidenceLevel = Math.min(0.8, 0.5 + (currentTime / this.manifestInfo.totalDuration) * 0.3);
            
            logDebug(`Time-based progress: ${Math.round(progress)}%, confidence=${this.confidenceLevel.toFixed(2)}`);
            
            this.sendProgress({
                ...data,
                progress: Math.round(this.smoothProgress(progress))
            });
            return;
        }
        
        // Last resort: pass through existing progress data
        this.sendProgress(data);
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
        
        // Look for segment download indications in FFmpeg output
        
        // Method 1: Look for segment pattern in Opening URL messages
        // Example: Opening 'https://example.com/segment_10.ts' for reading
        const segmentMatch = output.match(/Opening ['"].*?[_\/](\d+)\.(ts|mp4|m4s)['"] for reading/);
        if (segmentMatch) {
            const segmentNumber = parseInt(segmentMatch[1], 10);
            if (!isNaN(segmentNumber) && segmentNumber > 0) {
                // We found a segment number in the URL
                // Use this to adjust our current segment if needed
                if (segmentNumber > this.currentSegment) {
                    this.currentSegment = segmentNumber;
                    updateData.currentSegment = segmentNumber;
                    logDebug(`Detected segment number: ${segmentNumber}`);
                }
            }
        }
        
        // Method 2: Look for index patterns in filenames
        // Example: Opening 'media_b1600000_7.ts'
        const indexMatch = output.match(/Opening ['"][^'"]*?_(\d+)\.(ts|mp4|m4s)['"] for reading/);
        if (!segmentMatch && indexMatch) {
            const index = parseInt(indexMatch[1], 10);
            if (!isNaN(index) && index > 0) {
                if (index > this.currentSegment) {
                    this.currentSegment = index;
                    updateData.currentSegment = index;
                    logDebug(`Detected segment index: ${index}`);
                }
            }
        }
        
        // Only update if we have new data
        if (Object.keys(updateData).length > 0) {
            this.update(updateData);
        }
    }
}

module.exports = SegmentTrackingStrategy;