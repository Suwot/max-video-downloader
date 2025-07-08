/**
 * CommandRunner – Orchestrates command execution for the native host
 * - Registers command handler classes keyed by command type.
 * - Delegates incoming messages to the correct command handler.
 * - Injects messaging and error handling dependencies into commands.
 * - Handles unknown commands and propagates errors with logging.
 * - Ensures all command responses are correlated with request IDs.
 */

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
        const commandType = message.command;
        
        logDebug(`Executing command: ${commandType} (ID: ${requestId || 'none'})`);
        
        if (!this.commandRegistry.has(commandType)) {
            const error = `Unknown command: ${commandType}`;
            this.messaging.sendMessage({ error }, requestId);
            return { error };
        }

        try {
            // Instantiate the command directly with messaging service
            const CommandClass = this.commandRegistry.get(commandType);
            const command = new CommandClass(this.messaging);
            
            // Set the message ID for proper response routing
            command.setMessageId(requestId);

            // Execute the command
            return await command.execute(message);
        } catch (err) {
            return this.errorHandler.handleCommandError(err, commandType, requestId);
        }
    }
}

module.exports = CommandRunner;
