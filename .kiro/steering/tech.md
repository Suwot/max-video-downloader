# Technology Stack

## Core Technologies

- **JavaScript (ES6+)**: Primary language for both extension and native host
- **Chrome Extension API**: Manifest V3 with service workers
- **Node.js**: Native messaging host runtime
- **Chrome Native Messaging**: Communication bridge between extension and system

## Extension Stack

- **Background Service Worker**: Main extension logic using ES6 modules
- **Content Scripts**: In-page video detection and DOM monitoring
- **Popup UI**: HTML/CSS/JavaScript interface with SCSS preprocessing
- **Chrome APIs Used**:
  - `webRequest` - Network request monitoring
  - `scripting` - Content script injection
  - `downloads` - File download management
  - `nativeMessaging` - Communication with native host
  - `storage` - Extension state persistence
  - `tabs` - Tab management and tracking

## Native Host Stack

- **Node.js**: Runtime environment
- **pkg**: Binary packaging for distribution
- **FFmpeg Integration**: Video processing and analysis
- **Native Messaging Protocol**: JSON-based communication with extension

## Build System

### Extension

- No build system required - uses native ES6 modules
- SCSS compilation for popup styles (manual or watch mode)
- Direct file structure deployment

### Native Host

```bash
# Build native host binary
cd native_host
npm run build

# Install native host
./install.sh
```

## Common Commands

### Development

```bash
# Test container detection
npm run test:container-detector

# Build native host
cd native_host && npm run build

# Install/update native host
cd native_host && ./install.sh
```

### Testing

```bash
# Test native host messaging
cd native_host && node test-host.js

# Test streaming functionality
./test_streaming.sh
```

## Dependencies

### Extension

- No external dependencies (uses browser APIs only)
- Self-contained ES6 modules

### Native Host

- **Production**: Self-contained with bundled FFmpeg/FFprobe binaries
- **Development**: `pkg` for binary compilation
- **Bundled Binaries**: FFmpeg/FFprobe in `bin/mac/bin/` for distribution

## Module System

- **Extension**: ES6 modules with explicit imports/exports
- **Native Host**: CommonJS modules with require/module.exports
- **Communication**: JSON message passing via Chrome native messaging
