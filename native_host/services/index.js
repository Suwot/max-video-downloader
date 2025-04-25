// services/index.js
const ffmpegService = require('./ffmpeg');
const configService = require('./config');
const { logDebug } = require('../utils/logger');

/**
 * Services registry with explicit initialization order
 */
class ServicesManager {
    constructor() {
        this.services = {
            ffmpeg: ffmpegService,
            config: configService
        };
        this.initialized = false;
    }

    /**
     * Initialize all services in the correct order
     */
    async initialize() {
        if (this.initialized) {
            return true;
        }

        try {
            logDebug('Starting services initialization');
            
            // 1. Initialize Config service first
            if (!configService.initialize()) {
                logDebug('Config service initialization failed');
                return false;
            }
            
            // 2. Initialize FFmpeg service
            if (!ffmpegService.initialize()) {
                logDebug('FFmpeg service initialization failed');
                return false;
            }

            // Add other service initializations here in the correct order
            
            this.initialized = true;
            logDebug('All services initialized successfully');
            return true;
        } catch (err) {
            logDebug('Services initialization failed:', err);
            return false;
        }
    }

    /**
     * Get an initialized service instance
     */
    getService(serviceName) {
        if (!this.initialized) {
            throw new Error('Services not initialized before accessing them');
        }

        if (!this.services[serviceName]) {
            throw new Error(`Service ${serviceName} not found`);
        }

        return this.services[serviceName];
    }
}

module.exports = new ServicesManager();
