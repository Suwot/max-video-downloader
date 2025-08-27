#!/bin/bash

# Build release packages for public distribution
# This script creates all necessary installers and packages

set -e

VERSION=$(node -p "require('./package.json').version")
RELEASE_DIR="releases/v$VERSION"
PUBLIC_REPO="../max-video-downloader-public"

log_info() { echo -e "\033[32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $1"; }

log_info "Building release packages for version $VERSION"

# Build native host for all platforms
log_info "Building native host binaries..."
cd native_host

# Build for all platforms
./build-coapp.sh -build mac-arm64
./build-coapp.sh -build mac-x64  
./build-coapp.sh -build win-x64
./build-coapp.sh -build linux-x64

# Create macOS app bundle
./build-coapp.sh -package-app

cd ..

# Build production extension
log_info "Building production extension..."
./build-production.sh

# Create release directory in public repo
if [ -d "$PUBLIC_REPO" ]; then
    mkdir -p "$PUBLIC_REPO/$RELEASE_DIR"
    
    # Copy extension package
    cp dist/max-video-downloader-*.zip "$PUBLIC_REPO/$RELEASE_DIR/"
    
    # Copy native host installers
    cp native_host/build/*.dmg "$PUBLIC_REPO/$RELEASE_DIR/" 2>/dev/null || true
    cp native_host/build/*.zip "$PUBLIC_REPO/$RELEASE_DIR/" 2>/dev/null || true
    cp native_host/build/*.tar.gz "$PUBLIC_REPO/$RELEASE_DIR/" 2>/dev/null || true
    
    # Generate checksums
    cd "$PUBLIC_REPO/$RELEASE_DIR"
    for file in *; do
        if [ -f "$file" ]; then
            shasum -a 256 "$file" >> checksums.txt
        fi
    done
    
    log_info "✅ Release packages created in $PUBLIC_REPO/$RELEASE_DIR"
    log_info "Files:"
    ls -la
else
    log_warn "Public repository not found at $PUBLIC_REPO"
    log_info "Creating local release directory..."
    mkdir -p "$RELEASE_DIR"
    
    # Copy files locally
    cp dist/max-video-downloader-*.zip "$RELEASE_DIR/"
    find native_host/build -name "*.dmg" -o -name "*.zip" -o -name "*.tar.gz" | xargs -I {} cp {} "$RELEASE_DIR/"
    
    log_info "✅ Release packages created in $RELEASE_DIR"
fi
