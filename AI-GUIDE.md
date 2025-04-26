# Video Downloader Browser Extension (Manifest V3)

## Project Overview

This Chrome/Firefox extension detects and downloads videos from websites, supporting various formats including HLS streams, DASH manifests, MP4 videos, and other media formats. It uses a native host application for advanced functionality like downloading encrypted streams using FFmpeg.

## Architecture

### Extension Components

- **Background Script**: Service worker that manages state, handles messaging, and coordinates functionality
- **Content Script**: Injects into web pages to detect videos through DOM inspection and network monitoring
- **Popup UI**: User interface for displaying detected videos and initiating downloads
- **Native Host Communication**: Bridge between extension and native processing capabilities
- **URL Extraction System**: Identifies and extracts legitimate video URLs from query parameters

### Native Host Components

- **Command System**: Implements command pattern for different operations (download, quality detection, preview generation)
- **FFmpeg Service**: Handles video processing, format conversion, and metadata extraction
- **Messaging System**: Chrome native messaging protocol implementation for extension communication

## Component Diagram

```
┌─────────────────────────────────────────────── BROWSER ───────────────────────────────────────────────┐
│                                                                                                       │
│  ┌─────────────────────────────────────────── EXTENSION ─────────────────────────────────────────┐    │
│  │                                                                                               │    │
│  │  ┌──────────────────┐        ┌─────────────────────┐        ┌───────────────────────────┐     │    │
│  │  │                  │        │                     │        │                           │     │    │
│  │  │   Content Script ├────────►    Background.js    ◄────────┤      Popup Interface      │     │    │
│  │  │                  │        │                     │        │                           │     │    │
│  │  └──────────────────┘        └──────────┬──────────┘        └───────────────────────────┘     │    │
│  │                                         │                                                     │    │
│  └─────────────────────────────────────────┼─────────────────────────────────────────────────────┘    │
│                                            │                                                          │
└────────────────────────────────────────────┼──────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────── NATIVE HOST ──────────────────────────────────────────┐
│                                                                                              │
│  ┌─────────────────────┐        ┌─────────────────────┐       ┌──────────────────────────┐   │
│  │                     │        │                     │       │                          │   │
│  │   Command Runner    ├────────►    FFmpeg Service   ├───────►    File System Access    │   │
│  │                     │        │                     │       │                          │   │
│  └─────────────────────┘        └─────────────────────┘       └──────────────────────────┘   │
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagram

```
┌─────────────────┐    (1) Detect Videos   ┌────────────────┐    (2) Store Video Info   ┌────────────────┐
│                 │─────────────────────────►                ├──────────────────────────►                │
│  Content Script │                        │  Background.js  │                          │   Popup UI     │
│                 │◄─────────────────────────                ◄──────────────────────────┤                │
└─────────────────┘  (8) Script Injection  └────────┬───────┘   (3) Display Videos      └────────┬───────┘
                                                    │                                            │
                                                    │ (4) Download Request                       │
                                                    ▼                                            │
┌────────────────────────────────────┐    (5) Process Video   ┌────────────────┐                │
│                                    │◄───────────────────────┤                │                │
│           FFmpeg Service           │                        │ Command Runner │◄───────────────┘
│                                    │─────────────────────────►                │   (7) User Selects Video
└────────────────────────────────────┘   (6) Progress Updates └────────────────┘
```

## Entry Points

### Extension Entry Points

1. **Background Script** (`extension/background.js`):

   - **Entry Point Type**: Extension Initialization
   - **Description**: The main service worker that initializes when the extension starts
   - **Responsibilities**: Video state management, tab management, message routing

2. **Content Script** (`extension/content_script.js`):

   - **Entry Point Type**: Page Load
   - **Description**: Injected into web pages to detect videos
   - **Responsibilities**: DOM scanning, network request monitoring, video detection

3. **Popup UI** (`extension/popup/popup.html`):
   - **Entry Point Type**: User Interaction
   - **Description**: Interface displayed when user clicks the extension icon
   - **Trigger**: Browser action click
   - **Initial Function**: `popup/js/index.js` -> `initialize()`

### Native Host Entry Points

1. **Host Process** (`native_host/host.js`):

   - **Entry Point Type**: Process Startup
   - **Description**: Node.js process that handles native operations
   - **Trigger**: Extension sends message to native host
   - **Initial Function**: Message listener in `native_host/index.js`

2. **Command Handler** (`native_host/lib/command-runner.js`):
   - **Entry Point Type**: Message Processing
   - **Description**: Routes messages to appropriate command implementations
   - **Dependencies**: FFmpeg Service, Messaging System

## Key Workflows

### Video Detection

1. Content script monitors DOM for video elements and network requests
2. Detected videos are sent to background script
3. Background script processes and categorizes videos
4. Popup displays videos when user opens extension

### URL Extraction from Query Parameters

1. Content script intercepts tracking pixel URLs (like ping.gif) with query parameters
2. System analyzes query parameters for embedded video URLs (HLS or DASH manifests)
3. When a legitimate video URL is found, it's extracted and flagged with `foundFromQueryParam: true`
4. The extracted URL completely replaces the original tracking pixel URL
5. The URL is normalized for efficient duplicate detection
6. The extraction metadata is preserved throughout the pipeline
7. Popup displays the extracted video with a visual "Extracted" badge

### Video Download

1. User selects video from popup
2. For HLS/DASH streams, quality options are presented
3. Download request is sent to native host via background script
4. Native host uses FFmpeg to download and process video
5. Progress updates are streamed back to UI
6. Download completion notification is shown

## Special Considerations

- **Progress Updates**: Native host sends progress updates every 250ms which should display continuously in UI
- **Cross-Origin Limitations**: Content script uses multiple detection strategies due to cross-origin restrictions
- **Media Types**: Different approaches are used for different formats (HLS, DASH, direct, blob URLs)
- **CORS**: Some video requests may be affected by CORS policy
- **Tracking Pixels**: System handles tracking pixels like ping.gif that may contain legitimate video URLs
- **URL Normalization**: Enhanced normalization ensures proper deduplication of extracted URLs
- **Metadata Preservation**: The `foundFromQueryParam` flag is maintained throughout the pipeline to ensure proper handling

## Extension Structure

### extension/

- **background.js**: Service worker for state management and coordination
- **content_script.js**: Injected script for video detection on web pages
- **manifest.json**: Extension manifest defining permissions and resources
- **icons/**: Extension icon resources
  - **128.png**, **16.png**, **48.png**: Extension icons in various sizes
  - **video-placeholder.png**: Default placeholder for videos without thumbnails
- **js/**: Shared JavaScript modules
  - **native-host-service.js**: Interface for communicating with native host
- **popup/**: User interface components
  - **popup.html**: Main popup interface HTML structure
  - **popup.css**: Styling for the popup interface
  - **js/**: UI logic and API modules
    - **download.js**: Download operation and progress handling
    - **index.js**: Main entry point for popup initialization
    - **manifest-parser.js**: HLS/DASH manifest parsing
    - **preview.js**: Video preview/thumbnail generation
    - **state.js**: Application state management
    - **ui.js**: UI interaction handlers and components
    - **utilities.js**: Shared utility functions
    - **video-fetcher.js**: Retrieves and validates video sources from background
    - **video-processor.js**: Video metadata and quality analysis
    - **video-renderer.js**: UI components for video display

### native_host/

- **host**: Executable entry point for native host
- **index.js**: Main node.js process entry point
- **manifest.json**: Native host manifest for browser registration
- **package.json**: Node.js package configuration
- **install.sh**: Script to install native host on user's system
- **update.sh**: Script to update existing native host installation
- **commands/**: Command implementation files
  - **base-command.js**: Abstract base class for all commands
  - **download.js**: FFmpeg-based video download implementation
  - **generate-preview.js**: Thumbnail creation functionality
  - **get-download-status.js**: Progress reporting implementation
  - **get-qualities.js**: Video metadata and quality extraction
  - **heartbeat.js**: Connection verification command
  - **index.js**: Command registration and routing
- **lib/**: Core libraries
  - **command-runner.js**: Command pattern implementation
  - **error-handler.js**: Standardized error handling
  - **messaging.js**: Chrome native messaging protocol
  - **progress-tracker.js**: Download progress management
  - **progress/**: Progress calculation strategies
    - **base-strategy.js**: Abstract base progress strategy
    - **content-length-strategy.js**: Progress tracking via file size
    - **segment-tracking-strategy.js**: HLS/DASH segment tracking
    - **adaptive-bitrate-strategy.js**: Bitrate-based estimation
    - **time-based-strategy.js**: Duration-based fallback strategy
    - **manifest-parser.js**: Media manifest analysis utilities
- **services/**: Shared services
  - **config.js**: Configuration management
  - **ffmpeg.js**: FFmpeg wrapper and utilities
  - **index.js**: Service initialization and registration
- **utils/**: Utility modules
  - **logger.js**: Logging functionality
  - **resources.js**: Resource path management

## Key Features and Capabilities

### Video Source Types

- **Direct Video Files**: MP4, WebM, Ogg and other direct video formats
- **HLS Streams**: Dynamic streaming with quality variants (.m3u8 files)
- **DASH Manifests**: Adaptive streaming technology (.mpd files)
- **Blob URLs**: In-memory browser media resources
- **Embedded URLs**: Video URLs extracted from tracking pixel query parameters

### Advanced Progress Tracking System

The native host implements a sophisticated progress tracking system using the strategy pattern to provide accurate download progress for different media types:

1. **Progress Tracker** (`native_host/lib/progress-tracker.js`):

   - Core component that manages different progress calculation strategies
   - Selects the optimal strategy based on media type and available information
   - Falls back gracefully between strategies when needed
   - Provides consistent progress reporting to the UI

2. **Content Length Strategy** (`native_host/lib/progress/content-length-strategy.js`):

   - Makes a HEAD request to obtain the total file size from Content-Length header
   - Calculates progress as a percentage of downloaded bytes vs. total size
   - Used primarily for direct media files (MP4, WebM, etc.)
   - High confidence level for accurate progress reporting

3. **Segment Tracking Strategy** (`native_host/lib/progress/segment-tracking-strategy.js`):

   - Analyzes HLS/DASH manifests to count total segments
   - Tracks segment downloads from FFmpeg output
   - Uses hybrid approach combining segment counting and byte-based tracking
   - Adapts to different manifest formats and structures

4. **Adaptive Bitrate Strategy** (`native_host/lib/progress/adaptive-bitrate-strategy.js`):

   - Used for streaming media when segment tracking isn't available
   - Estimates total size based on duration and bitrate information
   - Dynamically adjusts estimations based on actual download data
   - Provides reasonable progress estimation for variable bitrate content

5. **Time Based Strategy** (`native_host/lib/progress/time-based-strategy.js`):
   - Last-resort fallback when other strategies aren't applicable
   - Calculates progress based on video duration and elapsed time
   - Less accurate but ensures some progress feedback is always available

The system continuously monitors confidence levels in its calculations and can switch between strategies if better data becomes available. This ensures users always receive the most accurate progress information possible during downloads, regardless of media type or source.

### URL Extraction System

The extension implements a sophisticated URL extraction system that can identify legitimate video URLs embedded in query parameters of tracking pixels. This system:

1. **Detection**: Identifies potential tracking pixels like ping.gif that might contain video URLs
2. **Extraction**: Parses query parameters to find legitimate HLS or DASH manifest URLs
3. **Validation**: Applies multiple validation checks to ensure extracted URLs are genuine video sources
4. **Flagging**: Marks extracted URLs with `foundFromQueryParam` for special handling
5. **Normalization**: Applies URL normalization to prevent duplicates between original and extracted URLs
6. **Visual Indication**: Displays an "Extracted" badge in the UI for URLs found via this method

This system significantly enhances the extension's ability to detect videos that would otherwise be missed.
