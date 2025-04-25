/**
 * @ai-guide-component CommandRegistry
 * @ai-guide-description Command registration and management system
 * @ai-guide-responsibilities
 * - Maintains registry of available command implementations
 * - Maps command types to their handler classes
 * - Provides lookup mechanism for command resolution
 * - Ensures consistent command initialization
 * - Centralizes command registration logic
 * - Allows dynamic command discovery and instantiation
 */

// commands/index.js
const { logDebug } = require('../utils/logger');

/**
 * Registry for command implementations
 */
class CommandRegistry {
    constructor() {
        this.commands = new Map();
    }

    /**
     * Register a command handler for a specific message type
     */
    registerCommand(commandType, CommandClass) {
        this.commands.set(commandType, CommandClass);
        logDebug(`Registered command in registry: ${commandType}`);
    }

    /**
     * Get a command implementation for a specific message type
     */
    getCommand(commandType) {
        return this.commands.get(commandType);
    }

    /**
     * Check if a command type is registered
     */
    hasCommand(commandType) {
        return this.commands.has(commandType);
    }

    /**
     * Get all registered command types
     */
    getRegisteredCommands() {
        return Array.from(this.commands.keys());
    }
}

module.exports = new CommandRegistry();
