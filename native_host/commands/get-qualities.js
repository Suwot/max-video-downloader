// commands/get-qualities.js
const { spawn } = require('child_process');
const BaseCommand = require('./base-command');
const { logDebug } = require('../utils/logger');
const { getFullEnv } = require('../utils/resources');

/**
 * Command for analyzing media streams and getting available qualities
 */
class GetQualitiesCommand extends BaseCommand {
    /**
     * Execute the getQualities command
     * @param {Object} params Command parameters
     * @param {string} params.url Video URL to analyze
     */
    async execute(params) {
        const { url } = params;
        logDebug('🎥 Analyzing media from:', url);
        
        // Skip for blob URLs
        if (url.startsWith('blob:')) {
            logDebug('❌ Cannot analyze blob URLs');
            this.sendError('Cannot analyze blob URLs');
            return { error: 'Cannot analyze blob URLs' };
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            return new Promise((resolve, reject) => {
                const ffprobe = spawn(ffmpegService.getFFprobePath(), [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_streams',
                    '-show_format',
                    url
                ], { env: getFullEnv() });
    
                let output = '';
                let errorOutput = '';
    
                ffprobe.stdout.on('data', (data) => {
                    output += data;
                });
    
                ffprobe.stderr.on('data', (data) => {
                    errorOutput += data;
                });
    
                ffprobe.on('close', (code) => {
                    if (code === 0 && output) {
                        try {
                            const info = JSON.parse(output);
                            const videoStream = info.streams.find(s => s.codec_type === 'video');
                            const audioStream = info.streams.find(s => s.codec_type === 'audio');
                            
                            const streamInfo = {
                                format: info.format?.format_name || 'unknown',
                                container: info.format?.format_long_name || 'unknown'
                            };
    
                            logDebug('📊 Media analysis results:');
                            logDebug(`Container: ${streamInfo.container}`);
                            
                            // Video stream info
                            if (videoStream) {
                                streamInfo.width = parseInt(videoStream.width) || null;
                                streamInfo.height = parseInt(videoStream.height) || null;
                                streamInfo.hasVideo = true;
                                streamInfo.videoCodec = {
                                    name: videoStream.codec_name || 'unknown',
                                    longName: videoStream.codec_long_name || 'unknown',
                                    profile: videoStream.profile || null,
                                    pixFmt: videoStream.pix_fmt || null,
                                    colorSpace: videoStream.color_space || null,
                                    bitDepth: videoStream.bits_per_raw_sample || null
                                };
                                
                                // Calculate framerate
                                let fps = null;
                                try {
                                    if (videoStream.r_frame_rate) {
                                        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
                                        if (den && num) fps = Math.round(num / den);
                                    } else if (videoStream.avg_frame_rate) {
                                        const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
                                        if (den && num) fps = Math.round(num / den);
                                    }
                                } catch (e) {
                                    logDebug('⚠️ Error parsing framerate:', e);
                                }
                                streamInfo.fps = fps;
    
                                // Get video bitrate
                                if (videoStream.bit_rate) {
                                    streamInfo.videoBitrate = parseInt(videoStream.bit_rate);
                                }
                                
                                logDebug('🎬 Video stream:', {
                                    codec: streamInfo.videoCodec.name,
                                    resolution: `${streamInfo.width}x${streamInfo.height}`,
                                    fps: `${streamInfo.fps}fps`,
                                    bitrate: streamInfo.videoBitrate ? `${(streamInfo.videoBitrate / 1000000).toFixed(2)}Mbps` : 'unknown'
                                });
                            } else {
                                streamInfo.hasVideo = false;
                                logDebug('ℹ️ No video stream found');
                            }
                            
                            // Audio stream info
                            if (audioStream) {
                                streamInfo.hasAudio = true;
                                streamInfo.audioCodec = {
                                    name: audioStream.codec_name || 'unknown',
                                    longName: audioStream.codec_long_name || 'unknown',
                                    profile: audioStream.profile || null,
                                    sampleRate: parseInt(audioStream.sample_rate) || null,
                                    channels: parseInt(audioStream.channels) || null,
                                    channelLayout: audioStream.channel_layout || null,
                                    bitDepth: audioStream.bits_per_raw_sample || null
                                };
                                
                                if (audioStream.bit_rate) {
                                    streamInfo.audioBitrate = parseInt(audioStream.bit_rate);
                                }
                                
                                logDebug('🔊 Audio stream:', {
                                    codec: streamInfo.audioCodec.name,
                                    channels: streamInfo.audioCodec.channels,
                                    sampleRate: streamInfo.audioCodec.sampleRate ? `${streamInfo.audioCodec.sampleRate}Hz` : 'unknown',
                                    bitrate: streamInfo.audioBitrate ? `${(streamInfo.audioBitrate / 1000).toFixed(0)}kbps` : 'unknown'
                                });
                            } else {
                                streamInfo.hasAudio = false;
                                logDebug('ℹ️ No audio stream found');
                            }
                            
                            // Total bitrate from format if available
                            if (info.format.bit_rate) {
                                streamInfo.totalBitrate = parseInt(info.format.bit_rate);
                            }
                            
                            // Duration if available
                            if (info.format.duration) {
                                streamInfo.duration = parseFloat(info.format.duration);
                                const minutes = Math.floor(streamInfo.duration / 60);
                                const seconds = Math.floor(streamInfo.duration % 60);
                                logDebug(`⏱️ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`);
                            }
                            
                            // File size if available
                            if (info.format.size) {
                                streamInfo.sizeBytes = parseInt(info.format.size);
                                const sizeMB = (streamInfo.sizeBytes / (1024 * 1024)).toFixed(1);
                                logDebug(`📦 Size: ${sizeMB}MB`);
                            }
                            
                            this.sendSuccess({ streamInfo });
                            logDebug('✅ Media analysis complete');
                            resolve({ success: true, streamInfo });
                            
                        } catch (error) {
                            logDebug('❌ Error parsing FFprobe output:', error);
                            this.sendError('Failed to parse stream info');
                            resolve({ error: 'Failed to parse stream info' });
                        }
                    } else {
                        logDebug('❌ FFprobe failed with code:', code, 'Error:', errorOutput);
                        this.sendError('Failed to analyze video');
                        resolve({ error: 'Failed to analyze video' });
                    }
                });
    
                ffprobe.on('error', (err) => {
                    logDebug('❌ FFprobe spawn error:', err);
                    this.sendError('Failed to start FFprobe: ' + err.message);
                    resolve({ error: 'Failed to start FFprobe: ' + err.message });
                });
            });
        } catch (err) {
            logDebug('❌ GetQualities error:', err);
            this.sendError(err.message);
            return { error: err.message };
        }
    }
}

module.exports = GetQualitiesCommand;
