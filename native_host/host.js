#!/usr/bin/env node
// native_host/host.js

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

// Use detected FFmpeg paths
let FFMPEG_PATH;
let FFPROBE_PATH;

// Debug logging
const LOG_FILE = path.join(process.env.HOME || os.homedir(), '.cache', 'video-downloader.log');
function logDebug(...args) {
    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : arg
    ).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
}

// Verify ffmpeg installation at startup
function checkFFmpeg() {
    try {
        // Try multiple common macOS paths first for M1/Intel Macs
        const macOSPaths = [
            '/opt/homebrew/bin',  // M1 Mac Homebrew
            '/usr/local/bin',     // Intel Mac Homebrew
            '/opt/local/bin',     // MacPorts
            '/usr/bin'            // System
        ];

        if (process.platform === 'darwin') {
            // Try each path until we find both ffmpeg and ffprobe
            for (const basePath of macOSPaths) {
                const ffmpegPath = `${basePath}/ffmpeg`;
                const ffprobePath = `${basePath}/ffprobe`;
                
                if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
                    FFMPEG_PATH = ffmpegPath;
                    FFPROBE_PATH = ffprobePath;
                    logDebug('Found FFmpeg at:', FFMPEG_PATH);
                    logDebug('Found FFprobe at:', FFPROBE_PATH);
                    return true;
                }
            }
        } else if (process.platform === 'win32') {
            // Windows paths
            FFMPEG_PATH = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
            FFPROBE_PATH = 'C:\\ffmpeg\\bin\\ffprobe.exe';
        } else {
            // Linux paths
            FFMPEG_PATH = '/usr/bin/ffmpeg';
            FFPROBE_PATH = '/usr/bin/ffprobe';
        }

        // Final check if paths are valid
        if (!fs.existsSync(FFMPEG_PATH) || !fs.existsSync(FFPROBE_PATH)) {
            throw new Error('FFmpeg or FFprobe not found at specified paths');
        }

        return true;
    } catch (err) {
        logDebug('FFmpeg check failed:', err);
        return false;
    }
}

function getFullEnv() {
    // Get a complete environment with PATH that includes common locations
    const extraPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ];
    
    const path = extraPaths.join(process.platform === 'win32' ? ';' : ':');
    
    return {
        ...process.env,
        PATH: `${path}:${process.env.PATH || ''}`
    };
}

// Add at the top of the file with other globals
let lastResponseTime = 0;
const MIN_RESPONSE_INTERVAL = 250; // Minimum 250ms between progress messages

// Initial setup
try {
    // Check FFmpeg
    if (!checkFFmpeg()) {
        logDebug('FFmpeg not found. Please install FFmpeg first.');
        // Log all environment info for debugging
        logDebug('PATH:', process.env.PATH);
        logDebug('Current working directory:', process.cwd());
        logDebug('User home:', process.env.HOME || os.homedir());
        process.exit(1);
    }

    // Create cache directory
    const cacheDir = path.join(process.env.HOME || os.homedir(), '.cache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
} catch (err) {
    logDebug('Setup failed:', err);
    logDebug('Error details:', err.stack);
    process.exit(1);
}

// Error handling
process.on('uncaughtException', (err) => {
    logDebug('Uncaught Exception:', err);
    sendResponse({ error: `Uncaught Exception: ${err.message}` });
});

process.on('unhandledRejection', (err) => {
    logDebug('Unhandled Rejection:', err);
    sendResponse({ error: `Unhandled Rejection: ${err.message}` });
});

// Message handling
let buffer = Buffer.alloc(0);

// Add message deduplication
const processedMessages = new Set();
let messageTimeout = null;

process.stdin.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    // Clear any existing timeout
    if (messageTimeout) {
        clearTimeout(messageTimeout);
    }
    
    // Set a new timeout to process messages
    messageTimeout = setTimeout(() => {
        processMessages();
    }, 50); // Wait 50ms to collect all message parts
});

function processMessages() {
    while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        
        const message = buffer.slice(4, length + 4);
        buffer = buffer.slice(length + 4);
        
        try {
            const request = JSON.parse(message);
            const messageId = JSON.stringify(request); // Use the message content as ID
            
            // Skip if we've already processed this message
            if (processedMessages.has(messageId)) {
                continue;
            }
            
            // Add to processed messages
            processedMessages.add(messageId);
            
            // Clear old messages after 1 second
            setTimeout(() => {
                processedMessages.delete(messageId);
            }, 1000);
            
            logDebug('Processing message:', request);
            handleMessage(request).catch(err => {
                logDebug('Error in message handling:', err);
                sendResponse({ error: err.message });
            });
        } catch (err) {
            logDebug('Error parsing message:', err);
            sendResponse({ error: 'Invalid message format' });
        }
    }
}

async function handleMessage(request) {
    logDebug('Processing message:', request);
    
    switch(request.type) {
        case 'download':
            await downloadVideo(request.url, request.filename, request.savePath, request.quality);
            break;
        case 'getQualities':
            await getStreamQualities(request.url);
            break;
        case 'generatePreview':
            await generatePreview(request.url);
            break;
        default:
            sendResponse({ error: 'Unknown command type: ' + request.type });
    }
}

async function downloadVideo(url, filename, savePath, quality = 'best') {
    logDebug('Starting download:', { url, filename, savePath, quality });
    
    try {
        // Determine video type from URL
        const videoType = getVideoTypeFromUrl(url);
        
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
        
        // Output parameters - try to copy streams when possible
        ffmpegArgs = ffmpegArgs.concat([
            '-c', 'copy',            // Copy streams without re-encoding
            '-bsf:a', 'aac_adtstoasc', // Fix for certain audio streams
            '-movflags', '+faststart',  // Optimize for streaming playback
            uniqueOutput
        ]);

        logDebug('FFmpeg command:', FFMPEG_PATH, ffmpegArgs.join(' '));

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { 
                env: getFullEnv()
            });

            let errorOutput = '';
            let progressOutput = '';
            let lastProgressUpdate = 0;
            let downloadStartTime = Date.now();
            let lastBytes = 0;
            let totalDuration = null;
            let hasError = false;

            // Send initial progress
            sendResponse({
                type: 'progress',
                progress: 0,
                speed: 0,
                downloaded: 0,
                size: 0
            });

            // Try to get duration first
            const ffprobe = spawn(FFPROBE_PATH, [
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
                    }
                } catch (e) {
                    logDebug('Error parsing ffprobe output:', e);
                }
            });

            ffmpeg.stderr.on('data', (data) => {
                if (hasError) return;
                
                const output = data.toString();
                errorOutput += output;
                progressOutput += output;
                
                const now = Date.now();
                if (now - lastProgressUpdate > 250) {
                    lastProgressUpdate = now;
                    
                    const timeMatch = progressOutput.match(/time=(\d+):(\d+):(\d+.\d+)/);
                    const sizeMatch = progressOutput.match(/size=\s*(\d+)kB/);
                    
                    if (timeMatch && sizeMatch) {
                        const [_, hours, minutes, seconds] = timeMatch;
                        const currentTime = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
                        const currentBytes = parseInt(sizeMatch[1]) * 1024;
                        
                        // Calculate speed
                        const elapsedTime = (now - downloadStartTime) / 1000;
                        const bytesPerSecond = currentBytes / elapsedTime;
                        const instantSpeed = (currentBytes - lastBytes) * 4;
                        lastBytes = currentBytes;
                        
                        // Calculate progress based on time if we have duration
                        let progress;
                        if (totalDuration) {
                            progress = Math.min(99, Math.round((currentTime / totalDuration) * 100));
                        } else {
                            // Fallback to a time-based estimate
                            progress = Math.min(99, Math.round((currentTime / 10) * 100));
                        }
                        
                        // Send progress update
                        sendResponse({
                            type: 'progress',
                            progress,
                            speed: instantSpeed > 0 ? instantSpeed : bytesPerSecond,
                            downloaded: currentBytes,
                            currentTime,
                            totalDuration
                        });
                        
                        progressOutput = ''; // Clear processed output
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0 && !hasError) {
                    logDebug('Download completed successfully');
                    // Send final progress
                    sendResponse({
                        type: 'progress',
                        progress: 100,
                        downloaded: lastBytes,
                        speed: 0
                    });
                    
                    // Small delay to ensure progress is received first
                    setTimeout(() => {
                        sendResponse({ success: true, path: uniqueOutput });
                        resolve();
                    }, 100);
                } else if (!hasError) {
                    hasError = true;
                    const error = `FFmpeg exited with code ${code}: ${errorOutput}`;
                    logDebug('Download failed:', error);
                    sendResponse({ error });
                    reject(new Error(error));
                }
            });

            ffmpeg.on('error', (err) => {
                if (!hasError) {
                    hasError = true;
                    logDebug('FFmpeg spawn error:', err);
                    sendResponse({ error: err.message });
                    reject(err);
                }
            });
        });
    } catch (err) {
        logDebug('Download error:', err);
        sendResponse({ error: err.message });
        throw err;
    }
}

function getVideoTypeFromUrl(url) {
    if (url.includes('.m3u8')) {
        return 'hls';
    } else if (url.includes('.mpd')) {
        return 'dash';
    } else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)/i.test(url)) {
        return 'direct';
    } else if (url.startsWith('blob:')) {
        return 'blob';
    } else {
        return 'unknown';
    }
}

async function getStreamQualities(url) {
    logDebug('🎥 Analyzing media from:', url);
    
    // Skip for blob URLs
    if (url.startsWith('blob:')) {
        logDebug('❌ Cannot analyze blob URLs');
        sendResponse({ error: 'Cannot analyze blob URLs' });
        return;
    }
    
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(FFPROBE_PATH, [
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
                    
                    sendResponse({ success: true, streamInfo });
                    logDebug('✅ Media analysis complete');
                    resolve();
                    
                } catch (error) {
                    logDebug('❌ Error parsing FFprobe output:', error);
                    sendResponse({ error: 'Failed to parse stream info' });
                    resolve();
                }
            } else {
                logDebug('❌ FFprobe failed with code:', code, 'Error:', errorOutput);
                sendResponse({ error: 'Failed to analyze video' });
                resolve();
            }
        });

        ffprobe.on('error', (err) => {
            logDebug('❌ FFprobe spawn error:', err);
            sendResponse({ error: 'Failed to start FFprobe: ' + err.message });
            resolve();
        });
    });
}

function generatePreview(url) {
    // Skip for blob URLs
    if (url.startsWith('blob:')) {
        sendResponse({ error: 'Cannot generate preview for blob URLs' });
        return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
        const previewPath = path.join(process.env.HOME || os.homedir(), '.cache', 'video-preview-' + Date.now() + '.jpg');
        const ffmpeg = spawn(FFMPEG_PATH, [
            '-ss', '00:00:01',  // Skip to 1 second in
            '-i', url,
            '-vframes', '1',    // Extract one frame
            '-vf', 'scale=120:-1',  // Scale to 120px width
            '-q:v', '2',        // High quality
            previewPath
        ], { env: getFullEnv() });

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
                    sendResponse({ previewUrl: dataUrl });
                    // Clean up
                    fs.unlink(previewPath, (err) => {
                        if (err) logDebug('Failed to delete preview file:', err);
                    });
                    resolve();
                } catch (err) {
                    sendResponse({ error: 'Failed to read preview file: ' + err.message });
                    reject(err);
                }
            } else {
                const error = `Failed to generate preview. FFmpeg exited with code ${code}: ${errorOutput}`;
                sendResponse({ error });
                reject(new Error(error));
            }
        });

        ffmpeg.on('error', (err) => {
            sendResponse({ error: err.message });
            reject(err);
        });
    });
}

function sendResponse(message) {
    try {
        // Only rate limit progress messages
        const now = Date.now();
        if (message.type === 'progress' && now - lastResponseTime < MIN_RESPONSE_INTERVAL) {
            return;
        }
        lastResponseTime = now;
        
        const messageStr = JSON.stringify(message);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(messageStr.length, 0);
        
        // Wrap in try-catch to handle potential write errors
        try {
            // Write as a single operation to avoid interleaved writes
            const combined = Buffer.concat([header, Buffer.from(messageStr)]);
            process.stdout.write(combined);
        } catch (writeErr) {
            logDebug('Error writing to stdout:', writeErr);
        }
    } catch (err) {
        logDebug('Error preparing response:', err);
    }
}

process.on('exit', (code) => {
    logDebug(`Process exiting with code: ${code}`);
});