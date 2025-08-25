// NativeHostService - Simplified native messaging transport
export class NativeHostService {
    constructor() {
        this.port = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
        this.eventListeners = new Map(); // For event-driven communication
        this.reconnectTimer = null;
        this.hostName = 'pro.maxvideodownloader.coapp';
        this.RECONNECT_DELAY = 2000;
        
        // Connection state management
        this.connectionState = 'disconnected'; // disconnected, connecting, connected, validating, error
        this.connectionInfo = null;
        this.lastConnectionAttempt = null;
        this.connectionError = null;
        this.connectionTimeout = null;
        // No connection timeout - let native host manage its own lifecycle
    }
    
    connect() {
        try {
            this.connectionState = 'connecting';
            this.lastConnectionAttempt = Date.now();
            this.connectionError = null;
            this.broadcastConnectionState();
            
            if (this.port) {
                try { this.port.disconnect(); } catch (e) { console.warn("Error disconnecting port", e); }
            }
            
            // Clear timers
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            
            this.port = chrome.runtime.connectNative(this.hostName);
            console.log('Connected to native host:', this.hostName);
            
            this.port.onMessage.addListener(this.handleMessage.bind(this));
            this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

            // Validate connection immediately after connecting
            this.validateConnection();
            
            return true;
        } catch (error) {
            console.error('Failed to connect to native host:', error);
            this.connectionState = 'error';
            this.connectionError = error.message || 'Connection failed';
            // Clear connectionInfo on connection failure (coapp not found)
            this.connectionInfo = null;
            this.broadcastConnectionState();
            return false;
        }
    }
    
    handleDisconnect() {
        const error = chrome.runtime.lastError;
        if (error) {
            console.warn('Native host disconnected with error:', error);
        } else {
            console.log('Native host disconnected gracefully');
        }

        // Clean up port reference
        if (this.port) {
            try {
                this.port.disconnect();
            } catch (e) {
                // Port might already be closed
            }
            this.port = null;
        }
        
        this.connectionState = 'disconnected';
        // Preserve connectionInfo for "found but disconnected" state
        this.connectionError = error?.message || 'Connection lost';
        this.broadcastConnectionState();
        
        // Clear connection timeout
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        
        // Reject all pending promises
        for (const [id, { reject }] of this.pendingMessages.entries()) {
            reject(new Error('Connection to native host lost'));
        }
        this.pendingMessages.clear();
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
        const { command } = event;
        
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
        await this.ensureConnection();
        
        if (!this.port) {
            chrome.storage.session.set({ coappAvailable: false });
            throw new Error('Could not connect to native host');
        }
        
        return new Promise((resolve, reject) => {
            const messageId = `msg_${++this.messageId}`;
            const messageWithId = { ...message, id: messageId };
            
            // Store promise callbacks and optional progress callback
            this.pendingMessages.set(messageId, { 
                resolve, 
                reject, 
                callback: progressCallback,
                timestamp: Date.now()
            });

            // Safety net timeouts (much longer than native host timeouts)
            let timeout;
            if (message.command === 'download') {
                timeout = 3600000 * 12; // 12 hours for downloads
            } else if (message.command === 'fileSystem') {
                timeout = 300000; // 5 minutes for file dialogs (user might leave dialog open)
            } else {
                timeout = 60000; // 1 minute for other operations (validation, etc.)
            }

            setTimeout(() => {
                if (this.pendingMessages.has(messageId)) {
                    const { reject } = this.pendingMessages.get(messageId);
                    this.pendingMessages.delete(messageId);
                    reject(new Error(`Message ${message.command} timed out after ${timeout/1000}s`));
                }
            }, timeout);
            
            // Send the message
            try {
                this.port.postMessage(messageWithId);
            } catch (error) {
                this.pendingMessages.delete(messageId);
                
                // Handle port closed errors by triggering disconnect
                if (error.message.includes('port closed') || error.message.includes('disconnected')) {
                    this.handleDisconnect();
                }
                
                reject(error);
            }
        });
    }
    
    // Send a fire-and-forget message (no response expected)
    async sendFireAndForget(message) {
        await this.ensureConnection();
        
        if (!this.port) {
            console.error('Could not connect to native host for message:', message.command);
            return;
        }
        
        try {
            this.port.postMessage(message);
            console.log('Sent fire-and-forget message:', message.command, message);
        } catch (error) {
            console.error('Failed to send fire-and-forget message:', error);
            
            // Handle port closed errors by triggering disconnect
            if (error.message.includes('port closed') || error.message.includes('disconnected')) {
                this.handleDisconnect();
            }
        }
    }
    

    
    // Ensure connection is established (on-demand pattern)
    async ensureConnection() {
        if (this.connectionState === 'connected' && this.port) {
            this.resetConnectionTimeout();
            return true;
        }
        
        if (this.connectionState === 'connecting' || this.connectionState === 'validating') {
            // Wait for current connection attempt
            return new Promise((resolve) => {
                const checkConnection = () => {
                    if (this.connectionState === 'connected') {
                        resolve(true);
                    } else if (this.connectionState === 'error' || this.connectionState === 'disconnected') {
                        resolve(false);
                    } else {
                        setTimeout(checkConnection, 100);
                    }
                };
                checkConnection();
            });
        }
        
        return this.connect();
    }
    
    // Reset connection timeout (no-op - native host manages its own lifecycle)
    resetConnectionTimeout() {
        // Clear any existing timeout but don't set a new one
        // Let the native host manage its own lifecycle based on active operations
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }



    // Validate connection by sending heartbeat
    async validateConnection() {
        this.connectionState = 'validating';
        this.broadcastConnectionState();
        
        try {
            // Use direct port message to avoid recursion
            const response = await new Promise((resolve, reject) => {
                const messageId = `msg_${++this.messageId}`;
                const messageWithId = { command: 'validateConnection', id: messageId };
                
                this.pendingMessages.set(messageId, { 
                    resolve, 
                    reject, 
                    callback: null,
                    timestamp: Date.now()
                });
                
                setTimeout(() => {
                    if (this.pendingMessages.has(messageId)) {
                        this.pendingMessages.delete(messageId);
                        reject(new Error('Connection validation timeout'));
                    }
                }, 5000);
                
                this.port.postMessage(messageWithId);
            });
            
            if (response?.success && response?.alive) {
                this.connectionState = 'connected';
                this.connectionInfo = {
                    alive: response.alive,
                    lastValidation: Date.now(),
                    version: response.version,
                    location: response.location,
                    ffmpegVersion: response.ffmpegVersion
                };
                this.connectionError = null;
                
                // Update session state: coapp is available
                chrome.storage.session.set({ coappAvailable: true });
                
                // Connection validated - start idle timeout
                this.resetConnectionTimeout();
            } else {
                this.connectionState = 'error';
                this.connectionError = 'Invalid connection validation response';
                // Don't clear connectionInfo - we got a response, so coapp exists
                chrome.storage.session.set({ coappAvailable: false });
            }
        } catch (error) {
            this.connectionState = 'error';
            this.connectionError = error.message || 'Validation failed';
            // Clear connectionInfo on validation failure (coapp not responding properly)
            this.connectionInfo = null;
            chrome.storage.session.set({ coappAvailable: false });
        }
        
        this.broadcastConnectionState();
    }
    
    // Get current connection state and info
    getConnectionState() {
        return {
            state: this.connectionState,
            info: this.connectionInfo,
            error: this.connectionError,
            lastAttempt: this.lastConnectionAttempt
        };
    }
    

    
    // Manually reconnect (for UI button)
    async reconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        return this.connect();
    }
    
    // Set broadcast function (called from popup-communication.js to avoid circular dependency)
    setBroadcastFunction(broadcastFn) {
        this.broadcastFn = broadcastFn;
    }
    
    // Broadcast connection state to all popup instances
    broadcastConnectionState() {
        if (this.broadcastFn) {
            try {
                this.broadcastFn({
                    command: 'nativeHostConnectionState',
                    connectionState: this.getConnectionState()
                });
            } catch (err) {
                console.warn('Failed to broadcast connection state:', err);
            }
        }
    }

    // Clean up resources
    disconnect() {
        this.connectionState = 'disconnected';
        // Preserve connectionInfo - this is a manual disconnect, not "not found"
        
        if (this.validationTimer) {
            clearInterval(this.validationTimer);
            this.validationTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.port) {
            this.port.disconnect();
            this.port = null;
        }
        
        // Reject any pending messages
        for (const [id, { reject }] of this.pendingMessages.entries()) {
            reject(new Error('Service disconnected'));
        }
        this.pendingMessages.clear();
        
        // Clear event listeners
        this.eventListeners.clear();
        
        this.broadcastConnectionState();
    }
}

// Create and export a singleton instance
const nativeHostService = new NativeHostService();
export default nativeHostService;