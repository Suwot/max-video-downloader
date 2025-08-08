# FFmpeg Binaries Setup Guide

## Windows Binaries
1. Download from: https://www.gyan.dev/ffmpeg/builds/
   - Get "release builds" -> "ffmpeg-release-essentials.zip"
   - Extract ffmpeg.exe and ffprobe.exe
   - Place in: `native_host/bin/win/bin/`

## Linux Binaries
1. Download from: https://johnvansickle.com/ffmpeg/
   - Get "release builds" -> "ffmpeg-git-amd64-static.tar.xz"
   - Extract ffmpeg and ffprobe (no .exe extension)
   - Place in: `native_host/bin/linux/bin/`

## Directory Structure After Setup
```
native_host/bin/
├── mac/bin/
│   ├── ffmpeg
│   └── ffprobe
├── win/bin/
│   ├── ffmpeg.exe
│   └── ffprobe.exe
└── linux/bin/
    ├── ffmpeg
    └── ffprobe
```