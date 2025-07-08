// NativeHostService - Simplified native messaging transport
export class NativeHostService {
    constructor() {
        this.port = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
        this.eventListeners = new Map(); // For event-driven communication
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.hostName = 'com.mycompany.ffmpeg';
        this.RECONNECT_DELAY = 2000;
        this.HEARTBEAT_INTERVAL = 15000;
        
        this.connect();
    }
    
    connect() {
        try {
            if (this.port) {
                try { this.port.disconnect(); } catch (e) { console.warn("Error disconnecting port", e); }
            }
            
            // Clear timers
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            
            this.port = chrome.runtime.connectNative(this.hostName);
            console.log('Connected to native host:', this.hostName);
            
            this.port.onMessage.addListener(this.handleMessage.bind(this));
            this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

            this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.HEARTBEAT_INTERVAL);
            
            return true;
        } catch (error) {
            console.error('Failed to connect to native host:', error);
            return false;
        }
    }
    
    handleDisconnect() {
        const error = chrome.runtime.lastError;
        console.error('Native host disconnected:', error);
        this.port = null;
        
        // Reject all pending promises
        for (const [id, { reject }] of this.pendingMessages.entries()) {
            reject(new Error('Connection to native host lost'));
        }
        this.pendingMessages.clear();
        
        // Try to reconnect
        if (!this.reconnectTimer) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.connect();
            }, this.RECONNECT_DELAY);
        }
    }
    
    handleMessage(response) {
        console.log('Received native message:', response);
        
        // Handle event-driven messages (downloads and other events)
        if (response?.command && !response?.id) {
            // This is an event message, not a response to a promise-based request
            this.handleEventMessage(response);
            return;
        }
        
        // Route to pending message handler if it exists (promise-based)
        if (response?.id && this.pendingMessages.has(response.id)) {
            const { resolve, reject, callback } = this.pendingMessages.get(response.id);
            
            if (response.error) {
                // Handle communication/connection errors - these should reject the promise
                if (callback) callback(response);
                
                const errorMessage = typeof response.error === 'string' 
                    ? response.error 
                    : response.error.message || JSON.stringify(response.error);
                    
                reject(new Error(errorMessage));
                this.pendingMessages.delete(response.id);
            } else if (response.success !== undefined) {
                // All final responses (success or failure) resolve the promise
                if (callback) callback(response);
                resolve(response);
                this.pendingMessages.delete(response.id);
            } else {
                // Intermediate response (like progress) - only notify callback
                if (callback) callback(response);
            }
            return;
        }
        
        // Log unhandled messages for debugging
        console.warn('Received message without matching pending request:', response);
    }
    
    /**
     * Handle event-driven messages (downloads, progress, etc.)
     * @param {Object} event - Event message from native host
     */
    handleEventMessage(event) {
        const { command, sessionId } = event;
        
        // Route to registered event listeners
        if (this.eventListeners.has(command)) {
            const listeners = this.eventListeners.get(command);
            listeners.forEach(listener => {
                try {
                    listener(event);
                } catch (error) {
                    console.error(`Error in event listener for ${command}:`, error);
                }
            });
        } else {
            console.warn(`No event listeners registered for command: ${command}`);
        }
    }
    
    /**
     * Register an event listener for a specific command
     * @param {string} command - Command to listen for
     * @param {Function} listener - Callback function
     */
    addEventListener(command, listener) {
        if (!this.eventListeners.has(command)) {
            this.eventListeners.set(command, new Set());
        }
        this.eventListeners.get(command).add(listener);
    }
    
    /**
     * Remove an event listener
     * @param {string} command - Command to remove listener from
     * @param {Function} listener - Callback function to remove
     */
    removeEventListener(command, listener) {
        if (this.eventListeners.has(command)) {
            this.eventListeners.get(command).delete(listener);
        }
    }
    
    async sendMessage(message, options = {}) {
        const { expectResponse = true, progressCallback = null } = options;
        
        if (!expectResponse) {
            // Fire-and-forget message
            this.sendFireAndForget(message);
            return;
        }
        
        // Promise-based message with optional progress callback
        if (!this.port && !this.connect()) {
            throw new Error('Could not connect to native host');
        }
        
        return new Promise((resolve, reject) => {
            const id = `msg_${++this.messageId}`;
            const messageWithId = { ...message, id };
            
            // Store promise callbacks and optional progress callback
            this.pendingMessages.set(id, { 
                resolve, 
                reject, 
                callback: progressCallback,
                timestamp: Date.now()
            });
            
            // Set timeout based on command type
            const isLongRunning = ['download'].includes(message.command);
            const timeout = isLongRunning ? 3600000 : 30000; // 1 hour vs 30 seconds
            
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    const { reject } = this.pendingMessages.get(id);
                    this.pendingMessages.delete(id);
                    reject(new Error(`Message ${message.command} timed out after ${timeout/1000}s`));
                }
            }, timeout);
            
            // Send the message
            try {
                this.port.postMessage(messageWithId);
            } catch (error) {
                this.pendingMessages.delete(id);
                reject(error);
                
                // Try to reconnect on send error
                if (error.message.includes('port closed') || !this.port) {
                    this.connect();
                }
            }
        });
    }
    
    /**
     * Send a fire-and-forget message (no response expected)
     * @param {Object} message - Message to send
     */
    sendFireAndForget(message) {
        if (!this.port && !this.connect()) {
            console.error('Could not connect to native host for message:', message.command);
            return;
        }
        
        try {
            this.port.postMessage(message);
            console.log('Sent fire-and-forget message:', message.command, message);
        } catch (error) {
            console.error('Failed to send fire-and-forget message:', error);
            
            // Try to reconnect on send error
            if (error.message.includes('port closed') || !this.port) {
                this.connect();
            }
        }
    }
    
    async sendHeartbeat() {
        try {
            const response = await this.sendMessage({ command: 'heartbeat' });
            if (!response?.alive) {
                console.error('Invalid heartbeat response, disconnecting');
                if (this.port) this.port.disconnect();
            }
        } catch (error) {
            console.error('Heartbeat failed:', error);
            if (this.port) this.port.disconnect();
        }
    }
    
    // Clean up resources
    disconnect() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.port) this.port.disconnect();
        
        // Reject any pending messages
        for (const [id, { reject }] of this.pendingMessages.entries()) {
            reject(new Error('Service disconnected'));
        }
        this.pendingMessages.clear();
        
        // Clear event listeners
        this.eventListeners.clear();
    }
}

// Create and export a singleton instance
const nativeHostService = new NativeHostService();
export default nativeHostService;