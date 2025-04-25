/**
 * @ai-guide-component NativeHostService
 * @ai-guide-description Bridge between extension and native messaging host
 * @ai-guide-responsibilities
 * - Establishes and maintains connection with native host
 * - Handles message passing with installed native application
 * - Manages request/response communication pattern
 * - Implements error handling and recovery mechanisms
 * - Ensures proper initialization of native capabilities
 * - Provides platform-specific functionality to extension
 * - Validates host installation and compatibility
 */

// js/native-host-service.js

// NativeHostService - Consolidated native messaging service
export class NativeHostService {
    constructor() {
        this.port = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.listeners = new Map();
        this.hostName = 'com.mycompany.ffmpeg';
        this.RECONNECT_DELAY = 2000; // 2 seconds
        this.HEARTBEAT_INTERVAL = 15000; // 15 seconds - match native host
        
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
            
            // Set up message handler
            this.port.onMessage.addListener(this.handleMessage.bind(this));
            
            // Set up disconnect handler
            this.port.onDisconnect.addListener(() => {
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
            });
            
            // Start heartbeat
            this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.HEARTBEAT_INTERVAL);
            
            return true;
        } catch (error) {
            console.error('Failed to connect to native host:', error);
            return false;
        }
    }
    
    handleMessage(response) {
        console.log('Received native message:', response);
        
        // Check if this is a response to a specific message
        if (response && response.id && this.pendingMessages.has(response.id)) {
            const { resolve, reject, responseHandler } = this.pendingMessages.get(response.id);
            
            if (response.error) {
                // For error responses, notify both the promise and the response handler
                if (responseHandler) responseHandler(response);
                reject(new Error(response.error));
                this.pendingMessages.delete(response.id);
            } else if (response.type === 'progress') {
                // For progress updates, don't resolve the promise yet, just notify the handler
                if (responseHandler) responseHandler(response);
            } else {
                // For final responses, notify both and resolve
                if (responseHandler) responseHandler(response);
                resolve(response);
                this.pendingMessages.delete(response.id);
            }
            return;
        }
        
        // If it's a message without an ID or unknown ID
        console.log('Received message without matching ID:', response);
        
        // If it's a typed message, notify any listeners
        if (response && response.type) {
            const listeners = this.listeners.get(response.type) || [];
            for (const listener of listeners) {
                listener(response);
            }
        }
    }
    
    async sendMessage(message, responseHandler = null) {
        if (!this.port && !this.connect()) {
            throw new Error('Could not connect to native host');
        }
        
        return new Promise((resolve, reject) => {
            // Add message ID to track response
            const id = `msg_${++this.messageId}`;
            const messageWithId = { ...message, id };
            
            // Store promise callbacks and optional responseHandler
            this.pendingMessages.set(id, { resolve, reject, responseHandler });
            
            // Set timeout to auto-reject after 60 seconds unless it's a download operation
            // Downloads can take longer
            const timeout = (message.type === 'download') ? 3600000 : 60000;
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    const { reject } = this.pendingMessages.get(id);
                    this.pendingMessages.delete(id);
                    reject(new Error(`Message ${message.type} timed out after ${timeout/1000} seconds`));
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
    
    // Helper for heartbeat
    async sendHeartbeat() {
        try {
            const response = await this.sendMessage({ type: 'heartbeat' });
            if (!response?.alive) {
                console.error('Invalid heartbeat response');
                if (this.port) {
                    this.port.disconnect();
                }
            }
        } catch (error) {
            console.error('Heartbeat failed:', error);
            if (this.port) {
                this.port.disconnect();
            }
        }
    }
    
    // Subscribe to specific message types (like progress updates)
    subscribe(type, callback) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(callback);
        
        // Return unsubscribe function
        return () => {
            const listeners = this.listeners.get(type) || [];
            this.listeners.set(type, listeners.filter(cb => cb !== callback));
        };
    }
    
    /**
     * Legacy compatibility method mimicking chrome.runtime.sendNativeMessage
     * @param {string} hostName - Native host name
     * @param {Object} message - Message to send
     * @param {Function} callback - Callback for response
     */
    sendNativeMessage(hostName, message, callback) {
        if (hostName !== this.hostName) {
            console.error(`Attempted to send message to unknown host: ${hostName}`);
            if (callback) callback({ error: `Unknown host: ${hostName}` });
            return;
        }
        
        // For messages that expect streaming responses (like downloads),
        // we need to use a responseHandler
        const expectsStreaming = ['download', 'downloadHLS'].includes(message.type);
        
        if (expectsStreaming) {
            this.sendMessage(message, callback)
                .catch(error => callback({ error: error.message }));
        } else {
            this.sendMessage(message)
                .then(response => callback(response))
                .catch(error => callback({ error: error.message }));
        }
    }
}

// Create and export a singleton instance
const nativeHostService = new NativeHostService();
export default nativeHostService;
