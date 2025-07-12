/**
 * NativeMessaging – Handles Chrome native messaging protocol implementation
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
        
        // Enhanced error handling for stdin
        process.stdin.on('error', (err) => {
            logDebug(`STDIN ERROR: ${err.code} - ${err.message}`);
            process.exit(1);
        });
        
        process.stdin.on('end', () => {
            logDebug('STDIN ended - extension disconnected');
            process.exit(0);
        });
        
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
        
        // Process messages immediately when we have complete message(s)
        this.processMessages();
    }

    /**
     * Process complete messages from the buffer
     */
    processMessages() {
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            
            // Check if we have the complete message
            if (this.buffer.length < length + 4) {
                logDebug(`Incomplete message: need ${length + 4} bytes, have ${this.buffer.length}`);
                break;
            }
            
            const message = this.buffer.slice(4, length + 4);
            this.buffer = this.buffer.slice(length + 4);
            
            try {
                const request = JSON.parse(message);
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
                logDebug('Error parsing message:', err.message);
                logDebug('Message content:', message.toString('utf8'));
                this.sendMessage({ error: 'Invalid message format' });
            }
        }
    }

    /**
     * Send a message back to the extension
     * @param {Object} message The message to send
     * @param {string} requestId Optional ID to include in response for request tracking
     */
    sendMessage(message, requestId = null) {
        // Prevent writes if pipe is already closed
        if (this.pipeClosed) {
            return;
        }
        
        try {
            // Add ID to response if this is a reply to a specific request
            const messageWithId = requestId ? { ...message, id: requestId } : message;
            
            const messageStr = JSON.stringify(messageWithId);
            const messageBuffer = Buffer.from(messageStr, 'utf8');
            const header = Buffer.alloc(4);
            header.writeUInt32LE(messageBuffer.length, 0);
            
            // Write as a single operation to avoid interleaved writes
            try {
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
     * Send an event message (fire-and-forget, no request ID)
     * @param {Object} message The event message to send
     */
    sendEvent(message) {
        this.sendMessage(message, null);
    }

    /**
     * Monitor heartbeat and exit if no heartbeat received
     */
    startHeartbeatMonitor() {
        setInterval(() => {
            const now = Date.now();
            const timeSinceHeartbeat = now - this.lastHeartbeatTime;
            
            // Exit if no heartbeat received for 3x the interval (45 seconds)
            if (timeSinceHeartbeat > this.HEARTBEAT_INTERVAL * 3) {
                logDebug(`No heartbeat received for ${timeSinceHeartbeat}ms, exiting...`);
                process.exit(1);
            }
        }, this.HEARTBEAT_INTERVAL);
    }
}

module.exports = MessagingService;
