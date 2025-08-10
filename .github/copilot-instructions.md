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
- **validateConnection** - Connection validation and host info retrieval
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
│   ├── processing/         # hls/dash parsers, video-store
│   ├── messaging/          # popup-communication, native-host-service (connection management)
│   ├── download/           # download-manager
│   └── state/              # tab-manager, settings-manager
├── popup/
│   ├── video/              # video-renderer, download-handler, dropdown, preview-hover
│   ├── styles/             # SCSS partials with _variables.scss (CSS is autocompiled output)
│   ├── settings-tab.js     # Settings UI with native host connection status
│   └── [index,ui,state,communication].js
└── shared/utils/           # logger, headers-utils, preview-cache, processing-utils

native_host/
├── bin/                    # Platform-specific FFmpeg + FFprobe binaries
│   ├── mac-arm64/         # macOS Apple Silicon binaries
│   ├── mac-x64/           # macOS Intel binaries  
│   ├── win-x64/           # Windows x64 binaries
│   ├── win-arm64/         # Windows ARM64 binaries
│   ├── linux-x64/         # Linux x64 binaries
│   └── linux-arm64/       # Linux ARM64 binaries
├── build/                  # Build outputs (gitignored)
│   ├── mac-arm64/         # Built binaries: mvdcoapp, ffmpeg, ffprobe
│   └── pro.maxvideodownloader.coapp.app/  # macOS app bundle
├── commands/               # [download,get-qualities,generate-preview,validate-connection,file-system].js
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
- **Background efficiency**: Service worker hibernation-aware, on-demand native host connections
- **Native host**: Process spawning optimization, FFmpeg binary reuse, progress streaming
- **Connection management**: UI displays real-time connection status, manual reconnect available
- **Build efficiency**: Platform-specific builds, no duplication of binaries, smart path resolution
- **Cross-platform**: Single codebase with platform-specific deployment

## Development Environment

- **Single environment**: Production files used for development (no dev/prod separation)
- **ESLint**: Chrome extension aware linting with ES6 modules (extension) + CommonJS (native_host)
- **Test page**: Single HTML with all video types for simultaneous detection testing
- **Settings UI**: Fully implemented with connection status display and native host management
- **Auto-compilation**: SCSS is built automatically on save by extensions, no CLI commands needed
- **Build workflow**: Only run `npm run build` if editing native_host folder, otherwise works on save
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

# Coding Preferences

## Core Rules

**Performance first**: Only implement features that measurably improve performance
**Direct data flow**: Pass data forward through pipeline stages, avoid circular dependencies
**Refactor over add**: Extend existing functions and move logic upstream instead of creating new components
**Trust data, log problems**: No silent failures or masking fallbacks - surface issues with clear logs
**Fix root causes**: Address underlying issues, not symptoms

## File Size Limits

**600-800 lines max per file**: If larger, split by functional responsibility or propose refactoring options

## Implementation Patterns

**Use native approaches**: Plain HTML insertion over DOM creation + querySelector for performance
**Fallback chains**: Use `mostReliable || lessReliable || guaranteed` pattern, not weighted options
**Avoid dynamic imports**: Use static imports when possible for better performance and bundling
**Service worker restriction**: Background service worker (anything in `background/` folder) CAN'T use dynamic imports - it's a Chrome extension restriction
**Leverage platform lifecycles**: Popup dies on close, service worker terminates, content scripts are per-tab
**Return rich data**: Better to return more from one call than make multiple calls
**Cache expensive operations only**: Don't cache cheap operations
**Fail fast**: Use warn/error logs with enough context to trace source

## Code Organization

**Single responsibility per file**: One clear purpose per module
**Pipeline thinking**: Structure as sequential stages where each adds value
**Explicit dependencies**: Make imports and data flow obvious
**Message passing**: Use Chrome APIs for communication, not shared state
**Exports at end**: Use `export {}` statement at file end
**Complex functions need orchestration**: Break down into coordinated steps

## Extension Strategy

**Reuse and extend existing functionality**: Before creating new functions, extend current ones
**Switch to refactoring mode when multiple roles emerge**: Ask:

- Do we already have needed data from prior steps?
- Which functions can be reused or extracted as helpers?
- Which logic should be inline (never reused)?
- Should this function/file move to better streamline flow and separate concerns?
