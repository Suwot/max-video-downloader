/**
 * @ai-guide-component CommandRunner
 * @ai-guide-description Implements command pattern for the native host
 * @ai-guide-responsibilities
 * - Registers and manages available commands (download, get-qualities, etc.)
 * - Routes incoming messages to appropriate command handlers
 * - Manages service dependency injection for commands
 * - Provides error handling and logging for command execution
 * - Maintains service lifecycle and initialization
 */

// lib/command-runner.js
const { logDebug } = require('../utils/logger');

/**
 * Handles command execution orchestration
 */
class CommandRunner {
    constructor(messagingService, errorHandler) {
        this.messaging = messagingService;
        this.errorHandler = errorHandler;
        this.commandRegistry = new Map();
    }

    /**
     * Register a command with the command runner
     */
    registerCommand(commandType, CommandClass) {
        this.commandRegistry.set(commandType, CommandClass);
        logDebug(`Registered command handler for: ${commandType}`);
    }

    /**
     * Process and execute a command based on message type
     * @param {Object} message The message containing the command
     * @param {string} requestId Optional message ID for tracking responses
     */
    async executeCommand(message, requestId) {
        const commandType = message.type;
        
        logDebug(`Executing command: ${commandType} (ID: ${requestId || 'none'})`);
        
        if (!this.commandRegistry.has(commandType)) {
            const error = `Unknown command type: ${commandType}`;
            this.messaging.sendResponse({ error }, requestId);
            return { error };
        }

        try {
            // Create a messaging proxy that will include the requestId in all responses
            const messagingProxy = {
                sendResponse: (response) => this.messaging.sendResponse(response, requestId),
                // Proxy other methods directly
                initialize: (...args) => this.messaging.initialize(...args),
                handleIncomingData: (...args) => this.messaging.handleIncomingData(...args),
                processMessages: (...args) => this.messaging.processMessages(...args),
                startHeartbeatMonitor: (...args) => this.messaging.startHeartbeatMonitor(...args)
            };

            // Instantiate the command with the messaging proxy
            const CommandClass = this.commandRegistry.get(commandType);
            const command = new CommandClass(messagingProxy);

            // Execute the command
            return await command.execute(message);
        } catch (err) {
            return this.errorHandler.handleCommandError(err, commandType, requestId);
        }
    }
}

module.exports = CommandRunner;
