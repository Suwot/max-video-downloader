/**
 * HLS Parser
 * Pure JavaScript-based parsing of HLS manifests without FFprobe
 * Provides lightweight and full parsing capabilities for HLS content
 */

import { 
    calculateEstimatedFileSizeBytes,
    resolveUrl
} from './parser-utils.js';
import { fetchManifest } from './manifest-fetcher.js';
import { createLogger } from '../../shared/utils/logger.js';
import { standardizeResolution, normalizeUrl, getBaseDirectory } from '../../shared/utils/processing-utils.js';

// Create a logger for the HLS parser
const logger = createLogger('HLS Parser');
logger.setLevel('ERROR');

// Track URLs currently being processed to prevent duplicates
const processingUrls = new Set();

/**
 * Parse an HLS playlist and organize content by type
 * First validates if it's really an HLS manifest using universal validator
 * 
 * @param {string} url - URL of the HLS manifest
 * @returns {Promise<Object>} Validated and parsed HLS content with videoTracks
 */
export async function parseHlsManifest(videoObject) {
    const { url, headers, metadata, tabId, normalizedUrl } = videoObject;

    // Skip if already being processed
    if (processingUrls.has(normalizedUrl)) {
        return { 
            status: 'processing',
            isValid: false,
            isMaster: false,
            isVariant: false,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: [],
            closedCaptions: [],
            hasMediaGroups: false
        };
    }
    
    // Mark as being processed
    processingUrls.add(normalizedUrl);
    
    try {
        logger.debug(`Fetching manifest: ${url} with headers:`, headers);
        
        // Fetch manifest content
        const fetchResult = await fetchManifest(url, headers);
        const timestampValidated = Date.now();
        
        // Early return if fetch failed
        if (!fetchResult.success) {
            logger.warn(`Failed to fetch manifest: ${url} (${fetchResult.status})`);
            return {
                status: 'fetch-failed',
                isValid: false,
                timestampValidated,
                isMaster: false,
                isVariant: false,
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: [],
                closedCaptions: [],
                hasMediaGroups: false
            };
        }
        
        const content = fetchResult.content;
        
        // Validate HLS format
        if (!content.includes('#EXTM3U')) {
            logger.warn(`Not a valid HLS manifest: ${url}`);
            return {
                status: 'invalid-format',
                isValid: false,
                timestampValidated,
                isMaster: false,
                isVariant: false,
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: [],
                closedCaptions: [],
                hasMediaGroups: false
            };
        }
        
        // Determine HLS type
        const isMaster = content.includes('#EXT-X-STREAM-INF');
        const isVariant = !isMaster && content.includes('#EXTINF');
        
        logger.debug(`Confirmed valid HLS ${isMaster ? 'master' : (isVariant ? 'variant' : 'unknown')} manifest: ${url}`);
        logger.debug(`Using validation results: isMaster=${isMaster}, isVariant=${isVariant}`);
        
        const baseUrl = getBaseDirectory(url);
        
        // For master playlists, parse video tracks
        let videoTracks = [];
        let duration = null;
        let segmentCount = null;
        let isEncrypted = false;
        let encryptionType = null;
        let isLive = false;
        let version = null; 
        let subtitleTracks = [];
        let closedCaptions = [];
        let audioTracks = [];
        let hasMediaGroups = false;

        if (isMaster) {
            // Parse the master playlist to extract variant URLs, subtitle tracks, and closed captions
            logger.debug(`Parsing HLS master playlist content: ${content.substring(0, 100)}...`);
            const masterParseResult = parseHlsMaster(content, baseUrl, url);

            // Store version from master playlist
            version = masterParseResult.version;
            subtitleTracks = masterParseResult.subtitleTracks || [];
            closedCaptions = masterParseResult.closedCaptions || [];
            audioTracks = masterParseResult.audioTracks || [];
            hasMediaGroups = masterParseResult.hasMediaGroups || false;

            // Prepare video tracks array with basic info
            videoTracks = masterParseResult.videoTracks || [];
            
            // Attach headers to video tracks for downstream use
            if (headers) {
                for (const videoTrack of videoTracks) {
                    videoTrack.headers = headers;
                }
            }
            
            // Combine all tracks for duration extraction attempt (all tracks have URLs by design)
            const allTracksWithUrls = [
                ...videoTracks,
                ...audioTracks,
                ...subtitleTracks
            ];
            
            logger.debug(`Found ${allTracksWithUrls.length} tracks for metadata extraction (${videoTracks?.length} video, ${audioTracks?.length} audio, ${subtitleTracks?.length} subtitle)`);
            
            // Try up to 3 tracks for metadata extraction
            let variantInfo = null;
            let successfulTrackIndex = -1;
            
            for (let i = 0; i < Math.min(3, allTracksWithUrls.length); i++) {
                try {
                    const currentTrack = allTracksWithUrls[i];
                    const trackType = videoTracks.includes(currentTrack) ? 'video' : 
                                     audioTracks.includes(currentTrack) ? 'audio' : 'subtitle';
                    
                    logger.debug(`Trying track ${i + 1}/${Math.min(3, allTracksWithUrls.length)} (${trackType}): ${currentTrack.url}`);
                    
                    variantInfo = await parseHlsVariant(currentTrack.url, headers, tabId);
                    
                    if (variantInfo) {
                        logger.debug(`Successfully fetched metadata from ${trackType} track ${i + 1}`);
                        successfulTrackIndex = i;
                        
                        // If it's live, stop iteration immediately regardless of duration
                        if (variantInfo.isLive) {
                            logger.debug('Detected live stream - stopping variant iteration');
                            break;
                        }
                        
                        // If it's VOD with duration, we're done
                        if (variantInfo.duration !== null) {
                            logger.debug('Got duration from VOD stream - stopping iteration');
                            break;
                        }
                    }
                } catch (error) {
                    logger.warn(`Failed to fetch track ${i + 1}: ${error.message}`);
                }
            }
            
            if (variantInfo) {
                // Extract metadata from successful track
                duration = variantInfo.isLive ? null : variantInfo.duration; // No duration for live streams
                segmentCount = variantInfo.isLive ? null : variantInfo.segmentCount; // No segment count for live streams
                isEncrypted = variantInfo.isEncrypted || false;
                encryptionType = variantInfo.encryptionType;
                isLive = variantInfo.isLive || false;
                
                // Propagate metadata to all video tracks
                videoTracks = videoTracks.map((videoTrack, index) => {
                    const updatedVideoTrack = { ...videoTrack };
                    updatedVideoTrack.metaJS.duration = duration;
                    updatedVideoTrack.metaJS.isLive = isLive;
                    updatedVideoTrack.metaJS.isEncrypted = isEncrypted;
                    updatedVideoTrack.metaJS.encryptionType = encryptionType;
                    updatedVideoTrack.metaJS.segmentCount = segmentCount;
                    updatedVideoTrack.metaJS.version = variantInfo.version || version;
                    
                    // Mark the track that was actually fetched
                    if (successfulTrackIndex >= 0 && videoTrack === allTracksWithUrls[successfulTrackIndex]) {
                        updatedVideoTrack.metaJS.directlyFetched = true;
                    }
                    
                    // Calculate estimated file size based on bandwidth and duration
                    if (duration !== null && duration >= 0) {
                        const effectiveBandwidth = updatedVideoTrack.metaJS.averageBandwidth || updatedVideoTrack.metaJS.bandwidth;
                        updatedVideoTrack.metaJS.estimatedFileSizeBytes = calculateEstimatedFileSizeBytes(
                            effectiveBandwidth, 
                            duration
                        );
                    }
                    
                    return updatedVideoTrack;
                });
                
                // Propagate metadata to all audio tracks
                audioTracks = audioTracks.map(track => {
                    if (track.url) {
                        const updatedTrack = { ...track };
                        updatedTrack.duration = duration;
                        updatedTrack.isLive = isLive;
                        updatedTrack.segmentCount = segmentCount;  // Add missing segmentCount
                        updatedTrack.version = variantInfo.version || version;
                        return updatedTrack;
                    }
                    return track;
                });
                
                logger.debug(`Propagated metadata to ${videoTracks.length} video tracks and ${audioTracks.filter(t => t.url).length} audio tracks`);
            } else {
                logger.warn('No valid tracks found for metadata extraction - will set noDuration flag');
                duration = null;
            }
        }
        else if (isVariant) {
            // For variant playlists, extract duration and encryption info directly
            logger.debug(`Parsing standalone variant playlist`);
            const variantInfo = calculateHlsVariantDuration(content);
            duration = variantInfo.duration;
            segmentCount = variantInfo.segmentCount;
            isLive = variantInfo.isLive;
            
            logger.debug(`Variant duration: ${duration}s, segmentCount: ${segmentCount}, isLive: ${isLive}`);
            
            // Extract encryption info
            const encryptionInfo = extractHlsEncryptionInfo(content);
            isEncrypted = encryptionInfo.isEncrypted;
            encryptionType = encryptionInfo.encryptionType;
            
            // Extract HLS version for standalone variant
            version = extractHlsVersion(content);
            logger.debug(`Standalone variant version: ${version}`);
            
            // Create a single-item video tracks array with HLS defaults
            videoTracks = [{
                url: url,
                normalizedUrl: normalizedUrl,
                masterUrl: null,
                hasKnownMaster: false,
                type: 'hls',
                isVariant: true,
                // HLS defaults - container-first logic will handle audio-only cases
                videoContainer: 'mp4',
                audioContainer: 'm4a',
                metaJS: {
                    duration: duration,
                    isLive: isLive,
                    segmentCount: variantInfo.segmentCount,
                    isEncrypted: isEncrypted,
                    encryptionType: encryptionType,
                    version: version
                },
                source: 'parseHlsManifest()',
                timestampDetected: Date.now()
            }];
            
            logger.debug(`Created standalone video track entry with container info: ${JSON.stringify(videoTracks[0])}`);
        }
        
        // Set the parsing completion timestamp
        const timestampParsed = Date.now();

        // Construct the full result with standardized structure
        const result = {
            url: url,
            normalizedUrl: normalizedUrl,
            type: 'hls',
            isValid: true,
            isMaster: isMaster,
            isVariant: isVariant,
            timestampValidated: timestampValidated,
            timestampParsed: timestampParsed,
            duration: duration,
            segmentCount: segmentCount,  // Add segmentCount at main level for easy access
            isLive: isLive,
            isEncrypted: isEncrypted,
            encryptionType: encryptionType,
            version: version,
            // Standardized structure
            videoTracks: videoTracks,
            audioTracks: audioTracks,
            subtitleTracks: subtitleTracks,
            closedCaptions: closedCaptions,
            hasMediaGroups: hasMediaGroups,
            status: 'success'
        };
        
        // Add noDuration flag if no duration could be extracted from any track
        if (duration === null && isMaster) {
            result.noDuration = true;
            logger.debug('Added noDuration flag - no valid tracks found for duration extraction');
        }

        logger.info(`Successfully parsed HLS: found ${videoTracks.length} video tracks, ${audioTracks?.length} audio tracks, ${subtitleTracks?.length} subtitle tracks, ${closedCaptions?.length} closed caption tracks`);
        return result;
    } catch (error) {
        logger.error(`Error parsing HLS: ${error.message}`);
        return { 
            status: 'parse-error',
            error: error.message,
            isValid: false,
            timestampValidated: Date.now(),
            isMaster: false,
            isVariant: false,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: [],
            closedCaptions: [],
            hasMediaGroups: false
        };
    } finally {
        // Clean up processing tracking
        processingUrls.delete(normalizedUrl);
    }
}

/**
 * Parse HLS master playlist content to extract variant information
 * Uses shared variant entry extraction logic for consistency and minimal codebase
 * 
 * @param {string} content - The playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL
 * @returns {Object} Object containing videoTracks array and playlist info
 */
function parseHlsMaster(content, baseUrl, masterUrl) {
    // Extract the HLS version from the master playlist
    const version = extractHlsVersion(content);
    logger.debug(`Processing master playlist v: ${version} with ${content.split(/\r?\n/).length} lines`);

    // Use the unified variant entry extraction
    const variantEntries = extractMasterVariantEntries(content, baseUrl, masterUrl);

    // Build video track objects
    const videoTracks = variantEntries.map(entry => {
        
        return {
            id: `video-${entry.streamInf.bandwidth || 'unknown'}-${entry.streamInf.height || 'p'}`,
            url: entry.url,
            normalizedUrl: entry.normalizedUrl,
            masterUrl: masterUrl,
            hasKnownMaster: true,
            type: 'hls',
            isVariant: true,
            isUsedForEmbeddedAudio: false,  // Flag for tracking embedded audio usage
            // Container information for download
            videoContainer: entry.streamInf.videoContainer || null,
            audioContainer: entry.streamInf.audioContainer || null,
            metaJS: {
                bandwidth: entry.streamInf.bandwidth,
                averageBandwidth: entry.streamInf.averageBandwidth,
                codecs: entry.streamInf.codecs,
                resolution: entry.streamInf.resolution,
                width: entry.streamInf.width,
                height: entry.streamInf.height,
                standardizedResolution: entry.streamInf.height ? standardizeResolution(entry.streamInf.height) : null,
                fps: entry.streamInf.fps,

                audioGroup: entry.streamInf.audioGroup,
                videoGroup: entry.streamInf.videoGroup,
                subtitleGroup: entry.streamInf.subtitleGroup,
                ccGroup: entry.streamInf.ccGroup
            },
            source: 'parseHlsMaster()',
            timestampDetected: Date.now()
        };
    });

    // --- Audio, subtitle and closed caption track detection ---
    // Parse #EXT-X-MEDIA:TYPE=AUDIO, TYPE=SUBTITLES and TYPE=CLOSED-CAPTIONS lines
    const audioTracks = [];
    const subtitleTracks = [];
    const closedCaptions = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA:')) {
            // Parse attributes
            const attrPattern = /([A-Z0-9\-]+)=(("[^"]*")|([^,]*))/g;
            let match;
            const attrs = {};
            while ((match = attrPattern.exec(line)) !== null) {
                const key = match[1];
                let value = match[3] || match[4] || '';
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                attrs[key] = value;
            }
            if (/TYPE=AUDIO/.test(line)) {
                // Detect audio container - HLS audio tracks are typically AAC in M4A (MP4 audio)
                // Since HLS is almost always MP4-compatible, audio should be M4A not MP3
                let audioUrl = null;
                let matchedVideoTrack = null;
                let isEmbedded = false;
                
                if (attrs['URI']) {
                    // Has URI - use directly
                    audioUrl = resolveUrl(baseUrl, attrs['URI']);
                } else {
                    // No URI - find matching video track by group
                    const audioGroupId = attrs['GROUP-ID'];
                    matchedVideoTrack = videoTracks.find(vt => vt.metaJS.audioGroup === audioGroupId);
                    
                    if (matchedVideoTrack) {
                        audioUrl = matchedVideoTrack.url;
                        matchedVideoTrack.isUsedForEmbeddedAudio = true;  // Mark as used
                        isEmbedded = true;
                    }
                    // If no match found, audioUrl stays null → track will be omitted
                }
                
                // Only add if we have a valid URL
                if (audioUrl) {
                    audioTracks.push({
                        id: `audio-${attrs['GROUP-ID'] || 'default'}-${attrs['NAME'] || audioTracks.length}`,
                        groupId: attrs['GROUP-ID'] || null,
                        name: attrs['NAME'] || null,
                        language: attrs['LANGUAGE'] || null,
                        url: audioUrl,
                        normalizedUrl: normalizeUrl(audioUrl),
                        default: attrs['DEFAULT'] === 'YES',
                        autoselect: attrs['AUTOSELECT'] === 'YES',
                        characteristics: attrs['CHARACTERISTICS'] || null,
                        channels: attrs['CHANNELS'] ? `${attrs['CHANNELS']} ch` : null,
                        assocLanguage: attrs['ASSOC-LANGUAGE'] || null,
                        isEmbedded: isEmbedded,  // Flag for embedded audio
                        // Container information for download - HLS audio is always M4A
                        audioContainer: 'm4a'
                    });
                }
            } else if (/TYPE=SUBTITLES/.test(line)) {
                // Only add subtitle tracks that have URIs
                if (attrs['URI']) {
                    const subtitleUrl = resolveUrl(baseUrl, attrs['URI']);
                    
                    subtitleTracks.push({
                        id: `subtitle-${attrs['GROUP-ID'] || 'default'}-${attrs['NAME'] || subtitleTracks.length}`,
                        groupId: attrs['GROUP-ID'] || null,
                        name: attrs['NAME'] || null,
                        language: attrs['LANGUAGE'] || null,
                        url: subtitleUrl,
                        normalizedUrl: normalizeUrl(subtitleUrl),
                        default: attrs['DEFAULT'] === 'YES',
                        autoselect: attrs['AUTOSELECT'] === 'YES',
                        forced: attrs['FORCED'] === 'YES',
                        characteristics: attrs['CHARACTERISTICS'] || null,
                        instreamId: attrs['INSTREAM-ID'] || null,
                        // Container information for download - HLS subtitles are always VTT
                        subtitleContainer: 'vtt'
                    });
                }
            } else if (/TYPE=CLOSED-CAPTIONS/.test(line)) {
                closedCaptions.push({
                    groupId: attrs['GROUP-ID'] || null,
                    name: attrs['NAME'] || null,
                    language: attrs['LANGUAGE'] || null,
                    instreamId: attrs['INSTREAM-ID'] || null,
                    default: attrs['DEFAULT'] === 'YES',
                    autoselect: attrs['AUTOSELECT'] === 'YES',
                    characteristics: attrs['CHARACTERISTICS'] || null
                });
            }
        }
    }
    logger.debug(`Found ${audioTracks.length} audio track(s), ${subtitleTracks.length} subtitle track(s) and ${closedCaptions.length} closed caption track(s) in HLS master: ${masterUrl}`);

    // Sort video tracks by bandwidth (highest first for best quality)
    if (videoTracks.length > 0) {
        videoTracks.sort((a, b) => {
            const aBandwidth = a.metaJS.averageBandwidth || a.metaJS.bandwidth || 0;
            const bBandwidth = b.metaJS.averageBandwidth || b.metaJS.bandwidth || 0;
            return bBandwidth - aBandwidth;
        });
        logger.debug(`Video tracks sorted by bandwidth, highest: ${videoTracks[0].metaJS.bandwidth}`);
    }

    return {
        videoTracks: videoTracks,
        audioTracks: audioTracks,
        subtitleTracks: subtitleTracks,
        closedCaptions: closedCaptions,
        hasMediaGroups: audioTracks.length > 0 || subtitleTracks.length > 0 || closedCaptions.length > 0,
        status: 'success',
        version: version
    };
}

/**
 * Parse an HLS variant playlist to extract full metadata
 * @param {string} variantUrl - URL of the HLS variant playlist
 * @param {Object} [headers] - Optional headers to use for the request
 * @returns {Promise<Object>} - Complete variant metadata
 */
async function parseHlsVariant(variantUrl, headers = null, _tabId) {
    try {
        logger.debug(`Fetching variant: ${variantUrl} with headers:`, headers);
        
        // Use the unified fetchManifest function with retry logic
        const fetchResult = await fetchManifest(variantUrl, headers, {
            timeoutMs: 10000,
            maxRetries: 2
        });
        
        if (!fetchResult.success) {
            logger.warn(`❌ Failed fetching variant ${variantUrl}: ${fetchResult.status}`);
            return { 
                duration: null, 
                isLive: true,
                segmentCount: null,
                isEncrypted: false,
                encryptionType: null,
                retryCount: fetchResult.retryCount || 0,
                // HLS default containers
                videoContainer: 'mp4',
                audioContainer: 'm4a'
            };
        }
        
        const content = fetchResult.content;
        logger.debug(`Received variant playlist (${content.length} bytes)`);
        
        if (content.length === 0) {
            logger.warn(`Empty response for variant ${variantUrl}`);
            return { 
                duration: null, 
                isLive: true,
                segmentCount: null,
                isEncrypted: false,
                encryptionType: null,
                // HLS default containers
                videoContainer: 'mp4',
                audioContainer: 'm4a'
            };
        }
        
        // Extract different types of metadata from variant playlist
        const durationInfo = calculateHlsVariantDuration(content);
        logger.debug(`Variant duration info: ${JSON.stringify(durationInfo)}`);
        
        const encryptionInfo = extractHlsEncryptionInfo(content);
        logger.debug(`Variant encryption info: ${JSON.stringify(encryptionInfo)}`);

        // Extract HLS version
        const version = extractHlsVersion(content);
        logger.debug(`Variant version: ${version}`);
        
        // Build a complete result object with HLS defaults
        const result = {
            duration: durationInfo.duration,
            isLive: durationInfo.isLive,
            segmentCount: durationInfo.segmentCount,
            isEncrypted: encryptionInfo.isEncrypted,
            encryptionType: encryptionInfo.isEncrypted ? encryptionInfo.encryptionType : null,
            version: version,
            // Container information for download (HLS defaults)
            videoContainer: 'mp4',
            audioContainer: 'm4a'
        };

        logger.debug(`Complete variant info: ${JSON.stringify(result)}`);
        return result;
    } catch (error) {
        logger.error(`❌ ERROR parsing variant ${variantUrl}: ${error.message}`);
        // Return complete object with defaults
        return { 
            duration: null, 
            isLive: true,
            segmentCount: null,
            isEncrypted: false,
            encryptionType: null,
            // HLS default containers
            videoContainer: 'mp4',
            audioContainer: 'm4a'
        };
    }
}

/**
 * Calculate the duration of an HLS variant playlist by summing segment durations
 * Also counts the total number of segments
 * @param {string} content - The playlist content 
 * @returns {Object} - Duration information and segment count
 */
function calculateHlsVariantDuration(content) {
    const lines = content.split(/\r?\n/);
    let totalDuration = 0;
    let segmentCount = 0;
    
    // Parse #EXTINF lines which contain segment durations
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            // Extract the duration value (format: #EXTINF:4.5,)
            const durationStr = line.substring(8).split(',')[0];
            const segmentDuration = parseFloat(durationStr);
            if (!isNaN(segmentDuration)) {
                totalDuration += segmentDuration;
                segmentCount++;
            }
        }
    }
    
    // Check if this is a live stream (no EXT-X-ENDLIST tag)
    const isLive = !content.includes('#EXT-X-ENDLIST');
    
    return {
        duration: isLive ? null : Math.round(totalDuration), // Don't calculate duration for live streams
        isLive: isLive,
        segmentCount: isLive ? null : segmentCount // Segment count is also meaningless for live streams
    };
}

/**
 * Extract encryption information from HLS playlist content
 * @param {string} content - HLS playlist content
 * @returns {Object} - Encryption information
 */
function extractHlsEncryptionInfo(content) {
    let isEncrypted = false;
    let encryptionType = null;
    
    // Check for encryption by looking for EXT-X-KEY tags
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (line.trim().startsWith('#EXT-X-KEY:')) {
            isEncrypted = true;
            
            // Try to extract encryption method
            const methodMatch = line.match(/METHOD=([^,]+)/);
            if (methodMatch && methodMatch[1]) {
                encryptionType = methodMatch[1].replace(/"/g, '');  // Remove quotes if present
            }
            break; // Found what we need
        }
    }
    
    return {
        isEncrypted: isEncrypted,
        encryptionType: encryptionType
    };
}

/**
 * Parse StreamInf line to extract variant information
 * Example: #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
 *
 * @param {string} line - The #EXT-X-STREAM-INF line
 * @returns {Object} Parsed stream information
 */
function parseStreamInf(line) {
    // Remove the #EXT-X-STREAM-INF: prefix
    const attrText = line.substring(line.indexOf(':') + 1);
    
    // Initialize result object
    const result = {
        bandwidth: null,
        averageBandwidth: null,
        codecs: null,
        resolution: null,
        width: null,
        height: null,
        fps: null,
        audioGroup: null,
        videoGroup: null,
        subtitleGroup: null,
        ccGroup: null
    };
    
    // Pattern for parsing attribute expressions, handling quoted values properly
    const attributePattern = /([^=,]+)=(?:"([^"]*)"|([^,]*))/g;
    
    let match;
    while ((match = attributePattern.exec(attrText)) !== null) {
        const key = match[1].trim();
        const value = (match[2] || match[3]).trim();
        
        switch (key) {
            case 'BANDWIDTH':
                result.bandwidth = parseInt(value, 10);
                break;
            case 'AVERAGE-BANDWIDTH':
                result.averageBandwidth = parseInt(value, 10);
                break;
            case 'CODECS':
                result.codecs = value;
                // Container detection based on codecs (direct regex matching)
                if (value) {
                    const codecString = value.toLowerCase();
                    
                    // Video container detection (direct matching)
                    if (/vp8|vp08|vp9|vp09/.test(codecString)) {
                        result.videoContainer = 'webm';
                    } else if (/avc1|hvc1|hev1|av01/.test(codecString)) {
                        result.videoContainer = 'mp4';
                    }
                    // If no video codec match → videoContainer remains undefined
                    
                    // Audio container detection (direct matching)
                    if (/mp3|mpa/.test(codecString)) {
                        result.audioContainer = 'mp3';
                    } else if (/opus|vorbis/.test(codecString)) {
                        result.audioContainer = 'webm';
                    } else if (/mp4a|aac|ac-3|ec-3/.test(codecString)) {
                        result.audioContainer = 'm4a';
                    }
                    // If no audio codec match → audioContainer remains undefined
                } else {
                    // No codecs - HLS fallback defaults
                    result.videoContainer = 'mp4';
                    result.audioContainer = 'm4a';
                }
                break;
            case 'RESOLUTION':
                result.resolution = value;
                // Parse resolution in the format "widthxheight"
                const [width, height] = value.split('x');
                result.width = parseInt(width, 10);
                result.height = parseInt(height, 10);
                break;
            case 'FRAME-RATE':
                result.fps = Math.round(parseFloat(value));
                break;
            case 'AUDIO':
                result.audioGroup = value;
                break;
            case 'VIDEO':
                result.videoGroup = value;
                break;
            case 'SUBTITLES':
                result.subtitleGroup = value;
                break;
            case 'CLOSED-CAPTIONS':
                result.ccGroup = value === 'NONE' ? null : value;
                break;
        }
    }
    
    return result;
}

/**
 * Extract HLS manifest version from content
 * @param {string} content - HLS playlist content
 * @returns {number|null} - HLS version number or null if not specified
 */
function extractHlsVersion(content) {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#EXT-X-VERSION:')) {
            const versionStr = trimmedLine.substring(15).trim();
            const version = parseInt(versionStr, 10);
            return isNaN(version) ? null : version;
        }
    }
    // If no version tag is present, the specification states it defaults to version 1
    return 1;
}

/**
 * Extract variant URLs from HLS master playlist for deduplication
 * Uses shared variant entry extraction logic for consistency
 * @param {string} url - URL of the HLS master playlist
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Array<string>>} Array of normalized variant URLs
 */
export async function extractHlsVariantUrls(url, headers = null, _tabId) {
    try {
        logger.debug(`Extracting variant URLs from master: ${url}`);
        // Fetch the master playlist content
        const fetchResult = await fetchManifest(url, headers, {
            maxRetries: 2
        });
        if (!fetchResult.success) {
            logger.warn(`Failed to fetch master playlist for variant extraction: ${fetchResult.status}`);
            return [];
        }
        // Quick validation that this is an HLS master playlist
        const content = fetchResult.content;
        if (!content.includes('#EXTM3U') || !content.includes('#EXT-X-STREAM-INF')) {
            logger.warn(`Content is not an HLS master playlist`);
            return [];
        }
        const baseUrl = getBaseDirectory(url);
        const normalizedMasterUrl = normalizeUrl(url);
        // Use the unified variant entry extraction and return only normalized URLs
        const variantEntries = extractMasterVariantEntries(content, baseUrl, normalizedMasterUrl);
        return variantEntries.map(entry => entry.normalizedUrl);
    } catch (error) {
        logger.error(`Error extracting variant URLs from ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Unified extraction of variant entries from HLS master playlist content
 * Returns array of objects: { url, normalizedUrl, streamInf }
 * Used by both parseHlsMaster and extractHlsVariantUrls for minimal codebase
 * @param {string} content - The master playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {string} masterUrl - The master playlist URL (normalized)
 * @returns {Array<Object>} Array of variant entry objects
 */
function extractMasterVariantEntries(content, baseUrl, masterUrl) {
    const entries = [];
    const lines = content.split(/\r?\n/);
    let currentStreamInf = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInf = parseStreamInf(line);
        } else if (currentStreamInf && line && !line.startsWith('#')) {
            const variantUrl = resolveUrl(baseUrl, line);
            const normalizedVariantUrl = normalizeUrl(variantUrl);
            entries.push({
                url: variantUrl,
                normalizedUrl: normalizedVariantUrl,
                streamInf: currentStreamInf,
                masterUrl: masterUrl
            });
            currentStreamInf = null;
        }
    }
    logger.debug(`Extracted ${entries.length} variant entries from master playlist`);
    return entries;
}

/**
 * Extract all media URLs from HLS master playlist for comprehensive deduplication
 * @param {string} url - URL of the HLS master playlist
 * @param {Object} [headers] - Optional request headers
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object>} Object containing arrays of normalized URLs for videoTracks, audioTracks, and subtitleTracks
 */
export async function extractHlsMediaUrls(url, headers = null, _tabId) {
    try {
        logger.debug(`Extracting all media URLs from master: ${url}`);
        // Fetch the master playlist content
        const fetchResult = await fetchManifest(url, headers, {
            maxRetries: 2
        });
        if (!fetchResult.success) {
            logger.warn(`Failed to fetch master playlist for media URL extraction: ${fetchResult.status}`);
            return { videoTracks: [], audioTracks: [], subtitleTracks: [] };
        }
        // Quick validation that this is an HLS master playlist
        const content = fetchResult.content;
        if (!content.includes('#EXTM3U') || !content.includes('#EXT-X-STREAM-INF')) {
            logger.warn(`Content is not an HLS master playlist`);
            return { videoTracks: [], audioTracks: [], subtitleTracks: [] };
        }
        const baseUrl = getBaseDirectory(url);
        const normalizedMasterUrl = normalizeUrl(url);
        
        // Extract video tracks
        const variantEntries = extractMasterVariantEntries(content, baseUrl, normalizedMasterUrl);
        const videoTrackUrls = variantEntries.map(entry => entry.normalizedUrl);
        
        // Extract audio tracks and subtitles from #EXT-X-MEDIA lines
        const audioUrls = [];
        const subtitleUrls = [];
        const lines = content.split(/\r?\n/);
        
        for (const line of lines) {
            if (line.startsWith('#EXT-X-MEDIA:')) {
                // Parse attributes
                const attrPattern = /([A-Z0-9\-]+)=(("[^"]*")|([^,]*))/g;
                let match;
                const attrs = {};
                while ((match = attrPattern.exec(line)) !== null) {
                    const key = match[1];
                    let value = match[3] || match[4] || '';
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1);
                    }
                    attrs[key] = value;
                }
                
                if (/TYPE=AUDIO/.test(line) && attrs['URI']) {
                    const audioUrl = resolveUrl(baseUrl, attrs['URI']);
                    audioUrls.push(normalizeUrl(audioUrl));
                } else if (/TYPE=SUBTITLES/.test(line) && attrs['URI']) {
                    const subtitleUrl = resolveUrl(baseUrl, attrs['URI']);
                    subtitleUrls.push(normalizeUrl(subtitleUrl));
                }
            }
        }
        
        logger.debug(`Extracted ${videoTrackUrls.length} video track URLs, ${audioUrls.length} audio URLs, ${subtitleUrls.length} subtitle URLs`);
        return { 
            videoTracks: videoTrackUrls, 
            audioTracks: audioUrls, 
            subtitleTracks: subtitleUrls 
        };
    } catch (error) {
        logger.error(`Error extracting media URLs from ${url}: ${error.message}`);
        return { videoTracks: [], audioTracks: [], subtitleTracks: [] };
    }
}