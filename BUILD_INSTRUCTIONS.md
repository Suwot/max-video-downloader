# Complete Cross-Platform Build Instructions

## Prerequisites

### 1. Download FFmpeg Binaries

**Windows:**
```bash
# Create directories
mkdir -p native_host/bin/win/bin

# Download from https://www.gyan.dev/ffmpeg/builds/
# Get "release builds" -> "ffmpeg-release-essentials.zip"
# Extract ffmpeg.exe and ffprobe.exe to native_host/bin/win/bin/
```

**Linux:**
```bash
# Create directories
mkdir -p native_host/bin/linux/bin

# Download from https://johnvansickle.com/ffmpeg/
# Get "release builds" -> "ffmpeg-git-amd64-static.tar.xz"
# Extract ffmpeg and ffprobe to native_host/bin/linux/bin/
```

### 2. Install Dependencies
```bash
cd native_host
npm install
```

## Build Process

### Option 1: Build All Platforms at Once
```bash
cd native_host

# Build binaries for all platforms
npm run build:all

# Package for all platforms
npm run package:all
```

### Option 2: Build Individual Platforms

**macOS:**
```bash
cd native_host
./build.sh -build mac-arm64
./build.sh -package-app mac-arm64
```

**Windows:**
```bash
cd native_host
./build.sh -build win-x64
./build.sh -package-windows win-x64
```

**Linux:**
```bash
cd native_host
./build.sh -build linux-x64
./build.sh -package-linux linux-x64
```

## Final Output

After successful build, you'll have:

```
native_host/build/
├── mac-arm64/                          # macOS binaries
├── win-x64/                           # Windows binaries
├── linux-x64/                        # Linux binaries
├── pro.maxvideodownloader.coapp.app/  # macOS app bundle
├── mvdcoapp-windows-win-x64.zip       # Windows installer
└── mvdcoapp-linux-linux-x64.tar.gz   # Linux installer
```

## Distribution

### macOS (.app bundle)
- **File:** `pro.maxvideodownloader.coapp.app`
- **Installation:** User downloads, double-clicks to run
- **Auto-install:** Runs `mvdcoapp -install` automatically
- **Location:** Installs to `~/Library/Application Support/[Browser]/NativeMessagingHosts/`

### Windows (.zip with installer)
- **File:** `mvdcoapp-windows-win-x64.zip`
- **Installation:** User extracts, runs `install.bat`
- **Auto-install:** Copies to `%LOCALAPPDATA%\mvdcoapp\`, adds registry entries
- **Requirements:** No admin rights needed (per-user install)

### Linux (.tar.gz with installer)
- **File:** `mvdcoapp-linux-linux-x64.tar.gz`
- **Installation:** User extracts, runs `./install.sh`
- **Auto-install:** Copies to `~/.local/bin/mvdcoapp/`, creates manifests
- **Requirements:** No sudo needed (per-user install)

## User Experience

### macOS
1. Download `pro.maxvideodownloader.coapp.app`
2. Double-click to launch
3. App automatically installs native host for all detected browsers
4. Extension works immediately

### Windows
1. Download `mvdcoapp-windows-win-x64.zip`
2. Extract anywhere
3. Run `install.bat` (no admin needed)
4. Extension works immediately

### Linux
1. Download `mvdcoapp-linux-linux-x64.tar.gz`
2. Extract: `tar -xzf mvdcoapp-linux-linux-x64.tar.gz`
3. Run: `cd mvdcoapp-linux-linux-x64 && ./install.sh`
4. Extension works immediately

## Testing

Test each platform:
```bash
# After installation, test connection
./mvdcoapp -version
./mvdcoapp -detect-browsers
./mvdcoapp -install  # Should show "already installed"
```

## Troubleshooting

### Missing FFmpeg Binaries
- Error: "FFmpeg binaries not found"
- Solution: Download and place FFmpeg binaries as described in prerequisites

### Build Failures
- Ensure Node.js 16+ is installed
- Run `npm install` in native_host directory
- Check that `pkg` is installed: `npx pkg --version`

### Permission Issues
- macOS: App may need to be allowed in Security & Privacy
- Windows: Some antivirus may flag the executable
- Linux: Ensure scripts are executable: `chmod +x install.sh`