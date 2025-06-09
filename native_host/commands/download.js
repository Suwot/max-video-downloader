/**
 * @ai-guide-component DownloadCommand
 * @ai-guide-description Handles video download operations using FFmpeg
 * @ai-guide-responsibilities
 * - Processes download requests from the extension
 * - Handles different stream types (HLS, DASH, direct)
 * - Constructs appropriate FFmpeg command based on video type
 * - Monitors download progress and reports back to extension
 * - Supports quality selection for different stream variants
 * - Handles download errors and reports them to the extension
 * - Sends progress updates every 250ms during download
 */

// commands/download.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BaseCommand = require('./base-command');
const { logDebug } = require('../utils/logger');
const { getFullEnv } = require('../utils/resources');
const ProgressTracker = require('../lib/progress-tracker');

/**
 * Command for downloading videos
 */
class DownloadCommand extends BaseCommand {
    /**
     * Execute the download command
     * @param {Object} params Command parameters
     * @param {string} params.url Video URL to download
     * @param {string} params.filename Filename to save as
     * @param {string} params.savePath Path to save file to
     * @param {string} params.videoType Media type ('hls', 'dash', 'direct')
     * @param {string} params.preferredContainer User's preferred container format (optional)
     * @param {string} params.originalContainer Original container from source (optional)
     * @param {boolean} params.audioOnly Whether to download audio only (optional)
     * @param {string} params.streamSelection Stream selection spec for DASH (optional)
     * @param {string} params.manifestUrl Optional master manifest URL (for reporting)
     * @param {Object} params.headers HTTP headers to use (optional)
     */
    async execute(params) {
        const {
            url,
            filename,
            savePath,
            manifestUrl,
            headers = {},
            audioOnly = false,
            streamSelection,
            videoType: explicitVideoType,
            duration = null
        } = params;

        logDebug('Starting download:', { 
            url, 
            filename, 
            savePath, 
            audioOnly: audioOnly || false,
            streamSelection: streamSelection || 'default'
        });
        
        if (headers && Object.keys(headers).length > 0) {
            logDebug('🔑 Using headers for download request:', Object.keys(headers));
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            // Determine video type - use explicit type from extension or detect from URL
            const videoType = explicitVideoType || ffmpegService.getVideoTypeFromUrl(url);
            
            // Determine container format
            const container = this.determineContainerFormat(params, videoType, url);
            
            // Generate clean output filename
            const outputFilename = this.generateOutputFilename(filename, container);
            
            // Resolve final output path with uniqueness check
            const uniqueOutput = this.resolveOutputPath(outputFilename, savePath);
            
            // Build FFmpeg command arguments
            const ffmpegArgs = this.buildFFmpegArgs({
                url,
                videoType,
                outputPath: uniqueOutput,
                container,
                audioOnly,
                streamSelection,
                headers
            });
            
            logDebug('FFmpeg command:', ffmpegService.getFFmpegPath(), ffmpegArgs.join(' '));
            
            // Execute FFmpeg with progress tracking
            return this.executeFFmpegWithProgress({
                ffmpegService,
                ffmpegArgs,
                uniqueOutput,
                url,
                videoType,
                manifestUrl,
                headers, 
                duration
            });
            
        } catch (err) {
            logDebug('Download error:', err);
            this.sendError(err.message);
            throw err;
        }
    }
    
    /**
     * Determine the appropriate container format based on parameters and video type
     * @private
     */
    determineContainerFormat(params, videoType, url) {
        const { preferredContainer, originalContainer } = params;
        
        // Explicit preferred container takes priority
        if (preferredContainer && /^(mp4|webm|mkv)$/i.test(preferredContainer)) {
            return preferredContainer.toLowerCase();
        }
        
        // Original container if provided (extension handles DASH container selection)
        if (originalContainer) {
            if (/^(mp4|webm|mkv|mov|m4v|ts|avi|flv)$/i.test(originalContainer)) {
                return originalContainer.toLowerCase();
            }
        }
        
        // For direct videos with webm extension, use webm
        if (videoType === 'direct') {
            const urlExtMatch = url.match(/\.([^./?#]+)($|\?|#)/i);
            const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : null;
            if (urlExt === 'webm') {
                return 'webm';
            }
        }
        
        // For HLS, default to MP4
        if (videoType === 'hls') {
            return 'mp4';
        }
        
        // Default fallback
        return 'mp4';
    }
    
    /**
     * Generate clean output filename
     * @private
     */
    generateOutputFilename(filename, container) {
        // Clean up filename: remove query params and extension  
        let outputFilename = (filename ? filename.replace(/[?#].*$/, '') : 'video');
        
        // Remove any existing video extensions
        outputFilename = outputFilename.replace(/\.(mp4|webm|mov|m4v|ts|avi|mkv|flv)$/i, '');
        
        return `${outputFilename}.${container}`;
    }
    
    /**
     * Resolves output path and ensures uniqueness
     * @private
     */
    resolveOutputPath(filename, savePath) {
        // Default to Desktop if no savePath or if it's "Desktop"
        const defaultDir = path.join(process.env.HOME || os.homedir(), 'Desktop');
        const targetDir = (!savePath || savePath === 'Desktop') ? defaultDir : savePath;
        
        // Join directory and filename
        let outputPath = path.join(targetDir, filename);
        
        // Ensure uniqueness
        let counter = 1;
        let uniqueOutput = outputPath;
        
        while (fs.existsSync(uniqueOutput)) {
            const ext = path.extname(outputPath);
            const base = outputPath.slice(0, -ext.length);
            uniqueOutput = `${base} (${counter})${ext}`;
            counter++;
        }
        
        logDebug('Output file will be:', uniqueOutput);
        return uniqueOutput;
    }
    
    /**
     * Builds FFmpeg command arguments based on input parameters
     * @private
     */
    buildFFmpegArgs({
        url,
        videoType,
        outputPath,
        container,
        audioOnly = false,
        streamSelection,
        headers = {}
    }) {
        const args = [];
        
        // Progress tracking arguments
        args.push('-stats', '-progress', 'pipe:2');
        
        // Add headers if provided
        if (headers && Object.keys(headers).length > 0) {
            const headerLines = Object.entries(headers)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\r\n');
            
            if (headerLines) {
                args.push('-headers', headerLines + '\r\n');
                logDebug('🔑 Added headers to FFmpeg command');
            }
        }
        
        // Input arguments based on media type
        if (videoType === 'hls' || videoType === 'dash') {
            args.push(
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-i', url
            );
        } else {
            args.push('-i', url);
        }
        
        // Stream selection
        if (audioOnly) {
            args.push('-map', '0:a');
            logDebug('🎵 Audio-only mode enabled');
        } 
        else if (streamSelection && videoType === 'dash') {
            // Parse stream selection string (e.g., "0:v:0,0:a:3,0:s:1") 
            streamSelection.split(',').forEach(streamSpec => {
                args.push('-map', streamSpec);
            });
            logDebug('🎯 Using stream selection:', streamSelection);
        }
        
        // Default to copying streams without re-encoding
        args.push('-c', 'copy');
        
        // Format-specific optimizations
        if (videoType === 'hls') {
            // Fix for certain audio streams commonly found in HLS
            args.push('-bsf:a', 'aac_adtstoasc');
        }
        
        // MP4/MOV optimizations
        if (['mp4', 'mov', 'm4v'].includes(container.toLowerCase())) {
            args.push('-movflags', '+faststart');
        }
        
        // Output path
        args.push(outputPath);
        
        return args;
    }
    
    /**
     * Executes FFmpeg with progress tracking
     * @private
     */
    executeFFmpegWithProgress({
        ffmpegService,
        ffmpegArgs,
        uniqueOutput,
        url,
        videoType,
        manifestUrl,
        headers,
        duration
    }) {
        return new Promise((resolve, reject) => {
            // Create progress tracker
            const progressTracker = new ProgressTracker({
                onProgress: (data) => {
                    this.sendProgress({
                        ...data,
                        filename: path.basename(uniqueOutput)
                    });
                },
                updateInterval: 200,
                debug: true
            });
            
            // Register tracking strategies
            ProgressTracker.registerDefaultStrategies(progressTracker);
            
            // Initialize with file info
            const fileInfo = {
                url: manifestUrl || url, // Use manifest URL if available
                type: videoType,
                outputPath: uniqueOutput
            };
            
            progressTracker.initialize(fileInfo)
                .then(() => {
                    logDebug('Progress tracker initialized successfully');
                })
                .catch(error => {
                    logDebug('Error initializing progress tracker:', error);
                });
            
            // Send initial progress update
            this.sendProgress({
                progress: 0,
                speed: 0,
                downloaded: 0,
                size: 0,
                filename: path.basename(uniqueOutput)
            });
            
            // If duration is provided and valid, use it directly
            if (duration && typeof duration === 'number' && duration > 0) {
                logDebug('Using provided duration from extension:', duration);
                progressTracker.update({
                    totalDuration: duration,
                    currentTime: 0
                });
            } else {
                // Only probe if duration wasn't provided or was invalid
                logDebug('No valid duration provided, probing media...');
                this.probeMediaDuration(ffmpegService, url, headers)
                    .then(probedDuration => {
                        if (probedDuration) {
                            logDebug('Got total duration from probe:', probedDuration);
                            progressTracker.update({
                                totalDuration: probedDuration,
                                currentTime: 0
                            });
                        }
                    })
                    .catch(error => {
                        logDebug('Error probing duration:', error);
                    });
            }
            
            // Start FFmpeg process
            const ffmpeg = spawn(ffmpegService.getFFmpegPath(), ffmpegArgs, { 
                env: getFullEnv(),
                windowsVerbatimArguments: process.platform === 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let errorOutput = '';
            let hasError = false;
            let lastBytes = 0;
            
            ffmpeg.stderr.on('data', (data) => {
                if (hasError) return;
                
                const output = data.toString();
                errorOutput += output;
                
                // Feed output to progress tracker
                progressTracker.processOutput(output);
            });
            
            ffmpeg.on('close', (code) => {
                if (code === 0 && !hasError) {
                    logDebug('Download completed successfully.');
                    
                    // Send final progress
                    this.sendProgress({
                        progress: 100,
                        downloaded: lastBytes,
                        speed: 0,
                        filename: path.basename(uniqueOutput)
                    });
                    
                    // Small delay to ensure progress is received first
                    setTimeout(() => {
                        this.sendSuccess({ 
                            path: uniqueOutput,
                            filename: path.basename(uniqueOutput)
                        });
                        resolve({ success: true, path: uniqueOutput });
                    }, 100);
                } else if (!hasError) {
                    hasError = true;
                    const error = `FFmpeg exited with code ${code}: ${errorOutput}`;
                    logDebug('Download failed:', error);
                    this.sendError(error);
                    reject(new Error(error));
                }
            });
            
            ffmpeg.on('error', (err) => {
                if (!hasError) {
                    hasError = true;
                    logDebug('FFmpeg spawn error:', err);
                    this.sendError(err.message);
                    reject(err);
                }
            });
        });
    }
}

module.exports = DownloadCommand;
