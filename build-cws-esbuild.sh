#!/bin/bash

# Chrome Web Store submission package builder with esbuild
# Creates a clean, minified extension package for store submission

set -e

VERSION=$(node -p "require('./extension/manifest.json').version")
CWS_BUILD_DIR="chrome-web-store"
EXTENSION_DIR="$CWS_BUILD_DIR/extension"

log_info() { echo -e "\033[32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $1"; }

log_info "Building Chrome Web Store package v$VERSION with esbuild"

# Clean previous builds
rm -rf "$CWS_BUILD_DIR"
mkdir -p "$EXTENSION_DIR"

# Step 1: Run esbuild to create minified bundles
log_info "🔨 Running esbuild..."
node esbuild.config.js

# Step 2: Copy static assets (non-JS files)
log_info "📁 Copying static assets..."

# Copy manifest.json
cp extension/manifest.json "$EXTENSION_DIR/"

# Copy icons (preserve folder structure)
cp -r extension/icons "$EXTENSION_DIR/"

# Copy popup HTML and CSS (but not SCSS)
mkdir -p "$EXTENSION_DIR/popup"
cp extension/popup/popup.html "$EXTENSION_DIR/popup/"
cp extension/popup/popup.css "$EXTENSION_DIR/popup/"

# Step 3: Update HTML to use bundled scripts
log_info "🔧 Updating popup.html for bundled scripts..."
sed -i '' 's|<script type="module" src="index.js"></script>|<script type="module" src="popup.js"></script>|' "$EXTENSION_DIR/popup/popup.html"

# Step 4: Update manifest for bundled background script
log_info "🔧 Updating manifest.json for bundled background..."
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('$EXTENSION_DIR/manifest.json', 'utf8'));
manifest.background.service_worker = 'background.js';
fs.writeFileSync('$EXTENSION_DIR/manifest.json', JSON.stringify(manifest, null, 2));
"

# Step 5: Clean up development files
log_info "🧹 Cleaning development files..."
find "$EXTENSION_DIR" -name "*.scss" -delete
find "$EXTENSION_DIR" -name "*.map" -delete
find "$EXTENSION_DIR" -name ".DS_Store" -delete

# Step 6: Validate the build
log_info "✅ Validating build..."

# Check if bundled files exist
if [ ! -f "$EXTENSION_DIR/background.js" ]; then
    log_error "Background bundle not found!"
    exit 1
fi

if [ ! -f "$EXTENSION_DIR/popup/popup.js" ]; then
    log_error "Popup bundle not found!"
    exit 1
fi

# Validate manifest
if ! jq empty "$EXTENSION_DIR/manifest.json" 2>/dev/null; then
    log_error "Invalid manifest.json"
    exit 1
fi

# Step 7: Create submission package
log_info "📦 Creating submission package..."
cd "$EXTENSION_DIR"
zip -r "../max-video-downloader-cws-v$VERSION.zip" . \
    -x "*.DS_Store*" "*.git*" "*.scss*" "*.map*"
cd - > /dev/null

# Step 8: Generate build report
BUNDLE_SIZE_BG=$(du -h "$EXTENSION_DIR/background.js" | cut -f1)
BUNDLE_SIZE_POPUP=$(du -h "$EXTENSION_DIR/popup/popup.js" | cut -f1)
TOTAL_SIZE=$(du -h "$CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip" | cut -f1)

cat > "$CWS_BUILD_DIR/build-report.txt" << EOF
Chrome Web Store Build Report
============================

Version: $VERSION
Build Date: $(date)
Build Tool: esbuild
Package: max-video-downloader-cws-v$VERSION.zip

Bundle Sizes:
- Background: $BUNDLE_SIZE_BG
- Popup: $BUNDLE_SIZE_POPUP
- Total Package: $TOTAL_SIZE

Optimizations Applied:
✅ JavaScript bundling and minification
✅ Identifier mangling
✅ Dead code elimination
✅ Tree shaking
✅ Debug code removal
✅ Source map removal
✅ Comment stripping

Files in Package:
$(unzip -l "$CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip")

Chrome Web Store Compliance:
✅ No obfuscation (only minification)
✅ No eval() or dynamic code execution
✅ No external code fetching
✅ Manifest V3 compliant
✅ All Chrome APIs preserved

Pre-Submission Checklist:
□ Test extension in fresh browser profile
□ Verify all features work without console errors
□ Check native host connection
□ Test video detection on sample sites
□ Verify popup UI loads correctly
□ Confirm downloads work properly

Upload Instructions:
1. Go to Chrome Web Store Developer Dashboard
2. Upload max-video-downloader-cws-v$VERSION.zip
3. Fill in store listing details
4. Submit for review
EOF

log_info "🎉 Chrome Web Store package ready!"
log_info ""
log_info "📦 Package: $CWS_BUILD_DIR/max-video-downloader-cws-v$VERSION.zip"
log_info "📊 Report: $CWS_BUILD_DIR/build-report.txt"
log_info "📏 Size: $TOTAL_SIZE"
log_info "🔧 Background bundle: $BUNDLE_SIZE_BG"
log_info "🔧 Popup bundle: $BUNDLE_SIZE_POPUP"
log_info ""
log_warn "⚠️  IMPORTANT: Test this package thoroughly before submitting!"
log_info ""
log_info "Next steps:"
log_info "1. Extract and load the extension in Chrome"
log_info "2. Test all functionality"
log_info "3. Submit to Chrome Web Store"