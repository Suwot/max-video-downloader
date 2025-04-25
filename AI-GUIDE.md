# Video Downloader Browser Extension (Manifest V3)

## Project Overview

This Chrome/Firefox extension detects and downloads videos from websites, supporting various formats including HLS streams, DASH manifests, MP4 videos, and other media formats. It uses a native host application for advanced functionality like downloading encrypted streams using FFmpeg.

## Architecture

### Extension Components

- **Background Script**: Service worker that manages state, handles messaging, and coordinates functionality
- **Content Script**: Injects into web pages to detect videos through DOM inspection and network monitoring
- **Popup UI**: User interface for displaying detected videos and initiating downloads
- **Native Host Communication**: Bridge between extension and native processing capabilities

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

## Extension Structure

### extension/

- **background.js**: Service worker for state management and coordination
- **content_script.js**: Injected script for video detection on web pages
- **popup/**: User interface components
  - **js/**: UI logic and API modules
    - **download.js**: Download operation and progress handling
    - **video-processor.js**: Video metadata and quality analysis
    - **manifest-parser.js**: HLS/DASH manifest parsing
    - **video-renderer.js**: UI components for video display
    - **state.js**: Application state management
    - **ui.js**: UI interaction handlers and components
    - **preview.js**: Video preview/thumbnail generation

### native_host/

- **commands/**: Command implementation files
  - **download.js**: FFmpeg-based video download implementation
  - **get-qualities.js**: Video metadata extraction
  - **generate-preview.js**: Thumbnail creation
- **lib/**: Core libraries
  - **command-runner.js**: Command pattern implementation
  - **messaging.js**: Chrome native messaging protocol
- **services/**: Shared services
  - **ffmpeg.js**: FFmpeg wrapper and utilities
