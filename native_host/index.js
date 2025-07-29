#!/usr/bin/env node
/**
 * NativeHostMain – Main entry point for the native host application
 * - Initializes the native messaging host environment
 * - Establishes connection with Chrome extension
 * - Sets up command handling and execution pipeline
 * - Coordinates services and dependency injection
 * - Manages application lifecycle and error handling
 * - Bridges browser extension with system capabilities
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Import core modules
const MessagingService = require('./lib/messaging');
const ErrorHandler = require('./lib/error-handler');
const CommandRunner = require('./lib/command-runner');
const { logDebug } = require('./utils/logger');

// Handle CLI commands before Chrome messaging setup
const args = process.argv.slice(2);

if (args.includes('-version')) {
    const pkg = require('./package.json');
    console.log(`Native Host v${pkg.version}`);
    process.exit(0);
}

if (args.includes('-install')) {
    // For built binaries, implement install directly
    if (typeof process.pkg !== 'undefined') {
        console.log('Install functionality will be implemented in the app bundle');
        console.log('For now, use: ./build.sh -install from the source directory');
    } else {
        // Development mode - use build script
        const { execSync } = require('child_process');
        try {
            execSync('./build.sh -install', { stdio: 'inherit' });
        } catch (err) {
            console.error('Installation failed:', err.message);
            process.exit(1);
        }
    }
    process.exit(0);
}

if (args.includes('-uninstall')) {
    // For built binaries, implement uninstall directly
    if (typeof process.pkg !== 'undefined') {
        console.log('Uninstall functionality will be implemented in the app bundle');
        console.log('For now, use: ./build.sh -uninstall from the source directory');
    } else {
        // Development mode - use build script
        const { execSync } = require('child_process');
        try {
            execSync('./build.sh -uninstall', { stdio: 'inherit' });
        } catch (err) {
            console.error('Uninstallation failed:', err.message);
            process.exit(1);
        }
    }
    process.exit(0);
}
const servicesManager = require('./services');

// Import command registry and commands
const DownloadCommand = require('./commands/download');
const GetQualitiesCommand = require('./commands/get-qualities');
const GeneratePreviewCommand = require('./commands/generate-preview');
const HeartbeatCommand = require('./commands/heartbeat');
const FileSystemCommand = require('./commands/file-system');

// Operation-based keep-alive management
let activeOperations = 0;
let idleTimer = null;
const IDLE_TIMEOUT = 60000; // 60 seconds idle timeout (only when no active operations)

function incrementOperations() {
    activeOperations++;
    logDebug(`Active operations: ${activeOperations} (incremented)`);
    clearIdleTimer();
}

function decrementOperations() {
    activeOperations = Math.max(0, activeOperations - 1);
    logDebug(`Active operations: ${activeOperations} (decremented)`);
    if (activeOperations === 0) {
        startIdleTimer();
    }
}

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function startIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        if (activeOperations === 0) {
            logDebug('Native host idle timeout - no active operations, exiting gracefully');
            process.exit(0);
        }
    }, IDLE_TIMEOUT);
}

function resetIdleTimer() {
    // For backwards compatibility with messaging service
    if (activeOperations === 0) {
        startIdleTimer();
    }
}

function handleGracefulShutdown() {
    logDebug(`Extension disconnected. Active operations: ${activeOperations}`);
    logDebug('Extension hibernation detected - operations will continue, idle timer will handle shutdown');
    // Don't do anything - let the normal operation counter and idle timer handle lifecycle
    // If there are active operations, they'll prevent the idle timer from running
    // If there are no active operations, the idle timer will naturally exit after 60 seconds
}

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
        
        // 4. Register all commands with command runner
        registerCommands(commandRunner);
        
        // 5. Initialize messaging with message handler function and shutdown handler
        messagingService.initialize(
            (request) => {
                processMessage(request, commandRunner).catch(err => {
                    logDebug('Error in message processing:', err.message || err);
                    messagingService.sendMessage({ error: err.message || 'Unknown error' }, request.id);
                });
            },
            handleGracefulShutdown
        );
        
        // Pass resetIdleTimer function to messaging service for direct calls
        messagingService.setIdleTimerReset(resetIdleTimer);
        
        // Start idle timer (no active operations initially)
        startIdleTimer();
        
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
function registerCommands(commandRunner) {
    // Register commands with command runner only
    commandRunner.registerCommand('download', DownloadCommand);
    commandRunner.registerCommand('cancel-download', DownloadCommand);
    commandRunner.registerCommand('getQualities', GetQualitiesCommand);
    commandRunner.registerCommand('generatePreview', GeneratePreviewCommand);
    commandRunner.registerCommand('heartbeat', HeartbeatCommand);
    commandRunner.registerCommand('fileSystem', FileSystemCommand);
    commandRunner.registerCommand('quit', {
        execute: async (params, requestId, messagingService) => {
            logDebug('Received quit command - exiting gracefully');
            messagingService.sendMessage({ success: true, message: 'Shutting down' }, requestId);
            process.exit(0);
        }
    });
    
    logDebug('All commands registered with CommandRunner');
}

/**
 * Process incoming messages and route to appropriate command
 */
async function processMessage(request, commandRunner) {
    const requestId = request.id;
    const commandType = request.command;
    
    // Track long-running operations
    const isLongRunningOperation = ['download', 'getQualities', 'generatePreview'].includes(commandType);
    
    if (isLongRunningOperation) {
        incrementOperations();
    }
    
    try {
        // Execute the command through the command runner, passing the request ID
        const result = await commandRunner.executeCommand(request, requestId);
        return result;
    } finally {
        if (isLongRunningOperation) {
            decrementOperations();
        }
    }
}

// Start the application
bootstrap();

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logDebug('Uncaught exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logDebug('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Handle process signals
process.on('SIGINT', () => {
    logDebug('Received SIGINT, exiting gracefully');
    if (idleTimer) clearTimeout(idleTimer);
    process.exit(0);
});

process.on('SIGTERM', () => {
    logDebug('Received SIGTERM, exiting gracefully');
    if (idleTimer) clearTimeout(idleTimer);
    process.exit(0);
});
