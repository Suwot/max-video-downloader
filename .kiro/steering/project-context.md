# Project Context

## Product

MAX Video Downloader - Chrome extension (Manifest V3) that downloads videos from any website. Supports HLS (.m3u8), DASH (.mpd), and direct video files through unified pipeline processing.

## Architecture

- **Extension** (`extension/`): Detection, validation, manifest processing via webRequest API
- **Native Host** (`native_host/`): Downloads, conversion, FFmpeg operations using bundled binaries

## State Management

- **Background service worker**: All persistent state, video detection, download tracking, tab management
- **Popup UI**: Stateless display layer that reads from background on open, destroyed on close
- **Communication**: Port messaging for real-time updates, no UI state persistence
- **Data flow**: Background → Popup (read-only), Popup → Background (commands/actions)

## Detection Flow

1. **webRequest.onHeadersReceived** - Primary detection method
2. **Header mapping** - Map headers from onSendHeaders by requestId for 403 bypass
3. **Rolling cleanup** - Immediate cleanup in onHeadersReceived to avoid memory bloat
4. **DNR rules** - Applied per detected media request using mapped headers

## Pipeline Stages

1. **Detect** - webRequest monitoring
2. **Validate** - Format identification and filtering
3. **Process** - Manifest parsing (HLS/DASH) + FFprobe (direct)
4. **Download** - Native host execution with smart container selection
5. **History** - Completion tracking

## Native Host Commands

- **download** - FFmpeg orchestration for video/audio downloads with progress tracking
- **get-qualities** - Stream quality analysis using FFprobe metadata extraction
- **generate-preview** - Thumbnail generation from video URLs with base64 conversion
- **heartbeat** - Connection monitoring between extension and native host
- **file-system** - Cross-platform file operations (open, save dialogs, folder navigation)

## Current File Structure

```
extension/
├── background/
│   ├── detection/          # webRequest detection, video-detector, url-filters
│   ├── processing/         # container-detector, hls/dash parsers, video-store
│   ├── messaging/          # popup-communication, native-host-service
│   ├── download/           # download-manager
│   └── state/              # tab-manager (state-manager unused legacy)
├── popup/
│   ├── video/              # video-renderer, download-handler, dropdown, preview-hover
│   ├── styles/             # SCSS partials with _variables.scss (CSS is compiled output)
│   └── [index,ui,state,communication].js
└── shared/utils/           # logger, headers-utils, preview-cache, processing-utils

native_host/
├── bin/mac/bin/            # Bundled FFmpeg + FFprobe binaries
├── commands/               # [download,get-qualities,generate-preview,heartbeat,file-system].js
├── lib/                    # messaging, command-runner, error-handler, progress/
└── services/               # config, ffmpeg integration
```

## Technology Stack

- **Extension**: ES6 modules, Chrome APIs (webRequest, scripting, downloads, nativeMessaging, storage, tabs)
- **Native Host**: Node.js, pkg binary packaging, bundled FFmpeg/FFprobe binaries
- **Styling**: SCSS with partials system (\_variables.scss used for all styles in all partials, CSS is compilation output)
- **Communication**: Port messaging (popup), connectNative (native host)

## Performance Considerations

- **Memory management**: Rolling cleanup in webRequest handlers, immediate disposal of temporary data
- **UI responsiveness**: Minimal DOM manipulation, direct HTML insertion over createElement chains
- **Background efficiency**: Service worker hibernation-aware, persistent connections only when needed
- **Native host**: Process spawning optimization, FFmpeg binary reuse, progress streaming

## Development Environment

- **Single environment**: Production files used for development (no dev/prod separation)
- **ESLint**: Chrome extension aware linting with ES6 modules (extension) + CommonJS (native_host)
- **Test page**: Single HTML with all video types for simultaneous detection testing
- **Settings UI**: Exists but empty, planned for comprehensive user options

## Build Commands

```bash
# Build native host
cd native_host && npm run build && ./install.sh

# Linting
npm run lint          # Check for errors
npm run lint:fix      # Auto-fix simple issues

# Testing
npm run test:container-detector
cd native_host && node test-host.js
./test_streaming.sh

# Test page: test/videos.html (all video formats)
```

## Extension Lifecycle

- **Service worker**: Persistent background processing, survives tab/popup closure
- **Popup**: Ephemeral UI, recreated on each open, no state retention
- **Content scripts**: Per-tab injection, isolated from extension state
- **Native host**: On-demand process spawning, connection pooling for efficiency

## Edge Cases (Handled Gracefully)

- HLS media-types for audio/subs (hasVideo/hasAudio flags)
- Videos masking as direct but are chunks (preview timeout acceptable)
- Obfuscated headers showing PNG but containing H264 after 4kb (not handled, acceptable)
- Separate audio tracks in video variants (codec-based detection)

## Security & Privacy

- **Manifest V3 compliance**: No eval(), CSP-compliant, declarativeNetRequest for header modification
- **Minimal permissions**: Only required APIs, no broad host permissions
- **Local processing**: All video analysis happens locally, no external API calls
- **User data**: Download history stored locally, no telemetry or tracking
