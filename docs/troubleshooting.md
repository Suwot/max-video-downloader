# Troubleshooting Guide

## 🔍 Common Issues

### Extension Not Detecting Videos

#### Symptoms
- Extension icon remains gray/inactive
- No videos appear in the popup
- "No videos detected" message

#### Solutions
1. **Refresh the page** - Video detection starts when the page loads
2. **Play the video** - Some sites only load video URLs when playback begins
3. **Check supported formats** - We support HLS (.m3u8), DASH (.mpd), and direct video files
4. **Try incognito mode** - Other extensions might interfere
5. **Clear browser cache** - Cached requests might not trigger detection

### Native Host Connection Issues

#### Symptoms
- "Native Host: Disconnected" in extension popup
- Downloads fail with "Native host error"
- Extension popup shows connection error

#### Solutions

##### 1. Verify Installation
```bash
# macOS
/Applications/MAX\ Video\ Downloader.app/Contents/MacOS/mvdcoapp -version

# Windows  
"C:\Program Files\MaxVideoDownloader\mvdcoapp.exe" -version

# Linux
/opt/MaxVideoDownloader/mvdcoapp -version
```

##### 2. Reinstall Native Host
```bash
# Uninstall first
mvdcoapp -uninstall

# Then reinstall
mvdcoapp -install
```

##### 3. Check Browser Registration
```bash
# See which browsers are detected
mvdcoapp -detect-browsers

# Force reinstall for specific browser
mvdcoapp -install --browser chrome
```

### Download Failures

#### Symptoms
- Downloads start but fail partway through
- "FFmpeg error" messages
- Corrupted or incomplete video files

#### Solutions
1. **Check disk space** - Ensure sufficient storage for the video
2. **Try different quality** - Lower quality might work better
3. **Check video URL** - Some streams expire quickly
4. **Restart browser** - Clear any cached connection issues
5. **Update native host** - Download latest version

### Permission Issues

#### macOS: "App can't be opened"
```bash
# Allow the app to run
sudo xattr -d com.apple.quarantine /Applications/MAX\ Video\ Downloader.app

# Or right-click → Open → Open anyway
```

#### Windows: "Windows protected your PC"
1. Click "More info"
2. Click "Run anyway"
3. Or run installer as administrator

#### Linux: Permission denied
```bash
# Make executable
chmod +x /opt/MaxVideoDownloader/mvdcoapp

# Check ownership
sudo chown -R $USER:$USER /opt/MaxVideoDownloader/
```

## 🌐 Site-Specific Issues

### YouTube
- **Not supported** - Use YouTube's official download features or YouTube Premium
- Extension intentionally doesn't work on YouTube due to terms of service

### Streaming Services (Netflix, Hulu, etc.)
- **DRM-protected content** - Cannot be downloaded due to encryption
- Extension respects content protection measures

### Social Media Platforms

#### Twitter/X
- Works for directly uploaded videos
- May not work for linked/embedded content
- Try refreshing page if videos don't appear

#### Instagram
- Works for video posts and stories
- May require playing the video first
- Some private accounts might not work

#### TikTok
- Generally works well
- Try both mobile and desktop versions
- Some regions may have restrictions

### Live Streams

#### Twitch
- Can record ongoing live streams
- VODs (past broadcasts) also supported
- May take longer to detect stream URLs

#### YouTube Live
- Recording not supported due to YouTube's terms
- Use YouTube's official features instead

## 🔧 Advanced Troubleshooting

### Reset Extension Data
```javascript
// Clear all extension data
chrome.storage.local.clear();
chrome.storage.session.clear();
```

### Check Native Host Logs

#### macOS
```bash
# View logs
tail -f ~/Library/Logs/MaxVideoDownloader/debug.log
```

#### Windows
```cmd
# View logs  
type "%APPDATA%\MaxVideoDownloader\Logs\debug.log"
```

#### Linux
```bash
# View logs
tail -f ~/.local/share/MaxVideoDownloader/logs/debug.log
```

### Network Issues

#### Corporate Firewalls
- Extension might be blocked by corporate security
- Contact IT department for allowlisting
- Try using personal device/network

#### VPN/Proxy Issues
- Some VPNs interfere with video detection
- Try disabling VPN temporarily
- Use VPN with different server location

#### Ad Blockers
- Some ad blockers interfere with video requests
- Add extension to ad blocker whitelist
- Try disabling ad blocker temporarily

## 🆘 Getting Help

### Before Reporting Issues
1. Try the solutions above
2. Test in incognito/private mode
3. Try different browser
4. Check if issue happens on multiple sites

### Information to Include
- Operating system and version
- Browser and version
- Extension version
- Native host version (`mvdcoapp -version`)
- Website where issue occurs
- Error messages (screenshots helpful)
- Steps to reproduce

### Contact Options
- [🐛 GitHub Issues](https://github.com/Suwot/max-video-downloader/issues) - Bug reports
- [💭 GitHub Discussions](https://github.com/Suwot/max-video-downloader/discussions) - Questions
- [📧 Email Support](mailto:support@maxvideodownloader.pro) - Direct help

## 📋 System Requirements

### Minimum Requirements
- **OS**: macOS 10.14+, Windows 10+, Ubuntu 18.04+
- **RAM**: 4GB (8GB recommended for large videos)
- **Storage**: 1GB free space + video file size
- **Browser**: Chrome 88+, Firefox 78+, Edge 88+

### Recommended Setup
- **OS**: Latest stable version
- **RAM**: 8GB or more
- **Storage**: SSD with ample free space
- **Network**: Stable internet connection
- **Browser**: Latest version with hardware acceleration enabled
