// lib/error-handler.js
const { logDebug } = require('../utils/logger');

/**
 * Centralized error handler to normalize errors and provide consistent responses
 */
class ErrorHandler {
    constructor(messagingService) {
        this.messaging = messagingService;
        
        // Setup global error handlers
        process.on('uncaughtException', (err) => this.handleUncaughtException(err));
        process.on('unhandledRejection', (err) => this.handleUnhandledRejection(err));
    }

    handleUncaughtException(err) {
        logDebug('Uncaught Exception:', err);
        this.messaging.sendResponse({ error: `Uncaught Exception: ${err.message}` });
    }

    handleUnhandledRejection(err) {
        logDebug('Unhandled Rejection:', err);
        this.messaging.sendResponse({ error: `Unhandled Rejection: ${err.message}` });
    }

    /**
     * Handle command execution errors
     * @param {Error} err The error object
     * @param {string} commandName The name of the command that failed
     * @param {string} requestId Optional message ID for response tracking
     */
    handleCommandError(err, commandName, requestId = null) {
        const errorMessage = `Error executing ${commandName || 'command'}: ${err.message}`;
        logDebug(errorMessage);
        this.messaging.sendResponse({ error: errorMessage }, requestId);
        return { error: errorMessage };
    }
    
    /**
     * Handle messaging protocol errors
     * @param {Error} err The error object
     * @param {string} requestId Optional message ID for response tracking
     */
    handleMessageError(err, requestId = null) {
        logDebug('Error in message handling:', err);
        this.messaging.sendResponse({ error: err.message }, requestId);
        return { error: err.message };
    }
}

module.exports = ErrorHandler;
