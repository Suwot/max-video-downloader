// Precompiled detectors (regex are case-insensitive and tolerate query/hash)
const DIRECT_EXT_RE = /\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|wmv)(?:$|[?#])/i;
const MPD_RE  = /\.mpd(?:$|[?#])/i;
const M3U8_RE = /\.m3u8(?:$|[?#])/i;

// Segment detection kept intentionally small & strict
const SEGMENT_EXT_RE = /\.(m4s|ts)(?:$|[?#])/i;
const INIT_HEADER_RE = /(^|\/)(init|header)\.(mp4|m4s)(?:$|[?#])/i;
const SEGMENT_PATTERNS = [/(segment|chunk|frag|part|seq)-\d+/i];

// Rare but valid direct binary mimes
const DIRECT_MIMES = new Set(['application/mp4', 'application/ogg']);

/**
 * Classify URL and MIME into candidate types
 * @param {string} url - URL to analyze
 * @param {Object} metadata - Request metadata with contentType
 * @returns {Object|null} Candidate type info or null
 */
export function probe(url, metadata = null) {
    if (!url || typeof url !== 'string') return null;

    const mime = metadata?.contentType ? metadata.contentType.split(';')[0].trim().toLowerCase() : null;

    // Get extension from URL path (before query params)
    let extension = null;
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const match = pathname.match(/\.([a-z0-9]{1,5})$/);
        extension = match ? match[1] : null;
    } catch {
        // Fallback for invalid URLs
        const match = url.toLowerCase().match(/\.([a-z0-9]{1,5})(?:[?#]|$)/);
        extension = match ? match[1] : null;
    }

    // HLS: URL ends with .m3u8 or MIME contains "mpegurl"
    if (M3U8_RE.test(url) || (mime && /\bmpegurl\b/.test(mime))) {
        return { type: 'hls' };
    }

    // DASH: URL ends with .mpd or DASH specific MIME
    if (MPD_RE.test(url) || mime === 'application/dash+xml') {
        return { type: 'dash' };
    }

    // Direct: clear audio/video mime or rare direct mimes, or strong extension hint
    const hasDirectMime = (mime && (mime.startsWith('video/') || mime.startsWith('audio/') || DIRECT_MIMES.has(mime)));
    const hasDirectExt = DIRECT_EXT_RE.test(url);
    if (hasDirectMime || hasDirectExt) {
        return {
            type: 'direct',
            mediaType: mime?.startsWith('audio/') ? 'audio' : 'video',
            originalContainer: mime ? mime.split('/')[1] : extension
        };
    }

    return null;
}

/**
 * Filter out segments and apply size checks (size check only for direct media)
 * @param {string} url - URL to check
 * @param {Object} metadata - Request metadata
 * @param {number} minSize - Minimum file size threshold
 * @param {Object} candidate - Candidate type info from probe() (optional)
 * @returns {boolean} True if should process, false if should skip
 */
export function gate(url, metadata = null, minSize = 1024, candidate = null) {
    if (!url) return false;

    // Reject segment extensions with proper boundaries, and common segment patterns
    if (SEGMENT_EXT_RE.test(url) || INIT_HEADER_RE.test(url) || SEGMENT_PATTERNS.some(p => p.test(url))) {
        return false;
    }

    // Size check ONLY for direct media (not manifests)
    const contentLength = Number.isFinite(metadata?.contentLength) ? metadata.contentLength : null;
    if (candidate?.type === 'direct' && contentLength !== null && contentLength < minSize) {
        return false;
    }

    // Octet-stream needs filename or sufficient size (safer parse)
    const mime = metadata?.contentType ? metadata.contentType.split(';')[0].trim().toLowerCase() : null;
    if (mime === 'application/octet-stream') {
        const hasFilename = !!metadata?.filename;
        if (candidate?.type === 'hls' || candidate?.type === 'dash') {
            return hasFilename || contentLength == null || contentLength > 0;
        }
        if (!hasFilename && (contentLength == null || contentLength < minSize)) {
            return false;
        }
    }

    return true;
}