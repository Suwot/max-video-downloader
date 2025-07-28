/**
 * HeartbeatCommand – Connection status monitoring command
 * - Responds to periodic status check requests from the extension
 * - Verifies that the native host is alive and responsive
 * - Maintains persistent connection between extension and native host
 * - Helps detect when the host process becomes unresponsive
 * - Provides simple diagnostics about host process status
 */

const BaseCommand = require('./base-command');
const { logDebug } = require('../utils/logger');

/**
 * Command for handling heartbeat messages to keep connection alive
 */
class HeartbeatCommand extends BaseCommand {
    /**
     * Execute the heartbeat command
     * @param {Object} params Command parameters
     */
    async execute(params) {
        logDebug('Received heartbeat');
        
        // Get version from package.json
        const pkg = require('../package.json');
        const version = pkg.version;
        
        // Get binary location
        const location = process.execPath || process.argv[0];
        
        // Get FFmpeg version info
        let ffmpegVersion = null;
        try {
            const ffmpegService = this.getService('ffmpeg');
            if (ffmpegService) {
                // Try to get FFmpeg version - this is a simple approach
                ffmpegVersion = '6.1'; // Default bundled version
                // TODO: Could run ffmpeg -version to get actual version, but keeping it simple for now
            }
        } catch (error) {
            logDebug('Could not get FFmpeg version:', error.message);
        }
        
        const response = {
            command: 'heartbeat',
            alive: true,
            success: true,
            version: version,
            location: location,
            ffmpegVersion: ffmpegVersion
        };
        
        // Send heartbeat response with extended info
        this.sendMessage(response);

        return response;
    }
}

module.exports = HeartbeatCommand;
