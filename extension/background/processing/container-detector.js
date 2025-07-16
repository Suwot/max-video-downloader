/**
 * Container Detection System
 * Centralized, reliable container detection for all media types
 * Based on codec analysis, mimeType detection, and robust fallback chains
 */

/**
 * Minimal codec to container mapping - only special cases that need specific handling
 * Everything else falls back to universal containers (MP4 for video, MP3 for audio)
 */
const CODEC_TO_CONTAINER = {
    // === VIDEO CODECS - Only specify non-MP4 cases ===
    // VP8/VP9 → WebM (native container)
    'vp8': 'webm',
    'vp9': 'webm', 
    'vp09': 'webm',
    'vp80': 'webm',
    
    // Lossless video → MKV (best support)
    'ffv1': 'mkv',
    'huffyuv': 'mkv',
    'utvideo': 'mkv',
    
    // Theora → OGG (native container)
    'theo': 'ogg',
    'thra': 'ogg',
    
    // === AUDIO CODECS - Only specify non-MP3 cases ===
    // AAC family → M4A (native container, no transcoding needed)
    'mp4a': 'm4a',
    'aac': 'm4a',
    'aacp': 'm4a',
    'he-aac': 'm4a',
    'he-aacv2': 'm4a',
    'alac': 'm4a',     // Apple Lossless
    'als': 'm4a',      // MPEG-4 ALS
    
    // Opus → WebM (native container)
    'opus': 'webm',
    
    // Vorbis → OGG (native container)
    'vorbis': 'ogg',
    
    // FLAC → FLAC (native container)
    'flac': 'flac',
    
    // High-end audio → MKV (best support)
    'dts': 'mkv',
    'dtshd': 'mkv',
    'dtse': 'mkv',
    'truehd': 'mkv',
    'mlp': 'mkv',
    'tta': 'mkv',
    'wavpack': 'mkv',
    'wv': 'mkv',
    'ape': 'mkv'
    
    // Everything else falls back to MP4 (video) or MP3 (audio) in the detection logic
};

/**
 * Minimal MIME type to container mapping - only special cases that need specific handling
 * Everything else falls back to universal containers (MP4 for video, MP3 for audio)
 */
const MIMETYPE_TO_CONTAINER = {
    // === VIDEO MIME TYPES - Only specify non-MP4 cases ===
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/mkv': 'mkv',
    'video/ogg': 'ogg',
    'video/x-theora': 'ogg',
    
    // === AUDIO MIME TYPES - Only specify non-MP3 cases ===
    'audio/mp4': 'm4a',
    'audio/aac': 'm4a',
    'audio/aacp': 'm4a',
    'audio/x-aac': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/x-m4b': 'm4a',
    'audio/x-m4p': 'm4a',
    'audio/x-m4r': 'm4a',
    'audio/x-alac': 'm4a',
    'audio/x-caf': 'm4a',
    'audio/3gpp': 'm4a',
    'audio/3gpp2': 'm4a',
    'audio/x-hx-aac-adts': 'm4a',
    'audio/aac-adts': 'm4a',
    'audio/aacp-adts': 'm4a',
    'audio/x-ac3': 'm4a',
    'audio/ac3': 'm4a',
    
    'audio/webm': 'webm',
    'audio/opus': 'webm',
    
    'audio/ogg': 'ogg',
    'audio/vorbis': 'ogg',
    'audio/x-vorbis': 'ogg',
    'audio/x-vorbis+ogg': 'ogg',
    'audio/x-speex': 'ogg',
    'audio/speex': 'ogg',
    
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    
    'audio/x-matroska': 'mkv',
    'audio/x-dts': 'mkv',
    'audio/vnd.dts': 'mkv',
    'audio/vnd.dts.hd': 'mkv',
    'audio/x-tta': 'mkv',
    'audio/x-wavpack': 'mkv',
    'audio/x-ape': 'mkv',
    
    // === SUBTITLE MIME TYPES ===
    'text/vtt': 'vtt',
    'text/webvtt': 'vtt',
    'application/x-subrip': 'srt',
    'text/srt': 'srt',
    'application/ttml+xml': 'ttml',
    'application/ttaf+xml': 'ttml',
    'text/x-ass': 'ass',
    'text/x-ssa': 'ass',
    'text/plain': 'srt',
    'application/x-subtitle': 'srt',
    'application/subtitle': 'srt'
    
    // Everything else falls back to MP4 (video) or MP3 (audio) in the detection logic
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
 * Determine container from codec analysis with smart fallbacks
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
        let suggestedContainer = CODEC_TO_CONTAINER[codec];
        
        // Apply fallbacks if not in mapping
        if (!suggestedContainer) {
            // Determine if it's video or audio codec and apply fallback
            if (isVideoCodec(codec)) {
                suggestedContainer = 'mp4'; // Video fallback
                codecAnalysis.hasVideo = true;
                codecAnalysis.videoCodecs.push(codec);
            } else if (isAudioCodec(codec)) {
                suggestedContainer = 'mp3'; // Audio fallback
                codecAnalysis.hasAudio = true;
                codecAnalysis.audioCodecs.push(codec);
            }
        } else {
            // Categorize known codecs
            if (isVideoCodec(codec)) {
                codecAnalysis.hasVideo = true;
                codecAnalysis.videoCodecs.push(codec);
            } else {
                codecAnalysis.hasAudio = true;
                codecAnalysis.audioCodecs.push(codec);
            }
        }
        
        if (suggestedContainer) {
            containerVotes[suggestedContainer] = (containerVotes[suggestedContainer] || 0) + 1;
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
 * Check if a codec is a video codec
 * @param {string} codec - Codec identifier
 * @returns {boolean} True if video codec
 */
function isVideoCodec(codec) {
    const videoCodecPatterns = [
        /^(avc|hvc|hev|h26[45]|x264|vp[089]|av0?1)/, // Modern video codecs
        /^(mp4v|divx|div[345]|xvid|3iv)/, // MPEG-4 Visual/DivX/XviD
        /^(wmv|rv[1-4]0|mjp|svq|cvid|iv[345])/, // Legacy video codecs
        /^(theo|ffv1|huffyuv|utvideo)/ // Other video codecs
    ];
    
    return videoCodecPatterns.some(pattern => pattern.test(codec));
}

/**
 * Check if a codec is an audio codec
 * @param {string} codec - Codec identifier
 * @returns {boolean} True if audio codec
 */
function isAudioCodec(codec) {
    const audioCodecPatterns = [
        /^(mp4a|aac|opus|vorbis|mp[123]|flac)/, // Modern audio codecs
        /^(alac|als|ac-?3|dts|truehd|mlp)/, // High-quality audio codecs
        /^(wma|ra|amr|qcelp|gsm|pcm|wav)/ // Legacy audio codecs
    ];
    
    return audioCodecPatterns.some(pattern => pattern.test(codec));
}

/**
 * Determine container from mimeType with smart fallbacks
 * @param {string} mimeType - MIME type to analyze
 * @returns {Object} Container analysis result
 */
function determineContainerFromMimeType(mimeType) {
    if (!mimeType) return { container: null, confidence: 'none', reason: 'no mime type' };
    
    const normalizedMime = mimeType.toLowerCase().split(';')[0]; // Remove parameters
    
    // Check specific mapping first
    if (MIMETYPE_TO_CONTAINER[normalizedMime]) {
        return {
            container: MIMETYPE_TO_CONTAINER[normalizedMime],
            confidence: 'high',
            reason: `mime type: ${normalizedMime}`
        };
    }
    
    // Apply fallbacks based on MIME type category
    if (normalizedMime.startsWith('video/')) {
        return {
            container: 'mp4',
            confidence: 'medium',
            reason: `video mime fallback: ${normalizedMime} → mp4`
        };
    } else if (normalizedMime.startsWith('audio/')) {
        return {
            container: 'mp3',
            confidence: 'medium',
            reason: `audio mime fallback: ${normalizedMime} → mp3`
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
 * Unified container detection for all media types and contexts
 * Single entry point that handles video, audio, and subtitle container detection
 * @param {Object} options - Detection options
 * @param {string} [options.codecs] - Codec string
 * @param {string} [options.mimeType] - MIME type
 * @param {string} [options.url] - URL
 * @param {string} [options.ffprobeContainer] - FFprobe container info
 * @param {string} [options.mediaType] - Media type ('video', 'audio', 'subtitle')
 * @param {string} [options.videoType] - Video type ('hls', 'dash', 'direct')
 * @param {string} [options.videoContainer] - Associated video container (for subtitles)
 * @param {boolean} [options.separateContainers] - Return separate video/audio containers
 * @returns {Object} Container detection result
 */
export function detectAllContainers(options = {}) {
    const { codecs, mimeType, url, ffprobeContainer, mediaType, videoType, videoContainer, separateContainers } = options;
    
    // If separate containers requested, handle that case
    if (separateContainers) {
        return detectSeparateVideoAudio(options);
    }
    
    // Handle subtitle-specific detection
    if (mediaType === 'subtitle') {
        return detectSubtitleWithContext(options);
    }
    
    // Standard detection for video/audio/unknown
    return detectSingleContainer(options);
}

/**
 * Core single container detection with unified fallback chain
 * @param {Object} options - Detection options
 * @returns {Object} Container detection result
 */
function detectSingleContainer(options) {
    const { codecs, mimeType, url, ffprobeContainer, mediaType } = options;
    
    // Simple reliability-ordered fallback chain
    const detectionResults = [];
    
    // 1. FFprobe container (highest reliability - direct media only)
    if (ffprobeContainer) {
        const container = ffprobeContainer.toLowerCase();
        const ffprobeMapping = {
            'mp4': 'mp4',
            'quicktime': 'mp4',
            'webm': 'webm',
            'matroska': 'webm',
            'mkv': 'mkv',
            'mov': 'mp4' // Convert MOV to MP4 for better compatibility
        };
        
        for (const [key, value] of Object.entries(ffprobeMapping)) {
            if (container.includes(key)) {
                detectionResults.push({ 
                    container: value, 
                    confidence: 'highest', 
                    reason: `ffprobe container${key === 'mov' ? ' (mov->mp4)' : ''}` 
                });
                break;
            }
        }
    }
    
    // 2. Codec analysis (high reliability)
    if (codecs && detectionResults.length === 0) {
        const codecResult = determineContainerFromCodecs(codecs);
        if (codecResult.container) {
            detectionResults.push(codecResult);
        }
    }
    
    // 3. MIME type analysis (high reliability)
    if (mimeType && detectionResults.length === 0) {
        const mimeResult = determineContainerFromMimeType(mimeType);
        if (mimeResult.container) {
            detectionResults.push(mimeResult);
        }
    }
    
    // 4. URL structure analysis (low reliability)
    if (url && detectionResults.length === 0) {
        const urlResult = determineContainerFromUrl(url);
        if (urlResult.container) {
            detectionResults.push(urlResult);
        }
    }
    
    // 5. Media type fallback (lowest reliability)
    if (detectionResults.length === 0) {
        const fallbackMapping = {
            'audio': { container: 'mp3', reason: 'audio fallback' },
            'subtitle': { container: 'srt', reason: 'subtitle fallback' },
            'video': { container: 'mp4', reason: 'video fallback' }
        };
        
        const fallback = fallbackMapping[mediaType] || fallbackMapping.video;
        detectionResults.push({
            container: fallback.container,
            confidence: 'fallback',
            reason: fallback.reason
        });
    }
    
    // Return best result (first in reliability order)
    const bestResult = detectionResults[0];
    return {
        container: bestResult.container,
        confidence: bestResult.confidence,
        reason: bestResult.reason,
        allAttempts: detectionResults
    };
}

/**
 * Detect separate video and audio containers for mixed content
 * @param {Object} options - Detection options
 * @returns {Object} Separate container detection result
 */
function detectSeparateVideoAudio(options) {
    const { codecs } = options;
    
    let videoContainer = null;
    let audioContainer = null;
    let reason = 'fallback';
    
    // Try codec-based separation first
    if (codecs) {
        const codecAnalysis = determineContainerFromCodecs(codecs);
        if (codecAnalysis.codecAnalysis) {
            const { hasVideo, hasAudio, videoCodecs, audioCodecs } = codecAnalysis.codecAnalysis;
            
            if (hasVideo && videoCodecs.length > 0) {
                videoContainer = CODEC_TO_CONTAINER[videoCodecs[0]] || 'mp4';
            }
            
            if (hasAudio && audioCodecs.length > 0) {
                audioContainer = CODEC_TO_CONTAINER[audioCodecs[0]] || 'mp3';
            }
            
            if (videoContainer || audioContainer) {
                reason = 'codec analysis';
            }
        }
    }
    
    // Apply fallbacks if codec analysis failed
    if (!videoContainer && !audioContainer) {
        const unified = detectSingleContainer(options);
        videoContainer = unified.container;
        audioContainer = 'mp3'; // Safe audio fallback
        reason = `unified fallback: ${unified.reason}`;
    }
    
    return {
        videoContainer: videoContainer || 'mp4',
        audioContainer: audioContainer || 'mp3',
        containerDetectionReason: reason
    };
}

/**
 * Detect subtitle container with video type context
 * @param {Object} options - Detection options
 * @returns {Object} Container detection result
 */
function detectSubtitleWithContext(options) {
    const { mimeType, url, videoType, videoContainer } = options;
    
    // Try standard detection first
    const standardResult = detectSingleContainer({ mimeType, url, mediaType: 'subtitle' });
    
    // If we got a reliable result, use it
    if (standardResult.confidence !== 'fallback') {
        return standardResult;
    }
    
    // Apply context-aware fallbacks
    let fallbackContainer = 'srt'; // Universal fallback
    let fallbackReason = 'subtitle fallback';
    
    if (videoType === 'hls') {
        fallbackContainer = 'vtt';
        fallbackReason = 'hls subtitle fallback';
    } else if (videoType === 'dash') {
        fallbackContainer = videoContainer === 'webm' ? 'vtt' : 'ttml';
        fallbackReason = 'dash subtitle fallback';
    }
    
    return {
        container: fallbackContainer,
        confidence: 'fallback',
        reason: fallbackReason,
        allAttempts: standardResult.allAttempts
    };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use detectAllContainers instead
 */
export function detectContainer(options = {}) {
    return detectAllContainers(options);
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use detectAllContainers with separateContainers: true instead
 */
export function detectSeparateContainers(options = {}) {
    return detectAllContainers({ ...options, separateContainers: true });
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use detectAllContainers with mediaType: 'subtitle' instead
 */
export function detectSubtitleContainer(options = {}) {
    return detectAllContainers({ ...options, mediaType: 'subtitle' });
}