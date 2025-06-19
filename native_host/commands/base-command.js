/**
 * @ai-guide-component BaseCommand
 * @ai-guide-description Foundation class for all native host commands
 * @ai-guide-responsibilities
 * - Provides common structure for all command implementations
 * - Manages messaging between native host and extension
 * - Offers standardized success/error/progress response methods
 * - Handles service access and dependency injection
 * - Enforces consistent command execution pattern
 */

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
            command: 'download-progress',
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
    sendError(error, details = null) {
        // Handle both string and object error formats
        if (typeof error === 'string') {
            logDebug(`Command error: ${error}`, details);
            this.messaging.sendResponse({
                error: error
            });
        } else {
            // Object format with detailed error information
            logDebug(`Command error: ${error.message || error}`, error);
            this.messaging.sendResponse({
                error: error.message || error,
                ...error
            });
        }
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
