// Precompiled detectors (regex are case-insensitive and tolerate query/hash) with audio-only extensions as well
const DIRECT_EXT_RE = /\.(mp4|webm|ogg|mov|avi|mkv|flv|3gp|wmv|m4a|mp3|wav|flac|aac|oga|opus|mka)(?:$|[?#])/i;
const MPD_RE  = /\.mpd(?:$|[?#])/i;
const M3U8_RE = /\.m3u8(?:$|[?#])/i;

// Obvious non-media extensions (early return perf guard only)
const NON_MEDIA_EXT_RE = /\.(?:js|mjs|css|map|json|html?|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|pdf)(?:$|[?#])/i;
// Very common non-media hostnames (analytics/fonts). Keep tiny and safe.
const NON_MEDIA_DOMAINS = new Set([
  'googletagmanager.com',
  'google-analytics.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);

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

    // Early reject: obvious non-media assets by extension
    if (NON_MEDIA_EXT_RE.test(url)) return null;
    // Early reject: well-known non-media hostnames
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (NON_MEDIA_DOMAINS.has(host) || host.endsWith('.googlesyndication.com')) return null;
    } catch {
        // Invalid URL, continue with detection
    }

    const normalizedMime = metadata?.contentType ? metadata.contentType.split(';')[0].trim().toLowerCase() : null;

    // HLS: URL ends with .m3u8 or MIME contains "mpegurl"
    if (M3U8_RE.test(url) || (normalizedMime && /\bmpegurl\b/.test(normalizedMime))) {
        return { type: 'hls', mime: normalizedMime };
    }

    // DASH: URL ends with .mpd or DASH specific MIME
    if (MPD_RE.test(url) || normalizedMime === 'application/dash+xml') {
        return { type: 'dash', mime: normalizedMime };
    }

    // Skip video/mp2t (almost always HLS segments, too rare as direct video)
    if (normalizedMime === 'video/mp2t') return null;

    // Direct: clear audio/video mime or rare direct mimes, or strong extension hint
    const hasDirectMime = (normalizedMime && (normalizedMime.startsWith('video/') || normalizedMime.startsWith('audio/') || DIRECT_MIMES.has(normalizedMime)));
    const hasDirectExt = DIRECT_EXT_RE.test(url);
    if (hasDirectMime || hasDirectExt) {
        let originalContainer = null;
        if (normalizedMime) {
            originalContainer = normalizedMime.split('/')[1];
        } else {
            const extMatch = DIRECT_EXT_RE.exec(url);
            originalContainer = extMatch ? extMatch[1].toLowerCase() : null;
        }
        const mediaType = normalizedMime?.startsWith('audio/') ? 'audio' : 'video';
        return { type: 'direct', mediaType, originalContainer, mime: normalizedMime };
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

    // Conservative URL range param skip: only for direct candidates (manifests are often tiny and chunked)
    if (candidate?.type === 'direct' && /[?&](?:bytes|range)=\d+-\d+/i.test(url)) {
        return false;
    }

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
    const mime = candidate?.mime != null ? candidate.mime : (metadata?.contentType ? metadata.contentType.split(';')[0].trim().toLowerCase() : null);
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