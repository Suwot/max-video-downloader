/**
 * DASH Parser
 * Specialized DASH MPD manifest parsing with proper adaptation set handling
 */

import {
    calculateEstimatedFileSizeBytes,
    parseFrameRate,
    extractAttribute,
    detectContainerFromDashTrack
} from './parser-utils.js';
import { fetchManifest } from './manifest-fetcher.js';
import { standardizeResolution, normalizeUrl } from '../../shared/utils/processing-utils.js';

// Track URLs currently being processed to prevent duplicates
const processingUrls = new Set();

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
    const regex = /<Representation[^>]*(?:>[\s\S]*?<\/Representation>|[/]?>)/g;
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
 * Extract channel count from audio configuration
 * 
 * @param {string} adaptationSetContent - AdaptationSet XML content
 * @param {string} representationContent - Representation XML content
 * @returns {number|null} Number of audio channels or null if not found
 */
function extractChannelCount(adaptationSetContent, representationContent) {
    // Check representation first, then adaptation set
    const repChannels = extractAttribute(representationContent, 'audioChannels') || 
                       extractAttribute(representationContent, 'channels');
    if (repChannels) {
        return parseInt(repChannels, 10);
    }
    
    const adaptChannels = extractAttribute(adaptationSetContent, 'audioChannels') || 
                         extractAttribute(adaptationSetContent, 'channels');
    if (adaptChannels) {
        return parseInt(adaptChannels, 10);
    }
    
    // Check AudioChannelConfiguration value
    const audioChannelConfigMatch = (representationContent + adaptationSetContent)
        .match(/<AudioChannelConfiguration[^>]*value="([^"]+)"[^>]*\/>/);
    if (audioChannelConfigMatch) {
        return parseInt(audioChannelConfigMatch[1], 10);
    }
    
    return null;
}

/**
 * Extract role information from adaptation set
 * 
 * @param {string} adaptationSetContent - AdaptationSet XML content
 * @returns {Object} Role information with role and _default properties
 */
function extractRoleInfo(adaptationSetContent) {
    const roleMatch = adaptationSetContent.match(/<Role[^>]*value="([^"]+)"[^>]*\/>/);
    const role = roleMatch ? roleMatch[1] : null;
    const _default = role === 'main';
    
    return { role, _default };
}

/**
 * Extract quality label from representation
 * 
 * @param {string} representationContent - Representation XML content
 * @returns {string|null} Quality label or null if not found
 */
function extractTrackQuality(representationContent) {
    // Check for explicit quality attribute
    const qualityAttr = extractAttribute(representationContent, 'quality');
    if (qualityAttr) {
        return qualityAttr;
    }
    
    return null;
}

/**
 * Check if track has accessibility features
 * 
 * @param {string} adaptationSetContent - AdaptationSet XML content
 * @returns {Object} Accessibility information
 */
function extractAccessibilityInfo(adaptationSetContent) {
    const hasAccessibility = adaptationSetContent.includes('<Accessibility') ||
                           adaptationSetContent.includes('role="caption"') ||
                           adaptationSetContent.includes('role="subtitle"') ||
                           adaptationSetContent.includes('role="description"');
    
    const isForced = adaptationSetContent.includes('role="forced-subtitle"') ||
                    adaptationSetContent.includes('forced="true"');
    
    return { hasAccessibility, isForced };
}

/**
 * Parse a DASH MPD document and organize content by media type
 * First validates if it's really a DASH manifest using light parsing
 * 
 * @param {string} url - URL of the DASH manifest
 * @returns {Promise<Object>} Validated and parsed DASH content structured by media type
 */
export async function parseDashManifest(videoObject) {
	const { url, headers, normalizedUrl } = videoObject;
    
    // Skip if already being processed
    if (processingUrls.has(normalizedUrl)) {
        return { 
            status: 'processing',
            isValid: false,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: [],
        };
    }
    
    // Mark as being processed
    processingUrls.add(normalizedUrl);
    
    try {
        console.debug(`Fetching manifest: ${url} with headers:`, headers);
        
        // Fetch manifest content
        const fetchResult = await fetchManifest(url, headers);
        const timestampValidated = Date.now();
        
        // Early return if fetch failed
        if (!fetchResult.success) {
            console.warn(`Failed to fetch manifest: ${url} (${fetchResult.status})`);
            return {
                status: 'fetch-failed',
                isValid: false,
                timestampValidated,
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: []
            };
        }
        
        const content = fetchResult.content;
        
        // Validate DASH format
        if (!content.includes('<MPD') || 
            (!content.includes('xmlns="urn:mpeg:dash:schema:mpd') && !content.includes('</MPD>'))) {
            console.warn(`Not a valid DASH manifest: ${url}`);
            return {
                status: 'invalid-format',
                isValid: false,
                timestampValidated,
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: []
            };
        }
        
        console.debug(`Confirmed valid DASH manifest: ${url}`);
        
        // Check if this is a live stream first
        const isLive = content.match(/type="dynamic"/i) !== null;
        
        // Extract basic MPD properties - skip duration parsing for live streams
        const duration = isLive ? null : (() => {
            const durationMatch = content.match(/mediaPresentationDuration="([^"]+)"/);
            return durationMatch ? parseDashDuration(durationMatch[1]) : null;
        })();
        
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
            const label = extractAttribute(adaptationSet, 'label') || null;
            
            // Extract role and accessibility information
            const roleInfo = extractRoleInfo(adaptationSet);
            const accessibilityInfo = extractAccessibilityInfo(adaptationSet);
            
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
                    role: roleInfo.role,
                    default: roleInfo._default,
                    hasAccessibility: accessibilityInfo.hasAccessibility,
                    isForced: accessibilityInfo.isForced,
                    estimatedFileSizeBytes: calculateEstimatedFileSizeBytes(bandwidth, duration)
                };
                
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
                    flatRepresentation.trackQuality = extractTrackQuality(representation);
                    
                    // Calculate resolution string
                    if (flatRepresentation.width && flatRepresentation.height) {
                        flatRepresentation.resolution = `${flatRepresentation.width}x${flatRepresentation.height}`;
                    }
                    
                    // Detect video container based on DASH mimeType and codecs
                    const videoContainerDetection = detectContainerFromDashTrack({
                        mimeType: repMimeType,
                        codecs: repCodecs,
                        mediaType: 'video'
                    });
                    
                    flatRepresentation.videoContainer = videoContainerDetection.container;
                    flatRepresentation.containerDetectionReason = videoContainerDetection.reason;
                    
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:v:${videoIndex++}`;
                    videoTracks.push(flatRepresentation);
                } 
                else if (mediaType === 'audio') {
                    flatRepresentation.audioSamplingRate = parseInt(extractAttribute(representation, 'audioSamplingRate'), 10) || null;
                    flatRepresentation.channels = extractChannelCount(adaptationSet, representation);
                    
                    // Detect audio container based on DASH mimeType and codecs
                    const audioContainerDetection = detectContainerFromDashTrack({
                        mimeType: repMimeType,
                        codecs: repCodecs,
                        mediaType: 'audio'
                    });
                    
                    flatRepresentation.audioContainer = audioContainerDetection.container;
                    flatRepresentation.containerDetectionReason = audioContainerDetection.reason;
                    
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:a:${audioIndex++}`;
                    audioTracks.push(flatRepresentation);
                } 
                else if (mediaType === 'subtitles') {
                    // Detect subtitle container with DASH context
                    const subtitleContainerDetection = detectContainerFromDashTrack({
                        mimeType: repMimeType,
                        mediaType: 'subtitle',
                        videoContainer: 'mp4' // Most common for DASH
                    });
                    
                    flatRepresentation.subtitleContainer = subtitleContainerDetection.container;
                    flatRepresentation.containerDetectionReason = subtitleContainerDetection.reason;
                    
                    // Assign FFmpeg stream index before pushing to array
                    flatRepresentation.ffmpegStreamIndex = `0:s:${subtitleIndex++}`;
                    subtitleTracks.push(flatRepresentation);
                }
            }
        }
        
        // Sort track arrays by mimeType, then codecs, then bandwidth (highest first)
        const sortTracks = (tracks) => tracks.sort((a, b) => {
            // Phase 1: mimeType (mp4 first, then webm)
            const mimeA = a.mimeType || '';
            const mimeB = b.mimeType || '';
            if (mimeA !== mimeB) {
                if (mimeA.includes('mp4')) return -1;
                if (mimeB.includes('mp4')) return 1;
                if (mimeA.includes('webm')) return -1;
                if (mimeB.includes('webm')) return 1;
            }
            
            // Phase 2: codecs (by family, alphabetical for consistency)
            const codecA = (a.codecs || '').split('.')[0];
            const codecB = (b.codecs || '').split('.')[0];
            if (codecA !== codecB) {
                return codecA.localeCompare(codecB);
            }
            
            // Phase 3: bandwidth (highest first)
            return (b.bandwidth || 0) - (a.bandwidth || 0);
        });
        
        sortTracks(videoTracks);
        sortTracks(audioTracks);
                
        // Set the parsing completion timestamp
        const timestampParsed = Date.now();
        
        // Construct the full result
        const result = {
            url: url,
            normalizedUrl: normalizedUrl,
            type: 'dash',
            isValid: true,
            timestampValidated: timestampValidated,
            timestampParsed: timestampParsed,
            duration: duration,
            isLive: isLive,
            isEncrypted: isEncrypted,
            encryptionType: encryptionType,
            videoTracks: videoTracks,
            audioTracks: audioTracks,
            subtitleTracks: subtitleTracks,
            status: 'success'
        };
        
        console.info(`Successfully parsed MPD: found ${videoTracks?.length} video, ${audioTracks?.length} audio, and ${subtitleTracks?.length} subtitle tracks`);
        return result;
    } catch (error) {
        console.error(`Error parsing MPD: ${error.message}`);
        return { 
            status: 'parse-error',
            isValid: false,
            timestampValidated: Date.now(),
            error: error.message,
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: []
        };
    } finally {
        // Clean up processing tracking
        processingUrls.delete(normalizedUrl);
    }
}
