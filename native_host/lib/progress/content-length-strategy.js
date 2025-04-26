/**
 * @ai-guide-component ContentLengthStrategy
 * @ai-guide-description Progress tracking based on HTTP Content-Length header
 * @ai-guide-responsibilities
 * - Performs a HEAD request to get Content-Length
 * - Calculates progress based on downloaded bytes vs. total size
 * - Provides the most accurate progress tracking for direct media
 */

// lib/progress/content-length-strategy.js
const https = require('https');
const http = require('http');
const { URL } = require('url');
const BaseProgressStrategy = require('./base-strategy');
const { logDebug } = require('../../utils/logger');

/**
 * Progress strategy that uses Content-Length header to track progress
 */
class ContentLengthStrategy extends BaseProgressStrategy {
    /**
     * Initialize the strategy by getting Content-Length
     * @param {Object} options Options object
     * @returns {Promise<boolean>} True if successful
     */
    async initialize(options = {}) {
        if (!this.url) {
            return false;
        }
        
        try {
            logDebug('Getting Content-Length for:', this.url);
            const contentLength = await this.getContentLength(this.url);
            
            if (contentLength) {
                this.totalSize = contentLength;
                this.confidenceLevel = 0.9; // Very high confidence
                logDebug('Content-Length strategy initialized with size:', this.totalSize);
                return true;
            }
            
            logDebug('Content-Length not available for:', this.url);
            return false;
        } catch (error) {
            logDebug('Content-Length strategy initialization failed:', error.message);
            return false;
        }
    }
    
    /**
     * Get Content-Length header using HEAD request
     * @param {string} url URL to request
     * @returns {Promise<number|null>} Content-Length or null
     */
    getContentLength(url) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const protocol = urlObj.protocol === 'https:' ? https : http;
                
                const options = {
                    method: 'HEAD',
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    timeout: 5000, // 5 second timeout
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };
                
                const req = protocol.request(options, (res) => {
                    if (res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 304) {
                        const contentLength = res.headers['content-length'];
                        if (contentLength) {
                            resolve(parseInt(contentLength, 10));
                        } else {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                    
                    // Consume response data to free up memory
                    res.resume();
                });
                
                req.on('error', (error) => {
                    logDebug('HEAD request error:', error.message);
                    resolve(null);
                });
                
                req.on('timeout', () => {
                    req.destroy();
                    logDebug('HEAD request timed out');
                    resolve(null);
                });
                
                req.end();
                
            } catch (error) {
                logDebug('Error getting Content-Length:', error.message);
                resolve(null);
            }
        });
    }
    
    /**
     * Update progress based on downloaded bytes
     * @param {Object} data Progress data
     */
    update(data) {
        if (!this.totalSize || this.totalSize <= 0) {
            // Fall back to data.progress if available
            this.sendProgress(data);
            return;
        }
        
        const downloaded = data.downloaded || 0;
        
        // Calculate progress percentage
        let progress = 0;
        if (downloaded > 0) {
            progress = Math.min(99.9, (downloaded / this.totalSize) * 100);
            
            // Increase confidence as we download more
            this.confidenceLevel = Math.min(0.95, 0.5 + (downloaded / this.totalSize) * 0.5);
            
            // If we've downloaded more than the Content-Length, something's off
            if (downloaded > this.totalSize * 1.05) {
                this.confidenceLevel = 0.5;
            }
        }
        
        // Apply smoothing for more stable UI
        const smoothedProgress = this.smoothProgress(progress);
        
        this.sendProgress({
            ...data,
            progress: Math.round(smoothedProgress),
            size: this.totalSize
        });
    }
    
    /**
     * Process FFmpeg output to extract size information
     * @param {string} output FFmpeg stderr output
     */
    processOutput(output) {
        // Extract size from FFmpeg output
        const size = this.parseSize(output);
        
        if (size) {
            this.update({
                downloaded: size
            });
        }
    }
}

module.exports = ContentLengthStrategy;