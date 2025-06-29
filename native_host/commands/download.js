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
            
            // Send response even when no process exists - UI needs confirmation
            this.sendSuccess({
                command: 'download-canceled',
                downloadUrl,
                message: 'Download already stopped or not found',
                downloadStats: null,
                duration: null,
                completedAt: Date.now()
            });
            return;
        }
        
        const { ffmpegProcess, progressTracker, outputPath } = processInfo;
        
        try {
            // Mark as canceled before terminating FFmpeg process
            processInfo.wasCanceled = true;
            
            // IMMEDIATELY remove from activeProcesses to prevent repeated cancels
            DownloadCommand.activeProcesses.delete(downloadUrl);
            logDebug('Removed process from activeProcesses Map immediately. Remaining processes:', DownloadCommand.activeProcesses.size);
            
            // Gracefully terminate FFmpeg process
            if (ffmpegProcess && !ffmpegProcess.killed) {
                logDebug('Terminating FFmpeg process with SIGTERM');
                ffmpegProcess.kill('SIGTERM');
                
                // Give it a moment to clean up, then force kill if needed
                setTimeout(() => {
                    if (ffmpegProcess && !ffmpegProcess.killed) {
                        logDebug('Force killing FFmpeg process with SIGKILL');
                        ffmpegProcess.kill('SIGKILL');
                    }
                }, 2000);
            } else {
                logDebug('FFmpeg process already terminated or killed');
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
                command: 'download-canceled',
                downloadUrl,
                duration: progressTracker.getDuration(),
                downloadStats: progressTracker.getDownloadStats() || null,
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
     * @param {string} params.defaultContainer Default container from processing (optional)
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
            defaultContainer = null,
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
                downloadStats: null, // No stats available for early errors (before FFmpeg starts)
                duration: null,
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
        const { preferredContainer, defaultContainer, type, audioOnly, downloadUrl } = params;
        
        // 1. User override takes priority (future feature)
        if (preferredContainer && /^(mp4|webm|mkv|mp3|m4a)$/i.test(preferredContainer)) {
            return preferredContainer.toLowerCase();
        }
        
        // 2. Audio-only mode - always use mp3
        if (audioOnly) {
            return 'mp3';
        }
        
        // 3. Use defaultContainer from processing (DASH from UI, Direct from FFprobe)
        if (defaultContainer && /^(mp4|webm|mkv|mov|m4v|ts|avi|flv)$/i.test(defaultContainer)) {
            return defaultContainer.toLowerCase();
        }
        
        // 4. Type-specific fallbacks
        if (type === 'hls') {
            return 'mp4';
        }
        
        // For direct videos with webm extension, use webm as final fallback
        if (type === 'direct') {
            const urlExtMatch = downloadUrl.match(/\.([^./?#]+)($|\?|#)/i);
            const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : null;
            if (urlExt === 'webm') {
                return 'webm';
            }
        }
        
        // 5. Final fallback
        return 'mp4';
    }
    
    /**
     * Generate clean output filename
     * @private
     */
    generateOutputFilename(filename, container) {
        // Clean up filename: remove query params and extension  
        let outputFilename = (filename ? filename.replace(/[?#].*$/, '') : 'audio');
        
        // For audio-only downloads, default to 'audio' if no filename
        if (container === 'mp3' && (!filename || filename.trim() === '')) {
            outputFilename = 'audio';
        }
        
        // Remove any existing video/audio extensions
        outputFilename = outputFilename.replace(/\.(mp4|webm|mov|m4v|ts|avi|mkv|flv|mp3|m4a|aac|wav)$/i, '');
        
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
            const probeStartTime = Date.now();
            const { stdout } = await new Promise((resolve, reject) => {
                const ffprobe = spawn(ffprobePath, args, { 
                    env: getFullEnv(),
                    windowsVerbatimArguments: process.platform === 'win32'
                });
                
                logDebug('FFprobe process started with PID:', ffprobe.pid);
                
                let stdout = '';
                let stderr = '';
                
                ffprobe.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                ffprobe.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                ffprobe.on('close', (code, signal) => {
                    const probeDuration = Date.now() - probeStartTime;
                    logDebug(`FFprobe completed in ${probeDuration}ms with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
                    
                    if (code === 0) {
                        resolve({ stdout, stderr });
                    } else {
                        reject(new Error(`FFprobe exited with code ${code}${signal ? ` (signal: ${signal})` : ''}: ${stderr}`));
                    }
                });
                
                ffprobe.on('error', (err) => {
                    const probeDuration = Date.now() - probeStartTime;
                    logDebug(`FFprobe spawn error after ${probeDuration}ms:`, err.message);
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
            const downloadStartTime = Date.now();
            const ffmpeg = spawn(ffmpegService.getFFmpegPath(), ffmpegArgs, { 
                env: getFullEnv(),
                windowsVerbatimArguments: process.platform === 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            logDebug('FFmpeg process started with PID:', ffmpeg.pid);
            
            // Track this process as active
            DownloadCommand.activeProcesses.set(downloadUrl, {
                ffmpegProcess: ffmpeg,
                progressTracker,
                outputPath: uniqueOutput,
                wasCanceled: false, // default
                startTime: downloadStartTime,
                pid: ffmpeg.pid
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
            
            ffmpeg.on('close', (code, signal) => {
                progressTracker.cleanup();
                const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
                const duration = progressTracker.getDuration();
                const downloadDuration = processInfo?.startTime ? Date.now() - processInfo.startTime : null;
                DownloadCommand.activeProcesses.delete(downloadUrl); // Remove from active processes on close
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const downloadStats = progressTracker.getDownloadStats();
                
                // Determine termination reason using signal and exit code
                const terminationInfo = this.analyzeProcessTermination(code, signal, processInfo?.wasCanceled);
                logDebug(`FFmpeg process (PID: ${processInfo?.pid}) terminated after ${downloadDuration}ms:`, terminationInfo);
                if (terminationInfo.wasCanceled) {
                    logDebug('Download was canceled by user.');
                    this.sendSuccess({
                        command: 'download-canceled',
                        downloadUrl,
                        masterUrl,
                        type,
                        message: `Download was canceled (${terminationInfo.reason})`,
                        duration,
                        downloadStats: downloadStats || null,
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        terminationInfo,
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    return resolve({ 
                        success: false, 
                        downloadStats
                    });
                }
                if (terminationInfo.isSuccess && !hasError) {
                    logDebug('Download completed successfully.');
                    this.sendSuccess({ 
                        command: 'download-success',
                        path: uniqueOutput,
                        filename: path.basename(uniqueOutput),
                        downloadUrl,
                        masterUrl,
                        type,
                        duration,
                        downloadStats: downloadStats || null,
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        terminationInfo,
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    resolve({ 
                        success: true, 
                        path: uniqueOutput,
                        downloadStats
                    });
                } else if (terminationInfo.wasCanceled && !hasError) {
                    // Handle signal-based cancellation detection
                    logDebug(`Download was terminated (${terminationInfo.reason}).`);
                    this.sendSuccess({
                        command: 'download-canceled',
                        downloadUrl,
                        masterUrl,
                        type,
                        message: `Download was canceled (${terminationInfo.reason})`,
                        duration,
                        downloadStats: downloadStats || null,
                        ffmpegFinalMessage: ffmpegFinalMessage || null,
                        terminationInfo,
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    resolve({ 
                        success: false, 
                        downloadStats
                    });
                } else if (!hasError) {
                    hasError = true;
                    const error = `FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}: ${errorOutput}`;
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
                        downloadStats: downloadStats || null, // Include stats in error message too
                        terminationInfo,
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
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
                    const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
                    const downloadDuration = processInfo?.startTime ? Date.now() - processInfo.startTime : null;
                    const duration = progressTracker.getDuration();
                    DownloadCommand.activeProcesses.delete(downloadUrl); // Remove from active processes on error
                    progressTracker.cleanup();
                    const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                    const downloadStats = progressTracker.getDownloadStats(); // Get stats even on spawn error
                    
                    logDebug(`FFmpeg spawn error (PID: ${processInfo?.pid}) after ${downloadDuration}ms:`, err);
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
                        downloadStats: downloadStats || null, // Include stats in spawn error too
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon
                    });
                    
                    reject(err);
                }
            });
        });
    }
    
    /**
     * Analyze process termination to determine the exact reason
     * @param {number} exitCode - Process exit code
     * @param {string|null} signal - Termination signal (SIGTERM, SIGKILL, etc.)
     * @param {boolean} wasCanceledFlag - Manual cancellation flag
     * @returns {Object} Termination analysis with reason, type, and flags
     * @private
     */
    analyzeProcessTermination(exitCode, signal, wasCanceledFlag = false) {
        // Signal-based detection (most reliable)
        if (signal) {
            switch (signal) {
                case 'SIGTERM':
                    return {
                        wasCanceled: true,
                        isSuccess: false,
                        reason: 'SIGTERM (graceful termination)',
                        signal,
                        exitCode,
                        method: 'signal-detection'
                    };
                case 'SIGKILL':
                    return {
                        wasCanceled: true,
                        isSuccess: false,
                        reason: 'SIGKILL (force termination)',
                        signal,
                        exitCode,
                        method: 'signal-detection'
                    };
                case 'SIGINT':
                    return {
                        wasCanceled: true,
                        isSuccess: false,
                        reason: 'SIGINT (interrupt)',
                        signal,
                        exitCode,
                        method: 'signal-detection'
                    };
                default:
                    return {
                        wasCanceled: true,
                        isSuccess: false,
                        reason: `${signal} (unknown signal)`,
                        signal,
                        exitCode,
                        method: 'signal-detection'
                    };
            }
        }
        
        // Exit code based detection (fallback)
        if (exitCode === 0) {
            return {
                wasCanceled: false,
                isSuccess: true,
                reason: 'successful completion',
                signal: null,
                exitCode,
                method: 'exit-code'
            };
        } else if (exitCode === 255) {
            // FFmpeg often returns 255 for SIGTERM
            return {
                wasCanceled: true,
                isSuccess: false,
                reason: 'exit code 255 (likely SIGTERM)',
                signal: null,
                exitCode,
                method: 'exit-code'
            };
        } else if (wasCanceledFlag) {
            // Manual flag detection (least reliable)
            return {
                wasCanceled: true,
                isSuccess: false,
                reason: 'manual cancellation flag',
                signal: null,
                exitCode,
                method: 'manual-flag'
            };
        } else {
            return {
                wasCanceled: false,
                isSuccess: false,
                reason: `error exit code ${exitCode}`,
                signal: null,
                exitCode,
                method: 'exit-code'
            };
        }
    }
}

module.exports = DownloadCommand;
