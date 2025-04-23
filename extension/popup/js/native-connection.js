/**
 * Native connection manager for handling communication with native host
 */
export class NativeConnection {
    constructor() {
        this.port = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectCount = 0;
        this.maxReconnects = 5;
        this.reconnectDelay = 1000; // 1 second
        this.callbacks = new Map();
        this.eventListeners = new Map();
        this.messageCounter = 0;
        this.debug = true; // Enable debugging
        
        // Track last successful message time
        this.lastSuccessfulMessage = Date.now();
        
        // Ping interval to keep connection alive
        this.pingInterval = setInterval(() => this.pingHost(), 30000);
        
        // Bind methods to maintain proper 'this' context
        this.handleMessage = this.handleMessage.bind(this);
        this.handleDisconnect = this.handleDisconnect.bind(this);
    }

    /**
     * Log debug message to console
     * @param {...any} args - Log arguments
     */
    log(...args) {
        if (this.debug) {
            console.log('[NativeConnection]', ...args);
        }
    }

    /**
     * Log error message to console
     * @param {...any} args - Log arguments
     */
    logError(...args) {
        if (this.debug) {
            console.error('[NativeConnection]', ...args);
        }
    }

    /**
     * Connect to the native host
     * @returns {Promise<boolean>} Connection success
     */
    async connect() {
        this.log('Connecting to native host');
        if (this.connected) {
            this.log('Already connected');
            return true;
        }
        
        if (this.connecting) {
            this.log('Connection in progress, waiting');
            return new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (!this.connecting) {
                        clearInterval(checkInterval);
                        resolve(this.connected);
                    }
                }, 100);
            });
        }
        
        this.connecting = true;
        
        try {
            this.log('Creating connection to com.videodownloader.app');
            this.port = chrome.runtime.connectNative('com.videodownloader.app');
            
            this.port.onMessage.addListener(this.handleMessage);
            this.port.onDisconnect.addListener(this.handleDisconnect);
            
            // Send a ping to verify connection is working directly, without using sendMessage
            this.log('Sending ping to verify connection');
            
            const pingId = `ping_${Date.now()}_${Math.random().toString(36).substring(2)}`;
            this.port.postMessage({type:'ping', id: pingId});
            const response = await new Promise((res, rej) => {
                const onMsg = m => {
                    this.log('Received ping response:', m);
                    // Accept the actual response format from native host
                    if (m.type === 'pong' && m.nativeHostConnected === true) {
                        this.port.onMessage.removeListener(onMsg);
                        res(m);
                    }
                };
                this.port.onMessage.addListener(onMsg);
                setTimeout(() => { 
                    this.port.onMessage.removeListener(onMsg);
                    rej(new Error('Ping timeout'));
                }, 2000);
            });
            
            if (response) {
                this.log('Connection verified successfully');
                this.connected = true;
                this.connecting = false;
                this.reconnectCount = 0;
                return true;
            }
            
            this.logError('Failed to verify connection');
            throw new Error('Failed to verify native host connection');
        } catch (error) {
            this.logError('Native connection error:', error);
            this.connected = false;
            this.connecting = false;
            
            if (this.port) {
                try {
                    this.port.disconnect();
                } catch (e) {
                    // Ignore disconnect errors
                    this.log('Error during port disconnect:', e);
                }
                this.port = null;
            }
            
            return false;
        }
    }

    /**
     * Handle disconnection from the native host
     * @param {Object} port - Disconnected port
     */
    async handleDisconnect(port) {
        this.log('Native host disconnected');
        
        const error = chrome.runtime.lastError;
        if (error) {
            this.logError('Disconnect error:', error);
        }
        
        this.connected = false;
        this.port = null;
        
        // Clear the ping interval to prevent multiple intervals
        clearInterval(this.pingInterval);
        
        // Reject all pending callbacks
        this.callbacks.forEach((callback, id) => {
            if (callback.reject) {
                callback.reject(new Error('Native host disconnected'));
            }
        });
        this.callbacks.clear();
        
        // Trigger disconnect event
        this.triggerEvent('disconnect', { error });
        
        // More aggressive reconnection
        if (this.reconnectCount < this.maxReconnects) {
            this.reconnectCount++;
            this.log(`Attempting to reconnect (${this.reconnectCount}/${this.maxReconnects})...`);
            
            setTimeout(async () => {
                const success = await this.connect();
                if (success) {
                    this.triggerEvent('reconnect', { attempt: this.reconnectCount });
                    // Restart the ping interval after successful reconnection
                    this.pingInterval = setInterval(() => this.pingHost(), 30000);
                } else if (this.reconnectCount >= this.maxReconnects) {
                    this.triggerEvent('reconnect-failed', { attempts: this.reconnectCount });
                }
            }, this.reconnectDelay);
        }
    }

    /**
     * Handle incoming messages from the native host
     * @param {Object} message - Message from native host
     */
    handleMessage(message) {
        this.log('Received message from native host:', message);
        if (!message) return;
        
        // Handle response messages - resolve as soon as we get a message with matching ID
        if (message.id && this.callbacks.has(message.id)) {
            const { resolve, reject } = this.callbacks.get(message.id);
            this.callbacks.delete(message.id);
            
            if (message.error) {
                this.logError('Error in message response:', message.error);
                reject(new Error(message.error));
            } else {
                resolve(message);
            }
            return;
        }
        
        // Handle progress updates
        if (message.type === 'progress' && message.downloadId) {
            this.triggerEvent('progress', message);
            return;
        }
        
        // Handle other events
        if (message.type) {
            this.triggerEvent(message.type, message);
        }
    }

    /**
     * Send a message to the native host
     * @param {Object} message - Message to send
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise<Object>} Response from native host
     */
    async sendMessage(message, timeout = 30000) {
        this.log('Sending message:', message);
        const connected = await this.connect();
        if (!connected) {
            this.logError('Cannot send message - not connected to native host');
            const errorDetails = this.getConnectionErrorDetails();
            throw new Error(`Not connected to native host. ${errorDetails}`);
        }
        
        // Add message ID if not present
        if (!message.id) {
            message.id = `msg_${Date.now()}_${++this.messageCounter}`;
        }
        
        return new Promise((resolve, reject) => {
            // Set timeout
            const timeoutId = setTimeout(() => {
                this.logError(`Request ${message.id} timed out after ${timeout}ms`);
                this.callbacks.delete(message.id);
                reject(new Error(`Request timed out after ${timeout}ms`));
            }, timeout);
            
            // Store callback
            this.callbacks.set(message.id, {
                resolve: (response) => {
                    this.log(`Received response for message ${message.id}:`, response);
                    clearTimeout(timeoutId);
                    resolve(response);
                },
                reject: (error) => {
                    this.logError(`Error for message ${message.id}:`, error);
                    clearTimeout(timeoutId);
                    reject(error);
                }
            });
            
            // Send message
            try {
                this.port.postMessage(message);
            } catch (error) {
                this.logError('Error sending message:', error);
                clearTimeout(timeoutId);
                this.callbacks.delete(message.id);
                reject(error);
            }
        });
    }

    /**
     * Get detailed error message for connection issues
     * @returns {string} Error details
     */
    getConnectionErrorDetails() {
        const error = chrome.runtime.lastError;
        if (error) {
            return `Error: ${error.message}`;
        }
        
        if (this.reconnectCount >= this.maxReconnects) {
            return `Failed after ${this.maxReconnects} connection attempts. Check that the native host application is installed and running.`;
        }
        
        return 'Check that the native host application is installed correctly and its manifest includes this extension ID in allowed_origins.';
    }

    /**
     * Add event listener
     * @param {string} event - Event name
     * @param {Function} callback - Event callback
     * @returns {string} Listener ID
     */
    addEventListener(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Map());
        }
        
        const id = `listener_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.eventListeners.get(event).set(id, callback);
        return id;
    }

    /**
     * Remove event listener
     * @param {string} event - Event name
     * @param {string} id - Listener ID
     * @returns {boolean} Success
     */
    removeEventListener(event, id) {
        if (!this.eventListeners.has(event)) {
            return false;
        }
        
        return this.eventListeners.get(event).delete(id);
    }

    /**
     * Trigger event
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    triggerEvent(event, data) {
        if (!this.eventListeners.has(event)) {
            return;
        }
        
        this.eventListeners.get(event).forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(`Error in event listener for ${event}:`, error);
            }
        });
    }

    /**
     * Disconnect from the native host
     */
    disconnect() {
        this.log('Disconnecting from native host');
        
        // Clear the ping interval
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
        if (this.port) {
            try {
                // Remove event listeners to prevent memory leaks
                this.port.onMessage.removeListener(this.handleMessage);
                this.port.onDisconnect.removeListener(this.handleDisconnect);
                
                // Disconnect the port
                this.port.disconnect();
            } catch (error) {
                this.logError('Error disconnecting:', error);
            }
            this.port = null;
        }
        
        this.connected = false;
        this.connecting = false;
        
        // Reject any pending callbacks
        this.callbacks.forEach((callback, id) => {
            if (callback.reject) {
                callback.reject(new Error('Native host disconnected intentionally'));
            }
        });
        this.callbacks.clear();
        
        // Trigger disconnect event
        this.triggerEvent('disconnect', { intentional: true });
    }

    async pingHost() {
        if (!this.connected || this.connecting) return;
        
        try {
            // Use healthCheck instead of ping - less likely to be blocked by antivirus
            const pingId = `health_${Date.now()}_${Math.random().toString(36).substring(2)}`;
            
            const healthCheckResult = await new Promise((resolve, reject) => {
                const onResponse = (message) => {
                    // Accept both old 'pong' and new 'healthCheck' responses for backwards compatibility
                    if ((message.type === 'pong' && message.nativeHostConnected === true) ||
                        (message.type === 'healthCheck' && message.status === 'ok')) {
                        this.port.onMessage.removeListener(onResponse);
                        resolve(true);
                    }
                };
                
                this.port.onMessage.addListener(onResponse);
                this.port.postMessage({type: 'healthCheck', id: pingId});
                
                // Set timeout for response
                setTimeout(() => {
                    this.port.onMessage.removeListener(onResponse);
                    reject(new Error('Health check timeout'));
                }, 2000);
            });
            
            this.lastSuccessfulMessage = Date.now();
            console.log('Native host health check successful');
        } catch (error) {
            console.error('Native host health check failed:', error);
            if (Date.now() - this.lastSuccessfulMessage > 60000) {
                // If no successful message in last minute, force reconnect
                this.connected = false;
                this.port = null;
                this.reconnectCount = 0;
                this.connect();
            }
        }
    }

    /**
     * Check native host connection status
     * @returns {Promise<boolean>} Connection status
     */
    async checkNativeHost() {
        try {
            if (this.connected) {
                // If already connected, verify with a ping
                try {
                    // Use direct messaging to verify connection
                    const pingId = `ping_${Date.now()}_${Math.random().toString(36).substring(2)}`;
                    
                    const pingResult = await new Promise((resolve, reject) => {
                        const onPingResponse = (message) => {
                            if (message.type === 'pong' && message.nativeHostConnected === true) {
                                this.port.onMessage.removeListener(onPingResponse);
                                resolve(true);
                            }
                        };
                        
                        this.port.onMessage.addListener(onPingResponse);
                        this.port.postMessage({type: 'ping', id: pingId});
                        
                        // Set timeout for ping response
                        setTimeout(() => {
                            this.port.onMessage.removeListener(onPingResponse);
                            reject(new Error('Ping timeout'));
                        }, 2000);
                    });
                    
                    return true;
                } catch (e) {
                    // Ping failed, connection is no longer valid
                    this.connected = false;
                    this.port = null;
                    // Fall through to reconnect
                }
            }
            
            // Not connected or ping failed, try to connect
            return await this.connect();
        } catch (error) {
            this.logError('Native host check failed:', error);
            this.triggerEvent('connection-error', { 
                error: error.message,
                details: this.getConnectionErrorDetails()
            });
            return false;
        }
    }
}

// Create singleton instance
const nativeConnection = new NativeConnection();

/**
 * Initialize the connection to the native host
 * This is a convenience function that can be called at application startup
 * @returns {Promise<boolean>} Connection success
 */
export async function initializeNativeConnection() {
    try {
        const connected = await nativeConnection.connect();
        console.log('Native connection initialized:', connected ? 'Connected' : 'Failed');
        return connected;
    } catch (error) {
        console.error('Native connection initialization failed:', error);
        return false;
    }
}

/**
 * Get media information for a URL
 * @param {string} url - Media URL
 * @returns {Promise<Object>} Media information
 */
export async function getMediaInfo(url) {
    try {
        const response = await nativeConnection.sendMessage({
            type: 'get_media_info',
            url
        });
        
        return response;
    } catch (error) {
        console.error('Error getting media info:', error);
        throw error;
    }
}

/**
 * Download a file
 * @param {string} url - Media URL
 * @param {string} type - Media type (hls, dash, direct, audio, blob)
 * @param {Object} options - Additional download options
 * @returns {Promise<Object>} Download result
 */
export async function downloadFile(url, type, options = {}) {
    try {
        const response = await nativeConnection.sendMessage({
            type: 'download',
            url,
            format: type,
            ...options
        });
        
        return response;
    } catch (error) {
        console.error('Error downloading file:', error);
        throw error;
    }
}

/**
 * Cancel a download
 * @param {string} downloadId - Download ID
 * @returns {Promise<Object>} Cancel result
 */
export async function cancelDownload(downloadId) {
    try {
        const response = await nativeConnection.sendMessage({
            type: 'cancel_download',
            downloadId
        });
        
        return response;
    } catch (error) {
        console.error('Error canceling download:', error);
        throw error;
    }
}

/**
 * Get available download locations
 * @returns {Promise<Object>} Download locations
 */
export async function getDownloadLocations() {
    try {
        const response = await nativeConnection.sendMessage({
            type: 'get_download_locations'
        });
        
        return response;
    } catch (error) {
        console.error('Error getting download locations:', error);
        throw error;
    }
}

/**
 * Check if native host is available
 * @returns {Promise<boolean>} Availability
 */
export async function checkNativeHost() {
    try {
        return await nativeConnection.connect();
    } catch (error) {
        return false;
    }
}

/**
 * Add progress listener
 * @param {Function} callback - Progress callback
 * @returns {Function} Function to remove the listener
 */
export function onProgress(callback) {
    const id = nativeConnection.addEventListener('progress', callback);
    return () => nativeConnection.removeEventListener('progress', id);
}

/**
 * Add progress listener
 * @param {Function} callback - Progress callback
 * @returns {string} Listener ID
 */
export function addProgressListener(callback) {
    return nativeConnection.addEventListener('progress', callback);
}

/**
 * Remove progress listener
 * @param {string} id - Listener ID
 * @returns {boolean} Success
 */
export function removeProgressListener(id) {
    return nativeConnection.removeEventListener('progress', id);
}

export default nativeConnection; 