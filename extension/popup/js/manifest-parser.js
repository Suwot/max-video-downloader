/**
 * @ai-guide-component ManifestParser
 * @ai-guide-description Parses streaming manifest files
 * @ai-guide-responsibilities
 * - Parses HLS (m3u8) manifests to extract stream variants
 * - Parses DASH (mpd) manifests to extract media representations
 * - Resolves relative URLs in streaming manifests
 * - Extracts quality and codec information from manifests
 * - Provides structured access to streaming manifest data
 * - Supports both master playlists and media playlists
 */

/**
 * Detect if an M3U8 file is a master playlist using proper HLS spec rules
 * @param {string} content - M3U8 content
 * @returns {Object} Detection result with confidence level
 */
export function detectPlaylistType(content) {
    const result = {
        isMaster: false,
        confidence: 0,
        reason: []
    };

    // Strong indicators for master playlist
    if (content.includes('#EXT-X-STREAM-INF:')) {
        result.confidence += 0.5;
        result.reason.push('Has STREAM-INF tag');
    }

    // Strong indicators for variant playlist
    if (content.includes('#EXTINF:')) {
        result.confidence -= 0.5;
        result.reason.push('Has EXTINF tag (variant)');
    }
    if (content.includes('#EXT-X-TARGETDURATION:')) {
        result.confidence -= 0.4;
        result.reason.push('Has TARGETDURATION tag (variant)');
    }
    if (content.includes('#EXT-X-MEDIA-SEQUENCE:')) {
        result.confidence -= 0.3;
        result.reason.push('Has MEDIA-SEQUENCE tag (variant)');
    }

    // Additional context clues
    if (content.includes('#EXT-X-VERSION:')) {
        // Version tag alone doesn't indicate type but adds confidence
        result.confidence += 0.1;
        result.reason.push('Has VERSION tag');
    }

    // Check for media segment patterns
    const hasSegments = /\.ts(\?|$)/.test(content) || /\.aac(\?|$)/.test(content) || /\.mp4(\?|$)/.test(content);
    if (hasSegments) {
        result.confidence -= 0.3;
        result.reason.push('Contains media segments');
    }

    result.isMaster = result.confidence > 0;
    return result;
}

/**
 * Parse HLS manifest content
 * @param {string} content - M3U8 content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Object} Parsed manifest info
 */
export function parseHLSManifest(content, baseUrl) {
    const lines = content.split('\n');
    const type = detectPlaylistType(content);
    
    // Early return for non-master playlists
    if (!type.isMaster) {
        return {
            type: 'hls',
            isMasterPlaylist: false,
            segments: parseMediaSegments(content, baseUrl),
            metadata: parseMetadata(content),
            confidence: Math.abs(type.confidence),
            reasons: type.reason
        };
    }

    const variants = [];
    let currentVariant = null;
    let streamInfCount = 0;

    for (const line of lines) {
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            streamInfCount++;
            currentVariant = parseStreamInfo(line);
            console.log(`[DEBUG] 📺 Found HLS STREAM-INF: ${line}`);
        } else if (line && !line.startsWith('#') && currentVariant) {
            // Add URL to variant
            currentVariant.url = resolveUrl(baseUrl, line.trim());
            console.log(`[DEBUG] 🔗 Adding variant URL: ${currentVariant.url}`);
            variants.push(currentVariant);
            currentVariant = null;
        }
    }
    
    console.log(`[DEBUG] 📊 HLS parsing complete: found ${streamInfCount} STREAM-INF tags and ${variants.length} valid variants`);
    if (variants.length === 0 && streamInfCount > 0) {
        console.warn(`[DEBUG] ⚠️ Found ${streamInfCount} STREAM-INF tags but no variants - possible parsing issue!`);
    }

    return {
        type: 'hls',
        isMasterPlaylist: true,
        variants: variants,
        metadata: parseMetadata(content),
        confidence: type.confidence,
        reasons: type.reason
    };
}

/**
 * Parse stream information from STREAM-INF tag
 * @param {string} line - STREAM-INF tag line
 * @returns {Object} Stream information
 */
function parseStreamInfo(line) {
    const info = {
        bandwidth: null,
        resolution: null,
        codecs: null,
        frameRate: null
    };

    // Extract attributes
    const attributes = line.substring(line.indexOf(':') + 1).split(',');
    for (const attr of attributes) {
        const [key, value] = attr.trim().split('=');
        switch (key) {
            case 'BANDWIDTH':
                info.bandwidth = parseInt(value);
                break;
            case 'RESOLUTION':
                info.resolution = value.replace(/"/g, '');
                if (info.resolution) {
                    const [width, height] = info.resolution.split('x');
                    info.width = parseInt(width);
                    info.height = parseInt(height);
                }
                break;
            case 'CODECS':
                info.codecs = value.replace(/"/g, '');
                break;
            case 'FRAME-RATE':
                info.frameRate = parseFloat(value);
                info.fps = parseFloat(value);
                break;
        }
    }

    return info;
}

/**
 * Parse metadata from manifest
 * @param {string} content - M3U8 content
 * @returns {Object} Metadata object
 */
function parseMetadata(content) {
    const metadata = {
        version: null,
        targetDuration: null,
        mediaSequence: null
    };

    const lines = content.split('\n');
    for (const line of lines) {
        if (line.startsWith('#EXT-X-VERSION:')) {
            metadata.version = parseInt(line.split(':')[1]);
        } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            metadata.targetDuration = parseInt(line.split(':')[1]);
        } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            metadata.mediaSequence = parseInt(line.split(':')[1]);
        }
    }

    return metadata;
}

/**
 * Parse media segments from variant playlist
 * @param {string} content - M3U8 content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array} Array of segment URLs
 */
function parseMediaSegments(content, baseUrl) {
    const segments = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
        if (line && !line.startsWith('#') && line.trim()) {
            segments.push(resolveUrl(baseUrl, line.trim()));
        }
    }
    
    return segments;
}

/**
 * Parse DASH manifest content
 * @param {string} content - MPD content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array} Array of variants
 */
export function parseDASHManifest(content, baseUrl) {
    const variants = [];
    try {
        // Check if DOMParser is available
        if (typeof DOMParser !== 'undefined') {
            const parser = new DOMParser();
            const xml = parser.parseFromString(content, 'text/xml');
            
            return processDashXml(xml, baseUrl);
        } else {
            // Fallback for environments without DOMParser
            console.log('DOMParser not available, using basic XML parsing');
            return parseBasicDashXml(content, baseUrl);
        }
    } catch (error) {
        console.error('Failed to parse DASH manifest:', error);
    }
    
    return variants;
}

/**
 * Process DASH XML using DOM methods
 * @param {Document} xml - Parsed XML document
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array} Array of variants
 */
function processDashXml(xml, baseUrl) {
    const variants = [];
    
    // Get all AdaptationSet elements
    const adaptationSets = xml.querySelectorAll('AdaptationSet');
    
    adaptationSets.forEach(adaptSet => {
        const mimeType = adaptSet.getAttribute('mimeType') || '';
        
        // Only process video adaptation sets
        if (mimeType.startsWith('video/')) {
            const representations = adaptSet.querySelectorAll('Representation');
            
            representations.forEach(rep => {
                const variant = extractVariantFromRepresentation(rep, adaptSet, baseUrl);
                if (variant) variants.push(variant);
            });
        }
    });
    
    return variants;
}

/**
 * Extract variant information from representation element
 * @param {Element} rep - Representation element
 * @param {Element} adaptSet - AdaptationSet element
 * @param {string} baseUrl - Base URL
 * @returns {Object} Variant object
 */
function extractVariantFromRepresentation(rep, adaptSet, baseUrl) {
    const variant = {
        id: rep.getAttribute('id'),
        bandwidth: parseInt(rep.getAttribute('bandwidth')),
        width: parseInt(rep.getAttribute('width')),
        height: parseInt(rep.getAttribute('height')),
        codecs: rep.getAttribute('codecs'),
        frameRate: rep.getAttribute('frameRate')
    };
    
    // Convert framerate to fps number
    if (variant.frameRate) {
        if (variant.frameRate.includes('/')) {
            const [num, den] = variant.frameRate.split('/').map(Number);
            variant.fps = num / den;
        } else {
            variant.fps = parseFloat(variant.frameRate);
        }
    }
    
    // Handle segment template
    const segTemplate = rep.querySelector('SegmentTemplate') || 
                        adaptSet.querySelector('SegmentTemplate');
    
    if (segTemplate) {
        variant.initialization = resolveUrl(baseUrl, 
            segTemplate.getAttribute('initialization'));
        variant.segments = resolveUrl(baseUrl, 
            segTemplate.getAttribute('media'));
    }
    
    // Handle base URL
    const baseURLElement = rep.querySelector('BaseURL') || 
                            adaptSet.querySelector('BaseURL');
    
    if (baseURLElement) {
        variant.url = resolveUrl(baseUrl, baseURLElement.textContent);
    }
    
    return variant;
}

/**
 * Basic XML parser for DASH manifests when DOMParser is unavailable
 * @param {string} content - XML content
 * @param {string} baseUrl - Base URL
 * @returns {Array} Array of variants
 */
function parseBasicDashXml(content, baseUrl) {
    const variants = [];
    
    try {
        // Extract AdaptationSet elements with video mimeType
        const videoAdaptSets = extractTagsWithAttribute(content, 'AdaptationSet', 'mimeType', /video\//);
        
        for (const adaptSetXml of videoAdaptSets) {
            // Extract Representation elements
            const representations = extractTags(adaptSetXml, 'Representation');
            
            for (const repXml of representations) {
                const variant = {
                    id: extractAttribute(repXml, 'id'),
                    bandwidth: parseInt(extractAttribute(repXml, 'bandwidth')) || 0,
                    width: parseInt(extractAttribute(repXml, 'width')) || 0,
                    height: parseInt(extractAttribute(repXml, 'height')) || 0,
                    codecs: extractAttribute(repXml, 'codecs'),
                    frameRate: extractAttribute(repXml, 'frameRate')
                };
                
                // Convert framerate to fps
                if (variant.frameRate) {
                    if (variant.frameRate.includes('/')) {
                        const [num, den] = variant.frameRate.split('/').map(Number);
                        variant.fps = num / den;
                    } else {
                        variant.fps = parseFloat(variant.frameRate);
                    }
                }
                
                // Handle BaseURL
                const baseURLContent = extractTagContent(repXml, 'BaseURL') || 
                                    extractTagContent(adaptSetXml, 'BaseURL');
                
                if (baseURLContent) {
                    variant.url = resolveUrl(baseUrl, baseURLContent);
                }
                
                // Handle SegmentTemplate
                const segTemplateRep = extractTag(repXml, 'SegmentTemplate');
                const segTemplateAdapt = extractTag(adaptSetXml, 'SegmentTemplate');
                const segTemplate = segTemplateRep || segTemplateAdapt;
                
                if (segTemplate) {
                    const init = extractAttribute(segTemplate, 'initialization');
                    const media = extractAttribute(segTemplate, 'media');
                    
                    if (init) variant.initialization = resolveUrl(baseUrl, init);
                    if (media) variant.segments = resolveUrl(baseUrl, media);
                }
                
                variants.push(variant);
            }
        }
    } catch (error) {
        console.error('Error in basic DASH parser:', error);
    }
    
    return variants;
}

/**
 * Extract tag from XML string
 * @param {string} xml - XML content
 * @param {string} tagName - Tag name
 * @returns {string|null} Tag content or null
 */
function extractTag(xml, tagName) {
    const regExp = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>|<${tagName}[^>]*\\/>`);
    const match = xml.match(regExp);
    return match ? match[0] : null;
}

/**
 * Extract all matching tags from XML string
 * @param {string} xml - XML content
 * @param {string} tagName - Tag name
 * @returns {Array} Array of matching tag strings
 */
function extractTags(xml, tagName) {
    const regExp = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>|<${tagName}[^>]*\\/>`, 'g');
    return xml.match(regExp) || [];
}

/**
 * Extract tag content
 * @param {string} xml - XML content
 * @param {string} tagName - Tag name
 * @returns {string|null} Content between tags or null
 */
function extractTagContent(xml, tagName) {
    const regExp = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
    const match = xml.match(regExp);
    return match ? match[1].trim() : null;
}

/**
 * Extract attribute value from XML tag
 * @param {string} xml - XML tag
 * @param {string} attrName - Attribute name
 * @returns {string|null} Attribute value or null
 */
function extractAttribute(xml, attrName) {
    const regExp = new RegExp(`${attrName}=["']([^"']*)["']`);
    const match = xml.match(regExp);
    return match ? match[1] : null;
}

/**
 * Extract tags with a specific attribute value
 * @param {string} xml - XML content
 * @param {string} tagName - Tag name
 * @param {string} attrName - Attribute name
 * @param {RegExp} attrValueRegex - Regular expression to match attribute value
 * @returns {Array} Array of matching tags
 */
function extractTagsWithAttribute(xml, tagName, attrName, attrValueRegex) {
    const tags = extractTags(xml, tagName);
    return tags.filter(tag => {
        const attrValue = extractAttribute(tag, attrName);
        return attrValue && attrValueRegex.test(attrValue);
    });
}

/**
 * Extract attribute value from HLS tag
 * @param {string} line - HLS tag line
 * @param {string} attr - Attribute name
 * @returns {string|null} Attribute value or null
 */
function extractHlsAttribute(line, attr) {
    const match = new RegExp(attr + '=([^,]+)').exec(line);
    return match ? match[1].replace(/"/g, '') : null;
}

/**
 * Resolve relative URL against base URL
 * @param {string} base - Base URL
 * @param {string} relative - Relative URL
 * @returns {string} Resolved URL
 */
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch {
        return relative;
    }
}