#!/bin/bash

# Build script for MAX Video Downloader Native Host
# Usage: ./build.sh [command] [platform]
# Commands: -version, -build, -package-app
# Platforms: mac-arm64, mac-x64, win-x64, win-arm64

set -e

VERSION=$(node -p "require('./package.json').version")
APP_NAME="pro.maxvideodownloader.coapp"

# Global flags
DRY_RUN=false

# Parse global flags
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
    esac
done

# Platform configuration functions
get_pkg_target() {
    case "$1" in
        mac-arm64) echo "node16-macos-arm64" ;;
        mac-x64) echo "node16-macos-x64" ;;
        win-x64) echo "node16-win-x64" ;;
        win-arm64) echo "node16-win-arm64" ;;
        linux-x64) echo "node16-linux-x64" ;;
        linux-arm64) echo "node16-linux-arm64" ;;
        *) echo "" ;;
    esac
}

get_binary_name() {
    case "$1" in
        mac-arm64|mac-x64|linux-x64|linux-arm64) echo "mvdcoapp" ;;
        win-x64|win-arm64) echo "mvdcoapp.exe" ;;
        *) echo "mvdcoapp" ;;
    esac
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    local prefix="${GREEN}[INFO]${NC}"
    if [[ "$DRY_RUN" == "true" ]]; then
        prefix="${GREEN}[DRY-RUN]${NC}"
    fi
    echo -e "$prefix $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

dry_run_or_execute() {
    local description="$1"
    shift
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "Would $description"
        return 0
    else
        "$@"
        return $?
    fi
}

show_version() {
    echo "Native Host v${VERSION}"
}

detect_platform() {
    local os=$(uname -s)
    local arch=$(uname -m)
    
    case "$os" in
        Darwin)
            case "$arch" in
                arm64) echo "mac-arm64" ;;
                x86_64) echo "mac-x64" ;;
                *) log_error "Unsupported macOS architecture: $arch"; exit 1 ;;
            esac
            ;;
        MINGW*|CYGWIN*|MSYS*|Windows_NT)
            case "$arch" in
                x86_64) echo "win-x64" ;;
                aarch64) echo "win-arm64" ;;
                *) log_error "Unsupported Windows architecture: $arch"; exit 1 ;;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64) echo "linux-x64" ;;
                aarch64) echo "linux-arm64" ;;
                *) log_error "Unsupported Linux architecture: $arch"; exit 1 ;;
            esac
            ;;
        *)
            log_error "Unsupported OS: $os"
            exit 1
            ;;
    esac
}

build_platform() {
    local platform=$1
    local pkg_target=$(get_pkg_target "$platform")
    local binary_name=$(get_binary_name "$platform")
    
    if [[ -z "$pkg_target" ]]; then
        log_error "Unsupported platform: $platform"
        exit 1
    fi
    
    log_info "Building for $platform..."
    
    # Create build directory
    local build_dir="build/$platform"
    mkdir -p "$build_dir"
    
    # Build the native host binary
    log_info "Compiling native host binary..."
    npx pkg . --target "$pkg_target" --output "$build_dir/$binary_name"
    
    # Copy FFmpeg binaries based on platform
    local ffmpeg_source=""
    case "$platform" in
        mac-arm64|mac-x64)
            ffmpeg_source="bin/mac/bin"
            ;;
        win-x64|win-arm64)
            ffmpeg_source="bin/win/bin"
            ;;
        linux-x64|linux-arm64)
            ffmpeg_source="bin/linux/bin"
            ;;
    esac
    
    if [[ -d "$ffmpeg_source" ]]; then
        log_info "Copying FFmpeg binaries from $ffmpeg_source..."
        cp "$ffmpeg_source/ffmpeg"* "$build_dir/"
        cp "$ffmpeg_source/ffprobe"* "$build_dir/"
    else
        log_warn "FFmpeg binaries not found at $ffmpeg_source"
    fi
    
    log_info "✓ Build complete for $platform at $build_dir"
}

package_mac_app() {
    local platform=${1:-$(detect_platform)}
    
    if [[ ! "$platform" =~ ^mac- ]]; then
        log_error "App packaging only supported for macOS platforms"
        exit 1
    fi
    
    local build_dir="build/$platform"
    local app_dir="build/${APP_NAME}.app"
    local contents_dir="$app_dir/Contents"
    local macos_dir="$contents_dir/MacOS"
    local resources_dir="$contents_dir/Resources"
    
    if [[ ! -d "$build_dir" ]]; then
        log_error "Build directory not found. Run './build.sh -build $platform' first"
        exit 1
    fi
    
    log_info "Creating macOS app bundle for $platform..."
    
    # Clean and create app structure
    rm -rf "$app_dir"
    mkdir -p "$macos_dir" "$resources_dir"
    
    # Copy binaries to MacOS folder
    cp "$build_dir/mvdcoapp" "$macos_dir/"
    cp "$build_dir/ffmpeg" "$macos_dir/"
    cp "$build_dir/ffprobe" "$macos_dir/"
    
    # Make binaries executable
    chmod +x "$macos_dir"/*
    
    # Copy app icon from extension folder
    local icon_source="../extension/icons/128.png"
    if [[ -f "$icon_source" ]]; then
        cp "$icon_source" "$resources_dir/AppIcon.png"
        log_info "Added app icon from extension"
    else
        log_warn "App icon not found at $icon_source"
    fi
    
    # Create Info.plist
    cat > "$contents_dir/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>mvdcoapp</string>
    <key>CFBundleIdentifier</key>
    <string>${APP_NAME}</string>
    <key>CFBundleName</key>
    <string>MAX Video Downloader</string>
    <key>CFBundleDisplayName</key>
    <string>MAX Video Downloader</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon.png</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF
    
    log_info "✓ macOS app bundle created at $app_dir"
    log_info "App can be launched with: open '$app_dir' --args -version"
    log_info "Binary location: $macos_dir/mvdcoapp"
}

package_linux_tarball() {
    local platform=${1:-$(detect_platform)}
    
    if [[ ! "$platform" =~ ^linux- ]]; then
        log_error "Linux packaging only supported for Linux platforms"
        exit 1
    fi
    
    local build_dir="build/$platform"
    local package_dir="build/mvdcoapp-linux-$platform"
    local tarball_name="mvdcoapp-linux-$platform.tar.gz"
    
    if [[ ! -d "$build_dir" ]]; then
        log_error "Build directory not found. Run './build.sh -build $platform' first"
        exit 1
    fi
    
    log_info "Creating Linux package for $platform..."
    
    # Clean and create package structure
    rm -rf "$package_dir"
    mkdir -p "$package_dir/bin"
    
    # Copy binaries
    cp "$build_dir/mvdcoapp" "$package_dir/bin/"
    cp "$build_dir/ffmpeg" "$package_dir/bin/"
    cp "$build_dir/ffprobe" "$package_dir/bin/"
    
    # Make binaries executable
    chmod +x "$package_dir/bin"/*
    
    # Create install script
    cat > "$package_dir/install.sh" << 'EOF'
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/bin/mvdcoapp"

echo "Installing MAX Video Downloader Native Host..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Copy binaries
cp "$SCRIPT_DIR/bin/"* "$INSTALL_DIR/"

# Make binaries executable
chmod +x "$INSTALL_DIR"/*

# Install native host manifests for detected browsers
cd "$INSTALL_DIR"
./mvdcoapp -install

echo "✓ Installation complete!"
echo "Native host installed at: $INSTALL_DIR"
echo "Run './mvdcoapp -detect-browsers' to see supported browsers"
EOF
    
    # Create uninstall script
    cat > "$package_dir/uninstall.sh" << 'EOF'
#!/bin/bash
set -e

INSTALL_DIR="$HOME/.local/bin/mvdcoapp"

echo "Uninstalling MAX Video Downloader Native Host..."

if [[ -d "$INSTALL_DIR" ]]; then
    # Remove native host manifests
    cd "$INSTALL_DIR"
    ./mvdcoapp -uninstall
    
    # Remove installation directory
    rm -rf "$INSTALL_DIR"
    
    echo "✓ Uninstallation complete!"
else
    echo "Native host not found at $INSTALL_DIR"
fi
EOF
    
    # Create README
    cat > "$package_dir/README.md" << EOF
# MAX Video Downloader Native Host - Linux

## Installation
Run the install script:
\`\`\`bash
chmod +x install.sh
./install.sh
\`\`\`

## Uninstallation
Run the uninstall script:
\`\`\`bash
chmod +x uninstall.sh
./uninstall.sh
\`\`\`

## Manual Usage
\`\`\`bash
# Show version
./bin/mvdcoapp -version

# Detect browsers
./bin/mvdcoapp -detect-browsers

# Install for all browsers
./bin/mvdcoapp -install

# Uninstall from all browsers
./bin/mvdcoapp -uninstall
\`\`\`

## Requirements
- Linux x64 or ARM64
- Supported browsers: Chrome, Firefox, Edge, Brave, Opera, Vivaldi, etc.
EOF
    
    # Make scripts executable
    chmod +x "$package_dir/install.sh"
    chmod +x "$package_dir/uninstall.sh"
    
    # Create tarball
    cd build
    tar -czf "$tarball_name" "$(basename "$package_dir")"
    
    log_info "✓ Linux package created: build/$tarball_name"
    log_info "Package contents: bin/, install.sh, uninstall.sh, README.md"
}

package_windows_zip() {
    local platform=${1:-$(detect_platform)}
    
    if [[ ! "$platform" =~ ^win- ]]; then
        log_error "Windows packaging only supported for Windows platforms"
        exit 1
    fi
    
    local build_dir="build/$platform"
    local package_dir="build/mvdcoapp-windows-$platform"
    local zip_name="mvdcoapp-windows-$platform.zip"
    
    if [[ ! -d "$build_dir" ]]; then
        log_error "Build directory not found. Run './build.sh -build $platform' first"
        exit 1
    fi
    
    log_info "Creating Windows package for $platform..."
    
    # Clean and create package structure
    rm -rf "$package_dir"
    mkdir -p "$package_dir/bin"
    
    # Copy binaries
    cp "$build_dir/mvdcoapp.exe" "$package_dir/bin/"
    cp "$build_dir/ffmpeg.exe" "$package_dir/bin/"
    cp "$build_dir/ffprobe.exe" "$package_dir/bin/"
    
    # Create install batch script
    cat > "$package_dir/install.bat" << 'EOF'
@echo off
setlocal

echo Installing MAX Video Downloader Native Host...

set "SCRIPT_DIR=%~dp0"
set "INSTALL_DIR=%LOCALAPPDATA%\mvdcoapp"

:: Create install directory
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: Copy binaries
copy "%SCRIPT_DIR%bin\*" "%INSTALL_DIR%\" >nul

:: Install native host manifests for detected browsers
cd /d "%INSTALL_DIR%"
mvdcoapp.exe -install

echo.
echo Installation complete!
echo Native host installed at: %INSTALL_DIR%
echo Run 'mvdcoapp.exe -detect-browsers' to see supported browsers
pause
EOF
    
    # Create uninstall batch script
    cat > "$package_dir/uninstall.bat" << 'EOF'
@echo off
setlocal

echo Uninstalling MAX Video Downloader Native Host...

set "INSTALL_DIR=%LOCALAPPDATA%\mvdcoapp"

if exist "%INSTALL_DIR%" (
    :: Remove native host manifests
    cd /d "%INSTALL_DIR%"
    mvdcoapp.exe -uninstall
    
    :: Remove installation directory
    cd /d "%LOCALAPPDATA%"
    rmdir /s /q "mvdcoapp"
    
    echo.
    echo Uninstallation complete!
) else (
    echo Native host not found at %INSTALL_DIR%
)
pause
EOF
    
    # Create README
    cat > "$package_dir/README.md" << 'EOF'
# MAX Video Downloader Native Host - Windows

## Installation
Run the install script as Administrator (recommended):
```
Right-click install.bat -> "Run as administrator"
```

Or double-click `install.bat` for current user only.

## Uninstallation
Run the uninstall script:
```
Double-click uninstall.bat
```

## Manual Usage
Open Command Prompt in the bin/ folder:
```cmd
# Show version
mvdcoapp.exe -version

# Detect browsers
mvdcoapp.exe -detect-browsers

# Install for all browsers
mvdcoapp.exe -install

# Uninstall from all browsers
mvdcoapp.exe -uninstall
```

## Requirements
- Windows 10/11 (x64 or ARM64)
- Supported browsers: Chrome, Edge, Firefox, Brave, Opera, Vivaldi, etc.
- Administrator rights recommended for system-wide installation
EOF
    
    # Create zip file (using PowerShell on Windows, or zip command on Unix)
    cd build
    if command -v powershell.exe >/dev/null 2>&1; then
        # Windows with PowerShell
        powershell.exe -Command "Compress-Archive -Path '$(basename "$package_dir")' -DestinationPath '$zip_name' -Force"
    elif command -v zip >/dev/null 2>&1; then
        # Unix with zip command
        zip -r "$zip_name" "$(basename "$package_dir")"
    else
        log_warn "No zip utility found. Package directory created but not compressed."
        log_info "✓ Windows package directory created: build/$(basename "$package_dir")"
        return
    fi
    
    log_info "✓ Windows package created: build/$zip_name"
    log_info "Package contents: bin/, install.bat, uninstall.bat, README.md"
}

detect_browsers() {
    local browsers=()
    
    case "$(uname -s)" in
        Darwin)
            # Chromium-based browsers (same extension works for all)
            [[ -d "/Applications/Google Chrome.app" ]] && browsers+=("chrome")
            [[ -d "/Applications/Google Chrome Canary.app" ]] && browsers+=("chrome-canary")
            [[ -d "/Applications/Arc.app" ]] && browsers+=("arc")
            [[ -d "/Applications/Microsoft Edge.app" ]] && browsers+=("edge")
            [[ -d "/Applications/Microsoft Edge Beta.app" ]] && browsers+=("edge-beta")
            [[ -d "/Applications/Microsoft Edge Dev.app" ]] && browsers+=("edge-dev")
            [[ -d "/Applications/Microsoft Edge Canary.app" ]] && browsers+=("edge-canary")
            [[ -d "/Applications/Brave Browser.app" ]] && browsers+=("brave")
            [[ -d "/Applications/Opera.app" ]] && browsers+=("opera")
            [[ -d "/Applications/Vivaldi.app" ]] && browsers+=("vivaldi")
            [[ -d "/Applications/Epic Privacy Browser.app" ]] && browsers+=("epic")
            [[ -d "/Applications/Yandex.app" ]] && browsers+=("yandex")
            
            # Firefox-based browsers (require separate extension)
            [[ -d "/Applications/Firefox.app" ]] && browsers+=("firefox")
            [[ -d "/Applications/Tor Browser.app" ]] && browsers+=("tor")
            ;;
        Linux)
            # Chromium-based browsers
            command -v google-chrome >/dev/null 2>&1 && browsers+=("chrome")
            command -v google-chrome-beta >/dev/null 2>&1 && browsers+=("chrome-beta")
            command -v google-chrome-unstable >/dev/null 2>&1 && browsers+=("chrome-canary")
            command -v chromium-browser >/dev/null 2>&1 && browsers+=("chromium")
            command -v microsoft-edge >/dev/null 2>&1 && browsers+=("edge")
            command -v microsoft-edge-beta >/dev/null 2>&1 && browsers+=("edge-beta")
            command -v microsoft-edge-dev >/dev/null 2>&1 && browsers+=("edge-dev")
            command -v brave-browser >/dev/null 2>&1 && browsers+=("brave")
            command -v opera >/dev/null 2>&1 && browsers+=("opera")
            command -v vivaldi >/dev/null 2>&1 && browsers+=("vivaldi")
            command -v yandex-browser >/dev/null 2>&1 && browsers+=("yandex")
            
            # Firefox-based browsers
            command -v firefox >/dev/null 2>&1 && browsers+=("firefox")
            ;;
        MINGW*|CYGWIN*|MSYS*|Windows_NT)
            # Windows - check for browser installations
            [[ -d "$PROGRAMFILES/Google/Chrome/Application" ]] && browsers+=("chrome")
            [[ -d "$PROGRAMFILES (X86)/Google/Chrome/Application" ]] && browsers+=("chrome")
            [[ -d "$LOCALAPPDATA/Google/Chrome SxS/Application" ]] && browsers+=("chrome-canary")
            [[ -d "$PROGRAMFILES/Microsoft/Edge/Application" ]] && browsers+=("edge")
            [[ -d "$PROGRAMFILES (X86)/Microsoft/Edge/Application" ]] && browsers+=("edge")
            [[ -d "$LOCALAPPDATA/Microsoft/Edge Beta/Application" ]] && browsers+=("edge-beta")
            [[ -d "$LOCALAPPDATA/Microsoft/Edge Dev/Application" ]] && browsers+=("edge-dev")
            [[ -d "$LOCALAPPDATA/Microsoft/Edge SxS/Application" ]] && browsers+=("edge-canary")
            [[ -d "$PROGRAMFILES/BraveSoftware/Brave-Browser/Application" ]] && browsers+=("brave")
            [[ -d "$PROGRAMFILES (X86)/BraveSoftware/Brave-Browser/Application" ]] && browsers+=("brave")
            [[ -d "$LOCALAPPDATA/Programs/Opera" ]] && browsers+=("opera")
            [[ -d "$PROGRAMFILES/Vivaldi/Application" ]] && browsers+=("vivaldi")
            [[ -d "$LOCALAPPDATA/Yandex/YandexBrowser/Application" ]] && browsers+=("yandex")
            [[ -d "$PROGRAMFILES/Mozilla Firefox" ]] && browsers+=("firefox")
            [[ -d "$PROGRAMFILES (X86)/Mozilla Firefox" ]] && browsers+=("firefox")
            
            # Remove duplicates
            browsers=($(printf '%s\n' "${browsers[@]}" | sort -u))
            ;;
    esac
    
    printf '%s\n' "${browsers[@]}"
}

get_browser_paths() {
    local browser=$1
    local os=$(uname -s)
    
    case "$os" in
        Darwin)
            case "$browser" in
                chrome)
                    echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
                    ;;
                chrome-canary)
                    echo "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
                    ;;
                arc)
                    echo "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
                    ;;
                edge)
                    echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
                    ;;
                edge-beta)
                    echo "$HOME/Library/Application Support/Microsoft Edge Beta/NativeMessagingHosts"
                    ;;
                edge-dev)
                    echo "$HOME/Library/Application Support/Microsoft Edge Dev/NativeMessagingHosts"
                    ;;
                edge-canary)
                    echo "$HOME/Library/Application Support/Microsoft Edge Canary/NativeMessagingHosts"
                    ;;
                brave)
                    echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
                    ;;
                opera)
                    echo "$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"
                    ;;
                vivaldi)
                    echo "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
                    ;;
                epic)
                    echo "$HOME/Library/Application Support/Epic Privacy Browser/NativeMessagingHosts"
                    ;;
                yandex)
                    echo "$HOME/Library/Application Support/Yandex/YandexBrowser/NativeMessagingHosts"
                    ;;
                firefox)
                    echo "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
                    ;;
                tor)
                    echo "$HOME/Library/Application Support/TorBrowser-Data/Browser/NativeMessagingHosts"
                    ;;
            esac
            ;;
        Linux)
            case "$browser" in
                chrome)
                    echo "$HOME/.config/google-chrome/NativeMessagingHosts"
                    ;;
                chrome-beta)
                    echo "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
                    ;;
                chrome-canary)
                    echo "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
                    ;;
                chromium)
                    echo "$HOME/.config/chromium/NativeMessagingHosts"
                    ;;
                edge)
                    echo "$HOME/.config/microsoft-edge/NativeMessagingHosts"
                    ;;
                edge-beta)
                    echo "$HOME/.config/microsoft-edge-beta/NativeMessagingHosts"
                    ;;
                edge-dev)
                    echo "$HOME/.config/microsoft-edge-dev/NativeMessagingHosts"
                    ;;
                brave)
                    echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
                    ;;
                opera)
                    echo "$HOME/.config/opera/NativeMessagingHosts"
                    ;;
                vivaldi)
                    echo "$HOME/.config/vivaldi/NativeMessagingHosts"
                    ;;
                yandex)
                    echo "$HOME/.config/yandex-browser/NativeMessagingHosts"
                    ;;
                firefox)
                    echo "$HOME/.mozilla/native-messaging-hosts"
                    ;;
            esac
            ;;
        MINGW*|CYGWIN*|MSYS*|Windows_NT)
            # Windows uses registry, return registry key paths
            case "$browser" in
                chrome)
                    echo "HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                chrome-canary)
                    echo "HKEY_CURRENT_USER\\Software\\Google\\Chrome SxS\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                edge)
                    echo "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                edge-beta)
                    echo "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge Beta\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                edge-dev)
                    echo "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge Dev\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                edge-canary)
                    echo "HKEY_CURRENT_USER\\Software\\Microsoft\\Edge SxS\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                brave)
                    echo "HKEY_CURRENT_USER\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                opera)
                    echo "HKEY_CURRENT_USER\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                vivaldi)
                    echo "HKEY_CURRENT_USER\\Software\\Vivaldi\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                yandex)
                    echo "HKEY_CURRENT_USER\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
                firefox)
                    echo "HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\pro.maxvideodownloader.coapp"
                    ;;
            esac
            ;;
    esac
}

create_chrome_manifest() {
    local binary_path="$1"
    local extension_id="$2"
    
    # Escape the binary path for JSON
    local escaped_path="${binary_path//\\/\\\\}"
    escaped_path="${escaped_path//\"/\\\"}"
    
    cat << EOF
{
  "name": "pro.maxvideodownloader.coapp",
  "description": "MAX Video Downloader Native Host",
  "path": "$escaped_path",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$extension_id/"
  ]
}
EOF
}

create_firefox_manifest() {
    local binary_path="$1"
    local extension_id="$2"
    
    # Escape the binary path for JSON
    local escaped_path="${binary_path//\\/\\\\}"
    escaped_path="${escaped_path//\"/\\\"}"
    
    cat << EOF
{
  "name": "pro.maxvideodownloader.coapp",
  "description": "MAX Video Downloader Native Host",
  "path": "$escaped_path",
  "type": "stdio",
  "allowed_extensions": [
    "$extension_id"
  ]
}
EOF
}

install_windows_registry() {
    local browser=$1
    local manifest_path=$2
    local registry_key=$3
    
    # Convert Unix path to Windows path for manifest
    local windows_manifest_path=$(cygpath -w "$manifest_path" 2>/dev/null || echo "$manifest_path")
    
    log_info "Installing Windows registry entry for $browser..."
    log_info "Registry key: $registry_key"
    log_info "Manifest path: $windows_manifest_path"
    
    # Use reg.exe to add registry entry
    if command -v reg.exe >/dev/null 2>&1; then
        reg.exe add "$registry_key" /ve /t REG_SZ /d "$windows_manifest_path" /f >/dev/null 2>&1
        if [[ $? -eq 0 ]]; then
            log_info "✓ Registry entry added successfully"
            return 0
        else
            log_error "✗ Failed to add registry entry"
            return 1
        fi
    else
        log_error "reg.exe not found - cannot install on Windows"
        return 1
    fi
}

uninstall_windows_registry() {
    local registry_key=$1
    
    log_info "Removing Windows registry entry: $registry_key"
    
    if command -v reg.exe >/dev/null 2>&1; then
        reg.exe delete "$registry_key" /f >/dev/null 2>&1
        if [[ $? -eq 0 ]]; then
            log_info "✓ Registry entry removed"
            return 0
        else
            log_warn "Registry entry not found or already removed"
            return 1
        fi
    else
        log_error "reg.exe not found - cannot uninstall on Windows"
        return 1
    fi
}

install_native_host() {
    local platform=${1:-$(detect_platform)}
    local build_dir="build/$platform"
    local binary_name=$(get_binary_name "$platform")
    local binary_path="$PWD/$build_dir/$binary_name"
    
    if [[ ! -f "$binary_path" ]]; then
        log_error "Binary not found at $binary_path. Run './build.sh -build $platform' first"
        exit 1
    fi
    
    # Extension IDs for different browser types
    local chrome_extension_id="bkblnddclhmmgjlmbofhakhhbklkcofd"
    local firefox_extension_id="max-video-downloader@rostislav.dev"  # You'll set this when you publish to Firefox
    
    log_info "Installing native host for detected browsers..."
    log_info "Binary path: $binary_path"
    log_info "Platform: $(uname -s)"
    
    local installed_count=0
    local browsers=($(detect_browsers))
    
    if [[ ${#browsers[@]} -eq 0 ]]; then
        log_warn "No supported browsers detected"
        return 1
    fi
    
    for browser in "${browsers[@]}"; do
        local target_path=$(get_browser_paths "$browser")
        
        if [[ -z "$target_path" ]]; then
            log_warn "Unknown browser path for: $browser"
            continue
        fi
        
        log_info "Installing for $browser..."
        
        case "$(uname -s)" in
            MINGW*|CYGWIN*|MSYS*|Windows_NT)
                # Windows: Create manifest file and register in registry
                # Use LOCALAPPDATA on Windows, fallback to HOME
                local temp_dir="${LOCALAPPDATA:-$HOME}/.mvdcoapp"
                local manifest_file="$temp_dir/pro.maxvideodownloader.coapp-$browser.json"
                
                if [[ "$DRY_RUN" == "true" ]]; then
                    log_info "Would create temp directory: $temp_dir"
                    log_info "Would create manifest: $manifest_file"
                    case "$browser" in
                        firefox)
                            log_info "Would use Firefox manifest format with extension ID: $firefox_extension_id"
                            ;;
                        *)
                            log_info "Would use Chrome manifest format with extension ID: $chrome_extension_id"
                            ;;
                    esac
                    log_info "Would add registry entry: $target_path"
                    log_info "✓ Would install for $browser (registry + manifest)"
                    ((installed_count++))
                else
                    mkdir -p "$temp_dir"
                    
                    # Create appropriate manifest
                    case "$browser" in
                        firefox)
                            create_firefox_manifest "$binary_path" "$firefox_extension_id" > "$manifest_file"
                            ;;
                        *)
                            create_chrome_manifest "$binary_path" "$chrome_extension_id" > "$manifest_file"
                            ;;
                    esac
                    
                    # Install registry entry
                    if install_windows_registry "$browser" "$manifest_file" "$target_path"; then
                        log_info "✓ Installed for $browser (registry + manifest)"
                        ((installed_count++))
                    else
                        log_error "✗ Failed to install for $browser"
                    fi
                fi
                ;;
            *)
                # macOS/Linux: Create manifest file in browser directory
                local manifest_file="$target_path/pro.maxvideodownloader.coapp.json"
                
                if [[ "$DRY_RUN" == "true" ]]; then
                    log_info "Would create directory: $target_path"
                    log_info "Would create manifest: $manifest_file"
                    case "$browser" in
                        firefox|tor)
                            log_info "Would use Firefox manifest format with extension ID: $firefox_extension_id"
                            ;;
                        *)
                            log_info "Would use Chrome manifest format with extension ID: $chrome_extension_id"
                            ;;
                    esac
                    log_info "✓ Would install for $browser: $manifest_file"
                    ((installed_count++))
                else
                    # Create target directory
                    mkdir -p "$target_path"
                    
                    # Create appropriate manifest based on browser type
                    case "$browser" in
                        firefox|tor)
                            create_firefox_manifest "$binary_path" "$firefox_extension_id" > "$manifest_file"
                            ;;
                        *)
                            create_chrome_manifest "$binary_path" "$chrome_extension_id" > "$manifest_file"
                            ;;
                    esac
                    
                    if [[ -f "$manifest_file" ]]; then
                        log_info "✓ Installed for $browser: $manifest_file"
                        ((installed_count++))
                    else
                        log_error "✗ Failed to install for $browser"
                    fi
                fi
                ;;
        esac
    done
    
    if [[ $installed_count -gt 0 ]]; then
        log_info "✓ Native host installed for $installed_count browser(s)"
        log_info "Detected browsers: ${browsers[*]}"
    else
        log_error "Failed to install for any browsers"
        return 1
    fi
}

uninstall_native_host() {
    log_info "Uninstalling native host from all browsers..."
    log_info "Platform: $(uname -s)"
    
    local removed_count=0
    
    # Check all possible browsers based on platform
    case "$(uname -s)" in
        Darwin)
            local all_possible_browsers=("chrome" "chrome-canary" "arc" "edge" "edge-beta" "edge-dev" "edge-canary" "brave" "opera" "vivaldi" "epic" "yandex" "firefox" "tor")
            ;;
        Linux)
            local all_possible_browsers=("chrome" "chrome-beta" "chrome-canary" "chromium" "edge" "edge-beta" "edge-dev" "brave" "opera" "vivaldi" "yandex" "firefox")
            ;;
        MINGW*|CYGWIN*|MSYS*|Windows_NT)
            local all_possible_browsers=("chrome" "chrome-canary" "edge" "edge-beta" "edge-dev" "edge-canary" "brave" "opera" "vivaldi" "yandex" "firefox")
            ;;
    esac
    
    for browser in "${all_possible_browsers[@]}"; do
        local target_path=$(get_browser_paths "$browser")
        
        if [[ -z "$target_path" ]]; then
            continue
        fi
        
        case "$(uname -s)" in
            MINGW*|CYGWIN*|MSYS*|Windows_NT)
                # Windows: Remove registry entry and manifest file
                if [[ "$DRY_RUN" == "true" ]]; then
                    log_info "Would remove registry entry: $target_path"
                    ((removed_count++))
                    
                    local temp_dir="${LOCALAPPDATA:-$HOME}/.mvdcoapp"
                    local manifest_file="$temp_dir/pro.maxvideodownloader.coapp-$browser.json"
                    log_info "✓ Would remove manifest file: $manifest_file"
                else
                    if uninstall_windows_registry "$target_path"; then
                        ((removed_count++))
                    fi
                    
                    # Also remove manifest file if it exists
                    local temp_dir="${LOCALAPPDATA:-$HOME}/.mvdcoapp"
                    local manifest_file="$temp_dir/pro.maxvideodownloader.coapp-$browser.json"
                    if [[ -f "$manifest_file" ]]; then
                        rm "$manifest_file"
                        log_info "✓ Removed manifest file: $manifest_file"
                    fi
                fi
                ;;
            *)
                # macOS/Linux: Remove manifest file
                local manifest_file="$target_path/pro.maxvideodownloader.coapp.json"
                if [[ -f "$manifest_file" ]] || [[ "$DRY_RUN" == "true" ]]; then
                    if [[ "$DRY_RUN" == "true" ]]; then
                        log_info "✓ Would remove from $browser: $manifest_file"
                    else
                        rm "$manifest_file"
                        log_info "✓ Removed from $browser: $manifest_file"
                    fi
                    ((removed_count++))
                fi
                ;;
        esac
    done
    
    # Clean up temp directory on Windows
    case "$(uname -s)" in
        MINGW*|CYGWIN*|MSYS*|Windows_NT)
            local temp_dir="${LOCALAPPDATA:-$HOME}/.mvdcoapp"
            if [[ -d "$temp_dir" ]] && [[ -z "$(ls -A "$temp_dir")" ]]; then
                rmdir "$temp_dir"
                log_info "✓ Cleaned up temporary directory"
            fi
            ;;
    esac
    
    if [[ $removed_count -gt 0 ]]; then
        log_info "✓ Native host uninstalled from $removed_count location(s)"
    else
        log_warn "No native host installations found to remove"
    fi
}

show_help() {
    echo "MAX Video Downloader Native Host Build Script"
    echo ""
    echo "Usage: ./build.sh [command] [platform]"
    echo ""
    echo "Commands:"
    echo "  -version              Show version information"
    echo "  -build [platform]     Build for specific platform (default: current)"
    echo "  -package-app          Create macOS .app bundle (macOS only)"
    echo "  -package-linux        Create Linux tarball package"
    echo "  -package-windows      Create Windows zip package"
    echo "  -install [platform]   Install native host for all detected browsers"
    echo "  -uninstall            Remove native host from all browsers"
    echo "  -detect-browsers      Show detected browsers"
    echo "  -help                 Show this help"
    echo ""
    echo "Flags:"
    echo "  --dry-run             Show what would be done without making changes"
    echo ""
    echo "Platforms:"
    echo "  mac-arm64            macOS Apple Silicon"
    echo "  mac-x64              macOS Intel"
    echo "  win-x64              Windows x64"
    echo "  win-arm64            Windows ARM64"
    echo "  linux-x64            Linux x64"
    echo "  linux-arm64          Linux ARM64"
    echo ""
    echo "Supported Browsers:"
    echo "  Chromium-based: Chrome (+ Canary), Arc, Edge (+ Beta/Dev/Canary), Brave,"
    echo "                  Opera, Vivaldi, Epic, Yandex (all use same extension)"
    echo "  Firefox-based:  Firefox, Tor Browser (require separate extension)"
    echo ""
    echo "  macOS:    All browsers supported"
    echo "  Linux:    All browsers except Arc and Epic"
    echo "  Windows:  All browsers except Arc, Epic, and Tor Browser"
    echo ""
    echo "Installation Methods:"
    echo "  macOS/Linux:  Manifest files in browser directories"
    echo "  Windows:      Registry entries + manifest files"
    echo ""
    echo "Examples:"
    echo "  ./build.sh -build mac-arm64    # Build for macOS ARM64"
    echo "  ./build.sh -install            # Install for all detected browsers"
    echo "  ./build.sh -uninstall          # Remove from all browsers"
    echo "  ./build.sh -package-app        # Create .app bundle (macOS)"
}

# Main script logic
case "${1:-}" in
    -version)
        show_version
        ;;
    -build)
        platform=${2:-$(detect_platform)}
        build_platform "$platform"
        ;;
    -package-app)
        platform=${2:-$(detect_platform)}
        package_mac_app "$platform"
        ;;
    -package-linux)
        platform=${2:-$(detect_platform)}
        package_linux_tarball "$platform"
        ;;
    -package-windows)
        platform=${2:-$(detect_platform)}
        package_windows_zip "$platform"
        ;;
    -install)
        platform=${2:-$(detect_platform)}
        install_native_host "$platform"
        ;;
    -uninstall)
        uninstall_native_host
        ;;
    -detect-browsers)
        log_info "Detecting installed browsers..."
        browsers=($(detect_browsers))
        if [[ ${#browsers[@]} -gt 0 ]]; then
            log_info "Found browsers: ${browsers[*]}"
            for browser in "${browsers[@]}"; do
                path=$(get_browser_paths "$browser")
                echo "  $browser -> $path"
            done
        else
            log_warn "No supported browsers detected"
        fi
        ;;
    -help|--help|help)
        show_help
        ;;
    "")
        show_help
        ;;
    *)
        log_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac