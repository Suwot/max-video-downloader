/**
 * Parse HLS manifest content
 * @param {string} content - M3U8 content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {Array} Array of variants
 */
export function parseHLSManifest(content, baseUrl) {
    const variants = [];
    const lines = content.split('\n');
    let currentVariant = null;
    
    lines.forEach(line => {
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            // Parse stream info
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
            
        } else if (line && !line.startsWith('#') && currentVariant) {
            // Add URL to variant
            currentVariant.url = resolveUrl(baseUrl, line.trim());
            variants.push(currentVariant);
            currentVariant = null;
        }
    });
    
    return variants;
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