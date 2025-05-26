/**
 * Test script to verify FFmpeg path detection and usage
 */
const ffmpegService = require('./services/ffmpeg');
const { logDebug } = require('./utils/logger');

// Initialize the service
if (ffmpegService.initialize()) {
    logDebug('FFmpeg Service initialized successfully');
    logDebug('FFmpeg Path:', ffmpegService.getFFmpegPath());
    logDebug('FFprobe Path:', ffmpegService.getFFprobePath());
} else {
    logDebug('Failed to initialize FFmpeg Service');
}
