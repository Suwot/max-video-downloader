#!/usr/bin/env node
/**
 * @ai-guide-component NativeHostMain
 * @ai-guide-description Main entry point for the native host application
 * @ai-guide-responsibilities
 * - Initializes the native messaging host environment
 * - Establishes connection with Chrome extension
 * - Sets up command handling and execution pipeline
 * - Coordinates services and dependency injection
 * - Manages application lifecycle and error handling
 * - Bridges browser extension with system capabilities
 */

// Main entry point for the native host application

const fs = require('fs');
const path = require('path');
const os = require('os');

// Import core modules
const MessagingService = require('./lib/messaging');
const ErrorHandler = require('./lib/error-handler');
const CommandRunner = require('./lib/command-runner');
const { logDebug } = require('./utils/logger');
const servicesManager = require('./services');

// Import command registry and commands
const commandRegistry = require('./commands');
const DownloadCommand = require('./commands/download');
const GetQualitiesCommand = require('./commands/get-qualities');
const GeneratePreviewCommand = require('./commands/generate-preview');
const HeartbeatCommand = require('./commands/heartbeat');

/**
 * Application bootstrap
 */
async function bootstrap() {
    try {
        logDebug('Starting native host application');
        
        // Initialize services first
        logDebug('Initializing services...');
        if (!await servicesManager.initialize()) {
            logDebug('Failed to initialize services');
            process.exit(1);
        }
        
        // Create and configure components
        logDebug('Creating application components...');
        
        // 1. Create messaging service
        const messagingService = new MessagingService();
        
        // 2. Create error handler with messaging service
        const errorHandler = new ErrorHandler(messagingService);
        
        // 3. Create command runner
        const commandRunner = new CommandRunner(messagingService, errorHandler);
        
        // 4. Register all commands with registry and command runner
        registerCommands(commandRunner, commandRegistry);
        
        // 5. Initialize messaging with message handler function
        messagingService.initialize((request) => {
            processMessage(request, commandRunner).catch(err => {
                logDebug('Error in message processing:', err);
                messagingService.sendResponse({ error: err.message });
            });
        });
        
        logDebug('Native host application started successfully');
    } catch (err) {
        logDebug('Bootstrap error:', err);
        console.error('Failed to start application:', err);
        process.exit(1);
    }
}

/**
 * Register all command types with the command runner
 */
function registerCommands(commandRunner, registry) {
    // Register commands with registry
    registry.registerCommand('download', DownloadCommand);
    registry.registerCommand('getQualities', GetQualitiesCommand);
    registry.registerCommand('generatePreview', GeneratePreviewCommand);
    registry.registerCommand('heartbeat', HeartbeatCommand);
    
    // Register the same commands with the command runner
    commandRunner.registerCommand('download', DownloadCommand);
    commandRunner.registerCommand('getQualities', GetQualitiesCommand);
    commandRunner.registerCommand('generatePreview', GeneratePreviewCommand);
    commandRunner.registerCommand('heartbeat', HeartbeatCommand);
    
    logDebug('All commands registered');
}

/**
 * Process incoming messages and route to appropriate command
 */
async function processMessage(request, commandRunner) {
    const requestId = request.id;
    logDebug('Processing message:', request, 'ID:', requestId);
    
    // Command type is in the request.type field
    const commandType = request.type;
    
    // Execute the command through the command runner, passing the request ID
    return await commandRunner.executeCommand(request, requestId);
}

// Start the application
bootstrap();
