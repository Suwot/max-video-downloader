#!/bin/bash

# Test script for bundled Chrome extension
# Helps diagnose issues with the minified build

set -e

EXTENSION_DIR="chrome-web-store/extension"

log_info() { echo -e "\033[32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $1"; }

log_info "🔍 Testing bundled Chrome extension..."

# Check if build exists
if [ ! -d "$EXTENSION_DIR" ]; then
    log_error "Build directory not found. Run 'npm run build:cws' first."
    exit 1
fi

# Validate manifest
log_info "📋 Validating manifest.json..."
if jq empty "$EXTENSION_DIR/manifest.json" 2>/dev/null; then
    log_info "✅ Manifest is valid JSON"
    
    # Check key fields
    NAME=$(jq -r '.name' "$EXTENSION_DIR/manifest.json")
    VERSION=$(jq -r '.version' "$EXTENSION_DIR/manifest.json")
    BACKGROUND=$(jq -r '.background.service_worker' "$EXTENSION_DIR/manifest.json")
    
    log_info "   Name: $NAME"
    log_info "   Version: $VERSION"
    log_info "   Background: $BACKGROUND"
else
    log_error "❌ Invalid manifest.json"
    exit 1
fi

# Check required files
log_info "📁 Checking required files..."
REQUIRED_FILES=(
    "background.js"
    "popup/popup.html"
    "popup/popup.js"
    "popup/popup.css"
    "icons/16.png"
    "icons/48.png"
    "icons/128.png"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$EXTENSION_DIR/$file" ]; then
        SIZE=$(du -h "$EXTENSION_DIR/$file" | cut -f1)
        log_info "   ✅ $file ($SIZE)"
    else
        log_error "   ❌ Missing: $file"
    fi
done

# Check bundle sizes
log_info "📊 Bundle analysis..."
BG_SIZE=$(du -h "$EXTENSION_DIR/background.js" | cut -f1)
POPUP_SIZE=$(du -h "$EXTENSION_DIR/popup/popup.js" | cut -f1)
TOTAL_SIZE=$(du -sh "$EXTENSION_DIR" | cut -f1)

log_info "   Background bundle: $BG_SIZE"
log_info "   Popup bundle: $POPUP_SIZE"
log_info "   Total extension: $TOTAL_SIZE"

# Check for potential issues
log_info "🔍 Checking for potential issues..."

# Check if Chrome APIs are preserved
if grep -q "chrome\." "$EXTENSION_DIR/background.js"; then
    log_info "   ✅ Chrome APIs found in background"
else
    log_warn "   ⚠️  No Chrome APIs found in background"
fi

if grep -q "chrome\." "$EXTENSION_DIR/popup/popup.js"; then
    log_info "   ✅ Chrome APIs found in popup"
else
    log_warn "   ⚠️  No Chrome APIs found in popup"
fi

# Check console filtering
CONSOLE_LOG_COUNT=$(grep -c "console\.log" "$EXTENSION_DIR/background.js" "$EXTENSION_DIR/popup/popup.js" 2>/dev/null || echo "0")
CONSOLE_WARN_COUNT=$(grep -c "console\.warn\|console\.error" "$EXTENSION_DIR/background.js" "$EXTENSION_DIR/popup/popup.js" 2>/dev/null || echo "0")

log_info "   Console.log statements: $CONSOLE_LOG_COUNT (should be 0)"
log_info "   Console.warn/error statements: $CONSOLE_WARN_COUNT (should be > 0)"

# Check for syntax issues
log_info "🔧 Basic syntax check..."
if node -c "$EXTENSION_DIR/background.js" 2>/dev/null; then
    log_info "   ✅ Background syntax OK"
else
    log_error "   ❌ Background syntax error"
fi

if node -c "$EXTENSION_DIR/popup/popup.js" 2>/dev/null; then
    log_info "   ✅ Popup syntax OK"
else
    log_error "   ❌ Popup syntax error"
fi

log_info ""
log_info "🎯 Testing Instructions:"
log_info "1. Open Chrome and go to chrome://extensions/"
log_info "2. Enable 'Developer mode'"
log_info "3. Click 'Load unpacked' and select: $EXTENSION_DIR"
log_info "4. Check for any loading errors"
log_info "5. Test popup functionality"
log_info "6. Check background script in DevTools > Application > Service Workers"
log_info ""
log_info "🐛 If issues found:"
log_info "- Check browser console for errors"
log_info "- Compare with original source functionality"
log_info "- Report specific errors for further debugging"