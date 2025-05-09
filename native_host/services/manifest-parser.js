/**
 * @ai-guide-component ManifestParserService
 * @ai-guide-description Service for parsing streaming manifests
 * @ai-guide-responsibilities
 * - Provides access to manifest parsing functionality
 * - Exposes light parsing for quick media type detection
 * - Supports both HLS and DASH manifest formats
 * - Coordinates with other services for manifest processing
 */

// services/manifest-parser.js
const ManifestParser = require('../lib/progress/manifest-parser');
const { logDebug } = require('../utils/logger');

/**
 * Service for manifest parsing operations
 */
class ManifestParserService {
    constructor() {
        this.parser = new ManifestParser();
    }

    /**
     * Initialize the service
     */
    async initialize() {
        logDebug('📄 Initializing Manifest Parser Service');
        return true;
    }

    /**
     * Parse a manifest completely
     * @param {string} url URL of the manifest
     * @param {string} type Manifest type ('hls' or 'dash')
     * @returns {Promise<Object|null>} Parsed manifest or null if failed
     */
    async parse(url, type) {
        return this.parser.parse(url, type);
    }

    /**
     * Light parse a manifest to detect if it's a master playlist
     * @param {string} url URL of the manifest
     * @param {string} type Manifest type ('hls' or 'dash')
     * @returns {Promise<Object|null>} Basic manifest info or null if failed
     */
    async lightParse(url, type) {
        return this.parser.lightParse(url, type);
    }
}

module.exports = new ManifestParserService();
