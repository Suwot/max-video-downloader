#!/bin/bash
# Installation script for native host

# Get the absolute path of the script directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Create path to index.js
HOST_PATH="$DIR/index.js"

# Hardcoded extension ID - no need to prompt
EXTENSION_ID="jfncojbcnbfnjajniebimjajlaepapho"

echo "Installing native host with extension ID: $EXTENSION_ID"

# Replace placeholder in manifest template
sed "s|HOST_PATH|$HOST_PATH|g" "$DIR/manifest.json" > "$DIR/manifest.json.temp"
sed "s|EXTENSION_ID|$EXTENSION_ID|g" "$DIR/manifest.json.temp" > "$DIR/manifest.json"
rm "$DIR/manifest.json.temp"

# Create native messaging host manifest directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    mkdir -p "$TARGET_DIR"
    cp "$DIR/manifest.json" "$TARGET_DIR/com.mycompany.ffmpeg.json"
    echo "Native host installed for macOS."
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    mkdir -p "$TARGET_DIR"
    cp "$DIR/manifest.json" "$TARGET_DIR/com.mycompany.ffmpeg.json"
    echo "Native host installed for Linux."
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "win"* ]]; then
    # Windows - requires registry edit
    echo "For Windows, please manually add the registry key:"
    echo "HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mycompany.ffmpeg"
    echo "with value: $DIR\\manifest.json"
    echo "Or run the registry script as administrator to install automatically."
    exit 0
else
    echo "Unsupported operating system: $OSTYPE"
    exit 1
fi

# Make sure index.js is executable
chmod +x "$HOST_PATH"

echo "Installation complete!"
echo "Native host application is installed at: $HOST_PATH"
echo "Manifest is installed at: $TARGET_DIR/com.mycompany.ffmpeg.json"
