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
/ (root - main repository)
├── extension/              # Chrome extension source
│   ├── background/
│   │   ├── detection/      # webRequest detection, video-detector, url-filters
│   │   ├── processing/     # hls/dash parsers, video-store
│   │   ├── messaging/      # popup-communication, native-host-service
│   │   ├── download/       # download-manager
│   │   └── state/          # tab-manager, settings-manager
│   ├── popup/
│   │   ├── video/          # video-renderer, download-handler, dropdown, preview-hover
│   │   ├── styles/         # SCSS partials with _variables.scss
│   │   ├── settings-tab.js # Settings UI with native host connection status
│   │   └── [index,ui,state,communication].js
│   └── shared/utils/       # logger, headers-utils, preview-cache, processing-utils
├── native_host/            # Native messaging host
│   ├── bin/                # Platform-specific FFmpeg + FFprobe binaries
│   ├── build/              # Build outputs (gitignored)
│   ├── commands/           # [download,get-qualities,generate-preview,validate-connection,file-system].js
│   ├── lib/                # messaging, command-runner, error-handler, progress/
│   ├── services/           # config, ffmpeg integration
│   ├── utils/              # utility functions
│   ├── build.sh            # Cross-platform build & distribution script
│   ├── install.sh          # System installation script
│   └── uninstall.sh        # System removal script
├── ffmpeg-builder/         # Submodule: FFmpeg/FFprobe build system
│   ├── ffmpeg/             # Nested submodule: FFmpeg source
│   ├── modules/            # Build modules and dependencies
│   ├── recipes/            # Platform-specific build recipes
│   ├── dist/               # Built FFmpeg/FFprobe binaries
│   └── build.sh            # FFmpeg build orchestration
├── chrome-web-store/       # esbuild bundled extension for CWS
│   └── extension/          # Minified, bundled extension files
├── test/                   # Test files and validation
├── docs/                   # Documentation
├── esbuild.config.js       # Extension bundling configuration
├── build-cws-esbuild.sh    # Chrome Web Store build script
└── test-bundled-extension.sh # CWS build validation
```

## Technology Stack

- **Extension**: ES6 modules, Chrome APIs (webRequest, scripting, downloads, nativeMessaging, storage, tabs)
- **Native Host**: Node.js, pkg binary packaging, bundled FFmpeg/FFprobe binaries
- **FFmpeg Build System**: Submodule-based FFmpeg/FFprobe compilation with platform-specific recipes
- **Build System**: Cross-platform bash scripts with platform detection, browser detection, registry management
- **Production Builds**: esbuild bundling/minification for Chrome Web Store submission
- **Styling**: SCSS with partials system (\_variables.scss used for all styles in all partials, CSS is autocompilation output by liveSass extension)
- **Communication**: Port messaging (popup), connectNative (native host)
- **Distribution**: Self-contained installers, standalone executables (mvdcoapp), macOS app bundles, multi-browser installation
- **Submodules**: Git submodules for FFmpeg builder and FFmpeg source separation

## Performance Considerations

- **Memory management**: Rolling cleanup in webRequest handlers, immediate disposal of temporary data
- **UI responsiveness**: Minimal DOM manipulation, direct HTML insertion over createElement chains
- **Background efficiency**: Service worker hibernation-aware, on-demand native host connections
- **Native host**: Process spawning optimization, FFmpeg binary reuse, progress streaming
- **Connection management**: UI displays real-time connection status, manual reconnect available
- **Build efficiency**: Platform-specific builds, no duplication of binaries, smart path resolution
- **Cross-platform**: Single codebase with platform-specific deployment

## Development Environment

- **Development**: Source files used directly (no dev/prod separation for development)
- **Production**: esbuild bundling/minification for Chrome Web Store submission
- **ESLint**: Chrome extension aware linting with ES6 modules (extension) + CommonJS (native_host)
- **Test page**: Single HTML with all video types for simultaneous detection testing
- **Settings UI**: Fully implemented with connection status display and native host management
- **Auto-compilation**: SCSS is built automatically on save by extensions, no CLI commands needed
- **Build workflow**: 
  - Extension development: Works on save, no build needed
  - Native host changes: Run `npm run build` to rebuild
  - FFmpeg changes: Use ffmpeg-builder submodule build system
  - CWS submission: Run `npm run build:cws` for bundled package
- **Path resolution**: Smart detection between dev (source) and built (pkg) environments
- **Submodule management**: FFmpeg builder as separate repository for cross-project reuse
- **Distribution workflow**: `npm run dist:[platform]` creates self-contained installers

## Build Commands

```bash
# Development & Linting
npm run lint                             # ESLint check for extension/ native_host/ *.js
npm run lint:fix                         # Auto-fix ESLint issues

# Native Host Builds
npm run build                            # Build native host for current platform
npm run build:mac                        # Build for mac-arm64 specifically
npm run version-host                     # Show native host version

# Distribution Builds (Self-contained installers)
npm run dist:mac-arm64                   # macOS Apple Silicon distribution
npm run dist:mac-x64                     # macOS Intel distribution  
npm run dist:win-x64                     # Windows x64 distribution
npm run dist:win-arm64                   # Windows ARM64 distribution
npm run dist:linux-x64                   # Linux x64 distribution
npm run dist:linux-arm64                # Linux ARM64 distribution

# Chrome Web Store Builds
npm run build:cws                        # esbuild bundled/minified extension
./test-bundled-extension.sh              # Validate CWS build

# Native Host Management (from native_host/)
./install.sh                             # Install native host system-wide
./uninstall.sh                           # Remove native host from system
./build.sh build [platform]              # Direct build command
./build.sh dist [platform]               # Direct distribution command

# FFmpeg Builds (from ffmpeg-builder/)
./build.sh                               # Build FFmpeg/FFprobe for current platform
./build.sh [platform]                    # Build for specific platform

# Testing & Validation
./test_streaming.sh                      # Test video detection
./test-bundled-extension.sh              # Test CWS build integrity

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

## Chrome Web Store Build Pipeline

- **esbuild bundling**: Combines all modules into 2 files (background.js, popup/popup.js)
- **Minification**: Identifier mangling, dead code elimination, tree shaking
- **Console filtering**: Removes `console.log/debug/info`, preserves `console.warn/error`
- **Size reduction**: ~60-70% smaller than source (256KB total package)
- **Policy compliance**: No obfuscation, only standard minification techniques
- **Chrome API preservation**: All extension APIs work normally after bundling
- **Output structure**: Proper icons/ folder, updated manifest, bundled scripts

## Security & Privacy

- **Manifest V3 compliance**: No eval(), CSP-compliant, declarativeNetRequest for header modification
- **Minimal permissions**: Only required APIs, no broad host permissions
- **Local processing**: All video analysis happens locally, no external API calls
- **User data**: Download history stored locally, no telemetry or tracking
