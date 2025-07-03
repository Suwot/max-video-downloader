// NativeHostService - Simplified native messaging transport
export class NativeHostService {
    constructor() {
        this.port = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
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
        
        // Route to pending message handler if it exists
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
    
    async sendMessage(message, progressCallback = null) {
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
    }
}

// Create and export a singleton instance
const nativeHostService = new NativeHostService();
export default nativeHostService;