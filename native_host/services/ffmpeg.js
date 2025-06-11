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

const fs = require('fs');
const path = require('path');
const os = require('os');
const { logDebug } = require('../utils/logger');
const configService = require('./config');

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
            // Initialize config service first
            configService.initialize();
            
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
            // Check if custom paths are configured and enabled
            const customPathsConfig = configService.get('ffmpegCustomPaths', { enabled: true });
            
            // If configuration has explicit paths and custom paths are enabled, use those
            if (customPathsConfig.enabled && 
                customPathsConfig.ffmpegPath && 
                customPathsConfig.ffprobePath) {
                
                if (fs.existsSync(customPathsConfig.ffmpegPath) && 
                    fs.existsSync(customPathsConfig.ffprobePath)) {
                    
                    this.ffmpegPath = customPathsConfig.ffmpegPath;
                    this.ffprobePath = customPathsConfig.ffprobePath;
                    logDebug('Using configured FFmpeg at:', this.ffmpegPath);
                    logDebug('Using configured FFprobe at:', this.ffprobePath);
                    return true;
                } else {
                    logDebug('Configured FFmpeg paths not found, falling back to defaults');
                }
            }
            
            // Platform-specific paths
            if (process.platform === 'darwin') {
                // Use the custom ffmpeg and ffprobe binaries from the project
                const customBinDir = path.join(__dirname, '..', 'bin', 'mac', 'bin');
                const ffmpegPath = path.join(customBinDir, 'ffmpeg');
                const ffprobePath = path.join(customBinDir, 'ffprobe');
                
                if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
                    this.ffmpegPath = ffmpegPath;
                    this.ffprobePath = ffprobePath;
                    
                    // Save these paths to config for future use
                    if (customPathsConfig.enabled) {
                        configService.set('ffmpegCustomPaths', {
                            enabled: true,
                            ffmpegPath: this.ffmpegPath,
                            ffprobePath: this.ffprobePath
                        });
                    }
                    
                    logDebug('Using custom FFmpeg at:', this.ffmpegPath);
                    logDebug('Using custom FFprobe at:', this.ffprobePath);
                    return true;
                } else {
                    logDebug('Custom FFmpeg binaries not found at:', customBinDir);
                    
                    // Fallback to system paths if custom binaries are not found
                    const macOSPaths = [
                        '/opt/homebrew/bin',  // M1 Mac Homebrew
                        '/usr/local/bin',     // Intel Mac Homebrew
                        '/opt/local/bin',     // MacPorts
                        '/usr/bin'            // System
                    ];
                    
                    // Try each path until we find both ffmpeg and ffprobe
                    for (const basePath of macOSPaths) {
                        const sysFfmpegPath = `${basePath}/ffmpeg`;
                        const sysFfprobePath = `${basePath}/ffprobe`;
                        
                        if (fs.existsSync(sysFfmpegPath) && fs.existsSync(sysFfprobePath)) {
                            this.ffmpegPath = sysFfmpegPath;
                            this.ffprobePath = sysFfprobePath;
                            logDebug('Falling back to system FFmpeg at:', this.ffmpegPath);
                            logDebug('Falling back to system FFprobe at:', this.ffprobePath);
                            return true;
                        }
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
     * Set custom FFmpeg path
     * @param {string} path - Path to FFmpeg binary
     */
    setFFmpegPath(path) {
        if (fs.existsSync(path)) {
            this.ffmpegPath = path;
            
            // Update config if initialized
            if (configService.initialized) {
                const customPathsConfig = configService.get('ffmpegCustomPaths', { enabled: true });
                configService.set('ffmpegCustomPaths', {
                    enabled: true,
                    ffmpegPath: path,
                    ffprobePath: customPathsConfig.ffprobePath || this.ffprobePath
                });
            }
            
            return true;
        }
        return false;
    }
    
    /**
     * Set custom FFprobe path
     * @param {string} path - Path to FFprobe binary
     */
    setFFprobePath(path) {
        if (fs.existsSync(path)) {
            this.ffprobePath = path;
            
            // Update config if initialized
            if (configService.initialized) {
                const customPathsConfig = configService.get('ffmpegCustomPaths', { enabled: true });
                configService.set('ffmpegCustomPaths', {
                    enabled: true,
                    ffmpegPath: customPathsConfig.ffmpegPath || this.ffmpegPath,
                    ffprobePath: path
                });
            }
            
            return true;
        }
        return false;
    }

    /**
     * Determine the type of video from the URL
     * @param {string} url - Video URL
     * @returns {string} - Video type: 'hls', 'dash', 'direct', 'blob', or 'unknown'
     */
    getVideoTypeFromUrl(url) {
        try {
            // Check for streaming formats first
            if (url.includes('.m3u8')) {
                return 'hls';
            } else if (url.includes('.mpd')) {
                return 'dash';
            } 
            
            // Handle direct media files - check for file extensions
            const fileExtensionMatch = url.match(/\.([^./?#]+)($|\?|#)/i);
            if (fileExtensionMatch) {
                const extension = fileExtensionMatch[1].toLowerCase();
                
                // Modern container formats - MP4, WebM, MOV
                if (['mp4', 'webm', 'mov'].includes(extension)) {
                    return 'direct';
                }
                
                // Legacy container formats - AVI, MKV, FLV, OGG
                if (['avi', 'mkv', 'flv', 'ogg'].includes(extension)) {
                    return 'direct';
                }
                
                // Audio formats
                if (['mp3', 'aac', 'wav', 'm4a'].includes(extension)) {
                    return 'direct';
                }
            }
            
            // Handle blob URLs
            if (url.startsWith('blob:')) {
                return 'blob';
            }
            
            // Default to unknown if no match
            return 'unknown';
        } catch (err) {
            logDebug('Error determining video type:', err);
            return 'unknown';
        }
    }
}

module.exports = new FFmpegService();
