/**
 * GetQualitiesCommand – Video stream quality analyzer
 * - Analyzes video streams for available quality options
 * - Uses FFprobe to extract stream metadata
 * - Identifies resolution, bitrate, and codec information
 * - Maps technical stream data to user-friendly quality labels
 * - Returns structured quality options to the extension UI
 * - Handles various streaming protocol formats
 */

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
     * @param {string} [params.type] Media type: 'hls', 'dash', 'direct'
     * @param {string} [params.representationId] For DASH: specific representation ID
     * @param {Object} [params.headers] HTTP headers for requests
     */
    async execute(params) {
        const { 
            url, 
            type, 
            representationId = null,
            headers = {}
        } = params;
        
        logDebug(`🎥 Analyzing media from: ${url} (type: ${type})`);
        
        // Skip for blob URLs
        if (url.startsWith('blob:')) {
            logDebug('❌ Cannot analyze blob URLs');
            this.sendMessage('Cannot analyze blob URLs');
            return { error: 'Cannot analyze blob URLs' };
        }
        
        // Log received headers
        if (headers && Object.keys(headers).length > 0) {
            logDebug('🔑 Received headers:', headers);
        }
        
        try {
            // Get required services
            const ffmpegService = this.getService('ffmpeg');
            
            return new Promise((resolve, reject) => {
                // Build FFprobe args
                const ffprobeArgs = [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_streams',
                    '-show_format'
                ];
                
                // Add headers if provided
                if (headers && Object.keys(headers).length > 0) {
                    // Format headers for FFprobe as "Key: Value\r\n" pairs
                    const headerLines = Object.entries(headers)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join('\r\n');
                    
                    if (headerLines) {
                        ffprobeArgs.push('-headers', headerLines + '\r\n');
                        logDebug('🔑 Using headers for FFprobe request');
                    }
                }
                
                // Handle DASH-specific representation selection
                let analyzeUrl = url;
                if (type === 'dash' && representationId) {
                    analyzeUrl = `${url}#${representationId}`;
                    logDebug(`🎯 Targeting specific DASH representation: ${representationId}`);
                }
                
                // Add URL as the last argument
                ffprobeArgs.push(analyzeUrl);
                
                const ffprobe = spawn(ffmpegService.getFFprobePath(), ffprobeArgs, { env: getFullEnv() });
    
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
                            const subtitleStreams = info.streams.filter(s => s.codec_type === 'subtitle');

                            const streamInfo = {
                                format: info.format?.format_name || 'unknown',
                                container: info.format?.format_long_name || 'unknown',
                                type: type,
                                inputUrl: url,
                                analyzeUrl: analyzeUrl
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

                            // Subtitle stream info
                            if (subtitleStreams && subtitleStreams.length > 0) {
                                streamInfo.hasSubs = true;
                                streamInfo.subtitles = subtitleStreams.map(sub => ({
                                    index: sub.index,
                                    codec: sub.codec_name || 'unknown',
                                    language: (sub.tags && (sub.tags.language || sub.tags.LANGUAGE)) || null,
                                    title: (sub.tags && (sub.tags.title || sub.tags.TITLE)) || null,
                                    disposition: sub.disposition || {},
                                }));
                                logDebug(`📝 Found ${subtitleStreams.length} subtitle stream(s):`, streamInfo.subtitles);
                            } else {
                                streamInfo.hasSubs = false;
                                streamInfo.subtitles = [];
                                logDebug('ℹ️ No subtitle streams found');
                            }

                            // Total bitrate from format if available
                            if (info.format.bit_rate) {
                                streamInfo.totalBitrate = parseInt(info.format.bit_rate);
                            }

                            // Duration if available
                            if (info.format.duration) {
                                streamInfo.duration = Math.round(parseFloat(info.format.duration));
                                const hours = Math.floor(streamInfo.duration / 3600);
                                const minutes = Math.floor((streamInfo.duration % 3600) / 60);
                                const seconds = streamInfo.duration % 60;
                                if (hours > 0) {
                                    logDebug(`⏱️ Duration: ${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
                                } else {
                                    logDebug(`⏱️ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`);
                                }
                            }

                            // File size if available
                            if (info.format.size) {
                                streamInfo.sizeBytes = parseInt(info.format.size);
                                const sizeMB = (streamInfo.sizeBytes / (1024 * 1024)).toFixed(1);
                                logDebug(`📦 Size: ${sizeMB}MB`);
                            }

                            // Calculate estimated size based on bitrate and duration if exact size not available
                            if (streamInfo.totalBitrate && streamInfo.duration) {
                                // Formula: (bitrate in bps * duration in seconds) / 8 = bytes
                                streamInfo.estimatedFileSizeBytes = Math.round((streamInfo.totalBitrate * streamInfo.duration) / 8);
                                const sizeMB = (streamInfo.estimatedFileSizeBytes / (1024 * 1024)).toFixed(1);
                                logDebug(`📊 Estimated size: ${sizeMB}MB (based on bitrate × duration)`);
                            }

                            this.sendMessage({ streamInfo, success: true });
                            logDebug('✅ Media analysis complete');
                            resolve({ success: true, streamInfo });
                            
                        } catch (error) {
                            logDebug('❌ Error parsing FFprobe output:', error);
                            this.sendMessage('Failed to parse stream info');
                            resolve({ error: 'Failed to parse stream info' });
                        }
                    } else {
                        logDebug('❌ FFprobe failed with code:', code, 'Error:', errorOutput);
                        this.sendMessage('Failed to analyze video');
                        resolve({ error: 'Failed to analyze video' });
                    }
                });
    
                ffprobe.on('error', (err) => {
                    logDebug('❌ FFprobe spawn error:', err);
                    this.sendMessage('Failed to start FFprobe: ' + err.message);
                    resolve({ error: 'Failed to start FFprobe: ' + err.message });
                });
            });
        } catch (err) {
            logDebug('❌ GetQualities error:', err);
            this.sendMessage(err.message);
            return { error: err.message };
        }
    }
}

module.exports = GetQualitiesCommand;
