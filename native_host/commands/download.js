/**
 * DownloadCommand – Central command class for orchestrating video/audio downloads using FFmpeg.
 * Responsibilities:
 * - Receives download/cancel requests from the extension and validates parameters.
 * - Determines the correct container format and output filename based on user input, media type, and source data.
 * - Constructs FFmpeg command-line arguments for HLS, DASH, and direct media, including support for HTTP headers and stream selection.
 * - Ensures output file uniqueness and resolves save paths, defaulting to Desktop if unspecified.
 * - Probes media duration with ffprobe if not provided, to enable accurate progress tracking.
 * - Launches FFmpeg as a child process, tracks progress via ProgressTracker, and relays updates to the UI.
 * - Handles download cancellation, process cleanup, and partial file removal.
 * - Logs all key actions, errors, and data flow for transparency and debugging.
 * - Maintains a static map of active download processes for robust cancellation and status management.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BaseCommand = require('./base-command');
const { logDebug } = require('../utils/logger');
const { getFullEnv } = require('../utils/resources');
const ProgressTracker = require('../lib/progress/progress-tracker');

/**
 * Command for downloading videos
 */
class DownloadCommand extends BaseCommand {
    // Static Map shared across all instances for process tracking
    static activeProcesses = new Map();

    /**
     * Cancel an ongoing download by downloadUrl
     * @param {Object} params Command parameters
     * @param {string} params.downloadUrl The download URL to cancel
     */
    async cancelDownload(params) {
        const { downloadUrl } = params;
        
        logDebug('Canceling download for:', downloadUrl);
        logDebug('Active processes Map has', DownloadCommand.activeProcesses.size, 'entries');
        logDebug('Active process URLs:', Array.from(DownloadCommand.activeProcesses.keys()));
        
        const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
        if (!processInfo) {
            logDebug('No active process found for:', downloadUrl);
            logDebug('Cancel request ignored - no matching download process');
            return;
        }
        
        const { ffmpegProcess, progressTracker, outputPath } = processInfo;
        
        try {
            // Mark as canceled before terminating FFmpeg process
            processInfo.wasCanceled = true;
            // Gracefully terminate FFmpeg process
            if (ffmpegProcess && !ffmpegProcess.killed) {
                logDebug('Terminating FFmpeg process with SIGTERM');
                ffmpegProcess.kill('SIGTERM');
                
                // Give it a moment to clean up, then force kill if needed
                setTimeout(() => {
                    if (!ffmpegProcess.killed) {
                        logDebug('Force killing FFmpeg process with SIGKILL');
                        ffmpegProcess.kill('SIGKILL');
                    }
                }, 2000);
            }
            
            // Clean up progress tracker
            if (progressTracker) {
                progressTracker.cleanup();
            }
            
            // Remove partial file if it exists
            if (outputPath && fs.existsSync(outputPath)) {
                try {
                    fs.unlinkSync(outputPath);
                    logDebug('Removed partial download file:', outputPath);
                } catch (err) {
                    logDebug('Failed to remove partial file:', err.message);
                }
            }
            
            logDebug('Download cancellation completed for:', downloadUrl);
            
            // Send immediate cancel confirmation
            this.sendSuccess({
                command: 'cancel-download',
                downloadUrl,
                duration: progressTracker.getDuration(),
                message: 'Download cancellation initiated successfully',
                completedAt: Date.now()
            });
            
        } catch (error) {
            logDebug('Error during download cancellation:', error);
            logDebug('Cancel operation failed, but not sending error message to extension');
        }
    }

    /**
     * Execute the download command
     * @param {Object} params Command parameters
     * @param {string} params.command The command type ('download' or 'cancel-download')
     * @param {string} params.downloadUrl Video URL to download
     * @param {string} params.filename Filename to save as
     * @param {string} params.savePath Path to save file to
     * @param {string} params.type Media type ('hls', 'dash', 'direct')
     * @param {string} params.preferredContainer User's preferred container format (optional)
     * @param {string} params.originalContainer Original container from source (optional)
     * @param {boolean} params.audioOnly Whether to download audio only (optional)
     * @param {string} params.streamSelection Stream selection spec for DASH (optional)
     * @param {string} params.masterUrl Optional master manifest URL (for reporting)
     * @param {Object} params.duration Video duration (optional)
     * @param {Object} params.headers HTTP headers to use (optional)
     */
    async execute(params) {
        const { command } = params;
        
        // Route to appropriate method based on command
        if (command === 'cancel-download') {
            return await this.cancelDownload(params);
        } else {
            return await this.executeDownload(params);
        }
    }

    /**
     * Execute the download command
     * @param {Object} params Command parameters (same as execute above)
     */
    async executeDownload(params) {
        const {
            downloadUrl,
            filename,
            savePath,
            type,
            preferredContainer = null,
            originalContainer = null,
            audioOnly = false,
            streamSelection,
            masterUrl = null,
            headers = {},
            // Progress tracking fields
            fileSizeBytes = null,
            duration = null,
            segmentCount = null,
            // Page context fields
            pageUrl = null,
            pageFavicon = null
        } = params;

        logDebug('Starting download:', params);
        
        if (headers && Object.keys(headers).length > 0) {
            logDebug('🔑 Using headers for download request:', Object.keys(headers));
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            // Determine container format
            const container = this.determineContainerFormat(params);
            
            // Generate clean output filename
            const outputFilename = this.generateOutputFilename(filename, container);
            
            // Resolve final output path with uniqueness check
            const uniqueOutput = this.resolveOutputPath(outputFilename, savePath);
            
            // Build FFmpeg command arguments
            const ffmpegArgs = this.buildFFmpegArgs({
                downloadUrl,
                type,
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
                downloadUrl,
                type,
                masterUrl,
                headers, 
                duration,
                fileSizeBytes,
                segmentCount,
                pageUrl,
                pageFavicon
            });
            
        } catch (err) {
            logDebug('Download error:', err);
            this.sendError({
                command: 'download-error',
                message: err.message,
                downloadUrl,
                masterUrl,
                type,
                ffmpegError: null,
                downloadStats: {}, // No stats available for early errors
                completedAt: Date.now(),
                pageUrl,
                pageFavicon
            });
            throw err;
        }
    }
    
    /**
     * Determine the appropriate container format based on parameters and video type
     * @private
     */
    determineContainerFormat(params) {
        const { preferredContainer, originalContainer, type, downloadUrl } = params;
        
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
        if (type === 'direct') {
            const urlExtMatch = downloadUrl.match(/\.([^./?#]+)($|\?|#)/i);
            const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : null;
            if (urlExt === 'webm') {
                return 'webm';
            }
        }
        
        // For HLS, default to MP4
        if (type === 'hls') {
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
        downloadUrl,
        type,
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
        if (type === 'hls' || type === 'dash') {
            args.push(
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-i', downloadUrl
            );
        } else {
            args.push('-i', downloadUrl);
        }
        
        // Stream selection
        if (audioOnly) {
            args.push('-map', '0:a');
            logDebug('🎵 Audio-only mode enabled');
        } 
        else if (streamSelection && type === 'dash') {
            // Parse stream selection string (e.g., "0:v:0,0:a:3,0:s:1") 
            streamSelection.split(',').forEach(streamSpec => {
                args.push('-map', streamSpec);
            });
            logDebug('🎯 Using stream selection:', streamSelection);
        }
        
        // Default to copying streams without re-encoding
        args.push('-c', 'copy');
        
        // Format-specific optimizations
        if (type === 'hls') {
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
     * Probe media duration using ffprobe
     * @param {Object} ffmpegService - FFmpeg service instance
     * @param {string} url - Media URL to probe
     * @param {Object} headers - HTTP headers to use for the request
     * @returns {Promise<number>} - Duration in seconds
     * @private
     */
    async probeMediaDuration(ffmpegService, url, headers = {}) {
        logDebug('Probing media duration for:', url);
        
        try {
            // Build headers argument if provided
            let headerArgs = [];
            if (headers && Object.keys(headers).length > 0) {
                const headerLines = Object.entries(headers)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\r\n');
                
                if (headerLines) {
                    headerArgs = ['-headers', headerLines + '\r\n'];
                    logDebug('🔑 Using headers for probe request');
                }
            }
            
            // Get path to ffprobe
            const ffprobePath = ffmpegService.getFFprobePath();
            if (!ffprobePath) {
                throw new Error('FFprobe path not available');
            }
            
            logDebug('Using FFprobe path:', ffprobePath);
            
            // Build probe command arguments
            const args = [
                ...headerArgs,
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'json',
                url
            ];
            
            logDebug('FFprobe command:', ffprobePath, args.join(' '));
            
            // Execute ffprobe as a child process
            const { stdout } = await new Promise((resolve, reject) => {
                const ffprobe = spawn(ffprobePath, args, { 
                    env: getFullEnv(),
                    windowsVerbatimArguments: process.platform === 'win32'
                });
                
                let stdout = '';
                let stderr = '';
                
                ffprobe.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                ffprobe.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                ffprobe.on('close', (code) => {
                    if (code === 0) {
                        resolve({ stdout, stderr });
                    } else {
                        reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
                    }
                });
                
                ffprobe.on('error', (err) => {
                    reject(err);
                });
            });
            
            // Parse the JSON output
            const result = JSON.parse(stdout);
            const duration = parseFloat(result?.format?.duration);
            
            if (isNaN(duration) || duration <= 0) {
                logDebug('Invalid duration returned from probe:', result);
                return null;
            }
            
            logDebug(`Probed duration: ${duration} seconds`);
            return duration;
        } catch (error) {
            logDebug('Error probing media duration:', error);
            return null;
        }
    }
    
    /**
     * Executes FFmpeg with progress tracking
     * @private
     */
    executeFFmpegWithProgress({
        ffmpegService,
        ffmpegArgs,
        uniqueOutput,
        downloadUrl,
        masterUrl,
        type,
        headers,
        duration,
        fileSizeBytes,
        segmentCount,
        pageUrl,
        pageFavicon
    }) {
        return new Promise(async (resolve, reject) => {
            // Probe duration upfront if not provided to avoid race conditions
            let finalDuration = duration;
            if (!duration || typeof duration !== 'number' || duration <= 0) {
                logDebug('No valid duration provided, probing media...');
                finalDuration = await this.probeMediaDuration(ffmpegService, downloadUrl, headers);
                if (finalDuration) {
                    logDebug('Got duration from probe:', finalDuration);
                } else {
                    logDebug('Could not probe duration, will rely on FFmpeg output parsing');
                }
            }
            
            // Create progress tracker with complete file information
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
            
            // Initialize once with all available metadata
            const fileInfo = {
                downloadUrl,
                type,
                masterUrl,
                outputPath: uniqueOutput,
                duration: finalDuration,
                fileSizeBytes,
                segmentCount
            };
            
            logDebug('Initializing progress tracker with:', fileInfo);
            
            try {
                const success = await progressTracker.initialize(fileInfo);
                if (!success) {
                    logDebug('Progress tracker initialization failed, continuing with basic tracking');
                }
            } catch (error) {
                logDebug('Error initializing progress tracker:', error);
                // Continue without progress tracking rather than failing
            }
            
            // Start FFmpeg process
            const ffmpeg = spawn(ffmpegService.getFFmpegPath(), ffmpegArgs, { 
                env: getFullEnv(),
                windowsVerbatimArguments: process.platform === 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            // Track this process as active
            DownloadCommand.activeProcesses.set(downloadUrl, {
                ffmpegProcess: ffmpeg,
                progressTracker,
                outputPath: uniqueOutput,
                wasCanceled: false // default
            });
            
            logDebug('Added process to activeProcesses Map. Total processes:', DownloadCommand.activeProcesses.size);
            
            let errorOutput = '';
            let hasError = false;
            
            // Simple data flow: FFmpeg output → ProgressTracker → UI
            ffmpeg.stderr.on('data', (data) => {
                if (hasError) return;
                
                const output = data.toString();
                errorOutput += output;
                
                // Single responsibility: just pass output to tracker
                progressTracker.processOutput(output);
            });
            
            ffmpeg.on('close', (code) => {
                progressTracker.cleanup();
                const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
                const wasCanceled = processInfo?.wasCanceled === true;
                const duration = progressTracker.getDuration();
                DownloadCommand.activeProcesses.delete(downloadUrl); // Remove from active processes on close
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const downloadStats = progressTracker.getDownloadStats();
                if (wasCanceled) {
                    logDebug('Download was canceled by user.');
                    this.sendSuccess({
                        command: 'download-canceled',
                        downloadUrl,
                        masterUrl,
                        type,
                        message: 'Download was canceled',
                        duration,
                        downloadStats: downloadStats || {},
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    return resolve({ 
                        success: false, 
                        downloadStats
                    });
                }
                if (code === 0 && !hasError) {
                    logDebug('Download completed successfully.');
                    this.sendSuccess({ 
                        command: 'download-success',
                        path: uniqueOutput,
                        filename: path.basename(uniqueOutput),
                        downloadUrl,
                        masterUrl,
                        type,
                        duration,
                        downloadStats: downloadStats || {},
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    resolve({ 
                        success: true, 
                        path: uniqueOutput,
                        downloadStats
                    });
                } else if (code === 255 && !hasError) {
                    // SIGTERM - process was terminated (cancellation)
                    logDebug('Download was terminated (SIGTERM).');
                    this.sendSuccess({
                        command: 'download-canceled',
                        downloadUrl,
                        masterUrl,
                        type,
                        message: 'Download was canceled',
                        duration,
                        downloadStats: downloadStats || {},
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    // Note: The original download promise resolves as canceled
                    // The cancel-download command gets its own immediate response in cancelDownload()
                    resolve({ 
                        success: false, 
                        downloadStats
                    });
                } else if (!hasError) {
                    hasError = true;
                    const error = `FFmpeg exited with code ${code}: ${errorOutput}`;
                    logDebug('Download failed:', error);
                    if (ffmpegFinalMessage) {
                        logDebug('FFmpeg final message:', ffmpegFinalMessage);
                    }
                    this.sendError({
                        command: 'download-error',
                        message: error,
                        downloadUrl,
                        masterUrl,
                        type,
                        duration,
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        downloadStats: downloadStats || {}, // Include stats in error message too
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    reject(new Error(error));
                }
            });
            
            ffmpeg.on('error', (err) => {
                if (!hasError) {
                    hasError = true;
                    const duration = progressTracker.getDuration();
                    DownloadCommand.activeProcesses.delete(downloadUrl); // Remove from active processes on error
                    progressTracker.cleanup();
                    const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                    const downloadStats = progressTracker.getDownloadStats(); // Get stats even on spawn error
                    
                    logDebug('FFmpeg spawn error:', err);
                    if (ffmpegFinalMessage) {
                        logDebug('FFmpeg final message:', ffmpegFinalMessage);
                    }
                    
                    this.sendError({
                        command: 'download-error',
                        message: err.message,
                        downloadUrl,
                        masterUrl,
                        type,
                        duration,
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        downloadStats: downloadStats || {}, // Include stats in spawn error too
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    
                    reject(err);
                }
            });
        });
    }
}

module.exports = DownloadCommand;
