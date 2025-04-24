/**
 * Detect if an M3U8 file is a master playlist
 * @param {string} content - M3U8 content
 * @returns {boolean} True if this is a master playlist
 */
function isMasterPlaylist(content) {
    // Quick checks for common tags
    const hasStreamInf = content.includes('#EXT-X-STREAM-INF:');
    const hasMediaSegments = content.includes('#EXTINF:');
    const hasTargetDuration = content.includes('#EXT-X-TARGETDURATION:');
    
    // If it has stream variants, it's definitely a master playlist
    if (hasStreamInf && !hasMediaSegments) {
        return true;
    }
    
    // If it has media segments or target duration, it's definitely a variant playlist
    if (hasMediaSegments || hasTargetDuration) {
        return false;
    }
    
    // Default to false if we can't be certain
    return false;
}

/**
 * Parse HLS manifest content and detect relationships
 * @param {string} content - M3U8 content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @param {Object} options - Additional options
 * @returns {Object} Parsed manifest info with variants and relationships
 */
export function parseHLSManifest(content, baseUrl, options = {}) {
    const variants = [];
    const lines = content.split('\n');
    let currentVariant = null;
    let isPlaylist = isMasterPlaylist(content);
    
    // Additional metadata we might find
    const metadata = {
        version: null,
        targetDuration: null,
        mediaSequence: null
    };
    
    lines.forEach(line => {
        // Parse version
        if (line.startsWith('#EXT-X-VERSION:')) {
            metadata.version = parseInt(line.split(':')[1]);
        }
        // Parse target duration
        else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            metadata.targetDuration = parseInt(line.split(':')[1]);
        }
        // Parse media sequence
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            metadata.mediaSequence = parseInt(line.split(':')[1]);
        }
        // Parse stream info
        else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            isPlaylist = true;
            currentVariant = {
                bandwidth: extractAttribute(line, 'BANDWIDTH'),
                resolution: extractAttribute(line, 'RESOLUTION'),
                codecs: extractAttribute(line, 'CODECS'),
                frameRate: extractAttribute(line, 'FRAME-RATE')
            };
            
            // Convert resolution string to width/height
            if (currentVariant.resolution) {
                const [width, height] = currentVariant.resolution.split('x');
                currentVariant.width = parseInt(width);
                currentVariant.height = parseInt(height);
            }
            
            // Convert frame rate to number
            if (currentVariant.frameRate) {
                currentVariant.fps = parseFloat(currentVariant.frameRate);
            }
        } 
        else if (line && !line.startsWith('#') && currentVariant) {
            // Add URL to variant
            currentVariant.url = resolveUrl(baseUrl, line.trim());
            // Add type and relationship info
            currentVariant.type = 'hls';
            currentVariant.isVariant = true;
            variants.push(currentVariant);
            currentVariant = null;
        }
    });
    
    // Sort variants by resolution (height) in descending order
    variants.sort((a, b) => {
        if (!a.height || !b.height) return 0;
        return b.height - a.height;
    });
    
    // If this is a master playlist, return full info
    if (isPlaylist) {
        return {
            type: 'hls',
            isPlaylist: true,
            variants: variants,
            highestQuality: variants[0],
            baseUrl: baseUrl,
            metadata
        };
    }
    
    // If this is a variant playlist, return simpler info
    return {
        type: 'hls',
        isPlaylist: false,
        url: baseUrl,
        segments: parseHLSSegments(content, baseUrl),
        metadata
    };
}

/**
 * Parse HLS segments from a variant manifest
 * @param {string} content - M3U8 content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array} Array of segment URLs
 */
function parseHLSSegments(content, baseUrl) {
    const segments = [];
    const lines = content.split('\n');
    
    lines.forEach(line => {
        if (line && !line.startsWith('#')) {
            segments.push(resolveUrl(baseUrl, line.trim()));
        }
    });
    
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
        const parser = new DOMParser();
        const xml = parser.parseFromString(content, 'text/xml');
        
        // Get all AdaptationSet elements
        const adaptationSets = xml.querySelectorAll('AdaptationSet');
        
        adaptationSets.forEach(adaptSet => {
            const mimeType = adaptSet.getAttribute('mimeType') || '';
            
            // Only process video adaptation sets
            if (mimeType.startsWith('video/')) {
                const representations = adaptSet.querySelectorAll('Representation');
                
                representations.forEach(rep => {
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
                    
                    variants.push(variant);
                });
            }
        });
        
    } catch (error) {
        console.error('Failed to parse DASH manifest:', error);
    }
    
    return variants;
}

/**
 * Extract attribute value from HLS tag
 * @param {string} line - HLS tag line
 * @param {string} attr - Attribute name
 * @returns {string|null} Attribute value or null
 */
function extractAttribute(line, attr) {
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