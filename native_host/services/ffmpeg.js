/**
 * @ai-guide-component FFmpegService
 * @ai-guide-description Core service for video processing using FFmpeg
 * @ai-guide-responsibilities
 * - Manages FFmpeg binary location and execution
 * - Detects video type and format from URLs
 * - Handles video stream analysis and metadata extraction
 * - Generates video previews/thumbnails
 * - Provides utilities for FFmpeg command construction
 * - Supports hardware acceleration detection and usage
 */

// services/ffmpeg.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logDebug } = require('../utils/logger');

/**
 * FFmpeg service for handling video processing operations
 */
class FFmpegService {
    constructor() {
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.initialized = false;
    }

    /**
     * Initialize the FFmpeg service
     */
    initialize() {
        if (this.initialized) {
            return true;
        }

        try {
            // Check if FFmpeg and FFprobe are available
            if (this.checkFFmpeg()) {
                this.initialized = true;
                return true;
            }
            return false;
        } catch (err) {
            logDebug('FFmpeg initialization failed:', err);
            return false;
        }
    }

    /**
     * Check for FFmpeg and FFprobe installation
     */
    checkFFmpeg() {
        try {
            // Try multiple common macOS paths first for M1/Intel Macs
            const macOSPaths = [
                '/opt/homebrew/bin',  // M1 Mac Homebrew
                '/usr/local/bin',     // Intel Mac Homebrew
                '/opt/local/bin',     // MacPorts
                '/usr/bin'            // System
            ];

            if (process.platform === 'darwin') {
                // Try each path until we find both ffmpeg and ffprobe
                for (const basePath of macOSPaths) {
                    const ffmpegPath = `${basePath}/ffmpeg`;
                    const ffprobePath = `${basePath}/ffprobe`;
                    
                    if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
                        this.ffmpegPath = ffmpegPath;
                        this.ffprobePath = ffprobePath;
                        logDebug('Found FFmpeg at:', this.ffmpegPath);
                        logDebug('Found FFprobe at:', this.ffprobePath);
                        return true;
                    }
                }
            } else if (process.platform === 'win32') {
                // Windows paths
                this.ffmpegPath = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
                this.ffprobePath = 'C:\\ffmpeg\\bin\\ffprobe.exe';
            } else {
                // Linux paths
                this.ffmpegPath = '/usr/bin/ffmpeg';
                this.ffprobePath = '/usr/bin/ffprobe';
            }

            // Final check if paths are valid
            if (!fs.existsSync(this.ffmpegPath) || !fs.existsSync(this.ffprobePath)) {
                throw new Error('FFmpeg or FFprobe not found at specified paths');
            }

            return true;
        } catch (err) {
            logDebug('FFmpeg check failed:', err);
            return false;
        }
    }

    /**
     * Get the detected FFmpeg path
     */
    getFFmpegPath() {
        return this.ffmpegPath;
    }

    /**
     * Get the detected FFprobe path
     */
    getFFprobePath() {
        return this.ffprobePath;
    }

    /**
     * Determine the type of video from the URL
     */
    getVideoTypeFromUrl(url) {
        if (url.includes('.m3u8')) {
            return 'hls';
        } else if (url.includes('.mpd')) {
            return 'dash';
        } else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)/i.test(url)) {
            return 'direct';
        } else if (url.startsWith('blob:')) {
            return 'blob';
        } else {
            return 'unknown';
        }
    }
}

module.exports = new FFmpegService();
