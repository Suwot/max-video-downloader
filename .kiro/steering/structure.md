# Project Structure

## Root Level
```
├── extension/          # Chrome extension code
├── native_host/        # Node.js native messaging host
├── package.json        # Dev/test scripts only
└── test_streaming.sh   # Integration test script
```

## Extension Structure (`extension/`)

### Core Components
- `manifest.json` - Extension configuration (Manifest V3)
- `background/index.js` - Main service worker entry point
- `content_script.js` - Legacy file (not used, reference only)
- `popup/` - Extension popup interface

### Background Services (`extension/background/`)
```
├── index.js                    # Service worker initialization
├── detection/                  # Video detection logic
│   ├── video-detector.js       # Main detection coordinator
│   ├── video-type-identifier.js # Format identification
│   └── url-filters.js          # URL filtering and validation
├── processing/                 # Video processing pipeline
│   ├── container-detector.js   # Container format detection
│   ├── video-processor.js      # Main processing logic
│   ├── hls-parser.js          # HLS manifest parsing
│   ├── dash-parser.js         # DASH manifest parsing
│   └── video-store.js         # Video data storage
├── messaging/                  # Communication layer
│   ├── popup-communication.js  # Extension popup messaging
│   └── native-host-service.js  # Native host communication
├── download/                   # Download management
│   └── download-manager.js     # Download coordination
└── state/                      # State management
    ├── state-manager.js        # Legacy state system (initialized but unused)
    └── tab-manager.js          # Per-tab state tracking
```

### Popup Interface (`extension/popup/`)
```
├── popup.html              # Main popup interface
├── popup.scss             # SCSS source styles
├── popup.css              # Compiled CSS
├── index.js               # Popup initialization
├── ui.js                  # UI management
├── state.js               # Popup state management
├── communication.js       # Background communication
├── video/                 # Video-specific UI components
│   ├── video-renderer.js  # Video list rendering
│   ├── video-item.js      # Individual video items
│   ├── download-handler.js # Download UI logic
│   ├── download-button.js  # Download button component
│   ├── dropdown.js        # Quality selection dropdown
│   └── preview-hover.js   # Video preview on hover
└── styles/                # SCSS component files
    ├── _variables.scss    # SCSS variables
    ├── _base.scss         # Base styles
    ├── _layout.scss       # Layout components
    ├── _components.scss   # UI components
    ├── _video-items.scss  # Video item styles
    ├── _downloads.scss    # Download UI styles
    ├── _navigation.scss   # Navigation styles
    └── _animations.scss   # Animation definitions
```

### Shared Utilities (`extension/shared/`)
```
└── utils/
    ├── logger.js           # Logging utilities
    ├── headers-utils.js    # HTTP header processing
    ├── preview-cache.js    # Video preview caching
    └── processing-utils.js # Common processing utilities
```

## Native Host Structure (`native_host/`)

### Core Files
- `index.js` - Main entry point and bootstrap
- `package.json` - Dependencies and build configuration
- `manifest.json` - Native messaging host manifest
- `host` - Compiled binary (generated)
- `bin/mac/bin/` - Bundled FFmpeg/FFprobe binaries for self-contained distribution

### Command System (`native_host/commands/`)
```
├── base-command.js      # Base command class
├── download.js          # Video download command
├── get-qualities.js     # Quality analysis command
├── generate-preview.js  # Preview generation command
├── heartbeat.js         # Connection health check
└── file-system.js       # File system operations
```

### Core Libraries (`native_host/lib/`)
```
├── messaging.js         # Native messaging protocol
├── command-runner.js    # Command execution framework
├── error-handler.js     # Error handling and reporting
└── progress/            # Progress tracking system
    ├── progress-tracker.js   # Progress monitoring
    └── progress-strategy.js  # Progress calculation strategies
```

### Services (`native_host/services/`)
```
├── index.js            # Service manager
├── config.js           # Configuration management
└── ffmpeg.js           # FFmpeg integration
```

### Utilities (`native_host/utils/`)
```
├── logger.js           # Logging system
└── resources.js        # Resource management
```

## Naming Conventions

### Files
- **kebab-case** for all file names (`video-detector.js`, `download-manager.js`)
- **Descriptive names** that indicate purpose (`container-detector.js`, `popup-communication.js`)

### Directories
- **Functional grouping** by responsibility (`detection/`, `processing/`, `messaging/`)
- **Clear separation** between extension and native host code

### Code Organization
- **Single responsibility** - each file has one clear purpose
- **Layered architecture** - clear separation between detection, processing, and UI
- **Modular design** - components can be tested and modified independently

## Import/Export Patterns

### Extension (ES6 Modules)
```javascript
// Named exports for utilities
export { createLogger, logDebug };

// Default exports for main classes/functions
export default VideoDetector;

// Explicit imports
import { createLogger } from '../shared/utils/logger.js';
```

### Native Host (CommonJS)
```javascript
// Module exports
module.exports = CommandRunner;

// Destructured requires
const { logDebug } = require('./utils/logger');
```