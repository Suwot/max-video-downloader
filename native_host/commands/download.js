/**
 * DownloadCommand – Central command class for orchestrating video/audio downloads using FFmpeg.
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
    
    // Static Set to track canceled downloads (survives process cleanup)
    static canceledDownloads = new Set();

    /**
     * Generate unique session ID for download
     */
    generateSessionId() {
        return `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Cancel an ongoing download by downloadUrl
     * @param {Object} params Command parameters
     * @param {string} params.downloadUrl The download URL to cancel
     */
    async cancelDownload(params) {
        const { downloadUrl, type } = params;
        
        logDebug('Canceling download for:', downloadUrl);
        logDebug('Active processes Map has', DownloadCommand.activeProcesses.size, 'entries');
        logDebug('Active process URLs:', Array.from(DownloadCommand.activeProcesses.keys()));
        
        const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
        if (!processInfo) {
            logDebug('No active process found for:', downloadUrl);
            logDebug('Cancel request ignored - no matching download process');
            
            // Send response even when no process exists - UI needs confirmation
            this.sendMessage({
                command: 'download-canceled',
                sessionId: null, // No session ID since no process exists
                downloadUrl,
                message: 'Download already stopped or not found',
                downloadStats: null,
                duration: null,
                completedAt: Date.now()
            }, { useMessageId: false }); // Event message, no response ID
            return;
        }
        
        const { ffmpegProcess, progressTracker, outputPath, sessionId } = processInfo;
        
        try {
            // Mark download as canceled in persistent set
            DownloadCommand.canceledDownloads.add(downloadUrl);
            logDebug('Added to canceled downloads set:', downloadUrl);
            
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
            
            // Remove partial file if it exists and type is not 'direct'
            if (type !== 'direct' && outputPath && fs.existsSync(outputPath)) {
                try {
                    fs.unlinkSync(outputPath);
                    logDebug('Removed partial download file:', outputPath);
                } catch (err) {
                    logDebug('Failed to remove partial file:', err.message);
                }
            }
            
            logDebug('Download cancellation completed for:', downloadUrl);
            
            // Send cancellation event
            this.sendMessage({
                command: 'download-canceled',
                sessionId,
                downloadUrl,
                duration: progressTracker.getDuration(),
                downloadStats: progressTracker.getDownloadStats() || null,
                message: 'Download was canceled',
                completedAt: Date.now(),
                isRedownload: processInfo.isRedownload || false
            }, { useMessageId: false }); // Event message, no response ID
            
        } catch (error) {
            logDebug('Error during download cancellation:', error);
            logDebug('Cancel operation failed, but not sending error message to extension');
        } finally {
            // Clean up canceled downloads set after a delay to allow close event to process
            setTimeout(() => {
                DownloadCommand.canceledDownloads.delete(downloadUrl);
                logDebug('Cleaned up canceled download from set:', downloadUrl);
            }, 5000); // 5 second cleanup delay
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
     * @param {boolean} params.isRedownload Whether this is a re-download request (optional)
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
            sourceAudioCodec = null,
            sourceAudioBitrate = null,
            // Progress tracking fields
            fileSizeBytes = null,
            duration = null,
            segmentCount = null,
            // Page context fields
            pageUrl = null,
            pageFavicon = null,
            // Re-download flag
            isRedownload = false
        } = params;

        // Generate unique session ID for this download
        const sessionId = this.generateSessionId();

        // Store original command for error reporting and potential re-downloads
        const originalCommand = {
            command: 'download',
            downloadUrl,
            filename,
            savePath,
            type,
            preferredContainer,
            defaultContainer,
            audioOnly,
            streamSelection,
            masterUrl,
            headers,
            fileSizeBytes,
            duration,
            segmentCount,
            pageUrl,
            pageFavicon,
            isRedownload,
            sourceAudioCodec,
            sourceAudioBitrate,
            sessionId
        };

        logDebug('Starting download with session ID:', sessionId, params);
        
        if (isRedownload) {
            logDebug('🔄 This is a re-download request');
        }
        
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
                headers,
                sourceAudioCodec,
                sourceAudioBitrate
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
                pageFavicon,
                originalCommand,
                isRedownload, 
                audioOnly,
                sessionId
            });
            
        } catch (err) {
            logDebug('Download error:', err);
            // Just throw the error - the promise rejection will handle it
            throw err;
        }
    }
    
    /**
     * Determine the appropriate container format based on parameters and video type
     * @private
     */
    determineContainerFormat(params) {
        const { preferredContainer, defaultContainer, type, audioOnly, downloadUrl, sourceAudioCodec } = params;
        
        // 1. User override takes priority (future feature)
        if (preferredContainer && /^(mp4|webm|mkv|mp3|m4a)$/i.test(preferredContainer)) {
            return preferredContainer.toLowerCase();
        }
        
        // 2. Audio-only mode - smart format selection based on source codec
        if (audioOnly) {
            return this.determineAudioContainer(sourceAudioCodec);
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
     * Determine optimal audio container based on source codec
     * @param {string} sourceAudioCodec - Source audio codec name (e.g., 'aac', 'mp3', 'opus')
     * @returns {string} - Optimal container format
     * @private
     */
    determineAudioContainer(sourceAudioCodec) {
        if (!sourceAudioCodec) {
            // No codec info available (HLS/DASH) - use universal MP3
            logDebug('No source audio codec info - using universal MP3 format');
            return 'mp3';
        }
        
        const codec = sourceAudioCodec.toLowerCase();
        
        switch (codec) {
            case 'aac':
                logDebug('🎵 AAC source detected → M4A container (copy)');
                return 'm4a';
            case 'mp3':
                logDebug('🎵 MP3 source detected → MP3 container (copy)');
                return 'mp3';
            default:
                logDebug(`🎵 ${codec} source detected → MP3 container (convert)`);
                return 'mp3'; // Convert other codecs to MP3 for universal compatibility
        }
    }

    /**
     * Generate clean output filename
     * @private
     */
    generateOutputFilename(filename, container) {
        // Clean up filename: remove query params and extension  
        let outputFilename = (filename ? filename.replace(/[?#].*$/, '') : 'audio');
        
        // For audio-only downloads, default to 'audio' if no filename
        if ((container === 'm4a' || container === 'mp3') && (!filename || filename.trim() === '')) {
            outputFilename = 'audio';
        }
        
        // Remove any existing video/audio extensions
        outputFilename = outputFilename.replace(/\.(mp4|webm|mov|m4v|ts|avi|mkv|flv|mp3|m4a|aac|wav)$/i, '');
        
        return `${outputFilename}.${container}`;
    }
    
    /**
     * Resolves output path and ensures uniqueness across both disk and active downloads
     * @private
     */
    resolveOutputPath(filename, savePath) {
        // Default to Desktop if no savePath or if it's "Desktop"
        const defaultDir = path.join(process.env.HOME || os.homedir(), 'Desktop');
        const targetDir = (!savePath || savePath === 'Desktop') ? defaultDir : savePath;

        // Join directory and filename
        let outputPath = path.join(targetDir, filename);

        // Helper to check if output path is in use by any active download
        const isPathInUse = (candidatePath) => {
            for (const proc of DownloadCommand.activeProcesses.values()) {
                if (proc && proc.outputPath === candidatePath) {
                    return true;
                }
            }
            return false;
        };

        // Ensure uniqueness across both disk and active downloads
        let counter = 1;
        let uniqueOutput = outputPath;
        while (fs.existsSync(uniqueOutput) || isPathInUse(uniqueOutput)) {
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
        headers = {},
        sourceAudioCodec = null,
        sourceAudioBitrate = null
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
        
        // Stream selection and codec configuration
        if (audioOnly) {
            if (streamSelection && type === 'dash') {
                // For DASH audio extraction, use the specific audio track from streamSelection
                streamSelection.split(',').forEach(streamSpec => {
                    args.push('-map', streamSpec);
                });
                logDebug('🎵 DASH audio-only mode with specific track:', streamSelection);
            } else {
                // For HLS/direct audio extraction, use specific first audio stream instead of generic mapping
                args.push('-map', '0:a:0');  // Map specifically the first audio stream
                logDebug('🎵 Audio-only mode enabled (HLS/direct) - mapping first audio stream');
            }
            
            // Explicitly disable video and subtitle streams for audio-only output
            args.push('-vn', '-sn');
            
            // Smart codec selection for audio-only
            this.addAudioCodecArgs(args, container, sourceAudioCodec, sourceAudioBitrate);
        } 
        else if (streamSelection && type === 'dash') {
            // Parse stream selection string (e.g., "0:v:0,0:a:3,0:s:1") 
            streamSelection.split(',').forEach(streamSpec => {
                args.push('-map', streamSpec);
            });
            logDebug('🎯 Using stream selection:', streamSelection);
            
            // Default to copying all streams without re-encoding for regular downloads
            args.push('-c', 'copy');
        } else {
            // Default to copying all streams without re-encoding for regular downloads
            args.push('-c', 'copy');
        }
        
        // Format-specific optimizations
        if (type === 'hls' && !audioOnly) {
            // Fix for certain audio streams commonly found in HLS (only for regular video downloads)
            args.push('-bsf:a', 'aac_adtstoasc');
        } else if (audioOnly && container === 'm4a') {
            // For audio-only AAC → M4A, apply the bitstream filter
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
     * Add appropriate audio codec arguments based on smart format selection
     * @param {Array} args - FFmpeg arguments array
     * @param {string} container - Output container format
     * @param {string} sourceAudioCodec - Source audio codec
     * @param {number} sourceAudioBitrate - Source audio bitrate in bps
     * @private
     */
    addAudioCodecArgs(args, container, sourceAudioCodec, sourceAudioBitrate) {
        const codec = sourceAudioCodec ? sourceAudioCodec.toLowerCase() : null;
        
        if (container === 'm4a' && codec === 'aac') {
            // AAC → M4A: Copy without re-encoding (lossless, fast)
            args.push('-c:a', 'copy');
            logDebug('🎵 AAC → M4A: copying without re-encoding');
        } else if (container === 'mp3' && codec === 'mp3') {
            // MP3 → MP3: Copy without re-encoding (lossless, fast)
            args.push('-c:a', 'copy');
            logDebug('🎵 MP3 → MP3: copying without re-encoding');
        } else {
            // Other codecs → MP3: Re-encode with libmp3lame
            args.push('-c:a', 'libmp3lame');
            
            // Use source bitrate if available, otherwise high-quality VBR
            if (sourceAudioBitrate && sourceAudioBitrate > 0) {
                // Convert from bps to kbps and cap at reasonable limits
                const bitrateKbps = Math.min(Math.max(Math.round(sourceAudioBitrate / 1000), 64), 320);
                args.push('-b:a', `${bitrateKbps}k`);
                logDebug(`🎵 ${codec || 'unknown'} → MP3: re-encoding at ${bitrateKbps}kbps (matched source)`);
            } else {
                // High-quality VBR when no bitrate info available
                args.push('-q:a', '2'); // ~190kbps VBR
                logDebug(`🎵 ${codec || 'unknown'} → MP3: re-encoding with VBR quality 2`);
            }
        }
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
        pageFavicon,
        originalCommand,
        isRedownload, 
        audioOnly,
        sessionId
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
                    this.sendMessage({
                        command: 'download-progress',
                        sessionId,
                        downloadUrl,
                        filename: path.basename(uniqueOutput),
                        isRedownload,
                        ...data
                    }, { useMessageId: false }); // Event message, no response ID
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
                segmentCount,
                audioOnly
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
            
            // Track this process as active (use both downloadUrl and sessionId for tracking)
            DownloadCommand.activeProcesses.set(downloadUrl, {
                ffmpegProcess: ffmpeg,
                progressTracker,
                outputPath: uniqueOutput,
                wasCanceled: false,
                startTime: downloadStartTime,
                pid: ffmpeg.pid,
                isRedownload,
                sessionId
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
                // Guard against multiple event handling
                if (hasError) return;
                
                progressTracker.cleanup();
                
                // Get process info before deletion (might be deleted in cancelDownload)
                const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
                const originalDuration = progressTracker.getDuration();
                const finalProcessedDuration = progressTracker.getFinalProcessedDuration();
                
                // Use final processed duration if available (actual processed time), fallback to original
                const duration = finalProcessedDuration || originalDuration;
                
                // Log duration information for debugging
                if (finalProcessedDuration && originalDuration && Math.abs(finalProcessedDuration - originalDuration) > 1) {
                    logDebug(`Duration difference: original=${originalDuration}s, processed=${finalProcessedDuration}s`);
                }
                
                const downloadDuration = processInfo?.startTime ? Date.now() - processInfo.startTime : null;
                
                // Clean up activeProcesses if not already done
                if (DownloadCommand.activeProcesses.has(downloadUrl)) {
                    DownloadCommand.activeProcesses.delete(downloadUrl);
                }
                
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const derivedErrorMessage = progressTracker.getDerivedErrorMessage();
                const downloadStats = progressTracker.getDownloadStats();

                // Determine termination reason using signal, exit code, and output file verification
                const terminationInfo = this.analyzeProcessTermination(code, signal, downloadUrl, uniqueOutput, type);
                logDebug(`FFmpeg process (PID: ${processInfo?.pid}) terminated after ${downloadDuration}ms:`, terminationInfo);
                
                if (terminationInfo.wasCanceled && !terminationInfo.isPartialSuccess) {
                    logDebug('Download was canceled by user.');
                    // Don't send response here - cancellation response already sent by cancelDownload()
                    return resolve({ 
                        success: false, 
                        downloadStats
                    });
                }
                
                if (terminationInfo.isSuccess || terminationInfo.isPartialSuccess) {
                    const isPartial = terminationInfo.isPartialSuccess || false;
                    logDebug(isPartial ? 'Download completed partially (direct type).' : 'Download completed successfully.');
                    
                    this.sendMessage({ 
                        command: 'download-success',
                        sessionId,
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
                        pageFavicon,
                        originalCommand,
                        isRedownload,
                        audioOnly,
                        isPartial // Add partial flag for UI
                    }, { useMessageId: false }); // Event message, no response ID
                    resolve({ 
                        success: true, 
                        path: uniqueOutput,
                        downloadStats,
                        isPartial
                    });
                } else {
                    // Mark as error to prevent duplicate handling
                    hasError = true;
                    const errorMessage = `FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
                    logDebug('Download failed:', errorMessage);
                    if (ffmpegFinalMessage) {
                        logDebug('FFmpeg final message:', ffmpegFinalMessage);
                    } else if (derivedErrorMessage) {
                        logDebug('Derived error message:', derivedErrorMessage);
                    }
                    
                    // Send error as event - this resolves the promise
                    this.sendMessage({
                        command: 'download-error',
                        sessionId,
                        success: false,
                        message: errorMessage,
                        ffmpegOutput: errorOutput || null,
                        downloadUrl,
                        masterUrl,
                        type,
                        duration,
                        ffmpegFinalMessage: ffmpegFinalMessage || derivedErrorMessage || null,
                        downloadStats: downloadStats || null,
                        terminationInfo,
                        processInfo: {
                            pid: processInfo?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon,
                        originalCommand,
                        isRedownload,
                        audioOnly
                    }, { useMessageId: false }); // Event message, no response ID
                    resolve({ 
                        success: false, 
                        downloadStats,
                        error: errorMessage
                    });
                }
            });
            
            ffmpeg.on('error', (err) => {
                // Guard against multiple event handling
                if (hasError) return;
                
                hasError = true;
                // Clean up activeProcesses if not already done
                if (DownloadCommand.activeProcesses.has(downloadUrl)) {
                    DownloadCommand.activeProcesses.delete(downloadUrl);
                }
                
                progressTracker.cleanup();
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const derivedErrorMessage = progressTracker.getDerivedErrorMessage();
                const downloadStats = progressTracker.getDownloadStats();
                
                // Get process info and calculate durations (same logic as close handler)
                const processInfo = DownloadCommand.activeProcesses.get(downloadUrl);
                const originalDuration = progressTracker.getDuration();
                const finalProcessedDuration = progressTracker.getFinalProcessedDuration();
                const duration = finalProcessedDuration || originalDuration;
                const downloadDuration = processInfo?.startTime ? Date.now() - processInfo.startTime : null;

                logDebug(`FFmpeg spawn error (PID: ${processInfo?.pid}) after ${downloadDuration}ms:`, err);
                if (ffmpegFinalMessage) {
                    logDebug('FFmpeg final message:', ffmpegFinalMessage);
                } else if (derivedErrorMessage) {
                    logDebug('Derived error message:', derivedErrorMessage);
                }

                // Send spawn error as event - this resolves the promise
                this.sendMessage({
                    success: false,
                    command: 'download-error',
                    sessionId,
                    message: `FFmpeg spawn error: ${err.message}`,
                    ffmpegOutput: null,
                    downloadUrl,
                    masterUrl,
                    type,
                    duration,
                    ffmpegFinalMessage: ffmpegFinalMessage || derivedErrorMessage || null,
                    downloadStats: downloadStats || null,
                    processInfo: {
                        pid: processInfo?.pid,
                        downloadDuration
                    },
                    completedAt: Date.now(),
                    pageUrl,
                    pageFavicon,
                    originalCommand,
                    isRedownload,
                    audioOnly
                }, { useMessageId: false }); // Event message, no response ID

                resolve({ 
                    success: false, 
                    downloadStats,
                    error: `FFmpeg spawn error: ${err.message}`
                });
            });
        });
    }
    
    /**
     * Analyze process termination to determine the exact reason
     * @param {number} exitCode - Process exit code
     * @param {string|null} signal - Termination signal (SIGTERM, SIGKILL, etc.)
     * @param {string} downloadUrl - Download URL to check cancellation status
     * @param {string} outputPath - Expected output file path
     * @param {string} type - Media type ('hls', 'dash', 'direct')
     * @returns {Object} Termination analysis with reason, type, and flags
     * @private
     */
    analyzeProcessTermination(exitCode, signal, downloadUrl, outputPath = null, type = null) {
        const wasCanceled = DownloadCommand.canceledDownloads.has(downloadUrl);
        const hasValidFile = outputPath && this.verifyDownloadCompletion(outputPath, type);
        
        logDebug('Termination analysis:', { exitCode, signal, wasCanceled, hasValidFile, type, outputPath });
        
        // Signal-based detection (most reliable for cancellation)
        if (signal) {
            return {
                wasCanceled: true,
                isSuccess: false,
                isPartialSuccess: false,
                reason: `${signal} (signal termination)`,
                signal,
                exitCode,
                method: 'signal-detection'
            };
        }
        
        // Cancellation-based logic with file verification
        if (wasCanceled) {
            if (hasValidFile && type === 'direct') {
                // Direct type with valid file after cancellation = partial success
                return {
                    wasCanceled: true,
                    isSuccess: false,
                    isPartialSuccess: true,
                    reason: 'canceled but partial file is playable (direct type)',
                    signal: null,
                    exitCode,
                    method: 'partial-success-detection'
                };
            } else {
                // All other cancellation cases
                return {
                    wasCanceled: true,
                    isSuccess: false,
                    isPartialSuccess: false,
                    reason: hasValidFile ? 'canceled with file cleanup' : 'canceled before file creation',
                    signal: null,
                    exitCode,
                    method: 'cancellation-detection'
                };
            }
        }
        
        // Non-cancellation outcomes
        if (exitCode === 0) {
            if (hasValidFile) {
                return {
                    wasCanceled: false,
                    isSuccess: true,
                    isPartialSuccess: false,
                    reason: 'successful completion (verified)',
                    signal: null,
                    exitCode,
                    method: 'file-verification'
                };
            } else {
                return {
                    wasCanceled: false,
                    isSuccess: false,
                    isPartialSuccess: false,
                    reason: 'exit code 0 but no valid output file',
                    signal: null,
                    exitCode,
                    method: 'file-verification'
                };
            }
        } else {
            // Any non-zero exit code = error
            return {
                wasCanceled: false,
                isSuccess: false,
                isPartialSuccess: false,
                reason: `error exit code ${exitCode}`,
                signal: null,
                exitCode,
                method: 'exit-code'
            };
        }
    }

    /**
     * Verify if download actually completed successfully by checking output file
     * @param {string} outputPath - Path to the expected output file
     * @param {string} type - Media type ('hls', 'dash', 'direct')
     * @returns {boolean} - True if download appears to have completed successfully
     * @private
     */
    verifyDownloadCompletion(outputPath, type) {
        try {
            if (!fs.existsSync(outputPath)) {
                logDebug('Download verification: Output file does not exist');
                return false;
            }

            const stats = fs.statSync(outputPath);
            const fileSizeBytes = stats.size;
            
            // Minimum size threshold: 10KB for most media files
            // Audio-only files might be smaller, but 10KB is reasonable minimum
            const minSizeBytes = 10 * 1024; // 10KB
            
            if (fileSizeBytes < minSizeBytes) {
                logDebug(`Download verification: File too small (${fileSizeBytes} bytes < ${minSizeBytes} bytes)`);
                return false;
            }
            
            logDebug(`Download verification: File exists with valid size (${fileSizeBytes} bytes)`);
            return true;
            
        } catch (error) {
            logDebug('Download verification error:', error.message);
            return false;
        }
    }
}

module.exports = DownloadCommand;
