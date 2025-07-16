/**
 * Container Detection System
 * Centralized, reliable container detection for all media types
 * Based on codec analysis, mimeType detection, and robust fallback chains
 */

/**
 * Codec to container mapping - optimized for best fit per media type
 * Based on industry standards and optimal container formats for each codec
 */
const CODEC_TO_CONTAINER = {
    // Video codecs - only mp4/webm/mkv (covers 100% of cases)
    'avc1': 'mp4',      // H.264
    'avc3': 'mp4',      // H.264
    'hvc1': 'mp4',      // H.265/HEVC
    'hev1': 'mp4',      // H.265/HEVC
    'vp8': 'webm',      // VP8
    'vp9': 'webm',      // VP9
    'vp09': 'webm',     // VP9
    'av01': 'mp4',      // AV1 (MP4 more widely supported)
    'av1': 'mp4',       // AV1
    
    // Audio codecs - best fit for each codec type
    'mp4a': 'm4a',      // AAC → M4A (best fit, no transcoding needed)
    'aac': 'm4a',       // AAC → M4A (best fit, no transcoding needed)
    'opus': 'webm',     // Opus → WebM (native container)
    'vorbis': 'ogg',    // Vorbis → OGG (native container)
    'mp3': 'mp3',       // MP3 → MP3 (native container)
    'ac-3': 'mp4',      // AC-3 → MP4 (common container)
    'ec-3': 'mp4',      // Enhanced AC-3 → MP4 (common container)
    'flac': 'flac',     // FLAC → FLAC (native container)
    'dts': 'mkv'        // DTS → MKV (common container)
};

/**
 * MimeType to container mapping - optimized for best fit per media type
 */
const MIMETYPE_TO_CONTAINER = {
    // Video mime types - only mp4/webm/mkv
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mp4',  // MOV → MP4 (more compatible)
    'video/x-msvideo': 'mp4',  // AVI → MP4 (more compatible)
    'video/x-flv': 'mp4',      // FLV → MP4 (more compatible)
    'video/mp2t': 'mp4',       // TS → MP4 (more compatible)
    
    // Audio mime types - best fit for each type
    'audio/mp4': 'm4a',        // MP4 audio → M4A (best fit)
    'audio/webm': 'webm',      // WebM audio → WebM
    'audio/mpeg': 'mp3',       // MPEG audio → MP3 
    'audio/aac': 'm4a',        // AAC → M4A (best fit)
    'audio/ogg': 'ogg',        // OGG → OGG
    'audio/flac': 'flac',      // FLAC → FLAC
    
    // Subtitle mime types
    'text/vtt': 'vtt',         // WebVTT → VTT
    'application/ttml+xml': 'ttml', // TTML → TTML
    'text/plain': 'srt'        // Plain text → SRT (common format)
};

/**
 * Parse codec string to extract individual codec identifiers
 * @param {string} codecString - Codec string (e.g., "avc1.640028,mp4a.40.2")
 * @returns {Array<string>} Array of individual codec identifiers
 */
function parseCodecString(codecString) {
    if (!codecString) return [];
    
    // Split by comma and clean up
    return codecString.split(',')
        .map(codec => codec.trim())
        .filter(codec => codec.length > 0)
        .map(codec => {
            // Extract base codec identifier (before any dots or parameters)
            const baseCodec = codec.split('.')[0].toLowerCase();
            return baseCodec;
        });
}

/**
 * Determine container from codec analysis
 * @param {string} codecString - Codec string to analyze
 * @returns {Object} Container analysis result
 */
function determineContainerFromCodecs(codecString) {
    const codecs = parseCodecString(codecString);
    if (codecs.length === 0) return { container: null, confidence: 'none', reason: 'no codecs' };
    
    // Analyze codecs and determine container
    const containerVotes = {};
    const codecAnalysis = {
        hasVideo: false,
        hasAudio: false,
        videoCodecs: [],
        audioCodecs: []
    };
    
    for (const codec of codecs) {
        if (CODEC_TO_CONTAINER[codec]) {
            const suggestedContainer = CODEC_TO_CONTAINER[codec];
            containerVotes[suggestedContainer] = (containerVotes[suggestedContainer] || 0) + 1;
            
            // Categorize codec type
            if (['avc1', 'avc3', 'hvc1', 'hev1', 'vp8', 'vp9', 'vp09', 'av01', 'av1'].includes(codec)) {
                codecAnalysis.hasVideo = true;
                codecAnalysis.videoCodecs.push(codec);
            } else {
                codecAnalysis.hasAudio = true;
                codecAnalysis.audioCodecs.push(codec);
            }
        }
    }
    
    // Determine best container based on votes
    const sortedContainers = Object.entries(containerVotes)
        .sort(([,a], [,b]) => b - a);
    
    if (sortedContainers.length === 0) {
        return { container: null, confidence: 'none', reason: 'unknown codecs', codecAnalysis };
    }
    
    const [bestContainer, votes] = sortedContainers[0];
    const confidence = votes === codecs.length ? 'high' : 'medium';
    
    return {
        container: bestContainer,
        confidence,
        reason: `codec analysis (${votes}/${codecs.length} codecs match)`,
        codecAnalysis
    };
}

/**
 * Determine container from mimeType
 * @param {string} mimeType - MIME type to analyze
 * @returns {Object} Container analysis result
 */
function determineContainerFromMimeType(mimeType) {
    if (!mimeType) return { container: null, confidence: 'none', reason: 'no mime type' };
    
    const normalizedMime = mimeType.toLowerCase().split(';')[0]; // Remove parameters
    
    if (MIMETYPE_TO_CONTAINER[normalizedMime]) {
        return {
            container: MIMETYPE_TO_CONTAINER[normalizedMime],
            confidence: 'high',
            reason: `mime type: ${normalizedMime}`
        };
    }
    
    return { container: null, confidence: 'none', reason: `unknown mime type: ${normalizedMime}` };
}

/**
 * Determine container from URL structure
 * @param {string} url - URL to analyze
 * @returns {Object} Container analysis result
 */
function determineContainerFromUrl(url) {
    if (!url) return { container: null, confidence: 'none', reason: 'no url' };
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        
        // Extract extension
        const extMatch = pathname.match(/\.([^./?#]+)$/);
        if (!extMatch) return { container: null, confidence: 'none', reason: 'no extension' };
        
        const extension = extMatch[1];
        
        // Map common extensions to optimal containers
        const extensionMap = {
            // Video extensions - only mp4/webm/mkv
            'mp4': 'mp4',
            'webm': 'webm',
            'mkv': 'mkv',
            'mov': 'mp4',   // MOV → MP4 (more compatible)
            'm4v': 'mp4',   // M4V → MP4 (more compatible)
            'avi': 'mp4',   // AVI → MP4 (more compatible)
            'flv': 'mp4',   // FLV → MP4 (more compatible)
            'ts': 'mp4',    // TS → MP4 (more compatible)
            
            // Audio extensions - best fit for each type
            'mp3': 'mp3',
            'm4a': 'm4a',
            'aac': 'm4a',   // AAC → M4A (best fit)
            'ogg': 'ogg',
            'flac': 'flac',
            'wav': 'wav',
            
            // Subtitle extensions
            'vtt': 'vtt',
            'srt': 'srt',
            'ass': 'ass',
            'ssa': 'ass',   // SSA → ASS (more compatible)
            'sub': 'srt',   // SUB → SRT (more compatible)
            'ttml': 'ttml'
        };
        
        if (extensionMap[extension]) {
            return {
                container: extensionMap[extension],
                confidence: 'low',
                reason: `url extension: .${extension}`
            };
        }
        
        return { container: null, confidence: 'none', reason: `unknown extension: .${extension}` };
    } catch {
        return { container: null, confidence: 'none', reason: 'invalid url' };
    }
}

/**
 * Unified container detection with robust fallback chain
 * @param {Object} options - Detection options
 * @param {string} [options.codecs] - Codec string
 * @param {string} [options.mimeType] - MIME type
 * @param {string} [options.url] - URL
 * @param {string} [options.ffprobeContainer] - FFprobe container info
 * @param {string} [options.mediaType] - Media type ('video' or 'audio')
 * @returns {Object} Container detection result
 */
export function detectContainer(options = {}) {
    const { codecs, mimeType, url, ffprobeContainer, mediaType } = options;
    
    // Track all detection attempts
    const detectionAttempts = [];
    
    // 1. FFprobe container info (highest reliability for direct media)
    if (ffprobeContainer) {
        const container = ffprobeContainer.toLowerCase();
        if (container.includes('mp4') || container.includes('quicktime')) {
            detectionAttempts.push({ container: 'mp4', confidence: 'highest', reason: 'ffprobe container' });
        } else if (container.includes('webm') || container.includes('matroska')) {
            detectionAttempts.push({ container: 'webm', confidence: 'highest', reason: 'ffprobe container' });
        } else if (container.includes('mkv')) {
            detectionAttempts.push({ container: 'mkv', confidence: 'highest', reason: 'ffprobe container' });
        } else if (container.includes('mov')) {
            detectionAttempts.push({ container: 'mp4', confidence: 'highest', reason: 'ffprobe container (mov->mp4)' });
        }
    }
    
    // 2. Codec analysis (high reliability)
    if (codecs) {
        const codecResult = determineContainerFromCodecs(codecs);
        if (codecResult.container) {
            detectionAttempts.push(codecResult);
        }
    }
    
    // 3. MIME type analysis (high reliability)
    if (mimeType) {
        const mimeResult = determineContainerFromMimeType(mimeType);
        if (mimeResult.container) {
            detectionAttempts.push(mimeResult);
        }
    }
    
    // 4. URL structure analysis (low reliability)
    if (url) {
        const urlResult = determineContainerFromUrl(url);
        if (urlResult.container) {
            detectionAttempts.push(urlResult);
        }
    }
    
    // 5. Media type based fallback with improved logic
    if (detectionAttempts.length === 0) {
        let fallbackContainer;
        let fallbackReason;
        
        if (mediaType === 'audio') {
            fallbackContainer = 'mp3'; // Safe transcoding target
            fallbackReason = 'audio fallback (mp3 - safe for transcoding)';
        } else if (mediaType === 'subtitle') {
            // For subtitles, try to infer from video type context if available
            fallbackContainer = 'srt'; // Most universal subtitle format
            fallbackReason = 'subtitle fallback (srt - universal format)';
        } else {
            fallbackContainer = 'mp4'; // Video fallback
            fallbackReason = 'video fallback (mp4 - universal format)';
        }
        
        detectionAttempts.push({
            container: fallbackContainer,
            confidence: 'fallback',
            reason: fallbackReason
        });
    }
    
    // Select best result based on confidence priority
    const confidencePriority = ['highest', 'high', 'medium', 'low', 'fallback'];
    const bestResult = detectionAttempts
        .sort((a, b) => confidencePriority.indexOf(a.confidence) - confidencePriority.indexOf(b.confidence))[0];
    
    return {
        container: bestResult.container,
        confidence: bestResult.confidence,
        reason: bestResult.reason,
        allAttempts: detectionAttempts
    };
}

/**
 * Determine separate video and audio containers for mixed content
 * @param {Object} options - Detection options
 * @param {string} [options.codecs] - Codec string
 * @param {string} [options.mimeType] - MIME type
 * @param {string} [options.url] - URL
 * @returns {Object} Separate container detection result
 */
export function detectSeparateContainers(options = {}) {
    const { codecs, mimeType, url } = options;
    
    // Parse codecs to separate video and audio
    const codecAnalysis = codecs ? determineContainerFromCodecs(codecs) : { codecAnalysis: { hasVideo: false, hasAudio: false, videoCodecs: [], audioCodecs: [] } };
    
    let videoContainer = null;
    let audioContainer = null;
    
    // Analyze video codecs
    if (codecAnalysis.codecAnalysis?.hasVideo && codecAnalysis.codecAnalysis.videoCodecs.length > 0) {
        const videoCodec = codecAnalysis.codecAnalysis.videoCodecs[0]; // Use first video codec
        videoContainer = CODEC_TO_CONTAINER[videoCodec] || 'mp4';
    }
    
    // Analyze audio codecs with better fallback
    if (codecAnalysis.codecAnalysis?.hasAudio && codecAnalysis.codecAnalysis.audioCodecs.length > 0) {
        const audioCodec = codecAnalysis.codecAnalysis.audioCodecs[0]; // Use first audio codec
        audioContainer = CODEC_TO_CONTAINER[audioCodec] || 'mp3'; // Fallback to mp3 for transcoding
    }
    
    // Fallback to unified detection if separate analysis fails
    if (!videoContainer && !audioContainer) {
        const unified = detectContainer(options);
        return {
            videoContainer: unified.container,
            audioContainer: 'mp3', // Always use mp3 for audio when no codec info available
            reason: `unified fallback: ${unified.reason}`
        };
    }
    
    return {
        videoContainer: videoContainer || 'mp4',
        audioContainer: audioContainer || 'mp3', // Default to mp3 for safe transcoding
        reason: 'separate codec analysis'
    };
}

/**
 * Detect subtitle container with video type context awareness
 * @param {Object} options - Detection options
 * @param {string} [options.mimeType] - MIME type
 * @param {string} [options.url] - URL
 * @param {string} [options.videoType] - Video type ('hls', 'dash', 'direct')
 * @param {string} [options.videoContainer] - Associated video container
 * @returns {Object} Container detection result
 */
export function detectSubtitleContainer(options = {}) {
    const { mimeType, url, videoType, videoContainer } = options;
    
    // Try standard detection first
    const standardResult = detectContainer({
        mimeType,
        url,
        mediaType: 'subtitle'
    });
    
    // If we got a reliable result, use it
    if (standardResult.confidence !== 'fallback') {
        return standardResult;
    }
    
    // Enhanced fallback logic based on video type and container
    let fallbackContainer = 'srt'; // Universal fallback
    let fallbackReason = 'subtitle fallback (srt - universal format)';
    
    if (videoType === 'hls') {
        // HLS typically uses WebVTT
        fallbackContainer = 'vtt';
        fallbackReason = 'hls subtitle fallback (vtt - common for hls)';
    } else if (videoType === 'dash') {
        // DASH can use various formats, often WebVTT or TTML
        if (videoContainer === 'webm') {
            fallbackContainer = 'vtt';
            fallbackReason = 'dash webm subtitle fallback (vtt - webm compatible)';
        } else {
            fallbackContainer = 'ttml';
            fallbackReason = 'dash subtitle fallback (ttml - common for dash)';
        }
    } else if (videoType === 'direct') {
        // Direct videos often have SRT or ASS subtitles
        fallbackContainer = 'srt';
        fallbackReason = 'direct video subtitle fallback (srt - common for direct)';
    }
    
    return {
        container: fallbackContainer,
        confidence: 'fallback',
        reason: fallbackReason,
        allAttempts: standardResult.allAttempts
    };
}