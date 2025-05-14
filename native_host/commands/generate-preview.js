/**
 * @ai-guide-component GeneratePreviewCommand
 * @ai-guide-description Video thumbnail generator
 * @ai-guide-responsibilities
 * - Creates thumbnail previews from video URLs
 * - Uses FFmpeg to extract frames from remote videos
 * - Converts thumbnails to base64 data URLs
 * - Handles various video source formats
 * - Optimizes thumbnails for UI display
 * - Implements temporary file management
 * - Reports preview generation progress and errors
 */

// commands/generate-preview.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BaseCommand = require('./base-command');
const { logDebug } = require('../utils/logger');
const { getFullEnv } = require('../utils/resources');

/**
 * Command for generating video previews/thumbnails
 */
class GeneratePreviewCommand extends BaseCommand {
    /**
     * Execute the preview generation command
     * @param {Object} params Command parameters
     * @param {string} params.url Video URL to generate preview for
     */
    async execute(params) {
        const { url, headers = {} } = params;
        logDebug('Generating preview for video:', url);
        
        // Skip for blob URLs
        if (url.startsWith('blob:')) {
            this.sendError('Cannot generate preview for blob URLs');
            return { error: 'Cannot generate preview for blob URLs' };
        }
        
        // Log received headers
        if (headers && Object.keys(headers).length > 0) {
            logDebug('🔑 Using headers for preview request:', Object.keys(headers));
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            return new Promise((resolve, reject) => {
                const previewPath = path.join(process.env.HOME || os.homedir(), '.cache', 'video-preview-' + Date.now() + '.jpg');
                
                // Build FFmpeg args
                let ffmpegArgs = ['-ss', '00:00:01'];  // Skip to 1 second in
                
                // Add headers if provided
                if (headers && Object.keys(headers).length > 0) {
                    // Format headers for FFmpeg as "Key: Value\r\n" pairs
                    const headerLines = Object.entries(headers)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join('\r\n');
                    
                    if (headerLines) {
                        ffmpegArgs.push('-headers', headerLines + '\r\n');
                    }
                }
                
                // Add the rest of the arguments
                ffmpegArgs = ffmpegArgs.concat([
                    '-i', url,
                    '-vframes', '1',     // Extract one frame
                    '-vf', 'scale=120:-1',  // Scale to 120px width
                    '-q:v', '2',         // High quality
                    previewPath
                ]);
                
                const ffmpeg = spawn(ffmpegService.getFFmpegPath(), ffmpegArgs, { env: getFullEnv() });
        
                let errorOutput = '';
        
                ffmpeg.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
        
                ffmpeg.on('close', (code) => {
                    if (code === 0) {
                        try {
                            // Convert image to data URL
                            const imageBuffer = fs.readFileSync(previewPath);
                            const dataUrl = 'data:image/jpeg;base64,' + imageBuffer.toString('base64');
                            this.sendSuccess({ previewUrl: dataUrl });
                            // Clean up
                            fs.unlink(previewPath, (err) => {
                                if (err) logDebug('Failed to delete preview file:', err);
                            });
                            resolve({ success: true, previewUrl: dataUrl });
                        } catch (err) {
                            this.sendError('Failed to read preview file: ' + err.message);
                            reject(err);
                        }
                    } else {
                        const error = `Failed to generate preview. FFmpeg exited with code ${code}: ${errorOutput}`;
                        this.sendError(error);
                        reject(new Error(error));
                    }
                });
        
                ffmpeg.on('error', (err) => {
                    this.sendError(err.message);
                    reject(err);
                });
            });
        } catch (err) {
            logDebug('Preview generation error:', err);
            this.sendError(err.message);
            return { error: err.message };
        }
    }
}

module.exports = GeneratePreviewCommand;
