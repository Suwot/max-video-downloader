/**
 * Download Manager Service
 * Handles video download operations including progress tracking, notifications, and port communication
 */

// Add static import at the top
import nativeHostService from '../../js/native-host-service.js';
import { buildRequestHeaders } from '../../js/utilities/headers-utils.js';
import { createLogger } from '../../js/utilities/logger.js';

// Track downloads by ID for better connection persistence
const downloads = new Map(); // key = downloadId, value = { url, progress, status, startTime, etc. }
const activeDownloads = new Map(); // key = url, value = { progress, tabId, notificationId, lastUpdated, filename, etc. }
const downloadPorts = new Map(); // key = portId, value = port object

// Create a logger instance for the Download Manager module
const logger = createLogger('Download Manager');

// Generate a unique download ID
function generateDownloadId() {
  return `download_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Get filename from URL
function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        let filename = pathname.split('/').pop();
        
        // Clean up filename (remove query params)
        filename = filename.replace(/[?#].*$/, '');
        
        // Make sure we preserve the original file extension if it exists
        // This ensures container format compatibility (especially for WebM files)
        const fileExtMatch = url.match(/\.([^./?#]+)($|\?|#)/i);
        if (fileExtMatch) {
            const ext = fileExtMatch[1].toLowerCase();
            
            // If URL has extension but filename doesn't, add it
            if (!filename.includes('.')) {
                filename += `.${ext}`;
            } 
            // If both have extensions but they're different, and URL extension is webm/mov, use URL extension
            else if (['webm', 'mov'].includes(ext) && !filename.toLowerCase().endsWith(`.${ext}`)) {
                const baseFilename = filename.replace(/\.[^.]+$/, '');
                filename = `${baseFilename}.${ext}`;
            }
        }
        
        if (filename && filename.length > 0) {
            return filename;
        }
    } catch {}
    
    return 'video';
}

function handleDownloadSuccess(response, notificationId) {
  chrome.notifications.update(notificationId, {
    title: 'Download Complete',
    message: `Saved to: ${response.path}`
  });
  
  for (const [portId, port] of downloadPorts.entries()) {
    try {
      port.postMessage(response);
    } catch (e) {
      console.error('Error sending success to port:', e);
      downloadPorts.delete(portId);
      logger.debug('Removed dead port after success failure:', portId);
    }
  }
}

function handleDownloadError(error, notificationId) {
  chrome.notifications.update(notificationId, {
    title: 'Download Failed',
    message: error
  });
  
  for (const [portId, port] of downloadPorts.entries()) {
    try {
      port.postMessage({ success: false, error: error });
    } catch (e) {
      console.error('Error sending error to port:', e);
      downloadPorts.delete(portId);
      logger.debug('Removed dead port after error failure:', portId);
    }
  }
}

/**
 * Initiates a download and sets up progress tracking
 */
function startDownload(request, port) {
    const downloadId = generateDownloadId();
    
    // Show initial notification
    const notificationId = `download-${Date.now()}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Downloading Video',
      message: 'Starting download...'
    });
    
    // Store initial download information
    downloads.set(downloadId, {
        url: request.url,
        progress: 0,
        status: 'downloading',
        startTime: Date.now(),
        filename: request.filename || getFilenameFromUrl(request.url),
        tabId: request.tabId || -1,
        type: request.type === 'downloadHLS' ? 'hls' : 'direct',
        quality: request.quality || null,
        originalUrl: request.originalUrl || request.url
    });
    
    // Send download ID back to popup
    if (port) {
        port.postMessage({
            type: 'downloadInitiated',
            downloadId: downloadId,
            url: request.url
        });
    }
    
    // Create response handler with downloadId context
    let hasError = false;
    const responseHandler = (response) => {
        if (response && response.type === 'progress' && !hasError) {
            // Update stored download information
            const download = downloads.get(downloadId);
            if (download) {
                download.progress = response.progress || 0;
                download.speed = response.speed;
                download.eta = response.eta;
                download.segmentProgress = response.segmentProgress;
                download.confidence = response.confidence;
                download.downloaded = response.downloaded;
                download.size = response.size;
                download.lastUpdated = Date.now();
            }
            
            // Ensure all progress data is passed through, including confidence levels,
            // segment tracking, ETA, and other enhanced tracking metrics
            const enhancedResponse = {
                ...response,
                type: 'progress',
                // Add download ID for tracking
                downloadId: downloadId,
                // Format filename if available
                filename: response.filename || request.filename || getFilenameFromUrl(request.url),
                // Add URL for tracking
                url: request.url
            };
            
            // Store in activeDownloads map for reconnecting popups (legacy approach)
            activeDownloads.set(request.url, {
                downloadId: downloadId, // Add download ID to legacy structure
                tabId: request.tabId || -1,
                notificationId: notificationId,
                progress: response.progress || 0,
                filename: enhancedResponse.filename,
                lastUpdated: Date.now(),
                speed: response.speed,
                eta: response.eta,
                segmentProgress: response.segmentProgress,
                confidence: response.confidence,
                downloaded: response.downloaded,
                size: response.size
            });
            
            // Update notification less frequently
            if (response.progress % 10 === 0) {
                let message = `Downloading: ${Math.round(response.progress)}%`;
                
                // Add segment info if available
                if (response.segmentProgress) {
                    message += ` (Segment: ${response.segmentProgress})`;
                }
                
                chrome.notifications.update(notificationId, {
                    message: message
                });
            }
            
            // Forward progress to all connected popups (live iteration)
            for (const [portId, port] of downloadPorts.entries()) {
                try {
                    port.postMessage(enhancedResponse);
                } catch (e) {
                    console.error('Error sending progress to port:', e);
                    downloadPorts.delete(portId);
                    logger.debug('Removed dead port after send failure:', portId);
                }
            }
        } else if (response && response.success && !hasError) {
            // Update download status
            const download = downloads.get(downloadId);
            if (download) {
                download.status = 'completed';
                download.completeTime = Date.now();
                download.progress = 100;
            }
            
            // On success, remove from active downloads
            activeDownloads.delete(request.url);
            
            handleDownloadSuccess(response, notificationId);
            
            // Keep completed download info for a while
            setTimeout(() => {
                downloads.delete(downloadId);
                logger.debug('Removed completed download info:', downloadId);
            }, 30 * 60 * 1000); // 30 minutes
            
        } else if (response && response.error && !hasError) {
            // Update download status
            const download = downloads.get(downloadId);
            if (download) {
                download.status = 'error';
                download.error = response.error;
            }
            
            // On error, remove from active downloads
            activeDownloads.delete(request.url);
            hasError = true;
            
            handleDownloadError(response.error, notificationId);
        }
    };
    
    // Send to native host using our service with enhanced parameters
    console.log('🔄 Forwarding download request to native host:', request.url);
    
    // Fetch headers for the video first
    buildRequestHeaders(request.tabId || -1, request.url).then(headers => {
        logger.debug('Using headers for download request:', Object.keys(headers));
        
        // Using imported nativeHostService with headers
        nativeHostService.sendMessage({
            type: 'download',
            url: request.url,
            filename: request.filename || getFilenameFromUrl(request.url),
            savePath: request.savePath,
            quality: request.quality,
            manifestUrl: request.manifestUrl || request.url, // Pass manifest URL for better progress tracking
            headers: headers // Include headers for authentication/authorization
        }, responseHandler).catch(error => {
            console.error('❌ Native host error:', error);
            
            // If error contains "codec not currently supported in container", attempt to retry with webm extension
            if (error.message && error.message.includes("codec not currently supported in container") && 
                request.url.toLowerCase().includes(".webm")) {
                
                console.log('⚠️ Codec incompatibility detected. Retrying with WebM extension...');
                
                // Force WebM extension for this download
                let updatedFilename = request.filename || getFilenameFromUrl(request.url);
                if (!/\.webm$/i.test(updatedFilename)) {
                    updatedFilename = updatedFilename.replace(/\.[^.]+$/, '') + '.webm';
                }
                
                nativeHostService.sendMessage({
                    type: 'download',
                    url: request.url,
                    filename: updatedFilename,
                    savePath: request.savePath,
                    quality: request.quality,
                    manifestUrl: request.manifestUrl || request.url,
                    headers: headers
                }, responseHandler).catch(retryError => {
                    // Update download status for retry error
                    const download = downloads.get(downloadId);
                    if (download) {
                        download.status = 'error';
                        download.error = retryError.message;
                    }
                    
                    handleDownloadError(retryError.message, notificationId);
                });
                return;
            }
            
            // Update download status
            const download = downloads.get(downloadId);
            if (download) {
                download.status = 'error';
                download.error = error.message;
            }
            
            handleDownloadError(error.message, notificationId);
        });
    }).catch(error => {
        console.error('❌ Error getting headers:', error);
        
        // Continue with download without headers as fallback
        logger.debug('Continuing download without custom headers');
        
        nativeHostService.sendMessage({
            type: 'download',
            url: request.url,
            filename: request.filename || getFilenameFromUrl(request.url),
            savePath: request.savePath,
            quality: request.quality,
            manifestUrl: request.manifestUrl || request.url
        }, responseHandler).catch(error => {
            console.error('❌ Native host error:', error);
            
            // If error contains "codec not currently supported in container", attempt to retry with webm extension
            if (error.message && error.message.includes("codec not currently supported in container") && 
                request.url.toLowerCase().includes(".webm")) {
                
                console.log('⚠️ Codec incompatibility detected. Retrying with WebM extension...');
                
                // Force WebM extension for this download
                let updatedFilename = request.filename || getFilenameFromUrl(request.url);
                if (!/\.webm$/i.test(updatedFilename)) {
                    updatedFilename = updatedFilename.replace(/\.[^.]+$/, '') + '.webm';
                }
                
                nativeHostService.sendMessage({
                    type: 'download',
                    url: request.url,
                    filename: updatedFilename,
                    savePath: request.savePath,
                    quality: request.quality,
                    manifestUrl: request.manifestUrl || request.url
                }, responseHandler).catch(retryError => {
                    // Update download status for retry error
                    const download = downloads.get(downloadId);
                    if (download) {
                        download.status = 'error';
                        download.error = retryError.message;
                    }
                    
                    handleDownloadError(retryError.message, notificationId);
                });
                return;
            }
            
            // Update download status
            const download = downloads.get(downloadId);
            if (download) {
                download.status = 'error';
                download.error = error.message;
            }
            
            handleDownloadError(error.message, notificationId);
        });
    });
    
    return downloadId;
}

/**
 * Sets up port connection for download progress tracking
 */
function setupDownloadPort(port, portId) {
    // Store in download-specific port collection
    downloadPorts.set(portId, port);

    // Set up message listener for this port
    port.onMessage.addListener((message) => {
        // Handle registration for specific download updates
        if (message.action === 'registerForDownload' && message.downloadUrl) {
            const downloadInfo = activeDownloads.get(message.downloadUrl);

            if (downloadInfo) {
                logger.debug('Sending immediate download state for URL:', message.downloadUrl);
                try {
                    port.postMessage({
                        type: 'progress',
                        progress: downloadInfo.progress || 0,
                        url: message.downloadUrl,
                        downloadId: downloadInfo.downloadId, // Include download ID in progress updates
                        filename: downloadInfo.filename || getFilenameFromUrl(message.downloadUrl),
                        speed: downloadInfo.speed,
                        eta: downloadInfo.eta,
                        segmentProgress: downloadInfo.segmentProgress,
                        confidence: downloadInfo.confidence,
                        downloaded: downloadInfo.downloaded,
                        size: downloadInfo.size
                    });
                } catch (e) {
                    console.error('Error sending immediate progress to port:', e);
                    downloadPorts.delete(portId);
                }
            }
        }
        // Handle download reconnection by ID
        else if (message.action === 'reconnectToDownload' && message.downloadId) {
            const downloadInfo = downloads.get(message.downloadId);
            
            if (downloadInfo) {
                logger.debug('Reconnecting to download:', message.downloadId);
                try {
                    port.postMessage({
                        type: 'progress',
                        progress: downloadInfo.progress || 0,
                        url: downloadInfo.url,
                        downloadId: message.downloadId,
                        filename: downloadInfo.filename || getFilenameFromUrl(downloadInfo.url),
                        speed: downloadInfo.speed,
                        eta: downloadInfo.eta,
                        segmentProgress: downloadInfo.segmentProgress,
                        confidence: downloadInfo.confidence,
                        downloaded: downloadInfo.downloaded,
                        size: downloadInfo.size
                    });
                } catch (e) {
                    console.error('Error sending reconnection data to port:', e);
                    downloadPorts.delete(portId);
                }
            } else {
                // Download ID not found
                try {
                    port.postMessage({
                        type: 'download_not_found',
                        downloadId: message.downloadId
                    });
                } catch (e) {
                    downloadPorts.delete(portId);
                }
            }
        } else if (message.type === 'download' || message.type === 'downloadHLS') {
            startDownload(message, port);
        }
    });

    // Handle port disconnection
    port.onDisconnect.addListener(() => {
        downloadPorts.delete(portId);
        logger.debug('Download port disconnected and removed:', portId);
    });
}

/**
 * Gets list of active downloads
 */
function getActiveDownloads() {
    return Array.from(downloads.entries())
        .filter(([id, info]) => info.status === 'downloading')
        .map(([id, info]) => ({
            downloadId: id,
            url: info.url,
            originalUrl: info.originalUrl || info.url,
            progress: info.progress || 0,
            status: info.status,
            filename: info.filename || getFilenameFromUrl(info.url),
            startTime: info.startTime,
            lastUpdated: info.lastUpdated,
            speed: info.speed,
            eta: info.eta,
            segmentProgress: info.segmentProgress,
            quality: info.quality
        }));
}

/**
 * Gets details of a specific download by ID
 */
function getDownloadDetails(downloadId) {
    const download = downloads.get(downloadId);
    if (!download) return null;
    
    return {
        downloadId: downloadId,
        url: download.url,
        originalUrl: download.originalUrl || download.url,
        progress: download.progress || 0,
        status: download.status,
        quality: download.quality,
        filename: download.filename
    };
}

/**
 * Cleans up downloads for a closed tab
 */
function cleanupDownloadsForTab(tabId) {
    for (const [url, downloadInfo] of activeDownloads.entries()) {
        if (downloadInfo.tabId === tabId) {
            logger.debug('Cleaning up download for closed tab:', url);
            activeDownloads.delete(url);
        }
    }
}

export { 
    startDownload,
    setupDownloadPort,
    getActiveDownloads,
    getDownloadDetails,
    cleanupDownloadsForTab
};