/**
 * @ai-guide-component BackgroundScript
 * @ai-guide-description Main extension service worker
 * @ai-guide-responsibilities
 * - Initializes the video detection system on extension startup
 * - Manages cross-tab communication via message passing
 * - Coordinates content script injection into web pages
 * - Maintains video detection state across browser sessions
 * - Handles native host communication via Native Host Service
 * - Implements browser action icon and badge functionality  
 * - Provides centralized video metadata storage for popup UI
 * - Filters tracking pixels while preserving legitimate video URLs
 * - Processes URLs extracted from query parameters with proper metadata
 * - Maintains the foundFromQueryParam flag throughout the video pipeline
 * - Deduplicates videos using smart URL normalization
 */

// background.js - Service worker for the extension

// Add at the top of the file
import { 
    fetchAndParseManifest, 
    processVideoRelationships, 
    isVariantOfMasterPlaylist, 
    clearCaches as clearManifestCaches 
} from './js/manifest-service.js';
import nativeHostService from './js/native-host-service.js';
import { validateAndFilterVideos } from './js/utilities/video-validator.js';
import { parseHLSManifest, parseDASHManifest } from './popup/js/manifest-parser.js';

// For automatic processing of HLS relationships
// Remove these redundant caches as they're now in manifest-service.js
// let manifestRelationsCache = new Map();
// let masterPlaylistCache = new Map();

// Debug logging helper
function logDebug(...args) {
    console.log('[Background Debug]', new Date().toISOString(), ...args);
}

let previewGenerationQueue = new Map();
const videosPerTab = {};
const playlistsPerTab = {};
const metadataProcessingQueue = new Map();
const manifestRelationships = new Map();

// Improved broadcast function that also stores processed videos for instant access
// when popup opens
function broadcastVideoUpdate(tabId) {
    if (!videosPerTab[tabId]) return;
    
    // Convert Map to Array for sending
    const videos = Array.from(videosPerTab[tabId].values());
    videos.sort((a, b) => b.timestamp - a.timestamp);
    
    // Apply proper grouping and filtering - FULLY process videos
    const processedVideos = processVideosForBroadcast(videos);
    
    // Important: Store the processed videos for instant access when popup opens
    chrome.storage.local.set({
        [`processedVideos_${tabId}`]: processedVideos,
        [`processedVideosTimestamp_${tabId}`]: Date.now()
    }).catch(err => {
        console.error('Failed to store processed videos:', err);
    });
    
    // First try to send to connected popups via port
    let portMessageSent = false;
    for (const [portId, port] of popupPorts.entries()) {
        try {
            port.postMessage({
                action: 'videoStateUpdated',
                tabId: tabId,
                videos: processedVideos
            });
            portMessageSent = true;
        } catch (e) {
            console.error('Error sending to popup port:', e);
            // Clean up dead ports
            popupPorts.delete(portId);
        }
    }
    
    // Fall back to one-time message if no ports are connected
    // This maintains backward compatibility
    if (!portMessageSent) {
        chrome.runtime.sendMessage({
            action: 'videoStateUpdated',
            tabId: tabId,
            videos: processedVideos
        }).catch(() => {
            // Suppress errors - popup may not be open
        });
    }
}

// Process videos for sending to popup - fully prepare videos for instant display
function processVideosForBroadcast(videos) {
    // First apply validation filter to remove unwanted videos
    const validatedVideos = validateAndFilterVideos(videos);
    
    // Now we need to group videos by identifying master-variant relationships
    // This avoids showing duplicate entries for variants that belong to a master playlist
    const processedVideos = [];
    const variantUrls = new Set();
    
    // First pass: identify all variant URLs and master playlists
    validatedVideos.forEach(video => {
        if (video.qualityVariants && video.qualityVariants.length > 0) {
            // This is a master playlist, add variants to our tracking set
            video.qualityVariants.forEach(variant => {
                const normalizedVariantUrl = normalizeUrl(variant.url);
                variantUrls.add(normalizedVariantUrl);
            });
        }
    });
    
    // Second pass: include only non-variant videos or master playlists
    validatedVideos.forEach(video => {
        const normalizedUrl = normalizeUrl(video.url);
        
        // Skip if this is a variant that belongs to a master playlist we're already showing
        if (video.isVariant || variantUrls.has(normalizedUrl)) {
            return;
        }
        
        // Add additional information needed for immediate display
        const enhancedVideo = {
            ...video,
            // Add additional metadata needed by UI
            timestamp: video.timestamp || Date.now(),
            processed: true,
            // Ensure video has all necessary fields for display
            title: video.title || getFilenameFromUrl(video.url),
            poster: video.poster || video.previewUrl || null,
            downloadable: true,
            // Add source information to track where the video came from
            source: video.source || 'background',
            // Track if this was added via background processing while popup was closed
            detectedWhilePopupClosed: true
        };
        
        // If we have stream info, ensure it's mapped to mediaInfo for the popup
        if (video.streamInfo && !video.mediaInfo) {
            enhancedVideo.mediaInfo = {
                hasVideo: video.streamInfo.hasVideo,
                hasAudio: video.streamInfo.hasAudio,
                videoCodec: video.streamInfo.videoCodec,
                audioCodec: video.streamInfo.audioCodec,
                format: video.streamInfo.format,
                container: video.streamInfo.container,
                duration: video.streamInfo.duration,
                sizeBytes: video.streamInfo.sizeBytes,
                width: video.streamInfo.width,
                height: video.streamInfo.height,
                fps: video.streamInfo.fps,
                bitrate: video.streamInfo.videoBitrate || video.streamInfo.totalBitrate
            };
        }
        
        // If we have resolution info from the stream but not as a separate field,
        // add it for immediate display in the popup
        if (!video.resolution && video.streamInfo) {
            enhancedVideo.resolution = {
                width: video.streamInfo.width,
                height: video.streamInfo.height,
                fps: video.streamInfo.fps,
                bitrate: video.streamInfo.videoBitrate || video.streamInfo.totalBitrate
            };
        }
        
        // Ensure we have a preview URL for rendering in the UI
        if (!enhancedVideo.previewUrl && enhancedVideo.poster) {
            enhancedVideo.previewUrl = enhancedVideo.poster;
        }
        
        // If this is an HLS video, pre-compute some indicators for the UI
        if (video.type === 'hls' && video.url.includes('.m3u8')) {
            enhancedVideo.isHLS = true;
            
            // If this is a master playlist with variants, mark it as such
            if (video.qualityVariants && video.qualityVariants.length > 0) {
                enhancedVideo.isMasterPlaylist = true;
                enhancedVideo.qualityCount = video.qualityVariants.length;
                
                // Find the highest quality variant for preview
                const highestQuality = [...video.qualityVariants].sort((a, b) => {
                    return (b.bandwidth || 0) - (a.bandwidth || 0);
                })[0];
                
                if (highestQuality) {
                    enhancedVideo.highestQualityInfo = {
                        width: highestQuality.width,
                        height: highestQuality.height,
                        bandwidth: highestQuality.bandwidth,
                        fps: highestQuality.fps
                    };
                }
            }
        }
        
        // Include this video in the final output
        processedVideos.push(enhancedVideo);
    });
    
    return processedVideos;
}

// Track tab updates and removal
chrome.tabs.onRemoved.addListener((tabId) => {
    logDebug('Tab removed:', tabId);
    if (videosPerTab[tabId]) {
        logDebug('Cleaning up videos for tab:', tabId, 'Count:', videosPerTab[tabId].size);
        delete videosPerTab[tabId];
    }
    
    // Clean up any active downloads associated with the closed tab
    for (const [url, downloadInfo] of activeDownloads.entries()) {
        if (downloadInfo.tabId === tabId) {
            logDebug('Cleaning up download for closed tab:', url);
            activeDownloads.delete(url);
        }
    }
});

// Keep track of active downloads by URL
const activeDownloads = new Map(); // key = url, value = { progress, tabId, notificationId, lastUpdated, filename, etc. }
const downloadPorts = new Map(); // key = portId, value = port object

// Track all popup connections for universal communication
const popupPorts = new Map(); // key = portId, value = port object

// Handle port connections from popup
chrome.runtime.onConnect.addListener(port => {
    // Create unique port ID
    const portId = Date.now().toString();
    
    if (port.name === 'download_progress') {
        // Store in download-specific port collection
        downloadPorts.set(portId, port);

        // Set up message listener for this port
        port.onMessage.addListener((message) => {
            // Handle registration for specific download updates
            if (message.action === 'registerForDownload' && message.downloadUrl) {
                const downloadInfo = activeDownloads.get(message.downloadUrl);

                if (downloadInfo) {
                    logDebug('Sending immediate download state for URL:', message.downloadUrl);
                    try {
                        port.postMessage({
                            type: 'progress',
                            progress: downloadInfo.progress || 0,
                            url: message.downloadUrl,
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
        });

        // Handle port disconnection
        port.onDisconnect.addListener(() => {
            downloadPorts.delete(portId);
            logDebug('Download port disconnected and removed:', portId);
        });
    } else if (port.name === 'popup') {
        // Store in general popup port collection
        popupPorts.set(portId, port);
        logDebug('Popup connected with port ID:', portId);
        
        // Set up message listener for general popup communication
        port.onMessage.addListener((message) => {
            handlePortMessage(message, port, portId);
        });
        
        // Handle port disconnection
        port.onDisconnect.addListener(() => {
            popupPorts.delete(portId);
            logDebug('Popup port disconnected and removed:', portId);
        });
    }
});

// Handle messages coming through port connection
async function handlePortMessage(message, port, portId) {
    logDebug('Received port message:', message);
    
    // Handle video list request
    if (message.action === 'getVideos') {
        const tabId = message.tabId;
        
        if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
            port.postMessage({
                action: 'videoListResponse',
                videos: []
            });
            return;
        }
        
        // Convert Map to Array for sending
        const videos = Array.from(videosPerTab[tabId].values());
        videos.sort((a, b) => b.timestamp - a.timestamp);
        
        port.postMessage({
            action: 'videoListResponse',
            videos: videos
        });
    }
    
    // Handle stored playlists request
    else if (message.action === 'getStoredPlaylists') {
        const playlists = playlistsPerTab[message.tabId] 
            ? Array.from(playlistsPerTab[message.tabId])
            : [];
            
        port.postMessage({
            action: 'storedPlaylistsResponse',
            playlists: playlists
        });
    }
    
    // Handle preview generation
    else if (message.type === 'generatePreview') {
        // Check if we're already generating this preview
        const cacheKey = message.url;
        if (previewGenerationQueue.has(cacheKey)) {
            // If we are, wait for the existing promise
            const response = await previewGenerationQueue.get(cacheKey);
            port.postMessage({
                type: 'previewResponse',
                ...response,
                requestUrl: message.url
            });
            return;
        }

        // Create new preview generation promise
        const previewPromise = new Promise(resolve => {
            nativeHostService.sendMessage({
                type: 'generatePreview',
                url: message.url
            }).then(response => {
                previewGenerationQueue.delete(cacheKey);
                
                // If we successfully generated a preview, cache it with the video
                if (response && response.previewUrl && message.tabId && videosPerTab[message.tabId]) {
                    const normalizedUrl = normalizeUrl(message.url);
                    const videoInfo = videosPerTab[message.tabId].get(normalizedUrl);
                    if (videoInfo) {
                        videoInfo.previewUrl = response.previewUrl;
                        videosPerTab[message.tabId].set(normalizedUrl, videoInfo);
                    }
                }
                
                resolve(response);
            }).catch(error => {
                previewGenerationQueue.delete(cacheKey);
                resolve({ error: error.message });
            });
        });

        // Store the promise
        previewGenerationQueue.set(cacheKey, previewPromise);
        
        // Wait for the preview and send it
        const response = await previewPromise;
        port.postMessage({
            type: 'previewResponse',
            ...response,
            requestUrl: message.url
        });
    }
    
    // Handle download request
    else if (message.type === 'download' || message.type === 'downloadHLS') {
        // This is handled through the one-time message listener for now
        // We'll keep this compatibility during the transition period
    }
    
    // Handle stream qualities request
    else if (message.type === 'getHLSQualities') {
        console.log('🎥 Requesting media info from native host for:', message.url);
        
        try {
            const response = await nativeHostService.sendMessage({
                type: 'getQualities',
                url: message.url
            });
            
            port.postMessage({
                type: 'qualitiesResponse',
                url: message.url,
                ...response
            });
        } catch (error) {
            console.error('Error getting media info:', error);
            port.postMessage({
                type: 'qualitiesResponse',
                url: message.url,
                error: error.message
            });
        }
    }
    
    // Handle manifest-related operations
    else if (message.type === 'fetchManifest') {
        const content = await fetchManifestContent(message.url);
        port.postMessage({
            type: 'manifestContent',
            url: message.url,
            content: content
        });
    }
    else if (message.type === 'storeManifestRelationship') {
        message.variants.forEach(variant => {
            manifestRelationships.set(variant.url, {
                playlistUrl: message.playlistUrl,
                bandwidth: variant.bandwidth,
                resolution: variant.resolution,
                codecs: variant.codecs,
                fps: variant.fps
            });
        });
        
        port.postMessage({
            type: 'manifestRelationshipStored',
            success: true
        });
    }
    else if (message.type === 'getManifestRelationship') {
        const relationship = manifestRelationships.get(message.variantUrl) || null;
        port.postMessage({
            type: 'manifestRelationshipResponse',
            variantUrl: message.variantUrl,
            relationship: relationship
        });
    }
}

// Helper function to extract stream metadata
async function getStreamMetadata(url) {
    try {
        const response = await nativeHostService.sendMessage({
            type: 'getQualities',
            url: url
        });

        if (response?.streamInfo) {
            // Add variants if available
            if (response.streamInfo.type === 'hls' || response.streamInfo.type === 'dash') {
                try {
                    const manifestResponse = await fetch(url);
                    const content = await manifestResponse.text();
                    
                    // Use appropriate parser based on type
                    const variants = response.streamInfo.type === 'hls' ?
                        parseHLSManifest(content, url) :
                        parseDASHManifest(content, url);
                        
                    if (variants.length > 0) {
                        response.streamInfo.variants = variants;
                    }
                } catch (error) {
                    console.warn('Failed to fetch manifest:', error);
                }
            }
            return response.streamInfo;
        }
        return null;
    } catch (error) {
        console.error('Failed to get stream metadata:', error);
        return null;
    }
}

// Process metadata queue with retry mechanism
async function processMetadataQueue(maxConcurrent = 3, maxRetries = 2) {
    if (metadataProcessingQueue.size === 0) return;
    
    const entries = Array.from(metadataProcessingQueue.entries()).slice(0, maxConcurrent);
    const processPromises = entries.map(async ([url, info]) => {
        let retries = 0;
        while (retries < maxRetries) {
            try {
                metadataProcessingQueue.delete(url);
                const streamInfo = await getStreamMetadata(url);
                
                if (streamInfo) {
                    if (info.tabId && videosPerTab[info.tabId]) {
                        const normalizedUrl = normalizeUrl(url);
                        const existingVideo = videosPerTab[info.tabId].get(normalizedUrl);
                        if (existingVideo) {
                            // Update video with stream info
                            const updatedVideo = {
                                ...existingVideo,
                                streamInfo,
                                mediaInfo: streamInfo, // Add direct mediaInfo reference
                                qualities: streamInfo.variants || [],
                                resolution: {
                                    width: streamInfo.width,
                                    height: streamInfo.height,
                                    fps: streamInfo.fps,
                                    bitrate: streamInfo.videoBitrate || streamInfo.totalBitrate
                                }
                            };
                            
                            // Store updated video
                            videosPerTab[info.tabId].set(normalizedUrl, updatedVideo);
                            
                            // Broadcast update to popup if open
                            broadcastVideoUpdate(info.tabId);
                        }
                    }
                    break;
                }
                retries++;
            } catch (error) {
                console.error(`Failed to process metadata for ${url} (attempt ${retries + 1}):`, error);
                if (retries >= maxRetries - 1) break;
                await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
            }
        }
    });

    await Promise.all(processPromises);
    
    if (metadataProcessingQueue.size > 0) {
        setTimeout(() => processMetadataQueue(maxConcurrent, maxRetries), 100);
    }
}

// Extract variants from manifest content
function extractVariantsFromManifest(content, baseUrl, type) {
    const variants = [];
    
    if (type === 'hls') {
        // Basic HLS manifest parsing
        const lines = content.split('\n');
        let currentVariant = null;
        
        lines.forEach(line => {
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                currentVariant = {
                    bandwidth: extractAttribute(line, 'BANDWIDTH'),
                    resolution: extractAttribute(line, 'RESOLUTION'),
                    codecs: extractAttribute(line, 'CODECS')
                };
            } else if (line && !line.startsWith('#') && currentVariant) {
                currentVariant.url = resolveUrl(baseUrl, line.trim());
                variants.push(currentVariant);
                currentVariant = null;
            }
        });
    } else if (type === 'dash') {
        // Basic DASH manifest parsing
        try {
            const parser = new DOMParser();
            const xml = parser.parseFromString(content, 'text/xml');
            const representations = xml.querySelectorAll('Representation');
            
            representations.forEach(rep => {
                variants.push({
                    bandwidth: rep.getAttribute('bandwidth'),
                    width: rep.getAttribute('width'),
                    height: rep.getAttribute('height'),
                    codecs: rep.getAttribute('codecs')
                });
            });
        } catch (error) {
            console.error('Failed to parse DASH manifest:', error);
        }
    }
    
    return variants;
}

// Helper to extract attributes from HLS manifest
function extractAttribute(line, attr) {
    const match = new RegExp(attr + '=([^,]+)').exec(line);
    return match ? match[1].replace(/"/g, '') : null;
}

// Helper to resolve relative URLs
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch {
        return relative;
    }
}

// Single message listener for all messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request);
  
  // NEW: Handle newVideoDetected events from content script
  if (request.action === 'newVideoDetected' && request.videos && request.videos.length > 0) {
    const tabId = sender?.tab?.id;
    if (!tabId) return false;
    
    console.log(`Received ${request.videos.length} new videos from content script for tab ${tabId}`);
    
    // Process each video through the same pipeline
    request.videos.forEach(video => {
      addVideoToTab(tabId, {
        url: video.url,
        type: video.type,
        source: 'contentScript',
        poster: video.poster,
        title: video.title,
        foundFromQueryParam: video.foundFromQueryParam || false,
      });
    });
    
    return false;
  }
  
  // Handle download requests
  if (request.type === 'downloadHLS' || request.type === 'download') {
    const notificationId = `download-${Date.now()}`;
    let hasError = false;
    
    // Get all active download ports
    const ports = Array.from(downloadPorts.values());

    // Create response handler
    const responseHandler = (response) => {
      if (response && response.type === 'progress' && !hasError) {
        // Ensure all progress data is passed through, including confidence levels,
        // segment tracking, ETA, and other enhanced tracking metrics
        const enhancedResponse = {
          ...response,
          type: 'progress',
          // Format filename if available
          filename: response.filename || request.filename || getFilenameFromUrl(request.url),
          // Add URL for tracking
          url: request.url
        };
        
        // Store in activeDownloads map for reconnecting popups
        activeDownloads.set(request.url, {
          tabId: sender?.tab?.id || request.tabId || -1,
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
        
        // Debug log to help track what's being passed to UI
        logDebug('Forwarding progress data to UI:', enhancedResponse);
        
        // Forward progress to all connected popups (live iteration)
        for (const [portId, port] of downloadPorts.entries()) {
          try {
            port.postMessage(enhancedResponse);
          } catch (e) {
            console.error('Error sending progress to port:', e);
            downloadPorts.delete(portId);
            logDebug('Removed dead port after send failure:', portId);
          }
        }
      } else if (response && response.success && !hasError) {
        // On success, remove from active downloads
        activeDownloads.delete(request.url);
        handleDownloadSuccess(response, notificationId, ports);
      } else if (response && response.error && !hasError) {
        // On error, remove from active downloads
        activeDownloads.delete(request.url);
        hasError = true;
        handleDownloadError(response.error, notificationId, ports);
      }
    };

    // Show initial notification
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'Downloading Video',
      message: 'Starting download...'
    });

    // Send to native host using our service with enhanced parameters
    nativeHostService.sendMessage({
      type: 'download',
      url: request.url,
      filename: request.filename || 'video.mp4',
      savePath: request.savePath,
      quality: request.quality,
      manifestUrl: request.manifestUrl || request.url // Pass manifest URL for better progress tracking
    }, responseHandler).catch(error => {
      handleDownloadError(error.message, notificationId, ports);
    });

    return true; // Keep channel open for progress updates
  }

  // Handle video detection from content script
  if (request.action === 'addVideo') {
    const tabId = sender.tab?.id;
    if (tabId && tabId > 0) {
      addVideoToTab(tabId, request);
    }
    return false;
  }

  // Handle stored playlists request
  if (request.action === 'getStoredPlaylists') {
    const playlists = playlistsPerTab[request.tabId] 
      ? Array.from(playlistsPerTab[request.tabId])
      : [];
    sendResponse(playlists);
    return true;
  }

  // Handle videos list request
  if (request.action === 'getVideos') {
    const tabId = request.tabId;
    
    if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
      sendResponse([]);
      return true;
    }
    
    // Convert Map to Array for sending
    const videos = Array.from(videosPerTab[tabId].values());
    videos.sort((a, b) => b.timestamp - a.timestamp);
    sendResponse(videos);
    return true;
  }

  // Handle preview generation
  if (request.type === 'generatePreview') {
    // Check if we're already generating this preview
    const cacheKey = request.url;
    if (previewGenerationQueue.has(cacheKey)) {
      // If we are, wait for the existing promise
      previewGenerationQueue.get(cacheKey).then(sendResponse);
      return true;
    }

    // Create new preview generation promise
    const previewPromise = new Promise(resolve => {
      nativeHostService.sendMessage({
        type: 'generatePreview',
        url: request.url
      }).then(response => {
        previewGenerationQueue.delete(cacheKey);
        
        // If we successfully generated a preview, cache it with the video
        if (response && response.previewUrl && request.tabId && videosPerTab[request.tabId]) {
          const normalizedUrl = normalizeUrl(request.url);
          const videoInfo = videosPerTab[request.tabId].get(normalizedUrl);
          if (videoInfo) {
            videoInfo.previewUrl = response.previewUrl;
            videosPerTab[request.tabId].set(normalizedUrl, videoInfo);
          }
        }
        
        resolve(response);
      }).catch(error => {
        previewGenerationQueue.delete(cacheKey);
        resolve({ error: error.message });
      });
    });

    // Store the promise
    previewGenerationQueue.set(cacheKey, previewPromise);
    
    // Wait for the preview and send it
    previewPromise.then(sendResponse);
    return true;
  }

  // Handle stream qualities request
  if (request.type === 'getHLSQualities') {
    // Create promise for quality detection
    const qualityPromise = new Promise(resolve => {
      console.log('🎥 Requesting media info from native host for:', request.url);
      
      nativeHostService.sendMessage({
        type: 'getQualities',
        url: request.url
      }).then(response => {
        if (response?.streamInfo) {
          console.group('📊 Received media info from native host:');
          console.log('URL:', request.url);
          
          // Log video info if available
          if (response.streamInfo.hasVideo) {
            console.log('Video:', {
              codec: response.streamInfo.videoCodec.name,
              resolution: `${response.streamInfo.width}x${response.streamInfo.height}`,
              fps: response.streamInfo.fps,
              bitrate: response.streamInfo.videoBitrate ? 
                  `${(response.streamInfo.videoBitrate / 1000000).toFixed(2)} Mbps` : 'unknown'
            });
          }
          
          // Log audio info if available
          if (response.streamInfo.hasAudio) {
            console.log('Audio:', {
              codec: response.streamInfo.audioCodec.name,
              channels: response.streamInfo.audioCodec.channels,
              sampleRate: response.streamInfo.audioCodec.sampleRate ? 
                  `${response.streamInfo.audioCodec.sampleRate}Hz` : 'unknown'
            });
          }
          
          // Log duration and container info
          if (response.streamInfo.duration) {
            const minutes = Math.floor(response.streamInfo.duration / 60);
            const seconds = Math.floor(response.streamInfo.duration % 60);
            console.log('Duration:', `${minutes}:${seconds.toString().padStart(2, '0')}`);
          }
          console.log('Container:', response.streamInfo.container);
          
          // Process stream variants
          if (response.streamInfo.variants && response.streamInfo.variants.length > 0) {
            console.log('Available qualities:', response.streamInfo.variants.length);
            response.streamInfo.variants.forEach((variant, index) => {
              console.log(`Quality ${index + 1}:`, {
                resolution: variant.resolution || `${variant.width}x${variant.height}`,
                bitrate: variant.bandwidth ? 
                    `${(variant.bandwidth / 1000000).toFixed(2)} Mbps` : 'unknown',
                codecs: variant.codecs || 'unknown'
              });
            });
          }
          
          console.groupEnd();
          resolve({ streamInfo: response.streamInfo });
        } else {
          console.warn('❌ Failed to get media info:', response?.error || 'Unknown error');
          resolve(response);
        }
      }).catch(error => {
        console.error('Error getting media info:', error);
        resolve({ error: error.message });
      });
    });
    
    // Wait for quality info and send response
    qualityPromise.then(sendResponse);
    return true;
  }

  // Handle manifest fetching
  if (request.type === 'fetchManifest') {
    fetchManifestContent(request.url).then(content => {
        sendResponse({ content });
    });
    return true;
  }

  // Handle manifest relationship storage
  if (request.type === 'storeManifestRelationship') {
    request.variants.forEach(variant => {
        manifestRelationships.set(variant.url, {
            playlistUrl: request.playlistUrl,
            bandwidth: variant.bandwidth,
            resolution: variant.resolution,
            codecs: variant.codecs,
            fps: variant.fps
        });
    });
    sendResponse({ success: true });
    return true;
  }

  // Handle manifest relationship lookup
  if (request.type === 'getManifestRelationship') {
    sendResponse(manifestRelationships.get(request.variantUrl) || null);
    return true;
  }

  return false;
});

// Add URL normalization to prevent duplicates
function normalizeUrl(url) {
    // Don't normalize blob URLs
    if (url.startsWith('blob:')) {
        return url;
    }
    
    try {
        const urlObj = new URL(url);
        
        // Remove common parameters that don't affect the content
        urlObj.searchParams.delete('_t');
        urlObj.searchParams.delete('_r');
        urlObj.searchParams.delete('cache');
        urlObj.searchParams.delete('_');
        urlObj.searchParams.delete('time');
        urlObj.searchParams.delete('timestamp');
        urlObj.searchParams.delete('random');
        
        // For HLS and DASH, keep a more canonical form
        if (url.includes('.m3u8') || url.includes('.mpd')) {
            // Remove common streaming parameters
            urlObj.searchParams.delete('seq');
            urlObj.searchParams.delete('segment');
            urlObj.searchParams.delete('session');
            urlObj.searchParams.delete('cmsid');
            
            // For manifest files, simply use the path for better duplicate detection
            if (url.includes('/manifest') || url.includes('/playlist') ||
                url.includes('/master.m3u8') || url.includes('/index.m3u8')) {
                return urlObj.origin + urlObj.pathname;
            }
        }
        
        return urlObj.origin + urlObj.pathname + urlObj.search;
    } catch {
        return url;
    }
}

// Add video to tab's collection with enhanced metadata handling
async function addVideoToTab(tabId, videoInfo) {
    if (!videosPerTab[tabId]) {
        logDebug('Creating new video collection for tab:', tabId);
        videosPerTab[tabId] = new Map();
    }
    
    // Skip known ping/tracking URLs that don't have extracted video URLs
    if ((videoInfo.url.includes('ping.gif') || videoInfo.url.includes('jwpltx.com')) && !videoInfo.foundFromQueryParam) {
        logDebug('Skipping tracking URL without embedded video URL:', videoInfo.url);
        return;
    }

    const normalizedUrl = normalizeUrl(videoInfo.url);
    
    // Get existing video info if any
    const existingVideo = videosPerTab[tabId].get(normalizedUrl);
    
    // For URLs extracted from query params, use them for deduplication
    if (videoInfo.foundFromQueryParam) {
        // Log the original source URL that contained this video URL
        if (videoInfo.originalUrl) {
            logDebug('Using extracted URL instead of original tracking URL:', videoInfo.url, 
                    'extracted from:', videoInfo.originalUrl);
        } else {
            logDebug('Found video URL in query parameter:', videoInfo.url);
        }
    }
    
    // Check if this is actually a new video
    const isNewVideo = !existingVideo;
    
    // Merge with existing data if present
    if (existingVideo) {
        logDebug('Updating existing video:', normalizedUrl);
        videoInfo = {
            ...existingVideo,
            ...videoInfo,
            // Preserve important existing fields
            timestamp: existingVideo.timestamp || Date.now(),
            streamInfo: existingVideo.streamInfo || null,
            qualities: existingVideo.qualities || [],
            // Update only if new data is present
            poster: videoInfo.poster || existingVideo.poster,
            title: videoInfo.title || existingVideo.title,
            // Preserve or update foundFromQueryParam flag
            foundFromQueryParam: videoInfo.foundFromQueryParam || existingVideo.foundFromQueryParam
        };
    } else {
        logDebug('Adding new video:', normalizedUrl);
        videoInfo.timestamp = Date.now();
    }
    
    // Store video info
    videosPerTab[tabId].set(normalizedUrl, videoInfo);
    logDebug('Current video count for tab', tabId, ':', videosPerTab[tabId].size);
    
    // Use the centralized manifest service to check for and process relationships
    if (!videoInfo.isVariant && !videoInfo.isMasterPlaylist && 
        (videoInfo.type === 'hls' || videoInfo.type === 'dash')) {
        try {
            // Process this video to check for master-variant relationships
            const processedVideo = await processVideoRelationships(videoInfo);
            
            // If the video was enhanced with relationship info, update it
            if (processedVideo !== videoInfo) {
                logDebug('Video was processed and enhanced with relationship data:', 
                         processedVideo.isVariant ? 'Is variant' : 
                         processedVideo.isMasterPlaylist ? 'Is master playlist' : 'No relationships');
                
                // Update in collection
                videosPerTab[tabId].set(normalizedUrl, processedVideo);
                videoInfo = processedVideo;
            }
        } catch (error) {
            console.error('Error processing video relationships:', error);
        }
    }
    
    // Add to metadata processing queue
    if (!metadataProcessingQueue.has(normalizedUrl)) {
        metadataProcessingQueue.set(normalizedUrl, {
            ...videoInfo,
            tabId,
            timestamp: videoInfo.timestamp
        });
        processMetadataQueue();
    }
    
    // For HLS playlists, also add to that specific collection
    if (videoInfo.type === 'hls' && videoInfo.url.includes('.m3u8')) {
        if (!playlistsPerTab[tabId]) {
            playlistsPerTab[tabId] = new Set();
        }
        playlistsPerTab[tabId].add(normalizedUrl);
    }
    
    console.log(`Added ${videoInfo.type} video to tab ${tabId}:`, videoInfo.url);
    
    // After processing relationships, group videos and broadcast update
    if (isNewVideo) {
        // Apply automatic grouping and filtering before broadcasting
        broadcastVideoUpdate(tabId);
    }
}

// Extract filename from URL
function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        if (filename && filename.length > 0) {
            return filename;
        }
    } catch {}
    
    return 'video';
}

// Listen for web requests to catch video-related content
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const url = details.url;
        // Check for HLS, DASH, and direct video files
        if (
            url.includes('.m3u8') || 
            url.includes('.mpd') || 
            /\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)
        ) {
            // Determine type
            let type = 'unknown';
            if (url.includes('.m3u8')) {
                type = 'hls';
            } else if (url.includes('.mpd')) {
                type = 'dash';
            } else if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)(\?|$)/i.test(url)) {
                type = 'direct';
            }
            
            // Add video
            addVideoToTab(details.tabId, {
                url: url,
                type: type,
                source: 'webRequest'
            });
        }
    },
    { urls: ["<all_urls>"] }
);

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete videosPerTab[tabId];
    delete playlistsPerTab[tabId];
    
    // Clear manifest relationships for this tab's URLs
    for (const [url, info] of manifestRelationships.entries()) {
        if (url.includes(tabId.toString())) {
            manifestRelationships.delete(url);
        }
    }
});

function handleDownloadSuccess(response, notificationId, ports) {
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
      logDebug('Removed dead port after success failure:', portId);
    }
  }
}

function handleDownloadError(error, notificationId, ports) {
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
      logDebug('Removed dead port after error failure:', portId);
    }
  }
}

// Helper function to fetch manifest content
async function fetchManifestContent(url) {
    try {
        const response = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            headers: {
                'Accept': '*/*'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
        }
        
        return await response.text();
    } catch (error) {
        console.error('Error fetching manifest:', error);
        if (error instanceof TypeError && error.message === 'Failed to fetch') {
            console.error('This might be due to CORS restrictions or the server being unavailable');
        }
        return null;
    }
}

// New helper function to fetch and process HLS manifests to identify master-variant relationships
async function fetchHLSManifest(url, tabId) {
    try {
        // Only process HLS URLs
        if (!url.includes('.m3u8')) return null;
        
        // Check cache first
        const normalizedUrl = normalizeUrl(url);
        if (masterPlaylistCache.has(normalizedUrl)) {
            return masterPlaylistCache.get(normalizedUrl);
        }
        
        // Fetch the content
        const content = await fetchManifestContent(url);
        if (!content) return null;
        
        // Parse manifest
        const manifestInfo = parseHLSManifest(content, url);
        
        // If this is a master playlist with variants, process the relationship
        if (manifestInfo && manifestInfo.isPlaylist && manifestInfo.variants && manifestInfo.variants.length > 0) {
            logDebug('Found master HLS playlist with variants:', url, 'Variants:', manifestInfo.variants.length);
            
            // Store in cache
            const enhancedVideo = {
                url: url,
                type: 'hls',
                isPlaylist: true,
                isMasterPlaylist: true,
                qualityVariants: manifestInfo.variants.map(v => ({
                    url: v.url,
                    width: v.width,
                    height: v.height,
                    fps: v.fps,
                    bandwidth: v.bandwidth,
                    codecs: v.codecs
                }))
            };
            
            // Store in master playlist cache
            masterPlaylistCache.set(normalizedUrl, enhancedVideo);
            
            // Also store the relationship between variants and master
            manifestInfo.variants.forEach(variant => {
                const variantNormalizedUrl = normalizeUrl(variant.url);
                manifestRelationsCache.set(variantNormalizedUrl, {
                    masterUrl: url,
                    masterNormalizedUrl: normalizedUrl
                });
                
                // If we already have this variant in our collection, mark it as part of a master playlist
                if (videosPerTab[tabId] && videosPerTab[tabId].has(variantNormalizedUrl)) {
                    const variantVideo = videosPerTab[tabId].get(variantNormalizedUrl);
                    variantVideo.isVariant = true;
                    variantVideo.masterUrl = url;
                    videosPerTab[tabId].set(variantNormalizedUrl, variantVideo);
                    
                    logDebug('Updated existing variant with master relationship:', variant.url);
                }
            });
            
            return enhancedVideo;
        }
        
        return null;
    } catch (error) {
        console.error('Failed to fetch/parse HLS manifest:', error);
        return null;
    }
}

// Store detected videos in local storage for immediate access by popup
async function storeProcessedVideosInStorage(videos, tabId) {
    // Process videos for immediate display
    const processedVideos = processVideosForBroadcast(videos);
    
    if (processedVideos && processedVideos.length > 0) {
        try {
            // Store both the videos and a timestamp
            await chrome.storage.local.set({
                [`processedVideos_${tabId}`]: processedVideos,
                [`processedVideosTimestamp_${tabId}`]: Date.now()
            });
            
            console.log(`[Background] Stored ${processedVideos.length} processed videos for tab ${tabId} in local storage`);
        } catch (error) {
            console.error('[Background] Error storing processed videos in local storage:', error);
        }
    }
}

// When videos are detected, process them immediately and store
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle video detection messages
    if (request.action === 'videoSourceFound' || request.action === 'foundVideos') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            console.error('[Background] No tab ID in sender:', sender);
            return;
        }
        
        console.log(`[Background] Received ${request.videos?.length || 0} videos from tab ${tabId}`);
        
        // Update the videos map for this tab
        const videos = request.videos || [];
        if (videos.length > 0) {
            detectionsPerTab.set(tabId, videos);
            
            // Process and store videos in local storage for instant access by popup
            storeProcessedVideosInStorage(videos, tabId);
            
            // Broadcast to any open popups to refresh
            chrome.runtime.sendMessage({
                action: 'videoUpdated',
                tabId: tabId,
                count: videos.length
            }).catch(error => {
                // This error is expected if no popup is listening
                if (!error.message.includes('Receiving end does not exist')) {
                    console.error('[Background] Error broadcasting video update:', error);
                }
            });
        }
    }
    
    // Handle other message types...
    if (request.action === 'newVideoDetected' && request.videos && request.videos.length > 0) {
        const tabId = sender?.tab?.id;
        if (!tabId) return false;
        
        console.log(`Received ${request.videos.length} new videos from content script for tab ${tabId}`);
        
        // Process each video through the same pipeline
        request.videos.forEach(video => {
          addVideoToTab(tabId, {
            url: video.url,
            type: video.type,
            source: 'contentScript',
            poster: video.poster,
            title: video.title,
            foundFromQueryParam: video.foundFromQueryParam || false,
          });
        });
        
        return false;
      }
      
      // Handle download requests
      if (request.type === 'downloadHLS' || request.type === 'download') {
        const notificationId = `download-${Date.now()}`;
        let hasError = false;
        
        // Get all active download ports
        const ports = Array.from(downloadPorts.values());
    
        // Create response handler
        const responseHandler = (response) => {
          if (response && response.type === 'progress' && !hasError) {
            // Ensure all progress data is passed through, including confidence levels,
            // segment tracking, ETA, and other enhanced tracking metrics
            const enhancedResponse = {
              ...response,
              type: 'progress',
              // Format filename if available
              filename: response.filename || request.filename || getFilenameFromUrl(request.url),
              // Add URL for tracking
              url: request.url
            };
            
            // Store in activeDownloads map for reconnecting popups
            activeDownloads.set(request.url, {
              tabId: sender?.tab?.id || request.tabId || -1,
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
            
            // Debug log to help track what's being passed to UI
            logDebug('Forwarding progress data to UI:', enhancedResponse);
            
            // Forward progress to all connected popups
            ports.forEach(port => {
              try {
                port.postMessage(enhancedResponse);
              } catch (e) {
                console.error('Error sending progress to port:', e);
              }
            });
          } else if (response && response.success && !hasError) {
            // On success, remove from active downloads
            activeDownloads.delete(request.url);
            handleDownloadSuccess(response, notificationId, ports);
          } else if (response && response.error && !hasError) {
            // On error, remove from active downloads
            activeDownloads.delete(request.url);
            hasError = true;
            handleDownloadError(response.error, notificationId, ports);
          }
        };
    
        // Show initial notification
        chrome.notifications.create(notificationId, {
          type: 'basic',
          iconUrl: 'icons/48.png',
          title: 'Downloading Video',
          message: 'Starting download...'
        });
    
        // Send to native host using our service with enhanced parameters
        nativeHostService.sendMessage({
          type: 'download',
          url: request.url,
          filename: request.filename || 'video.mp4',
          savePath: request.savePath,
          quality: request.quality,
          manifestUrl: request.manifestUrl || request.url // Pass manifest URL for better progress tracking
        }, responseHandler).catch(error => {
          handleDownloadError(error.message, notificationId, ports);
        });
    
        return true; // Keep channel open for progress updates
      }
    
      // Handle video detection from content script
      if (request.action === 'addVideo') {
        const tabId = sender.tab?.id;
        if (tabId && tabId > 0) {
          addVideoToTab(tabId, request);
        }
        return false;
      }
    
      // Handle stored playlists request
      if (request.action === 'getStoredPlaylists') {
        const playlists = playlistsPerTab[request.tabId] 
          ? Array.from(playlistsPerTab[request.tabId])
          : [];
        sendResponse(playlists);
        return true;
      }
    
      // Handle videos list request
      if (request.action === 'getVideos') {
        const tabId = request.tabId;
        
        if (!videosPerTab[tabId] || videosPerTab[tabId].size === 0) {
          sendResponse([]);
          return true;
        }
        
        // Convert Map to Array for sending
        const videos = Array.from(videosPerTab[tabId].values());
        videos.sort((a, b) => b.timestamp - a.timestamp);
        sendResponse(videos);
        return true;
      }
    
      // Handle preview generation
      if (request.type === 'generatePreview') {
        // Check if we're already generating this preview
        const cacheKey = request.url;
        if (previewGenerationQueue.has(cacheKey)) {
          // If we are, wait for the existing promise
          previewGenerationQueue.get(cacheKey).then(sendResponse);
          return true;
        }
    
        // Create new preview generation promise
        const previewPromise = new Promise(resolve => {
          nativeHostService.sendMessage({
            type: 'generatePreview',
            url: request.url
          }).then(response => {
            previewGenerationQueue.delete(cacheKey);
            
            // If we successfully generated a preview, cache it with the video
            if (response && response.previewUrl && request.tabId && videosPerTab[request.tabId]) {
              const normalizedUrl = normalizeUrl(request.url);
              const videoInfo = videosPerTab[request.tabId].get(normalizedUrl);
              if (videoInfo) {
                videoInfo.previewUrl = response.previewUrl;
                videosPerTab[request.tabId].set(normalizedUrl, videoInfo);
              }
            }
            
            resolve(response);
          }).catch(error => {
            previewGenerationQueue.delete(cacheKey);
            resolve({ error: error.message });
          });
        });
    
        // Store the promise
        previewGenerationQueue.set(cacheKey, previewPromise);
        
        // Wait for the preview and send it
        previewPromise.then(sendResponse);
        return true;
      }
    
      // Handle stream qualities request
      if (request.type === 'getHLSQualities') {
        // Create promise for quality detection
        const qualityPromise = new Promise(resolve => {
          console.log('🎥 Requesting media info from native host for:', request.url);
          
          nativeHostService.sendMessage({
            type: 'getQualities',
            url: request.url
          }).then(response => {
            if (response?.streamInfo) {
              console.group('📊 Received media info from native host:');
              console.log('URL:', request.url);
              
              // Log video info if available
              if (response.streamInfo.hasVideo) {
                console.log('Video:', {
                  codec: response.streamInfo.videoCodec.name,
                  resolution: `${response.streamInfo.width}x${response.streamInfo.height}`,
                  fps: response.streamInfo.fps,
                  bitrate: response.streamInfo.videoBitrate ? 
                      `${(response.streamInfo.videoBitrate / 1000000).toFixed(2)} Mbps` : 'unknown'
                });
              }
              
              // Log audio info if available
              if (response.streamInfo.hasAudio) {
                console.log('Audio:', {
                  codec: response.streamInfo.audioCodec.name,
                  channels: response.streamInfo.audioCodec.channels,
                  sampleRate: response.streamInfo.audioCodec.sampleRate ? 
                      `${response.streamInfo.audioCodec.sampleRate}Hz` : 'unknown'
                });
              }
              
              // Log duration and container info
              if (response.streamInfo.duration) {
                const minutes = Math.floor(response.streamInfo.duration / 60);
                const seconds = Math.floor(response.streamInfo.duration % 60);
                console.log('Duration:', `${minutes}:${seconds.toString().padStart(2, '0')}`);
              }
              console.log('Container:', response.streamInfo.container);
              
              // Process stream variants
              if (response.streamInfo.variants && response.streamInfo.variants.length > 0) {
                console.log('Available qualities:', response.streamInfo.variants.length);
                response.streamInfo.variants.forEach((variant, index) => {
                  console.log(`Quality ${index + 1}:`, {
                    resolution: variant.resolution || `${variant.width}x${variant.height}`,
                    bitrate: variant.bandwidth ? 
                        `${(variant.bandwidth / 1000000).toFixed(2)} Mbps` : 'unknown',
                    codecs: variant.codecs || 'unknown'
                  });
                });
              }
              
              console.groupEnd();
              resolve({ streamInfo: response.streamInfo });
            } else {
              console.warn('❌ Failed to get media info:', response?.error || 'Unknown error');
              resolve(response);
            }
          }).catch(error => {
            console.error('Error getting media info:', error);
            resolve({ error: error.message });
          });
        });
        
        // Wait for quality info and send response
        qualityPromise.then(sendResponse);
        return true;
      }
    
      // Handle manifest fetching
      if (request.type === 'fetchManifest') {
        fetchManifestContent(request.url).then(content => {
            sendResponse({ content });
        });
        return true;
      }
    
      // Handle manifest relationship storage
      if (request.type === 'storeManifestRelationship') {
        request.variants.forEach(variant => {
            manifestRelationships.set(variant.url, {
                playlistUrl: request.playlistUrl,
                bandwidth: variant.bandwidth,
                resolution: variant.resolution,
                codecs: variant.codecs,
                fps: variant.fps
            });
        });
        sendResponse({ success: true });
        return true;
      }
    
      // Handle manifest relationship lookup
      if (request.type === 'getManifestRelationship') {
        sendResponse(manifestRelationships.get(request.variantUrl) || null);
        return true;
      }
    
      return false;
    });