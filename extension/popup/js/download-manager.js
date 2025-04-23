import { downloadFile } from './native-connection.js';
import { VideoModel } from './video-model.js';

/**
 * Download manager to handle download operations with progress tracking
 */
export class DownloadManager {
    constructor() {
        this.activeDownloads = new Map();
        this.listeners = new Map();
    }

    /**
     * Add a listener for download events
     * @param {string} eventType - Event type (progress, complete, error)
     * @param {Function} callback - Callback function
     * @returns {string} Listener ID
     */
    addListener(eventType, callback) {
        const id = crypto.randomUUID();
        if (!this.listeners.has(eventType)) {
            this.listeners.set(eventType, new Map());
        }
        this.listeners.get(eventType).set(id, callback);
        return id;
    }

    /**
     * Remove a listener
     * @param {string} eventType - Event type
     * @param {string} listenerId - Listener ID
     */
    removeListener(eventType, listenerId) {
        if (this.listeners.has(eventType)) {
            this.listeners.get(eventType).delete(listenerId);
        }
    }

    /**
     * Trigger an event
     * @param {string} eventType - Event type
     * @param {Object} data - Event data
     */
    triggerEvent(eventType, data) {
        if (this.listeners.has(eventType)) {
            for (const callback of this.listeners.get(eventType).values()) {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in ${eventType} listener:`, error);
                }
            }
        }
    }

    /**
     * Update progress for a download
     * @param {string} downloadId - Download ID
     * @param {Object} progressData - Progress data
     */
    updateProgress(downloadId, progressData) {
        if (!this.activeDownloads.has(downloadId)) {
            return;
        }

        const download = this.activeDownloads.get(downloadId);
        download.progress = progressData.progress || 0;
        download.speed = progressData.speed || 0;
        download.eta = progressData.eta || 0;
        download.status = progressData.status || download.status;

        // Update the UI
        this.triggerEvent('progress', {
            downloadId,
            ...download
        });

        // If download is complete, clean up
        if (progressData.status === 'complete') {
            this.triggerEvent('complete', {
                downloadId,
                ...download
            });
            this.activeDownloads.delete(downloadId);
        } else if (progressData.status === 'error') {
            this.triggerEvent('error', {
                downloadId,
                error: progressData.error || 'Unknown error',
                ...download
            });
            this.activeDownloads.delete(downloadId);
        }
    }

    /**
     * Start a download
     * @param {VideoModel} video - Video model instance
     * @param {Object} options - Download options
     * @returns {Promise<string>} Download ID
     */
    async startDownload(video, options = {}) {
        try {
            const downloadId = crypto.randomUUID();
            const filename = options.filename || this.generateFilename(video);
            const outputPath = options.outputPath || '';
            const format = options.format || video.getFileExtension();
            const resolution = options.resolution || video.getResolution();

            // Create download entry
            this.activeDownloads.set(downloadId, {
                id: downloadId,
                video,
                filename,
                outputPath,
                format,
                resolution,
                progress: 0,
                speed: 0,
                eta: 0,
                status: 'starting',
                startTime: Date.now()
            });

            // Notify listeners
            this.triggerEvent('start', {
                downloadId,
                ...this.activeDownloads.get(downloadId)
            });

            // Start the actual download
            const downloadOptions = {
                url: video.url,
                filename,
                outputPath,
                format,
                resolution,
                isAudioOnly: video.isAudioOnly,
                downloadId
            };

            // Register callback for download progress
            const progressHandler = (event) => {
                if (event.downloadId === downloadId) {
                    this.updateProgress(downloadId, event);
                }
            };

            // Add temporary listener to handle this download's progress
            const listenerId = this.addListener('native_progress', progressHandler);

            // Start the download using the native connection
            const result = await downloadFile(downloadOptions);

            if (!result.success) {
                throw new Error(result.error || 'Download failed');
            }

            return downloadId;
        } catch (error) {
            console.error('Download error:', error);
            throw error;
        }
    }

    /**
     * Cancel a download
     * @param {string} downloadId - Download ID
     * @returns {boolean} Success
     */
    cancelDownload(downloadId) {
        if (!this.activeDownloads.has(downloadId)) {
            return false;
        }

        // Send cancel message to native host
        chrome.runtime.sendMessage({
            action: 'cancelDownload',
            downloadId
        });

        // Update status and notify listeners
        const download = this.activeDownloads.get(downloadId);
        download.status = 'cancelled';
        this.triggerEvent('cancel', {
            downloadId,
            ...download
        });

        // Remove from active downloads
        this.activeDownloads.delete(downloadId);
        return true;
    }

    /**
     * Generate a filename for a video
     * @param {VideoModel} video - Video model instance
     * @returns {string} Filename
     */
    generateFilename(video) {
        // Sanitize title
        let sanitizedTitle = video.title
            .replace(/[\\/:*?"<>|]/g, '_') // Replace invalid filename characters
            .replace(/\s+/g, '_')          // Replace spaces with underscores
            .replace(/_+/g, '_')           // Replace multiple underscores with single
            .replace(/^_|_$/g, '');        // Remove leading/trailing underscores

        // Add resolution to filename if available
        const resolution = video.getResolution();
        const resolutionStr = resolution && resolution !== 'Unknown' ? `_${resolution}` : '';

        // Get file extension
        const extension = video.getFileExtension();

        // Trim filename if too long (max 200 chars including extension)
        const maxLength = 200 - extension.length - resolutionStr.length - 1;
        if (sanitizedTitle.length > maxLength) {
            sanitizedTitle = sanitizedTitle.substring(0, maxLength);
        }

        return `${sanitizedTitle}${resolutionStr}.${extension}`;
    }

    /**
     * Get all active downloads
     * @returns {Object[]} Active downloads
     */
    getActiveDownloads() {
        return Array.from(this.activeDownloads.values());
    }

    /**
     * Get a specific download
     * @param {string} downloadId - Download ID
     * @returns {Object|null} Download info or null if not found
     */
    getDownload(downloadId) {
        return this.activeDownloads.get(downloadId) || null;
    }

    /**
     * Handle progress update from native host
     * @param {Object} message - Progress message
     */
    handleNativeProgress(message) {
        this.triggerEvent('native_progress', message);
    }
}

// Create and export a singleton instance
export const downloadManager = new DownloadManager();

// Listen for progress updates from background script
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadProgress') {
        downloadManager.handleNativeProgress(message);
    }
    return true;
}); 