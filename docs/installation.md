# Installation Guide

## 🎯 Quick Setup (2 steps)

### Step 1: Install Browser Extension

Choose your browser and install from the official store:

| Browser | Installation Link |
|---------|-------------------|
| **Chrome** | [Chrome Web Store](https://chrome.google.com/webstore/detail/bkblnddclhmmgjlmbofhakhhbklkcofd) |
| **Firefox** | [Firefox Add-ons](https://addons.mozilla.org/addon/max-video-downloader/) |
| **Edge** | [Chrome Web Store](https://chrome.google.com/webstore/detail/bkblnddclhmmgjlmbofhakhhbklkcofd) |
| **Brave** | [Chrome Web Store](https://chrome.google.com/webstore/detail/bkblnddclhmmgjlmbofhakhhbklkcofd) |
| **Opera** | [Chrome Web Store](https://chrome.google.com/webstore/detail/bkblnddclhmmgjlmbofhakhhbklkcofd) |

### Step 2: Install Native Host

The extension requires a companion app for video processing. Download for your platform:

## 🖥️ macOS Installation

### Automatic Installation (Recommended)
1. Download: [MaxVideoDownloader-mac-arm64.dmg](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-mac-arm64.dmg) (Apple Silicon) or [MaxVideoDownloader-mac-x64.dmg](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-mac-x64.dmg) (Intel)
2. Open the DMG file
3. Drag "MAX Video Downloader" to Applications folder
4. Right-click the app and select "Open" (first time only)
5. The app will automatically install itself for all supported browsers

### Verification
- Open the extension popup in your browser
- Check that "Native Host: Connected" appears in green

## 🪟 Windows Installation

### Automatic Installation (Recommended)
1. Download: [MaxVideoDownloader-win-x64.zip](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-win-x64.zip) or [MaxVideoDownloader-win-arm64.zip](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-win-arm64.zip)
2. Extract the ZIP file to any folder (e.g., `C:\Program Files\MaxVideoDownloader\`)
3. Right-click `install.bat` and select "Run as administrator"
4. The installer will register the native host for all supported browsers

### Manual Installation
If automatic installation fails:
1. Extract files to: `%LOCALAPPDATA%\MaxVideoDownloader\`
2. Run: `mvdcoapp.exe -install`

### Verification
- Open the extension popup in your browser
- Check that "Native Host: Connected" appears in green

## 🐧 Linux Installation

### Manual Installation
1. Download: [MaxVideoDownloader-linux-x64.tar.gz](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-linux-x64.tar.gz) or [MaxVideoDownloader-linux-arm64.tar.gz](https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-linux-arm64.tar.gz)
2. Extract: `tar -xzf MaxVideoDownloader-linux-x64.tar.gz`
3. Move to system directory: `sudo mv MaxVideoDownloader /opt/`
4. Install for browsers: `/opt/MaxVideoDownloader/mvdcoapp -install`

### Ubuntu/Debian
```bash
# Download and install
wget https://github.com/Suwot/max-video-downloader/releases/latest/download/MaxVideoDownloader-linux-x64.tar.gz
tar -xzf MaxVideoDownloader-linux-x64.tar.gz
sudo mv MaxVideoDownloader /opt/
sudo /opt/MaxVideoDownloader/mvdcoapp -install
```

### Verification
- Open the extension popup in your browser
- Check that "Native Host: Connected" appears in green

## 🔧 Troubleshooting

### Extension Installed but Not Working
1. Check if native host is installed and running
2. Refresh the webpage where you want to download videos
3. Look for the extension icon to turn colored when videos are detected

### Native Host Connection Issues

#### Check Installation
```bash
# macOS/Linux
/Applications/MAX\ Video\ Downloader.app/Contents/MacOS/mvdcoapp -version

# Windows
"C:\Program Files\MaxVideoDownloader\mvdcoapp.exe" -version
```

#### Reinstall Native Host
```bash
# macOS/Linux
mvdcoapp -uninstall
mvdcoapp -install

# Windows (as administrator)
mvdcoapp.exe -uninstall
mvdcoapp.exe -install
```

### Browser-Specific Issues

#### Chrome/Chromium
- Ensure extension has permission to access all sites
- Check `chrome://extensions/` that the extension is enabled

#### Firefox
- Ensure extension has permission to access all sites
- Check `about:addons` that the extension is enabled

#### Brave
- Disable Brave's aggressive blocking for video sites
- Allow extension in private windows if needed

### Permission Denied Errors
- **macOS**: Right-click app → Open (first time only)
- **Windows**: Run installer as administrator
- **Linux**: Ensure executable permissions: `chmod +x mvdcoapp`

## 🆘 Still Need Help?

- [🐛 Report Issues](https://github.com/Suwot/max-video-downloader/issues)
- [💭 Community Discussions](https://github.com/Suwot/max-video-downloader/discussions)
- [📧 Direct Support](mailto:support@maxvideodownloader.pro)
