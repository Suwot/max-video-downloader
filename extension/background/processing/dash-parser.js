/**
 * DASH Parser
 * Specialized DASH MPD manifest parsing with proper adaptation set handling
 */

import {
    processingRequests,
    calculateEstimatedFileSizeBytes,
    parseFrameRate,
    resolveUrl,
    extractAttribute,
    fetchManifest,
    validateManifestType
} from './parser-utils.js';
import { createLogger } from '../../shared/utils/logger.js';
import { getVideoByUrl } from './video-store.js';
import { standardizeResolution, normalizeUrl, getBaseDirectory } from '../../shared/utils/processing-utils.js';
import { detectAllContainers } from './container-detector.js';
import { registerDashSegmentPaths } from '../detection/video-detector.js'

// Create a logger for the DASH parser
const logger = createLogger('DASH Parser');

/**
 * Parse DASH duration string (ISO 8601 format)
 * Example: PT1H22M3.546S
 * 
 * @param {string} durationStr - The duration string
 * @returns {number} Duration in seconds
 */
export function parseDashDuration(durationStr) {
    if (!durationStr) return 0;
    
    // Handle full ISO 8601 duration format including years, months, days
    // P[n]Y[n]M[n]DT[n]H[n]M[n]S
    const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = durationStr.match(regex);
    
    if (!matches) return 0;
    
    // Extract time components (we're simplifying by using approximate values for years/months)
    const years = matches[1] ? parseInt(matches[1], 10) * 31536000 : 0;   // Approximate year as 365 days
    const months = matches[2] ? parseInt(matches[2], 10) * 2592000 : 0;   // Approximate month as 30 days
    const days = matches[3] ? parseInt(matches[3], 10) * 86400 : 0;
    const hours = matches[4] ? parseInt(matches[4], 10) * 3600 : 0;
    const minutes = matches[5] ? parseInt(matches[5], 10) * 60 : 0;
    const seconds = matches[6] ? parseFloat(matches[6]) : 0;
    
    // Calculate the total and round to full seconds
    return Math.round(years + months + days + hours + minutes + seconds);
}

/**
 * Helper function to extract AdaptationSet sections
 * 
 * @param {string} content - The MPD content
 * @returns {Array<string>} Array of AdaptationSet XML strings
 */
export function extractAdaptationSets(content) {
    const adaptationSets = [];
    const regex = /<AdaptationSet[^>]*>[\s\S]*?<\/AdaptationSet>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        adaptationSets.push(match[0]);
    }
    return adaptationSets;
}

/**
 * Helper function to extract Representation sections
 * 
 * @param {string} adaptationSetContent - The AdaptationSet XML content
 * @returns {Array<string>} Array of Representation XML strings
 */
export function extractRepresentations(adaptationSetContent) {
    const representations = [];
    const regex = /<Representation[^>]*(?:>[\s\S]*?<\/Representation>|[\/]?>)/g;
    let match;
    while ((match = regex.exec(adaptationSetContent)) !== null) {
        representations.push(match[0]);
    }
    return representations;
}

/**
 * Determine the media type of an adaptation set
 * @param {string} adaptationSetContent - AdaptationSet XML content
 * @returns {string} Media type: 'video', 'audio', 'subtitles', or 'unknown'
 */
function getAdaptationSetType(adaptationSetContent) {
    // Check for mimeType and contentType attributes
    const mimeType = extractAttribute(adaptationSetContent, 'mimeType') || '';
    const contentType = extractAttribute(adaptationSetContent, 'contentType') || '';
    
    if (mimeType.includes('video') || contentType === 'video') {
        return 'video';
    } else if (mimeType.includes('audio') || contentType === 'audio') {
        return 'audio';
    } else if (mimeType.includes('text') || contentType === 'text' || 
               mimeType.includes('subtitle') || contentType === 'subtitle' ||
               contentType === 'subtitles') {
        return 'subtitles';
    }
    
    // Check for specific roles or codec indicators if mime/content type not available
    if (adaptationSetContent.includes('<Role value="subtitle"') || 
        adaptationSetContent.includes('<Role value="caption"')) {
        return 'subtitles';
    }
    
    if (adaptationSetContent.includes('mp4a.') || adaptationSetContent.includes('vorbis') || 
        adaptationSetContent.includes('opus') || adaptationSetContent.includes('ec-3')) {
        return 'audio';
    }
    
    if (adaptationSetContent.includes('avc') || adaptationSetContent.includes('hvc1') || 
        adaptationSetContent.includes('vp9') || adaptationSetContent.includes('av1')) {
        return 'video';
    }
    
    return 'unknown';
}

/**
 * Extract segment template information from adaptation set or representation
 * 
 * @param {string} xmlContent - XML content of adaptation set or representation
 * @returns {Object|null} Segment template info or null if not found
 */
function extractSegmentTemplate(xmlContent) {
    // Look for SegmentTemplate tag
    const segmentTemplateMatch = xmlContent.match(/<SegmentTemplate[^>]*>([\s\S]*?)<\/SegmentTemplate>|<SegmentTemplate[^>]*\/>/);
    if (!segmentTemplateMatch) {
        return null;
    }
    
    const segmentTemplateContent = segmentTemplateMatch[0];
    
    // Extract common attributes
    return {
        media: extractAttribute(segmentTemplateContent, 'media'),
        initialization: extractAttribute(segmentTemplateContent, 'initialization'),
        startNumber: parseInt(extractAttribute(segmentTemplateContent, 'startNumber') || '1', 10),
        timescale: parseInt(extractAttribute(segmentTemplateContent, 'timescale') || '1', 10),
        duration: parseInt(extractAttribute(segmentTemplateContent, 'duration') || '0', 10)
    };
}

/**
 * Extract segment base information from adaptation set or representation
 * 
 * @param {string} xmlContent - XML content of adaptation set or representation
 * @returns {Object|null} Segment base info or null if not found
 */
function extractSegmentBase(xmlContent) {
    // Look for SegmentBase tag
    const segmentBaseMatch = xmlContent.match(/<SegmentBase[^>]*>([\s\S]*?)<\/SegmentBase>|<SegmentBase[^>]*\/>/);
    if (!segmentBaseMatch) {
        return null;
    }
    
    const segmentBaseContent = segmentBaseMatch[0];
    
    // Extract initialization segment info
    let initialization = null;
    const initMatch = segmentBaseContent.match(/<Initialization[^>]*\/>/);
    if (initMatch) {
        initialization = {
            range: extractAttribute(initMatch[0], 'range'),
            sourceURL: extractAttribute(initMatch[0], 'sourceURL')
        };
    }
    
    return {
        indexRange: extractAttribute(segmentBaseContent, 'indexRange'),
        initialization: initialization,
        presentationTimeOffset: parseInt(extractAttribute(segmentBaseContent, 'presentationTimeOffset') || '0', 10),
        timescale: parseInt(extractAttribute(segmentBaseContent, 'timescale') || '1', 10)
    };
}

/**
 * Extract segment list information from adaptation set or representation
 * 
 * @param {string} xmlContent - XML content of adaptation set or representation
 * @returns {Object|null} Segment list info or null if not found
 */
function extractSegmentList(xmlContent) {
    // Look for SegmentList tag
    const segmentListMatch = xmlContent.match(/<SegmentList[^>]*>([\s\S]*?)<\/SegmentList>/);
    if (!segmentListMatch) {
        return null;
    }
    
    const segmentListContent = segmentListMatch[0];
    
    // Extract initialization segment info
    let initialization = null;
    const initMatch = segmentListContent.match(/<Initialization[^>]*\/>/);
    if (initMatch) {
        initialization = {
            sourceURL: extractAttribute(initMatch[0], 'sourceURL'),
            range: extractAttribute(initMatch[0], 'range')
        };
    }
    
    // Extract segments
    const segments = [];
    const segmentUrlRegex = /<SegmentURL[^>]*\/>/g;
    let segmentMatch;
    while ((segmentMatch = segmentUrlRegex.exec(segmentListContent)) !== null) {
        segments.push({
            media: extractAttribute(segmentMatch[0], 'media'),
            mediaRange: extractAttribute(segmentMatch[0], 'mediaRange')
        });
    }
    
    return {
        duration: parseInt(extractAttribute(segmentListContent, 'duration') || '0', 10),
        timescale: parseInt(extractAttribute(segmentListContent, 'timescale') || '1', 10),
        initialization: initialization,
        segments: segments
    };
}

/**
 * Extract base paths for segments from MPD content
 * Used to identify and filter media segments in the background script
 * 
 * @param {string} content - MPD XML content
 * @returns {Array<string>} Array of segment base paths
 */
function extractSegmentBasePaths(content) {
    const paths = new Set();
    
    try {
        // Extract SegmentTemplate media attributes
        const segmentTemplateRegex = /<SegmentTemplate[^>]*media="([^"]+)"[^>]*>/g;
        let match;
        
        while ((match = segmentTemplateRegex.exec(content)) !== null) {
            const mediaPattern = match[1];
            
            // Extract the base path (directory) from the pattern
            // e.g. from "video/$RepresentationID$/segment-$Number$.m4s" get "video/"
            const pathParts = mediaPattern.split('/');
            if (pathParts.length > 1) {
                // Remove the filename part and join the path
                pathParts.pop();
                const basePath = pathParts.join('/');
                
                if (basePath) {
                    paths.add(basePath);
                }
            }
        }
        
        // Also check BaseURL elements which often contain segment paths
        const baseUrlRegex = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/g;
        while ((match = baseUrlRegex.exec(content)) !== null) {
            const baseUrl = match[1].trim();
            
            // Look for common segment directory indicators
            if (baseUrl.includes('segment') || baseUrl.includes('chunk') || 
                baseUrl.includes('frag') || baseUrl.includes('media')) {
                paths.add(baseUrl);
            }
        }
        
        // Extract common segment patterns from initialization attributes
        const initRegex = /<SegmentTemplate[^>]*initialization="([^"]+)"[^>]*>/g;
        while ((match = initRegex.exec(content)) !== null) {
            const initPattern = match[1];
            const pathParts = initPattern.split('/');
            if (pathParts.length > 1) {
                pathParts.pop();
                const basePath = pathParts.join('/');
                if (basePath) {
                    paths.add(basePath);
                }
            }
        }
    } catch (e) {
        logger.error('Error extracting segment base paths:', e);
    }
    
    return Array.from(paths);
}

/**
 * Parse a DASH MPD document and organize content by media type
 * First validates if it's really a DASH manifest using light parsing
 * 
 * @param {string} url - URL of the DASH manifest
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Object>} Validated and parsed DASH content structured by media type
 */
export async function parseDashManifest(url, headers = null, tabId) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full && processingRequests.full.has(normalizedUrl)) {
        return { 
            status: 'processing',
            isValid: false,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: [],
            variants: []
        };
    }
    
    // Mark as being processed
    if (processingRequests.full) {
        processingRequests.full.add(normalizedUrl);
    }
    
    try {
        logger.debug(`Validating manifest: ${url}, with these headers:`, headers);
        
        // Get video metadata from storage if available
        const videoInfo = await getVideoByUrl(url);
        const existingMetadata = videoInfo?.metadata;
        
        // First perform light parsing to validate this is actually a DASH manifest
        const validation = await validateManifestType(url, headers, existingMetadata, tabId);
        
        // Preserve the light parsing timestamp
        const timestampLP = validation.timestampLP || Date.now();
        
        // Early return if not a valid manifest or if not DASH
        if (!validation.isValid || validation.manifestType !== 'dash') {
            logger.warn(`URL does not point to a valid DASH manifest: ${url} (${validation.status})`);
            return {
                status: validation.status || 'not-dash',
                isValid: false,
                timestampLP,
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: [],
                variants: []
            };
        }
        
        logger.debug(`Confirmed valid DASH manifest, proceeding to full parse: ${url}`);
        
        // Use content from light parsing if available, otherwise fetch full content
        let content;
        if (validation.content) {
            logger.debug('Reusing content from light parsing for full parse');
            content = validation.content;
        } else {
            logger.debug('Content not available from light parsing, fetching full content');
            const fetchResult = await fetchManifest(url, {
                headers,
                maxRetries: 3,
                tabId: tabId
            });
            
            if (!fetchResult.ok) {
                logger.error(`Failed to fetch MPD: ${fetchResult.status}`);
                return { 
                    status: 'fetch-failed',
                    isValid: false,
                    timestampLP,
                    retryCount: fetchResult.retryCount || 0,
                    videoTracks: [],
                    audioTracks: [],
                    subtitleTracks: [],
                    variants: []
                };
            }
            
            content = fetchResult.content;
        }
        
        const baseUrl = getBaseDirectory(url);
        
        // Extract segment base paths to help filter out segments in the background script
        const segmentPaths = extractSegmentBasePaths(content);
        
        // Try to send segment paths to background script
        if (segmentPaths.length > 0) {
            try {
                // Try to extract tabId from URL if it contains it (common in background fetch)
                let tabId = null;
                try {
                    const urlParams = new URL(url).searchParams;
                    if (urlParams.has('tabId')) {
                        tabId = parseInt(urlParams.get('tabId'), 10);
                    }
                } catch (e) {
                    logger.debug('No tabId in URL params');
                }
                
                // Send paths to background
                registerDashSegmentPaths(tabId, segmentPaths, url);

                logger.debug(`Sent ${segmentPaths.length} segment paths to background for URL: ${url}`);
            } catch (e) {
                logger.warn('Error sending segment paths to background:', e);
            }
        }
        
        // Extract basic MPD properties
        const durationMatch = content.match(/mediaPresentationDuration="([^"]+)"/);
        const duration = durationMatch ? parseDashDuration(durationMatch[1]) : null;
        
        // Check if this is a live stream
        const isLive = content.match(/type="dynamic"/i) !== null;
        
        // Check for encryption/DRM
        const isEncrypted = content.includes('<ContentProtection') || 
                           content.includes('cenc:') || 
                           content.includes('dashif:');
        
        // Try to extract encryption type if present
        let encryptionType = null;
        if (isEncrypted) {
            // Check for common encryption schemes
            if (content.includes('urn:mpeg:dash:mp4protection:2011')) {
                encryptionType = 'cenc';
            } else if (content.includes('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')) {
                encryptionType = 'widevine';
            } else if (content.includes('urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95')) {
                encryptionType = 'playready';
            } else if (content.includes('urn:uuid:f239e769-efa3-4850-9c16-a903c6932efb')) {
                encryptionType = 'clearkey';
            } else if (content.includes('urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2')) {
                encryptionType = 'fairplay';
            } else if (content.includes('urn:uuid:5e629af5-38da-4063-8977-97ffbd9902d4')) {
                encryptionType = 'marlin';
            } else if (content.includes('urn:uuid:1077efecc0b24d02ace33c1e52e2fb4b')) {
                encryptionType = 'verimatrix';
            } else if (content.includes('urn:uuid:f239e769-efa3-4850-9c16-a903c6932efb')) {
                encryptionType = 'adobe-primetime';
            } else if (content.includes('urn:uuid:6a99532d-869f-40ea-a75b-8ebe2e279df6')) {
                encryptionType = 'oma-drm';
            }
        }
        
        // Extract all adaptation sets
        const adaptationSets = extractAdaptationSets(content);
        
        // Initialize track arrays
        const videoTracks = [];
        const audioTracks = [];
        const subtitleTracks = [];
        
        // Initialize counters for FFmpeg stream indices
        let videoIndex = 0;
        let audioIndex = 0;
        let subtitleIndex = 0;
        
        // Process each adaptation set
        for (const adaptationSet of adaptationSets) {
            const mediaType = getAdaptationSetType(adaptationSet);
            
            if (mediaType === 'unknown') {
                continue;
            }
            
            // Extract common adaptation set properties
            const adaptationSetId = extractAttribute(adaptationSet, 'id') || `${mediaType}-${Date.now()}`;
            const mimeType = extractAttribute(adaptationSet, 'mimeType') || null;
            const codecs = extractAttribute(adaptationSet, 'codecs') || null;
            const lang = extractAttribute(adaptationSet, 'lang') || null;
            const label = extractAttribute(adaptationSet, 'label') || (lang ? `${lang.toUpperCase()} Track` : null);
            
            // Extract segment information (could be at adaptation set level)
            const segmentTemplate = extractSegmentTemplate(adaptationSet);
            const segmentBase = extractSegmentBase(adaptationSet);
            const segmentList = extractSegmentList(adaptationSet);
            
            // Extract audio channel configuration if present
            let audioChannelConfig = null;
            const audioChannelConfigMatch = adaptationSet.match(/<AudioChannelConfiguration[^>]*\/>/);
            if (audioChannelConfigMatch) {
                audioChannelConfig = {
                    schemeIdUri: extractAttribute(audioChannelConfigMatch[0], 'schemeIdUri'),
                    value: extractAttribute(audioChannelConfigMatch[0], 'value')
                };
            }
            
            // Get all representations for this adaptation set
            const representationElements = extractRepresentations(adaptationSet);
            
            // Process each representation and add it directly to the appropriate tracks array
            for (const representation of representationElements) {
                const repId = extractAttribute(representation, 'id') || `${adaptationSetId}-rep-${Date.now()}`;
                const bandwidthAttr = extractAttribute(representation, 'bandwidth');
                const bandwidth = bandwidthAttr ? parseInt(bandwidthAttr, 10) : null;
                const repCodecs = extractAttribute(representation, 'codecs') || codecs;
                const repMimeType = extractAttribute(representation, 'mimeType') || mimeType;
                
                // Create flattened representation object with adaptation set properties
                const flatRepresentation = {
                    id: repId,
                    adaptationSetId: adaptationSetId,
                    bandwidth: bandwidth,
                    codecs: repCodecs,
                    mimeType: repMimeType,
                    lang: lang,
                    label: label,
                    estimatedFileSizeBytes: calculateEstimatedFileSizeBytes(bandwidth, duration)
                };
                
                // Add segment information from adaptation set if not present at representation level
                const repSegmentTemplate = extractSegmentTemplate(representation);
                flatRepresentation.segmentTemplate = repSegmentTemplate || segmentTemplate;
                
                const repSegmentBase = extractSegmentBase(representation);
                flatRepresentation.segmentBase = repSegmentBase || segmentBase;
                
                const repSegmentList = extractSegmentList(representation);
                flatRepresentation.segmentList = repSegmentList || segmentList;
                
                // Add audio channel configuration if available for audio
                if (mediaType === 'audio' && audioChannelConfig) {
                    flatRepresentation.audioChannelConfiguration = audioChannelConfig;
                }
                
                // For rendering in the UI, create URL with fragment identifier
                flatRepresentation.trackUrl = `${url}#adaptationSet=${adaptationSetId}&representation=${repId}`;
                flatRepresentation.normalizedTrackUrl = normalizeUrl(flatRepresentation.trackUrl);
                
                // Add media-specific properties
                if (mediaType === 'video') {
                    flatRepresentation.width = parseInt(extractAttribute(representation, 'width'), 10) || null;
                    flatRepresentation.height = parseInt(extractAttribute(representation, 'height'), 10) || null;
                    flatRepresentation.standardizedResolution = flatRepresentation.height ? 
                    standardizeResolution(flatRepresentation.height) : null;
                    flatRepresentation.frameRate = parseFrameRate(extractAttribute(representation, 'frameRate') || null);
                    flatRepresentation.sar = extractAttribute(representation, 'sar') || null;
                    flatRepresentation.scanType = extractAttribute(representation, 'scanType') || null;
                    
                    // Calculate resolution string
                    if (flatRepresentation.width && flatRepresentation.height) {
                        flatRepresentation.resolution = `${flatRepresentation.width}x${flatRepresentation.height}`;
                    }
                    
                    // Detect video container based on DASH mimeType and codecs
                    const videoContainerDetection = detectAllContainers({
                        mimeType: repMimeType,
                        codecs: repCodecs,
                        url: flatRepresentation.trackUrl,
                        mediaType: 'video',
                        videoType: 'dash'
                    });
                    
                    flatRepresentation.videoContainer = videoContainerDetection.container;
                    flatRepresentation.containerDetectionReason = videoContainerDetection.reason;
                    
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:v:${videoIndex++}`;
                    videoTracks.push(flatRepresentation);
                } 
                else if (mediaType === 'audio') {
                    flatRepresentation.audioSamplingRate = parseInt(extractAttribute(representation, 'audioSamplingRate'), 10) || null;
                    flatRepresentation.channels = parseInt(extractAttribute(representation, 'audioChannels') || 
                                               extractAttribute(representation, 'channels'), 10) || null;
                    
                    // Detect audio container based on DASH mimeType and codecs
                    const audioContainerDetection = detectAllContainers({
                        mimeType: repMimeType,
                        codecs: repCodecs,
                        url: flatRepresentation.trackUrl,
                        mediaType: 'audio',
                        videoType: 'dash'
                    });
                    
                    flatRepresentation.audioContainer = audioContainerDetection.container;
                    flatRepresentation.containerDetectionReason = audioContainerDetection.reason;
                    
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:a:${audioIndex++}`;
                    audioTracks.push(flatRepresentation);
                } 
                else if (mediaType === 'subtitles') {
                    // Detect subtitle container with DASH context
                    const subtitleContainerDetection = detectAllContainers({
                        mimeType: repMimeType,
                        url: flatRepresentation.trackUrl,
                        mediaType: 'subtitle',
                        videoType: 'dash',
                        videoContainer: 'mp4' // Most common for DASH
                    });
                    
                    flatRepresentation.subtitleContainer = subtitleContainerDetection.container;
                    flatRepresentation.containerDetectionReason = subtitleContainerDetection.reason;
                    
                    // Any subtitle-specific properties can be added here
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:s:${subtitleIndex++}`;
                    subtitleTracks.push(flatRepresentation);
                }
            }
        }
        
        // Sort track arrays by bandwidth (highest first)
        videoTracks.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        audioTracks.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        
        // For backward compatibility, also create a variants array from video tracks
        const variants = [];
        if (videoTracks.length > 0) {
            // Find best audio track to pair with these videos (if available)
            const bestAudioTrack = audioTracks.length > 0 ? audioTracks[0] : null;
            const audioCodec = bestAudioTrack && bestAudioTrack.codecs ? bestAudioTrack.codecs : null;
            
            // Add each video track directly as a variant
            for (const videoTrack of videoTracks) {
                // Combine video and audio codecs (if available)
                let combinedCodecs = null;
                if (videoTrack.codecs && audioCodec) {
                    combinedCodecs = `${videoTrack.codecs},${audioCodec}`;
                } else if (videoTrack.codecs) {
                    combinedCodecs = videoTrack.codecs;
                } else if (audioCodec) {
                    combinedCodecs = audioCodec;
                }
                
                // Create backward-compatible variant structure
                const variant = {
                    url: videoTrack.trackUrl,
                    normalizedUrl: videoTrack.normalizedTrackUrl,
                    id: videoTrack.id,
                    masterUrl: url,
                    hasKnownMaster: true,
                    type: 'dash',
                    isVariant: true,
                    isDASH: true,
                    metaJS: {
                        bandwidth: videoTrack.bandwidth,
                        codecs: combinedCodecs,
                        videoCodec: videoTrack.codecs,
                        audioCodec: audioCodec,
                        width: videoTrack.width,
                        height: videoTrack.height,
                        standardizedResolution: videoTrack.standardizedResolution,
                        fps: videoTrack.frameRate,
                        resolution: videoTrack.resolution,
                        estimatedFileSizeBytes: videoTrack.estimatedFileSizeBytes,
                        ffmpegStreamIndex: videoTrack.ffmpegStreamIndex, // Add FFmpeg stream index to variants
                        isEncrypted: isEncrypted,
                        encryptionType: encryptionType,
                        isLive: isLive,
                        duration: duration
                    },
                    source: 'parseDashManifest()',
                    timestampDetected: Date.now()
                };
                
                variants.push(variant);
            }
            
            // Sort variants by bandwidth (highest first) - should already be sorted but ensuring it here
            variants.sort((a, b) => (b.metaJS.bandwidth || 0) - (a.metaJS.bandwidth || 0));
        }
        
        // Set the full parse timestamp only at the end of successful parsing
        const timestampFP = Date.now();
        
        // Construct the full result with both timestamps
        const result = {
            url: url,
            normalizedUrl: normalizedUrl,
            type: 'dash',
            isValid: true,
            timestampLP: timestampLP, // Preserve the light parsing timestamp
            timestampFP: timestampFP, // Set full parsing timestamp
            duration: duration,
            isLive: isLive,
            isEncrypted: isEncrypted,
            encryptionType: encryptionType,
            videoTracks: videoTracks,
            audioTracks: audioTracks,
            subtitleTracks: subtitleTracks,
            variants: variants, // For backward compatibility
            segmentPaths: segmentPaths, // Add segment paths for filtering in background script
            status: 'success'
        };
        
        logger.info(`Successfully parsed MPD: found ${videoTracks.length} video, ${audioTracks.length} audio, and ${subtitleTracks.length} subtitle tracks`);
        return result;
    } catch (error) {
        logger.error(`Error parsing MPD: ${error.message}`);
        return { 
            status: 'parse-error',
            isValid: false,
            timestampLP: Date.now(), // In case of error without light parsing completed
            error: error.message,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: [],
            variants: []
        };
    } finally {
        // Clean up
        if (processingRequests.full) {
            processingRequests.full.delete(normalizedUrl);
        }
    }
}
