// commands/base-command.js
const { logDebug } = require('../utils/logger');
const servicesManager = require('../services');

/**
 * Base class for all commands
 */
class BaseCommand {
    constructor(messagingService) {
        this.messaging = messagingService;
        this.services = servicesManager;
    }

    /**
     * Get a required service for this command
     */
    getService(serviceName) {
        return this.services.getService(serviceName);
    }

    /**
     * Send progress update (rate-limited)
     */
    sendProgress(progress) {
        this.messaging.sendResponse({
            type: 'progress',
            ...progress
        });
    }

    /**
     * Send success response
     */
    sendSuccess(data = {}) {
        this.messaging.sendResponse({
            success: true,
            ...data
        });
    }

    /**
     * Send error response
     */
    sendError(message, details = null) {
        logDebug(`Command error: ${message}`, details);
        this.messaging.sendResponse({
            error: message
        });
    }
    
    /**
     * Execute the command with the given parameters
     * To be implemented by subclasses
     */
    async execute(params) {
        throw new Error('Command execution not implemented');
    }
}

module.exports = BaseCommand;
