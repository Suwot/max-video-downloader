// lib/messaging.js
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
    }

    /**
     * Initialize the messaging service
     * @param {Function} messageHandler Function to handle parsed messages
     */
    initialize(messageHandler) {
        this.messageHandler = messageHandler;
        
        // Set up stdin data handler
        process.stdin.on('data', (data) => this.handleIncomingData(data));
        
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
        try {
            // Add ID to response if this is a reply to a specific request
            const responseWithId = requestId ? { ...message, id: requestId } : message;
            
            // Only rate limit progress messages
            const now = Date.now();
            if (responseWithId.type === 'progress' && now - this.lastResponseTime < this.MIN_RESPONSE_INTERVAL) {
                return;
            }
            this.lastResponseTime = now;
            
            const messageStr = JSON.stringify(responseWithId);
            const header = Buffer.alloc(4);
            header.writeUInt32LE(messageStr.length, 0);
            
            // Wrap in try-catch to handle potential write errors
            try {
                // Write as a single operation to avoid interleaved writes
                const combined = Buffer.concat([header, Buffer.from(messageStr)]);
                process.stdout.write(combined);
            } catch (writeErr) {
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
