// commands/heartbeat.js
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
        
        // Send simple heartbeat response to confirm host is alive
        this.sendSuccess({ type: 'heartbeat', alive: true });
        
        return { success: true, type: 'heartbeat', alive: true };
    }
}

module.exports = HeartbeatCommand;
