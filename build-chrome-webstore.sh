#!/bin/bash

# Chrome Web Store submission package builder
# Creates a clean, optimized extension package for store submission

set -e

VERSION=$(node -p "require('./extension/manifest.json').version")
CWS_BUILD_DIR="chrome-web-store"
SUBMISSION_DIR="$CWS_BUILD_DIR/submission"

log_info() { echo -e "\033[32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $1"; }

log_info "Building Chrome Web Store submission package v$VERSION"

# Clean previous builds
rm -rf "$CWS_BUILD_DIR"
mkdir -p "$SUBMISSION_DIR"

# Copy extension files
cp -r extension/ "$SUBMISSION_DIR/"

# Remove all debug/development files
log_info "Cleaning development files..."
find "$SUBMISSION_DIR" -name "*.scss" -delete
find "$SUBMISSION_DIR" -name "*.map" -delete
find "$SUBMISSION_DIR" -name ".DS_Store" -delete

# Update logger to production mode (minimal logging)
log_info "Setting up production console..."
cat > "$SUBMISSION_DIR/shared/utils/logger.js" << 'EOF'
// Production console wrapper for Chrome Web Store submission
// Only critical errors and warnings are logged

// Override console methods to disable debug/log in production
const originalConsole = {
  log: console.log,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
  group: console.group,
  groupEnd: console.groupEnd
};

// Disable debug and log in production
console.log = () => {};
console.debug = () => {};
console.group = () => {};
console.groupEnd = () => {};

// Keep info, warn, and error for important messages
console.info = originalConsole.info;
console.warn = originalConsole.warn;
console.error = originalConsole.error;

// Export for any legacy compatibility (empty since we removed logger)
export const createLogger = () => ({
  debug: () => {},
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  group: () => {},
  setLevel: () => {},
  getLevel: () => {}
});

export const loggerConfig = {
  setGlobalLevel: () => {},
  getGlobalLevel: () => {},
  resetAllModules: () => {},
  getModuleLevels: () => ({})
};
EOF

# Remove debug code from all JavaScript files
log_info "Removing debug code..."

# Function to safely remove console debug statements
remove_debug_console() {
    local file="$1"
    # Use Node.js for safer, syntax-aware removal
    node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$file', 'utf8');
    
    // Remove console.log and console.debug calls (but keep console.warn, console.error, console.info)
    content = content.replace(/console\.(log|debug)\s*\([^)]*\)\s*;?\s*$/gm, '');
    
    // Remove console.group/groupEnd pairs for debug
    content = content.replace(/console\.group\s*\([^)]*\)\s*;?\s*/g, '');
    content = content.replace(/console\.groupEnd\s*\(\s*\)\s*;?\s*/g, '');
    
    // Remove debug interval and logger patterns
    content = content.replace(/startDebugLogger\s*\(\s*\)\s*;?\s*/g, '');
    content = content.replace(/debugInterval[^\n]*\n?/g, '');
    
    // Remove debug comment blocks
    content = content.replace(/\/\/ === DEBUG:.*?===.*?\n/gs, '');
    
    // Clean up extra empty lines
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    fs.writeFileSync('$file', content);
    "
}

find "$SUBMISSION_DIR" -name "*.js" -type f | while read -r file; do
    log_info "Processing: $(basename "$file")"
    remove_debug_console "$file"
done

# Clean up background/index.js specifically
log_info "Cleaning background script..."
if [ -f "$SUBMISSION_DIR/background/index.js" ]; then
    node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$SUBMISSION_DIR/background/index.js', 'utf8');
    
    // Remove debug logger function and calls
    content = content.replace(/\/\/ Debug logger.*?\n.*?^}/gms, '');
    content = content.replace(/startDebugLogger\s*\(\s*\)\s*;?\s*/g, '');
    content = content.replace(/debugInterval[^\n]*\n?/g, '');
    
    // Clean up extra empty lines
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    fs.writeFileSync('$SUBMISSION_DIR/background/index.js', content);
    "
fi

# Validate manifest
log_info "Validating manifest..."
if ! jq empty "$SUBMISSION_DIR/manifest.json" 2>/dev/null; then
    log_error "Invalid manifest.json"
    exit 1
fi

# Create submission package
log_info "Creating submission package..."
cd "$SUBMISSION_DIR"
zip -r "../max-video-downloader-cws-v$VERSION.zip" . \
    -x "*.DS_Store*" "*.git*" "*.scss*" "*.map*"
cd - > /dev/null

# Generate submission info
cat > "$CWS_BUILD_DIR/submission-info.txt" << EOF
Chrome Web Store Submission Package
===================================

Version: $VERSION
Date: $(date)
Package: max-video-downloader-cws-v$VERSION.zip

Size: $(du -h "$CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip" | cut -f1)

Files included:
$(unzip -l "$CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip" | head -20)

Submission Checklist:
□ Test extension in fresh browser profile
□ Verify all features work without debug console
□ Check native host connection
□ Verify popup UI works correctly
□ Test video detection on sample sites
□ Confirm no console errors in production
□ Review Chrome Web Store policies compliance

Upload Instructions:
1. Go to Chrome Web Store Developer Dashboard
2. Upload max-video-downloader-cws-v$VERSION.zip
3. Fill in store listing details
4. Submit for review

Notes:
- Debug logging has been removed
- SCSS files excluded
- Source maps excluded
- Development files cleaned
EOF

log_info "✅ Chrome Web Store package ready!"
log_info ""
log_info "📦 Package: $CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip"
log_info "📄 Info: $CWS_BUILD_DIR/submission-info.txt"
log_info "📏 Size: $(du -h "$CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip" | cut -f1)"
log_info ""
log_warn "⚠️  IMPORTANT: Test this package in a fresh browser profile before submitting!"
log_info ""
log_info "Next steps:"
log_info "1. Extract and test the package locally"
log_info "2. Verify native host connection works"
log_info "3. Test video detection and downloads"
log_info "4. Submit to Chrome Web Store Developer Dashboard"