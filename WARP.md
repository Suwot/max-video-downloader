# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

MAX Video Downloader is a Chrome extension (Manifest V3) that downloads videos from any website. It supports HLS (.m3u8), DASH (.mpd), and direct video files through a unified pipeline architecture with two main components:

- **Extension** (`extension/`): Video detection, validation, and manifest processing via Chrome's webRequest API
- **Native Host** (`native_host/`): Downloads, conversion, and FFmpeg operations using bundled platform-specific binaries

## Essential Development Commands

### Building and Installation
```bash
# Build native host for current platform
npm run build

# Build for specific platforms
npm run build:mac
npm run dist:mac-arm64
npm run dist:win-x64
npm run dist:linux-x64

# Install native host for all detected browsers
npm run install-host

# Check native host installation status
npm run version-host

# Remove native host from all browsers
npm run uninstall-host
```

### Development Workflow
```bash
# Lint all code (extension + native host)
npm run lint
npm run lint:fix

# Test native host connection
cd native_host && node test-host.js

# Test streaming capabilities
./test_streaming.sh

# Check what browsers are detected
cd native_host && ./build.sh -detect-browsers
```

### Single Test Execution
```bash
# Test specific functionality
cd native_host && node -e "
const cmd = require('./commands/validate-connection.js');
cmd.execute({}).then(console.log);
"

# Test FFmpeg integration
cd native_host && node -e "
const ffmpeg = require('./services/ffmpeg.js');
ffmpeg.getVersion().then(console.log);
"
```

## Architecture Overview

### Core Pipeline Stages
1. **Detect** - webRequest monitoring via `video-detector.js`
2. **Validate** - Format identification through `video-type-identifier.js`
3. **Process** - Manifest parsing (HLS/DASH) + FFprobe analysis (direct videos)
4. **Download** - Native host execution with smart container selection
5. **History** - Completion tracking and storage

### State Management Pattern
- **Background service worker**: All persistent state, video detection, download tracking, tab management
- **Popup UI**: Stateless display layer that reads from background on open, destroyed on close
- **Communication**: Port messaging for real-time updates, no UI state persistence
- **Data flow**: Background → Popup (read-only), Popup → Background (commands/actions)

### Detection Flow
1. **webRequest.onHeadersReceived** - Primary detection method
2. **Header mapping** - Map headers from onSendHeaders by requestId for 403 bypass
3. **Rolling cleanup** - Immediate cleanup in onHeadersReceived to avoid memory bloat
4. **DNR rules** - Applied per detected media request using mapped headers

### Native Host Commands
- **download** - FFmpeg orchestration for video/audio downloads with progress tracking
- **get-qualities** - Stream quality analysis using FFprobe metadata extraction
- **generate-preview** - Thumbnail generation with base64 conversion
- **validateConnection** - Connection validation and host info retrieval
- **file-system** - Cross-platform file operations (dialogs, folder navigation)

## Key Architectural Decisions

### Download ID System
Uses hash-based downloadId generation for privacy and performance:
- **Format**: `{urlHash}_{streamHash}_{audioFlag}_{subsFlag}_{timestamp}`
- **Flow**: UI → Background → Native Host → Background → UI (never modified)
- **Matching**: Downloads-tab uses downloadId (precise), videos-tab uses URL (fallback)

### Multi-Platform Support
**Chromium-based** (same extension ID): Chrome, Arc, Edge, Brave, Opera, Vivaldi, Epic, Yandex
**Firefox-based** (different extension ID): Firefox, Tor Browser

**Installation Methods:**
- macOS/Linux: Manifest files in browser directories
- Windows: Registry entries + manifest files

### Performance-First Implementation
- **Memory management**: Rolling cleanup in webRequest handlers
- **UI responsiveness**: Direct HTML insertion over createElement chains
- **Background efficiency**: Service worker hibernation-aware
- **Native host**: Process spawning optimization, FFmpeg binary reuse

## File Structure Deep Dive

### Extension Architecture
```
extension/
├── background/
│   ├── detection/          # webRequest detection, URL filters
│   ├── processing/         # HLS/DASH parsers, video-store
│   ├── messaging/          # popup-communication, native-host-service
│   ├── download/           # download-manager with queue management
│   └── state/              # tab-manager, settings-manager
├── popup/
│   ├── video/              # video-renderer, download-handler, preview-hover
│   └── styles/             # SCSS partials (_variables.scss drives all styles)
└── shared/utils/           # logger, headers-utils, preview-cache
```

### Native Host Architecture
```
native_host/
├── bin/                    # Platform-specific FFmpeg + FFprobe binaries
│   ├── mac-arm64/         # Apple Silicon
│   ├── win-x64/           # Windows x64
│   └── linux-x64/         # Linux x64
├── commands/               # Command pattern implementation
├── lib/                    # messaging, command-runner, error-handler
├── services/               # config, ffmpeg integration
└── build.sh               # Cross-platform build & install script
```

## Development Constraints and Patterns

### Performance-First Rules
- Only implement features that measurably improve performance
- Pass data forward through pipeline stages, avoid circular dependencies
- Refactor existing functions rather than creating new components
- Trust data, log problems - no silent failures

### File Size Limits
- **600-800 lines max per file** - split by functional responsibility if larger

### Chrome Extension Restrictions
- **Service worker restriction**: Background files (anything in `background/` folder) CAN'T use dynamic imports
- **Manifest V3 compliance**: No eval(), CSP-compliant, declarativeNetRequest for header modification

### Implementation Patterns
- Use native approaches: Plain HTML insertion over DOM creation
- Fallback chains: `mostReliable || lessReliable || guaranteed` pattern
- Return rich data: Better one call with more data than multiple calls
- Exports at end: Use `export {}` statement at file end

## Technology Stack Details

### Extension Technology
- **ES6 modules** with Chrome APIs (webRequest, scripting, downloads, nativeMessaging)
- **Communication**: Port messaging (popup), connectNative (native host)
- **Styling**: SCSS with partials system (auto-compilation by LiveSass extension)

### Native Host Technology
- **Node.js** with pkg binary packaging
- **FFmpeg/FFprobe** bundled platform-specific binaries
- **Cross-platform** bash script with platform detection, browser detection, registry management

### Build System
- **Single environment**: Production files used for development (no dev/prod separation)
- **Platform-specific builds**: No duplication of binaries, smart path resolution
- **Auto-compilation**: SCSS built automatically on save, no CLI commands needed

## Testing and Debugging

### Test Resources
- **Test page**: `test/videos.html` contains all video types for simultaneous detection
- **Stream testing**: `./test_streaming.sh` tests HLS/DASH capabilities
- **Host testing**: `cd native_host && node test-host.js`

### Debugging Tips
- Extension settings UI shows real-time native host connection status
- Smart detection between dev (source) and built (pkg) environments
- ESLint configured for Chrome extension awareness with ES6 modules (extension) + CommonJS (native_host)

## Common Development Workflows

### Extension Changes
1. Edit extension files directly (no build step needed)
2. Reload extension in Chrome developer mode
3. Use `npm run lint` to check for issues

### Native Host Changes
1. Edit files in `native_host/`
2. Run `npm run build` to rebuild
3. Run `npm run install-host` if manifests changed
4. Test with `cd native_host && node test-host.js`

### Styling Changes
1. Edit SCSS files in `popup/styles/`
2. CSS auto-compiles on save (via LiveSass extension)
3. Refresh popup to see changes
