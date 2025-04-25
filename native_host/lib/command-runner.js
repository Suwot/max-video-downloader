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
     */
    async executeCommand(message) {
        const commandType = message.type;
        
        logDebug(`Executing command: ${commandType}`);
        
        if (!this.commandRegistry.has(commandType)) {
            const error = `Unknown command type: ${commandType}`;
            this.messaging.sendResponse({ error });
            return { error };
        }

        try {
            // Instantiate the command
            const CommandClass = this.commandRegistry.get(commandType);
            const command = new CommandClass(this.messaging);

            // Execute the command
            return await command.execute(message);
        } catch (err) {
            return this.errorHandler.handleCommandError(err, commandType);
        }
    }
}

module.exports = CommandRunner;
