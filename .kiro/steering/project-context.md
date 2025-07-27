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

## Native Host CLI Commands

- **-version** - Show version (0.1.0)
- **-build [platform]** - Build for specific platform (mac-arm64, mac-x64, win-x64, win-arm64)
- **-install** - Install native host for all detected browsers
- **-uninstall** - Remove native host from all browsers
- **-detect-browsers** - Show detected browsers on system
- **-package-app** - Create macOS .app bundle
- **--dry-run** - Test commands without making changes

## Browser Support

**Chromium-based (same extension ID: bkblnddclhmmgjlmbofhakhhbklkcofd):**
- Chrome (Stable + Canary), Arc, Edge (all channels), Brave, Opera, Vivaldi, Epic, Yandex

**Firefox-based (different extension ID: max-video-downloader@rostislav.dev):**
- Firefox, Tor Browser

**Installation Methods:**
- macOS/Linux: Manifest files in browser directories
- Windows: Registry entries + manifest files

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
│   ├── styles/             # SCSS partials with _variables.scss (CSS is autocompiled output)
│   └── [index,ui,state,communication].js
└── shared/utils/           # logger, headers-utils, preview-cache, processing-utils

native_host/
├── bin/mac/bin/            # Bundled FFmpeg + FFprobe binaries
├── build/                  # Build outputs (gitignored)
│   ├── mac-arm64/         # Built binaries: mvdcoapp, ffmpeg, ffprobe
│   └── pro.maxvideodownloader.coapp.app/  # macOS app bundle
├── commands/               # [download,get-qualities,generate-preview,heartbeat,file-system].js
├── lib/                    # messaging, command-runner, error-handler, progress/
├── services/               # config, ffmpeg integration
├── build.sh               # Cross-platform build & install script
└── package.json           # Version 0.1.0, executable: mvdcoapp
```

## Technology Stack

- **Extension**: ES6 modules, Chrome APIs (webRequest, scripting, downloads, nativeMessaging, storage, tabs)
- **Native Host**: Node.js, pkg binary packaging, bundled FFmpeg/FFprobe binaries
- **Build System**: Cross-platform bash script with platform detection, browser detection, registry management
- **Styling**: SCSS with partials system (\_variables.scss used for all styles in all partials, CSS is autocompilation output by liveSass extension)
- **Communication**: Port messaging (popup), connectNative (native host)
- **Distribution**: Standalone executables (mvdcoapp), macOS app bundles, multi-browser installation

## Performance Considerations

- **Memory management**: Rolling cleanup in webRequest handlers, immediate disposal of temporary data
- **UI responsiveness**: Minimal DOM manipulation, direct HTML insertion over createElement chains
- **Background efficiency**: Service worker hibernation-aware, persistent connections only when needed
- **Native host**: Process spawning optimization, FFmpeg binary reuse, progress streaming
- **Build efficiency**: Platform-specific builds, no duplication of binaries, smart path resolution
- **Cross-platform**: Single codebase with platform-specific deployment

## Development Environment

- **Single environment**: Production files used for development (no dev/prod separation)
- **ESLint**: Chrome extension aware linting with ES6 modules (extension) + CommonJS (native_host)
- **Test page**: Single HTML with all video types for simultaneous detection testing
- **Settings UI**: Exists but empty, planned for comprehensive user options
- **Build workflow**: `npm run build:mac` for quick rebuilds, `./build.sh -install` for testing
- **Path resolution**: Smart detection between dev (source) and built (pkg) environments

## Build Commands

```bash
# Build native host (new system)
cd native_host && npm run build:mac     # Quick rebuild for mac-arm64
cd native_host && ./build.sh -build     # Build for current platform
cd native_host && ./build.sh -install   # Install for all detected browsers

# Cross-platform builds
./build.sh -build mac-arm64              # macOS Apple Silicon
./build.sh -build win-x64                # Windows x64
./build.sh -package-app                  # Create macOS .app bundle

# Browser management
./build.sh -detect-browsers              # Show detected browsers
./build.sh -uninstall                    # Remove from all browsers
./build.sh --dry-run -install            # Test without changes

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
