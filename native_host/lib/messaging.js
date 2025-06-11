/**
 * @ai-guide-component NativeMessaging
 * @ai-guide-description Handles Chrome native messaging protocol implementation
 * @ai-guide-responsibilities
 * - Implements Chrome's native messaging protocol (read/write messages)
 * - Handles message size limits and multi-part messages if needed
 * - Manages serialization/deserialization of messages
 * - Provides error handling for corrupted messages
 * - Supports both synchronous and asynchronous communication patterns
 */

const { logDebug } = require('../utils/logger');

/**
 * Handles the native messaging protocol between the extension and native host
 */
class MessagingService {
    constructor() {
        this.buffer = Buffer.alloc(0);
        this.processedMessages = new Set();
        this.messageTimeout = null;
        this.lastResponseTime = 0;
        this.MIN_RESPONSE_INTERVAL = 250; // Minimum 250ms between progress messages
        this.lastHeartbeatTime = Date.now();
        this.HEARTBEAT_INTERVAL = 15000; // 15 seconds
        this.pipeClosed = false; // Track if pipe is closed
    }

    /**
     * Initialize the messaging service
     * @param {Function} messageHandler Function to handle parsed messages
     */
    initialize(messageHandler) {
        this.messageHandler = messageHandler;
        
        // Set up stdin data handler
        process.stdin.on('data', (data) => this.handleIncomingData(data));
        
        // Enhanced error handling for stdout
        process.stdout.on('error', (err) => {
            this.pipeClosed = true;
            logDebug(`STDOUT ERROR: ${err.code} - ${err.message}`);
            
            if (err.code === 'EPIPE') {
                logDebug('SIGPIPE: stdout closed unexpectedly');
                
                // Exit gracefully after a short delay
                setTimeout(() => process.exit(0), 250);
            }
        });
        
        // Set up heartbeat monitoring
        this.startHeartbeatMonitor();
        
        logDebug('Messaging service initialized');
    }

    /**
     * Handle incoming data from stdin
     */
    handleIncomingData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        
        // Clear any existing timeout
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
        }
        
        // Set a new timeout to process messages
        this.messageTimeout = setTimeout(() => {
            this.processMessages();
        }, 50); // Wait 50ms to collect all message parts
    }

    /**
     * Process complete messages from the buffer
     */
    processMessages() {
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (this.buffer.length < length + 4) break;
            
            const message = this.buffer.slice(4, length + 4);
            this.buffer = this.buffer.slice(length + 4);
            
            try {
                const request = JSON.parse(message);
                const messageId = JSON.stringify(request); // Use the message content as ID
                
                // Skip if we've already processed this message
                if (this.processedMessages.has(messageId)) {
                    continue;
                }
                
                // Add to processed messages
                this.processedMessages.add(messageId);
                
                // Clear old messages after 1 second
                setTimeout(() => {
                    this.processedMessages.delete(messageId);
                }, 1000);
                
                logDebug('Processing message:', request);
                
                // Update heartbeat time for any message
                this.lastHeartbeatTime = Date.now();
                
                // Store message ID for responses
                const requestId = request.id;
                
                // Pass message to handler
                if (this.messageHandler) {
                    this.messageHandler(request, requestId);
                }
            } catch (err) {
                logDebug('Error parsing message:', err);
                this.sendResponse({ error: 'Invalid message format' });
            }
        }
    }

    /**
     * Send a response back to the extension
     * @param {Object} message The response message to send
     * @param {string} requestId Optional ID to include in response for request tracking
     */
    sendResponse(message, requestId = null) {
        // Prevent writes if pipe is already closed
        if (this.pipeClosed) {
            return;
        }
        
        try {
            // Add ID to response if this is a reply to a specific request
            const responseWithId = requestId ? { ...message, id: requestId } : message;
            
            // Only rate limit progress messages
            const now = Date.now();
            if (responseWithId.command === 'progress' && now - this.lastResponseTime < this.MIN_RESPONSE_INTERVAL) {
                // For progress messages, only drop if very recent to avoid flooding
                // But ensure significant changes always go through
                const lastProgress = this.lastProgressSent || 0;
                const currentProgress = responseWithId.progress || 0;
                
                // Always send if it's a significant change or at key milestones
                if (Math.abs(currentProgress - lastProgress) >= 5 || 
                    currentProgress % 10 === 0 ||
                    currentProgress === 100) {
                    // Important update - send it anyway
                    logDebug(`Sending priority progress update: ${currentProgress}%`);
                } else {
                    // Otherwise, respect rate limiting
                    return;
                }
            }
            
            // Update last progress sent if this is a progress message
            if (responseWithId.command === 'progress') {
                this.lastProgressSent = responseWithId.progress || 0;
            }
            
            this.lastResponseTime = now;
            
            const messageStr = JSON.stringify(responseWithId);
            const messageBuffer = Buffer.from(messageStr, 'utf8'); // Explicitly use UTF-8 encoding
            const header = Buffer.alloc(4);
            header.writeUInt32LE(messageBuffer.length, 0);
            
            // Wrap in try-catch to handle potential write errors
            try {
                // Write as a single operation to avoid interleaved writes
                const combined = Buffer.concat([header, messageBuffer]);
                process.stdout.write(combined);
            } catch (writeErr) {
                if (writeErr.code === 'EPIPE') {
                    this.pipeClosed = true;
                    logDebug('Pipe closed by Chrome extension. Halting writes.');
                    
                    // Exit gracefully after a short delay
                    setTimeout(() => process.exit(0), 250);
                    return;
                }
                logDebug('Error writing to stdout:', writeErr);
            }
        } catch (err) {
            logDebug('Error preparing response:', err);
        }
    }

    /**
     * Monitor heartbeat and exit if no heartbeat received
     */
    startHeartbeatMonitor() {
        setInterval(() => {
            const now = Date.now();
            if (now - this.lastHeartbeatTime > this.HEARTBEAT_INTERVAL * 2) {
                logDebug('No heartbeat received for too long, exiting...');
                process.exit(1);
            }
        }, this.HEARTBEAT_INTERVAL);
    }
}

module.exports = MessagingService;
