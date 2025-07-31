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
    // Static Map for download tracking keyed by downloadId
    static activeDownloads = new Map();

    /**
     * Cancel an ongoing download by downloadId
     * @param {Object} params Command parameters
     * @param {string} params.downloadId The download ID to cancel
     * @param {string} params.downloadUrl The download URL to cancel (fallback lookup)
     * @param {string} params.type Media type for cleanup decisions
     */
    async cancelDownload(params) {
        const { downloadId, downloadUrl, type } = params;
        
        logDebug('Canceling download with downloadId:', downloadId, 'downloadUrl:', downloadUrl);
        logDebug('Active downloads Map has', DownloadCommand.activeDownloads.size, 'entries');
        logDebug('Active download IDs:', Array.from(DownloadCommand.activeDownloads.keys()));
        
        // Find download by downloadId first, then fallback to URL lookup
        let downloadEntry = null;
        let lookupKey = null;
        
        if (downloadId && DownloadCommand.activeDownloads.has(downloadId)) {
            downloadEntry = DownloadCommand.activeDownloads.get(downloadId);
            lookupKey = downloadId;
            logDebug('Found download by downloadId:', downloadId);
        } else if (downloadUrl) {
            // Fallback: search by downloadUrl in stored data
            for (const [id, entry] of DownloadCommand.activeDownloads.entries()) {
                if (entry.originalCommand && entry.originalCommand.downloadUrl === downloadUrl) {
                    downloadEntry = entry;
                    lookupKey = id;
                    logDebug('Found download by downloadUrl lookup:', downloadUrl, '-> downloadId:', id);
                    break;
                }
            }
        }
        
        if (!downloadEntry) {
            logDebug('No active download found for:', downloadId || downloadUrl);
            logDebug('Cancel request ignored - no matching download process');
            
            // Send response even when no process exists - UI needs confirmation
            this.sendMessage({
                command: 'download-canceled',
                downloadId: downloadId || null,
                downloadUrl,
                message: 'Download already stopped or not found',
                downloadStats: null,
                duration: null,
                completedAt: Date.now()
            }, { useMessageId: false }); // Event message, no response ID
            return;
        }
        
        const { process, outputPath, originalCommand } = downloadEntry;
        const processDownloadId = lookupKey; // Use the found downloadId
        
        try {
            // IMMEDIATELY remove from activeDownloads to prevent repeated cancels
            DownloadCommand.activeDownloads.delete(lookupKey);
            logDebug('Removed download from activeDownloads Map immediately. Remaining downloads:', DownloadCommand.activeDownloads.size);
            
            // Gracefully terminate FFmpeg process using PID
            if (process && process.pid && !process.killed) {
                logDebug('Terminating FFmpeg process with PID:', process.pid, 'using SIGTERM');
                process.kill('SIGTERM');
                
                // Give it a moment to clean up, then force kill if needed
                setTimeout(() => {
                    if (process && !process.killed) {
                        logDebug('Force killing FFmpeg process with PID:', process.pid, 'using SIGKILL');
                        process.kill('SIGKILL');
                    }
                }, 2000);
            } else {
                logDebug('FFmpeg process already terminated or killed');
            }
            
            // Clean up progress tracker if available
            if (downloadEntry.progressTracker) {
                downloadEntry.progressTracker.cleanup();
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
            
            logDebug('Download cancellation completed for downloadId:', processDownloadId);
            
            // For direct types, defer cancellation message to close handler
            // The close handler will determine final outcome based on file existence
            if (type === 'direct') {
                logDebug('Direct type cancellation - deferring message to close handler');
                return; // Let close handler send the final message
            }
            
            // For HLS/DASH types, send immediate cancellation message
            this.sendMessage({
                command: 'download-canceled',
                downloadId: processDownloadId,
                downloadUrl: originalCommand?.downloadUrl || downloadUrl,
                duration: downloadEntry.progressTracker?.getDuration(),
                downloadStats: downloadEntry.progressTracker?.getDownloadStats() || null,
                message: 'Download was canceled',
                completedAt: Date.now(),
                isRedownload: originalCommand?.isRedownload || false,
                headers: downloadEntry.headers || null
            }, { useMessageId: false }); // Event message, no response ID
            
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
     * @param {string} params.container Container format from extension (required)
     * @param {boolean} params.audioOnly Whether to download audio only (optional)
     * @param {boolean} params.subsOnly Whether to download subtitles only (optional)
     * @param {string} params.streamSelection Stream selection spec for DASH (optional)
     * @param {Array} params.inputs Array of input objects for HLS advanced mode (optional)
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
            container,
            audioOnly = false,
            subsOnly = false,
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
            // UI context fields
            selectedOptionOrigText = null,
            // Re-download flag
            isRedownload = false,
            videoData,
            // Download ID for progress mapping (replaces sessionId)
            downloadId = null
        } = params;

        // Use downloadId directly from extension (no need to generate sessionId)
        if (!downloadId) {
            throw new Error('downloadId is required for download tracking');
        }

        // Store original command for error reporting and potential re-downloads
        const originalCommand = {
            command: 'download',
            downloadUrl,
            filename,
            savePath,
            type,
            container,
            audioOnly,
            subsOnly,
            streamSelection,
            masterUrl,
            headers,
            fileSizeBytes,
            duration,
            segmentCount,
            pageUrl,
            pageFavicon,
            selectedOptionOrigText,
            isRedownload,
            sourceAudioCodec,
            sourceAudioBitrate,
            videoData: videoData ? {
                ...videoData,
                previewUrl: undefined // Remove heavy preview data for storage efficiency
            } : undefined,
            downloadId
        };

        logDebug('Starting download with downloadId:', downloadId, params);
        
        if (isRedownload) {
            logDebug('🔄 This is a re-download request');
        }
        
        if (headers && Object.keys(headers).length > 0) {
            logDebug('🔑 Using headers for download request:', Object.keys(headers));
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            // Use container from extension (trusted completely)
            const container = params.container || 'mp4';
            logDebug('📦 Using container from extension:', container);
            
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
                subsOnly,
                streamSelection,
                inputs: params.inputs,
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
                subsOnly,
                downloadId, // Use downloadId instead of sessionId
                selectedOptionOrigText
            });
            
        } catch (err) {
            logDebug('Download error:', err);
            // Just throw the error - the promise rejection will handle it
            throw err;
        }
    }

    /**
     * Generate clean output filename
     * @private
     */
    generateOutputFilename(filename, container) {
        // Clean up filename: remove query params
        let outputFilename = (filename ? filename.replace(/[?#].*$/, '') : 'video');
        
        // For audio-only downloads, default to 'audio' if no filename
        if ((container === 'm4a' || container === 'mp3') && (!filename || filename.trim() === '')) {
            outputFilename = 'audio';
        }
        
        // Remove container extension if already present to prevent double extensions
        const expectedExt = `.${container}`;
        if (outputFilename.toLowerCase().endsWith(expectedExt.toLowerCase())) {
            outputFilename = outputFilename.slice(0, -expectedExt.length);
        }
        
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
            for (const downloadEntry of DownloadCommand.activeDownloads.values()) {
                if (downloadEntry && downloadEntry.outputPath === candidatePath) {
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
        subsOnly = false,
        streamSelection,
        inputs = null,
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
        
        // Input arguments based on media type and inputs array
        if (inputs && inputs.length > 0) {
            // Advanced mode: multiple inputs (HLS with separate tracks)
            // Global headers already applied above, no need to repeat per input
            inputs.forEach(input => {
                if (type === 'hls') {
                    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
                }
                args.push('-i', input.url);
            });
        } else {
            // Simple mode: single input
            if (type === 'hls' || type === 'dash') {
                args.push(
                    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                    '-i', downloadUrl
                );
            } else {
                args.push('-i', downloadUrl);
            }
        }
        
        // Stream selection and codec configuration
        if (audioOnly) {
            if (streamSelection && type === 'dash') {
                // For DASH audio extraction, use the specific audio track from streamSelection
                streamSelection.split(',').forEach(streamSpec => {
                    args.push('-map', streamSpec);
                });
                logDebug('🎵 DASH audio-only mode with specific track:', streamSelection);
            } else if (inputs && inputs.length > 0) {
                // For HLS advanced audio extraction, map audio inputs only
                inputs.forEach(input => {
                    if (input.streamMap.includes(':a:')) {
                        args.push('-map', input.streamMap);
                    }
                });
                logDebug('🎵 HLS advanced audio-only mode with specific tracks');
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
        else if (subsOnly) {
            if (streamSelection && type === 'dash') {
                // For DASH subtitle extraction, use the specific subtitle track from streamSelection
                streamSelection.split(',').forEach(streamSpec => {
                    args.push('-map', streamSpec);
                });
                logDebug('📝 DASH subtitle-only mode with specific track:', streamSelection);
            } else if (inputs && inputs.length > 0) {
                // For HLS advanced subtitle extraction, map subtitle inputs only
                inputs.forEach(input => {
                    if (input.streamMap.includes(':s:')) {
                        args.push('-map', input.streamMap);
                    }
                });
                logDebug('📝 HLS advanced subtitle-only mode with specific tracks');
            } else {
                // For HLS/direct subtitle extraction, use first subtitle stream
                args.push('-map', '0:s:0');
                logDebug('📝 Subtitle-only mode enabled (HLS/direct) - mapping first subtitle stream');
            }
            
            // Explicitly disable video and audio streams for subtitle-only output
            args.push('-vn', '-an');
            
            // Copy subtitle streams without re-encoding
            args.push('-c:s', 'copy');
        } 
        else if (inputs && inputs.length > 0) {
            // Advanced HLS mode: map streams from multiple inputs
            inputs.forEach(input => {
                args.push('-map', input.streamMap);
            });
            logDebug('🎯 Using HLS advanced inputs:', inputs.map(i => i.streamMap).join(','));
            
            // Default to copying all streams without re-encoding
            args.push('-c', 'copy');
        }
        else if (streamSelection && type === 'dash') {
            // Parse stream selection string (e.g., "0:v:0,0:a:3,0:s:1") 
            streamSelection.split(',').forEach(streamSpec => {
                args.push('-map', streamSpec);
            });
            logDebug('🎯 Using DASH stream selection:', streamSelection);
            
            // Default to copying all streams without re-encoding for regular downloads
            args.push('-c', 'copy');
        } else {
            // Default to copying all streams without re-encoding for regular downloads
            args.push('-c', 'copy');
        }
        
        // Format-specific optimizations
        if (type === 'hls' && !audioOnly && !subsOnly) {
            // Fix for certain audio streams commonly found in HLS (only for regular video downloads)
            args.push('-bsf:a', 'aac_adtstoasc');
        } else if (audioOnly && container === 'm4a') {
            // For audio-only AAC → M4A, apply the bitstream filter
            args.push('-bsf:a', 'aac_adtstoasc');
        }
        
        // MP4/MOV optimizations (only for video/audio, not subtitles)
        if (!subsOnly && ['mp4', 'mov', 'm4v'].includes(container.toLowerCase())) {
            args.push('-movflags', '+faststart');
        }
        
        // Output path
        args.push(outputPath);
        
        return args;
    }
    
    /**
     * Add appropriate audio codec arguments based on container format
     * @param {Array} args - FFmpeg arguments array
     * @param {string} container - Output container format (from extension)
     * @param {string} sourceAudioCodec - Source audio codec (unused, kept for compatibility)
     * @param {number} sourceAudioBitrate - Source audio bitrate in bps
     * @private
     */
    addAudioCodecArgs(args, container, sourceAudioCodec, sourceAudioBitrate) {
        logDebug('🎵 Audio codec selection for container:', container);
        
        if (container === 'm4a') {
            // M4A container: Copy audio stream (assumes AAC-compatible source)
            args.push('-c:a', 'copy');
            logDebug('🎵 M4A container: copying audio stream');
        } else if (container === 'mp3') {
            // MP3 container: Always re-encode with libmp3lame for universal compatibility
            args.push('-c:a', 'libmp3lame');
            
            // Use source bitrate if available, otherwise high-quality VBR
            if (sourceAudioBitrate && sourceAudioBitrate > 0) {
                // Convert from bps to kbps and cap at reasonable limits
                const bitrateKbps = Math.min(Math.max(Math.round(sourceAudioBitrate / 1000), 64), 320);
                args.push('-b:a', `${bitrateKbps}k`);
                logDebug(`🎵 MP3 container: re-encoding at ${bitrateKbps}kbps (matched source)`);
            } else {
                // High-quality VBR when no bitrate info available
                args.push('-q:a', '2'); // ~190kbps VBR
                logDebug('🎵 MP3 container: re-encoding with VBR quality 2');
            }
        } else {
            // Other containers (flac, ogg, etc.): Copy by default
            args.push('-c:a', 'copy');
            logDebug(`🎵 ${container} container: copying audio stream`);
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
        subsOnly,
        downloadId, // Use downloadId instead of sessionId
        selectedOptionOrigText
    }) {
        return new Promise((resolve, _reject) => {
            // Use an IIFE to handle async operations properly
            (async () => {
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
                            downloadId, // Use downloadId for both session and progress mapping
                            downloadUrl,
                            filename: path.basename(uniqueOutput),
                            selectedOptionOrigText, // Pass through selected option text
                            downloadStartTime, // Add start time for UI elapsed time calculation
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
                
                // Track this process as active (keyed by downloadId with minimal data)
                DownloadCommand.activeDownloads.set(downloadId, {
                    process: ffmpeg,
                    startTime: downloadStartTime,
                    outputPath: uniqueOutput,
                    type,
                    headers: headers || null,
                    progressTracker,
                    originalCommand,
                    selectedOptionOrigText,
                    isRedownload
                });
                
                logDebug('Added download to activeDownloads Map. Total downloads:', DownloadCommand.activeDownloads.size);
                
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
                
                // Get download info from activeDownloads BEFORE deletion
                const downloadEntry = DownloadCommand.activeDownloads.get(downloadId);
                const wasCanceled = !downloadEntry; // Check if it was already removed by cancelDownload
                
                const originalDuration = progressTracker.getDuration();
                const finalProcessedDuration = progressTracker.getFinalProcessedDuration();
                
                // Use final processed duration if available (actual processed time), fallback to original
                const duration = finalProcessedDuration || originalDuration;
                
                // Log duration information for debugging
                if (finalProcessedDuration && originalDuration && Math.abs(finalProcessedDuration - originalDuration) > 1) {
                    logDebug(`Duration difference: original=${originalDuration}s, processed=${finalProcessedDuration}s`);
                }
                
                const downloadDuration = downloadEntry?.startTime ? Date.now() - downloadEntry.startTime : null;
                
                // Clean up activeDownloads if not already done by cancelDownload
                if (DownloadCommand.activeDownloads.has(downloadId)) {
                    DownloadCommand.activeDownloads.delete(downloadId);
                }
                
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const derivedErrorMessage = progressTracker.getDerivedErrorMessage();
                const downloadStats = progressTracker.getDownloadStats();

                // Determine termination reason using signal, exit code, and output file verification
                // Pass wasCanceled state directly instead of relying on Map lookup
                const terminationInfo = this.analyzeProcessTermination(code, signal, wasCanceled, uniqueOutput, type, subsOnly);
                logDebug(`FFmpeg process (PID: ${downloadEntry?.process?.pid}) terminated after ${downloadDuration}ms:`, terminationInfo);
                
                if (terminationInfo.wasCanceled && !terminationInfo.isPartialSuccess) {
                    logDebug('Download was canceled by user.');
                    
                    // For direct types, send cancellation message here (deferred from cancelDownload)
                    if (type === 'direct') {
                        this.sendMessage({
                            command: 'download-canceled',
                            downloadId, // Use downloadId for both session and progress mapping
                            downloadUrl,
                            duration,
                            downloadStats: downloadStats || null,
                            message: 'Download was canceled',
                            completedAt: Date.now(),
                            pageUrl,
                            pageFavicon,
                            originalCommand,
                            isRedownload: downloadEntry?.isRedownload || false,
                            audioOnly,
                            subsOnly,
                            headers: downloadEntry?.headers || null
                        }, { useMessageId: false }); // Event message, no response ID
                    }
                    
                    // Don't send additional response for HLS/DASH - already sent by cancelDownload()
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
                        downloadId, // Use downloadId instead of sessionId
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
                            pid: downloadEntry?.process?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon,
                        originalCommand,
                        isRedownload,
                        audioOnly,
                        subsOnly,
                        isPartial, // Add partial flag for UI
                        headers: downloadEntry?.headers || null
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
                        downloadId, // Use downloadId instead of sessionId
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
                            pid: downloadEntry?.process?.pid,
                            downloadDuration
                        },
                        completedAt: Date.now(),
                        pageUrl,
                        pageFavicon,
                        originalCommand,
                        isRedownload,
                        audioOnly,
                        subsOnly,
                        headers: downloadEntry?.headers || null
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
                // Clean up activeDownloads if not already done
                if (DownloadCommand.activeDownloads.has(downloadId)) {
                    DownloadCommand.activeDownloads.delete(downloadId);
                }
                
                progressTracker.cleanup();
                const ffmpegFinalMessage = progressTracker.getFFmpegFinalMessage();
                const derivedErrorMessage = progressTracker.getDerivedErrorMessage();
                const downloadStats = progressTracker.getDownloadStats();
                
                // Get download info and calculate durations (same logic as close handler)
                const downloadEntry = DownloadCommand.activeDownloads.get(downloadId);
                
                const originalDuration = progressTracker.getDuration();
                const finalProcessedDuration = progressTracker.getFinalProcessedDuration();
                const duration = finalProcessedDuration || originalDuration;
                const downloadDuration = downloadEntry?.startTime ? Date.now() - downloadEntry.startTime : null;

                logDebug(`FFmpeg spawn error (PID: ${downloadEntry?.process?.pid}) after ${downloadDuration}ms:`, err);
                if (ffmpegFinalMessage) {
                    logDebug('FFmpeg final message:', ffmpegFinalMessage);
                } else if (derivedErrorMessage) {
                    logDebug('Derived error message:', derivedErrorMessage);
                }

                // Send spawn error as event - this resolves the promise
                this.sendMessage({
                    success: false,
                    command: 'download-error',
                    downloadId, // Use downloadId instead of sessionId
                    message: `FFmpeg spawn error: ${err.message}`,
                    ffmpegOutput: null,
                    downloadUrl,
                    masterUrl,
                    type,
                    duration,
                    ffmpegFinalMessage: ffmpegFinalMessage || derivedErrorMessage || null,
                    downloadStats: downloadStats || null,
                    processInfo: {
                        pid: downloadEntry?.process?.pid,
                        downloadDuration
                    },
                    completedAt: Date.now(),
                    pageUrl,
                    pageFavicon,
                    originalCommand,
                    isRedownload,
                    audioOnly,
                    headers: downloadEntry?.headers || null
                }, { useMessageId: false }); // Event message, no response ID

                resolve({ 
                    success: false, 
                    downloadStats,
                    error: `FFmpeg spawn error: ${err.message}`
                });
            });
            })(); // Close the IIFE
        });
    }
    
    /**
     * Analyze process termination to determine the exact reason
     * @param {number} exitCode - Process exit code
     * @param {string|null} signal - Termination signal (SIGTERM, SIGKILL, etc.)
     * @param {boolean} wasCanceled - Whether the download was canceled (determined by caller)
     * @param {string} outputPath - Expected output file path
     * @param {string} type - Media type ('hls', 'dash', 'direct')
     * @param {boolean} subsOnly - Whether this was a subtitle-only download
     * @returns {Object} Termination analysis with reason, type, and flags
     * @private
     */
    analyzeProcessTermination(exitCode, signal, wasCanceled, outputPath = null, type = null, subsOnly = false) {
        const hasValidFile = outputPath && this.verifyDownloadCompletion(outputPath, type, subsOnly);
        
        logDebug('Termination analysis:', { exitCode, signal, wasCanceled, hasValidFile, type, outputPath, subsOnly });
        
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
                // Direct type with no valid file OR non-direct types = cancellation
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
    verifyDownloadCompletion(outputPath, type, subsOnly = false) {
        try {
            if (!fs.existsSync(outputPath)) {
                logDebug('Download verification: Output file does not exist');
                return false;
            }

            const stats = fs.statSync(outputPath);
            const fileSizeBytes = stats.size;
            
            // Different minimum size thresholds based on content type
            let minSizeBytes;
            if (subsOnly) {
                // Subtitle files can be very small (even 1KB for short content)
                minSizeBytes = 100; // 100 bytes - just ensure file has some content
                logDebug('Download verification: Using subtitle file threshold');
            } else {
                // Media files (video/audio) should be larger
                minSizeBytes = 10 * 1024; // 10KB
                logDebug('Download verification: Using media file threshold');
            }
            
            if (fileSizeBytes < minSizeBytes) {
                logDebug(`Download verification: File too small (${fileSizeBytes} bytes < ${minSizeBytes} bytes)`);
                return false;
            }
            
            logDebug(`Download verification: File exists with valid size (${fileSizeBytes} bytes, threshold: ${minSizeBytes} bytes)`);
            return true;
            
        } catch (error) {
            logDebug('Download verification error:', error.message);
            return false;
        }
    }
}

module.exports = DownloadCommand;
