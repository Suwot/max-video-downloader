/**
 * DASH Parser
 * Specialized DASH MPD manifest parsing with proper adaptation set handling
 */

import { 
    normalizeUrl,
    buildRequestHeaders,
    processingRequests,
    calculateEstimatedFileSizeBytes,
    parseFrameRate,
    parseDashDuration,
    resolveUrl,
    getBaseDirectory,
    extractAttribute,
    extractAdaptationSets,
    extractRepresentations,
    fetchContentRange,
    fetchFullContent
} from './parser-utils.js';

/**
 * Check if a URL likely points to a DASH MPD manifest
 * Performs a quick check using content-type and minimal content inspection
 * 
 * @param {string} url - URL to check
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<boolean>} - Whether the URL likely points to a DASH MPD
 */
export async function isDashManifest(url, headers = null) {
    try {
        console.log(`[DASH Parser] Checking if ${url} is a DASH manifest`);
        
        // First do a HEAD request to check content-type if possible
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            const headResponse = await fetch(url, {
                method: 'HEAD',
                signal: controller.signal,
                headers: headers || await buildRequestHeaders(null, url)
            });
            
            clearTimeout(timeoutId);
            
            if (headResponse.ok) {
                const contentType = headResponse.headers.get('content-type') || '';
                if (contentType.includes('application/dash+xml') || 
                    contentType.includes('video/vnd.mpeg.dash.mpd')) {
                    console.log(`[DASH Parser] Content-Type indicates DASH: ${contentType}`);
                    return true;
                }
                
                // If content-type clearly indicates it's not XML, return false
                if (contentType.includes('video/mp4') || 
                    contentType.includes('video/webm') || 
                    contentType.includes('audio/')) {
                    return false;
                }
            }
        } catch (error) {
            // Ignore HEAD request failures, proceed to content inspection
            console.log(`[DASH Parser] HEAD request failed, using content inspection: ${error.message}`);
        }
        
        // Fall back to checking content
        const result = await fetchContentRange(url, headers, 1024);
        
        if (!result.ok) {
            console.log(`[DASH Parser] Failed to fetch content: ${result.status}`);
            return false;
        }
        
        // Look for DASH MPD signatures
        const isDash = result.content.includes('<MPD') && 
                      (result.content.includes('xmlns="urn:mpeg:dash:schema:mpd') || 
                       result.content.includes('</MPD>'));
        
        console.log(`[DASH Parser] Content inspection ${isDash ? 'indicates' : 'does not indicate'} DASH manifest`);
        return isDash;
    } catch (error) {
        console.error(`[DASH Parser] Error checking DASH manifest: ${error.message}`);
        return false;
    }
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
 * Parse a DASH MPD document and organize content by media type
 * 
 * @param {string} url - URL of the DASH manifest
 * @param {Object} [headers] - Optional request headers
 * @returns {Promise<Object>} Parsed DASH content structured by media type
 */
export async function parseDashManifest(url, headers = null) {
    const normalizedUrl = normalizeUrl(url);
    
    // Skip if already being processed
    if (processingRequests.full && processingRequests.full.has(normalizedUrl)) {
        return { 
            status: 'processing',
            videoTracks: [],
            audioTracks: [],
            subtitleTracks: []
        };
    }
    
    // Mark as being processed
    if (processingRequests.full) {
        processingRequests.full.add(normalizedUrl);
    }
    
    try {
        console.log(`[DASH Parser] Parsing manifest: ${url}`);
        
        // Fetch the full content of the manifest
        const fetchResult = await fetchFullContent(url, headers);
        
        if (!fetchResult.ok) {
            console.error(`[DASH Parser] Failed to fetch MPD: ${fetchResult.status}`);
            return { 
                status: 'fetch-failed',
                videoTracks: [],
                audioTracks: [],
                subtitleTracks: []
            };
        }
        
        const content = fetchResult.content;
        const baseUrl = getBaseDirectory(url);
        
        // Extract basic MPD properties
        const durationMatch = content.match(/mediaPresentationDuration="([^"]+)"/);
        const duration = durationMatch ? parseDashDuration(durationMatch[1]) : 0;
        
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
            }
        }
        
        // Extract all adaptation sets
        const adaptationSets = extractAdaptationSets(content);
        
        // Initialize track arrays
        const videoTracks = [];
        const audioTracks = [];
        const subtitleTracks = [];
        
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
            
            // Get all representations for this adaptation set
            const representationElements = extractRepresentations(adaptationSet);
            
            // Create track object with representations
            const track = {
                id: adaptationSetId,
                mimeType: mimeType,
                codecs: codecs,
                lang: lang,
                label: label,
                segmentTemplate: segmentTemplate,
                segmentBase: segmentBase,
                segmentList: segmentList,
                representations: []
            };
            
            // Process each representation
            for (const representation of representationElements) {
                const repId = extractAttribute(representation, 'id') || `${adaptationSetId}-rep-${track.representations.length + 1}`;
                const bandwidth = parseInt(extractAttribute(representation, 'bandwidth') || '0', 10);
                const repCodecs = extractAttribute(representation, 'codecs') || codecs;
                
                // Create representation object with properties specific to media type
                const repObject = {
                    id: repId,
                    bandwidth: bandwidth,
                    codecs: repCodecs,
                    mimeType: extractAttribute(representation, 'mimeType') || mimeType,
                    estimatedFileSizeBytes: calculateEstimatedFileSizeBytes(bandwidth, duration)
                };
                
                // Check for representation-specific segment info
                const repSegmentTemplate = extractSegmentTemplate(representation);
                if (repSegmentTemplate) {
                    repObject.segmentTemplate = repSegmentTemplate;
                }
                
                const repSegmentBase = extractSegmentBase(representation);
                if (repSegmentBase) {
                    repObject.segmentBase = repSegmentBase;
                }
                
                const repSegmentList = extractSegmentList(representation);
                if (repSegmentList) {
                    repObject.segmentList = repSegmentList;
                }
                
                // Add media-specific properties
                if (mediaType === 'video') {
                    repObject.width = parseInt(extractAttribute(representation, 'width') || '0', 10);
                    repObject.height = parseInt(extractAttribute(representation, 'height') || '0', 10);
                    repObject.frameRate = parseFrameRate(extractAttribute(representation, 'frameRate') || null);
                    repObject.sar = extractAttribute(representation, 'sar') || null;
                    repObject.scanType = extractAttribute(representation, 'scanType') || null;
                    
                    // Calculate resolution string
                    if (repObject.width && repObject.height) {
                        repObject.resolution = `${repObject.width}x${repObject.height}`;
                    }
                } 
                else if (mediaType === 'audio') {
                    repObject.audioSamplingRate = parseInt(extractAttribute(representation, 'audioSamplingRate') || '0', 10);
                    repObject.channels = parseInt(extractAttribute(representation, 'audioChannels') || 
                                       extractAttribute(representation, 'channels') || '2', 10);
                } 
                else if (mediaType === 'subtitles') {
                    // Any subtitle-specific properties
                }
                
                // For rendering in the UI, create URL with fragment identifier
                repObject.trackUrl = `${url}#adaptationSet=${adaptationSetId}&representation=${repId}`;
                repObject.normalizedTrackUrl = normalizeUrl(repObject.trackUrl);
                
                track.representations.push(repObject);
            }
            
            // Sort representations by bandwidth (highest first)
            track.representations.sort((a, b) => b.bandwidth - a.bandwidth);
            
            // Add the track to the appropriate array
            if (mediaType === 'video') {
                videoTracks.push(track);
            } else if (mediaType === 'audio') {
                audioTracks.push(track);
            } else if (mediaType === 'subtitles') {
                subtitleTracks.push(track);
            }
        }
        
        // For backward compatibility, also create a variants array from video tracks
        const variants = [];
        if (videoTracks.length > 0) {
            for (const videoTrack of videoTracks) {
                // Find best audio track to pair with this video (if available)
                const bestAudioTrack = audioTracks.length > 0 ? audioTracks[0] : null;
                const audioCodec = bestAudioTrack && bestAudioTrack.codecs ? bestAudioTrack.codecs : null;
                
                // Add each video representation as a variant
                for (const representation of videoTrack.representations) {
                    // Combine video and audio codecs (if available)
                    let combinedCodecs = null;
                    if (representation.codecs && audioCodec) {
                        combinedCodecs = `${representation.codecs},${audioCodec}`;
                    } else if (representation.codecs) {
                        combinedCodecs = representation.codecs;
                    } else if (audioCodec) {
                        combinedCodecs = audioCodec;
                    }
                    
                    // Create backward-compatible variant structure
                    const variant = {
                        url: representation.trackUrl,
                        normalizedUrl: representation.normalizedTrackUrl,
                        id: representation.id,
                        masterUrl: url,
                        hasKnownMaster: true,
                        type: 'dash',
                        subtype: 'dash-variant',
                        isVariant: true,
                        isDASH: true,
                        metaJS: {
                            bandwidth: representation.bandwidth,
                            codecs: combinedCodecs,
                            videoCodec: representation.codecs,
                            audioCodec: audioCodec,
                            width: representation.width,
                            height: representation.height,
                            fps: representation.frameRate,
                            resolution: representation.resolution,
                            estimatedFileSizeBytes: representation.estimatedFileSizeBytes,
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
            }
            
            // Sort variants by bandwidth (highest first)
            variants.sort((a, b) => (b.metaJS.bandwidth || 0) - (a.metaJS.bandwidth || 0));
        }
        
        // Construct the full result
        const result = {
            url: url,
            normalizedUrl: normalizedUrl,
            type: 'dash',
            duration: duration,
            isLive: isLive,
            isEncrypted: isEncrypted,
            encryptionType: encryptionType,
            videoTracks: videoTracks,
            audioTracks: audioTracks,
            subtitleTracks: subtitleTracks,
            variants: variants, // For backward compatibility
            status: 'success'
        };
        
        console.log(`[DASH Parser] Successfully parsed MPD: found ${videoTracks.length} video, ${audioTracks.length} audio, and ${subtitleTracks.length} subtitle tracks`);
        return result;
    } catch (error) {
        console.error(`[DASH Parser] Error parsing MPD: ${error.message}`);
        return { 
            status: 'parse-error', 
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
