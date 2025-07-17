# Product Overview

MAX Video Downloader is a Chrome extension (Manifest V3) that enables users to download videos from any website. The extension supports multiple video formats including HLS streams, DASH manifests, and direct media files.

## Key Features

- **Universal Video Detection**: Automatically detects videos on web pages through DOM scanning, network request monitoring, and player configuration analysis
- **Multiple Format Support**: Handles HLS (.m3u8), DASH (.mpd), and direct video files
- **Native Host Integration**: Uses a Node.js native messaging host for system-level operations like file downloads and FFmpeg processing
- **Smart Container Detection**: Intelligent codec analysis and container format detection for optimal compatibility
- **Preview Generation**: Creates video thumbnails and quality analysis
- **Download Management**: Progress tracking and download state management

## Architecture

The extension consists of two main components:
1. **Browser Extension** (`extension/`): Chrome extension with background service worker, content scripts, and popup UI
2. **Native Host** (`native_host/`): Node.js application that handles system operations and communicates with the extension via Chrome's native messaging API

The extension detects videos through multiple channels and processes them through a unified pipeline for consistent handling across different video sources and formats.