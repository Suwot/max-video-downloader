#!/usr/bin/env node
// native_host/host.js

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Use detected FFmpeg paths
let FFMPEG_PATH;
let FFPROBE_PATH;

// Debug logging
const LOG_FILE = path.join(process.env.HOME, '.cache', 'video-downloader.log');
function logDebug(...args) {
    const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : arg
    ).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
}

// Verify ffmpeg installation at startup
function checkFFmpeg() {
    try {
        // Hardcode the paths based on your system
        FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';  // Replace with your actual path from `which ffmpeg`
        FFPROBE_PATH = '/opt/homebrew/bin/ffprobe'; // Replace with your actual path from `which ffprobe`
        
        // Verify the files exist
        if (!fs.existsSync(FFMPEG_PATH) || !fs.existsSync(FFPROBE_PATH)) {
            throw new Error('FFmpeg or FFprobe not found at specified paths');
        }
        
        logDebug('Found FFmpeg at:', FFMPEG_PATH);
        logDebug('Found FFprobe at:', FFPROBE_PATH);
        return true;
    } catch (err) {
        logDebug('FFmpeg check failed:', err);
        return false;
    }
}

function getFullEnv() {
    return {
        ...process.env,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    };
}

// Initial setup
try {
    // Check FFmpeg
    if (!checkFFmpeg()) {
        logDebug('FFmpeg not found. Please install FFmpeg first.');
        // Log all environment info for debugging
        logDebug('PATH:', process.env.PATH);
        logDebug('Current working directory:', process.cwd());
        logDebug('User home:', process.env.HOME);
        process.exit(1);
    }

    // Create cache directory
    const cacheDir = path.join(process.env.HOME, '.cache');
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

process.stdin.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        
        const message = buffer.slice(4, length + 4);
        buffer = buffer.slice(length + 4);
        
        try {
            const request = JSON.parse(message);
            logDebug('Received message:', request);
            handleMessage(request).catch(err => {
                logDebug('Error in message handling:', err);
                sendResponse({ error: err.message });
            });
        } catch (err) {
            logDebug('Error parsing message:', err);
            sendResponse({ error: 'Invalid message format' });
        }
    }
});

async function handleMessage(request) {
    logDebug('Processing message:', request);
    
    switch(request.type) {
        case 'download':
            await downloadVideo(request.url, request.filename, request.quality);
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

async function downloadVideo(url, filename, quality = 'best') {
    logDebug('Starting download:', { url, filename, quality });
    const outputPath = path.join(process.env.HOME, 'Downloads', filename);
    
    const isHLS = url.includes('.m3u8');
    const ffmpegArgs = isHLS ? [
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-i', url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        outputPath
    ] : [
        '-i', url,
        '-c', 'copy',
        outputPath
    ];

    logDebug('FFmpeg command:', FFMPEG_PATH, ffmpegArgs.join(' '));
    
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { env: getFullEnv() });
        let errorOutput = '';

        ffmpeg.stderr.on('data', (data) => {
            errorOutput += data.toString();
            logDebug(`ffmpeg stderr: ${data}`);
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                sendResponse({ success: true, path: outputPath });
                resolve();
            } else {
                const error = `FFmpeg exited with code ${code}: ${errorOutput}`;
                logDebug(error);
                sendResponse({ error });
                reject(new Error(error));
            }
        });

        ffmpeg.on('error', (err) => {
            logDebug('FFmpeg spawn error:', err);
            sendResponse({ error: err.message });
            reject(err);
        });
    });
}

async function getStreamQualities(url) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(FFPROBE_PATH, [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            url
        ], { env: getFullEnv() });

        let output = '';
        let errorOutput = '';

        ffprobe.stdout.on('data', (data) => {
            output += data;
        });

        ffprobe.stderr.on('data', (data) => {
            errorOutput += data.toString();
            logDebug(`ffprobe stderr: ${data}`);
        });

        ffprobe.on('close', (code) => {
            if (code === 0) {
                try {
                    const data = JSON.parse(output);
                    const qualities = data.streams
                        .filter(stream => stream.codec_type === 'video')
                        .map(stream => ({
                            resolution: stream.height,
                            bitrate: Math.round(stream.bit_rate / 1000) || null
                        }));
                    sendResponse({ qualities: qualities.length ? qualities : [{ resolution: 'best', bitrate: null }] });
                    resolve();
                } catch (e) {
                    sendResponse({ qualities: [{ resolution: 'best', bitrate: null }] });
                    resolve();
                }
            } else {
                const error = `FFprobe exited with code ${code}: ${errorOutput}`;
                sendResponse({ error });
                reject(new Error(error));
            }
        });

        ffprobe.on('error', (err) => {
            logDebug('FFprobe spawn error:', err);
            sendResponse({ error: err.message });
            reject(err);
        });
    });
}

function generatePreview(url) {
    return new Promise((resolve, reject) => {
        const previewPath = path.join(process.env.HOME, '.cache', 'video-preview-' + Date.now() + '.jpg');
        const ffmpeg = spawn(FFMPEG_PATH, [
            '-ss', '00:00:01',
            '-i', url,
            '-vframes', '1',
            '-vf', 'scale=120:-1',
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
        const messageStr = JSON.stringify(message);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(messageStr.length, 0);
        
        process.stdout.write(header);
        process.stdout.write(messageStr);
        
        logDebug('Sent response:', message);
    } catch (err) {
        logDebug('Error sending response:', err);
        try {
            const errorMessage = JSON.stringify({ error: err.message });
            const errorHeader = Buffer.alloc(4);
            errorHeader.writeUInt32LE(errorMessage.length, 0);
            process.stdout.write(errorHeader);
            process.stdout.write(errorMessage);
        } catch (e) {
            logDebug('Failed to send error response:', e);
        }
    }
}

process.on('exit', (code) => {
    logDebug(`Process exiting with code: ${code}`);
});