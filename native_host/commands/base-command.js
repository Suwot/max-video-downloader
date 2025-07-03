/**
 * BaseCommand – Foundation class for all native host commands
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
        if (typeof error === 'string') {
            // Simple string error
            logDebug(`Command error: ${error}`, details);
            this.messaging.sendResponse({
                error: error
            });
        } else if (error && typeof error === 'object') {
            // Object format with detailed error information
            const errorMessage = error.message || error.error || 'Unknown error';
            logDebug(`Command error: ${errorMessage}`, error);
            
            // Send clean error structure without nesting
            this.messaging.sendResponse({
                error: errorMessage,
                command: error.command || 'error',
                ...error
            });
        } else {
            // Fallback for other types
            logDebug(`Command error: ${error}`, details);
            this.messaging.sendResponse({
                error: String(error)
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
