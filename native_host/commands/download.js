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
     * @param {string} params.quality Video quality to download
     */
    async execute(params) {
        const { url, filename, savePath, quality = 'best' } = params;
        logDebug('Starting download:', { url, filename, savePath, quality });
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            // Determine video type from URL
            const videoType = ffmpegService.getVideoTypeFromUrl(url);
            
            // Ensure proper file extension
            let outputFilename = filename || 'video.mp4';
            
            // Clean up filename:
            // 1. Remove query params
            outputFilename = outputFilename.replace(/[?#].*$/, '');
            
            // 2. Replace manifest extensions with MP4
            if (videoType === 'hls' || videoType === 'dash') {
                outputFilename = outputFilename.replace(/\.(m3u8|mpd|ts)$/, '.mp4');
            }
            
            // 3. Make sure we have a video extension for direct URLs
            if (videoType === 'direct' && !/\.(mp4|webm|mov|avi|mkv|flv)$/i.test(outputFilename)) {
                outputFilename += '.mp4';
            }
            
            // Set output path - prefer desktop by default
            const defaultDir = path.join(process.env.HOME || os.homedir(), 'Desktop');
            
            const finalOutput = savePath ? 
                (savePath === 'Desktop' ? 
                    path.join(defaultDir, outputFilename) : 
                    path.join(savePath, outputFilename)) : 
                path.join(defaultDir, outputFilename);

            // Check if file exists and append number if needed
            let counter = 1;
            let uniqueOutput = finalOutput;
            while (fs.existsSync(uniqueOutput)) {
                const ext = path.extname(finalOutput);
                const base = finalOutput.slice(0, -ext.length);
                uniqueOutput = `${base} (${counter})${ext}`;
                counter++;
            }

            logDebug('Output file will be:', uniqueOutput);

            // Build FFmpeg args based on video type
            let ffmpegArgs = [];
            
            // Force progress output format by adding -stats and -progress pipe:2
            ffmpegArgs.push('-stats', '-progress', 'pipe:2');
            
            // Common input parameters for all types
            if (videoType === 'hls' || videoType === 'dash') {
                // Streaming protocol support for HLS/DASH
                ffmpegArgs.push(
                    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                    '-i', url
                );
            } else {
                // Direct video
                ffmpegArgs.push('-i', url);
            }
            
            // Output parameters - try to copy streams without re-encoding
            ffmpegArgs = ffmpegArgs.concat([
                '-c', 'copy',            // Copy streams without re-encoding
                '-bsf:a', 'aac_adtstoasc', // Fix for certain audio streams
                '-movflags', '+faststart',  // Optimize for streaming playback
                uniqueOutput
            ]);

            logDebug('FFmpeg command:', ffmpegService.getFFmpegPath(), ffmpegArgs.join(' '));

            return new Promise((resolve, reject) => {
                // Create progress tracker for this download
                const progressTracker = new ProgressTracker({
                    onProgress: (data) => {
                        this.sendProgress(data);
                    },
                    updateInterval: 200, // Update every 200ms
                    debug: true // Enable detailed progress logging
                });
                
                // Register default strategies
                ProgressTracker.registerDefaultStrategies(progressTracker);
                
                // Initialize progress tracker with file info
                progressTracker.initialize({
                    url,
                    type: videoType
                }).catch(error => {
                    logDebug('Error initializing progress tracker:', error);
                });

                const ffmpeg = spawn(ffmpegService.getFFmpegPath(), ffmpegArgs, { 
                    env: getFullEnv()
                });

                let errorOutput = '';
                let hasError = false;
                let lastBytes = 0;
                let totalDuration = null;

                // Send initial progress update
                this.sendProgress({
                    progress: 0,
                    speed: 0,
                    downloaded: 0,
                    size: 0
                });

                // Try to get duration first with FFprobe
                const ffprobe = spawn(ffmpegService.getFFprobePath(), [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_format',
                    url
                ], { env: getFullEnv() });
                
                ffprobe.stdout.on('data', data => {
                    try {
                        const info = JSON.parse(data.toString());
                        if (info.format && info.format.duration) {
                            totalDuration = parseFloat(info.format.duration);
                            logDebug('Got total duration:', totalDuration);
                            
                            // Update progress tracker with duration
                            progressTracker.update({
                                totalDuration: totalDuration
                            });
                        }
                    } catch (e) {
                        logDebug('Error parsing ffprobe output:', e);
                    }
                });

                // Process FFmpeg output for progress tracking
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
                            speed: 0
                        });
                        
                        // Small delay to ensure progress is received first
                        setTimeout(() => {
                            this.sendSuccess({ path: uniqueOutput });
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
        } catch (err) {
            logDebug('Download error:', err);
            this.sendError(err.message);
            throw err;
        }
    }
}

module.exports = DownloadCommand;
