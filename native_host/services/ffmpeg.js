/**
 * FFmpegService – Core service for video processing using FFmpeg
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
            
            // Try to get binaries using smart path resolution
            const binaryPaths = this.getBinaryPaths();
            
            if (fs.existsSync(binaryPaths.ffmpeg) && fs.existsSync(binaryPaths.ffprobe)) {
                this.ffmpegPath = binaryPaths.ffmpeg;
                this.ffprobePath = binaryPaths.ffprobe;
                
                // Save these paths to config for future use
                if (customPathsConfig.enabled) {
                    configService.set('ffmpegCustomPaths', {
                        enabled: true,
                        ffmpegPath: this.ffmpegPath,
                        ffprobePath: this.ffprobePath
                    });
                }
                
                logDebug('Using FFmpeg at:', this.ffmpegPath);
                logDebug('Using FFprobe at:', this.ffprobePath);
                return true;
            }

            // Fallback to system paths
            return this.trySystemPaths();
        } catch (err) {
            logDebug('FFmpeg check failed:', err);
            return false;
        }
    }

    /**
     * Detect platform with architecture for binary selection
     */
    detectPlatform() {
        const platform = process.platform;
        const arch = process.arch;
        
        switch (platform) {
            case 'darwin':
                return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
            case 'win32':
                return arch === 'arm64' ? 'win-arm64' : 'win-x64';
            case 'linux':
                return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
            default:
                // Fallback to x64 for unknown platforms
                return `${platform}-x64`;
        }
    }

    /**
     * Get binary paths based on execution context (dev vs built)
     */
    getBinaryPaths() {
        // Check if we're running from a built binary (pkg sets this)
        const isBuilt = typeof process.pkg !== 'undefined';
        
        if (isBuilt) {
            // Built binary: binaries are in same directory as executable
            const execDir = path.dirname(process.execPath);
            logDebug('Running from built binary, exec dir:', execDir);
            
            return {
                ffmpeg: path.join(execDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
                ffprobe: path.join(execDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
            };
        } else {
            // Development: use bin folder structure with platform-architecture detection
            logDebug('Running in development mode');
            const platform = this.detectPlatform();
            const binDir = path.join(__dirname, '..', 'bin', platform);
            
            return {
                ffmpeg: path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
                ffprobe: path.join(binDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
            };
        }
    }

    /**
     * Try system-installed FFmpeg as fallback
     */
    trySystemPaths() {
        logDebug('Trying system FFmpeg paths as fallback');
        
        const systemPaths = process.platform === 'darwin' ? [
            '/opt/homebrew/bin',  // M1 Mac Homebrew
            '/usr/local/bin',     // Intel Mac Homebrew
            '/opt/local/bin',     // MacPorts
            '/usr/bin'            // System
        ] : process.platform === 'win32' ? [
            'C:\\ffmpeg\\bin',
            'C:\\Program Files\\ffmpeg\\bin'
        ] : [
            '/usr/bin',
            '/usr/local/bin'
        ];
        
        const extension = process.platform === 'win32' ? '.exe' : '';
        
        for (const basePath of systemPaths) {
            const ffmpegPath = path.join(basePath, `ffmpeg${extension}`);
            const ffprobePath = path.join(basePath, `ffprobe${extension}`);
            
            if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
                this.ffmpegPath = ffmpegPath;
                this.ffprobePath = ffprobePath;
                logDebug('Using system FFmpeg at:', this.ffmpegPath);
                logDebug('Using system FFprobe at:', this.ffprobePath);
                return true;
            }
        }
        
        logDebug('No system FFmpeg found');
        return false;
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
}

module.exports = new FFmpegService();
