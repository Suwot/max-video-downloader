#!/bin/bash
# Native Host Update Script
# Refreshes native host configuration after code changes

# Get absolute path of script directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "🔄 Updating native host..."

# 1. Update symlink to ensure consistency
echo "📌 Updating symbolic links..."
ln -sf index.js host

# 2. Ensure executable permissions
echo "🔑 Setting executable permissions..."
chmod +x index.js 
chmod +x install.sh
chmod +x update.sh

# 3. Terminate any running instances
echo "🛑 Stopping any running instances..."
pkill -f "node.*[/]index.js" 2>/dev/null || echo "  - No running instances found"

# 4. Reinstall native host with existing extension ID
echo "📥 Reinstalling native host..."
./install.sh

# 5. Run a quick test
echo "🧪 Testing native host..."
RESULT=$(node test-host.js | grep -o "Received response.*")
if [[ "$RESULT" == *"alive"* ]]; then
  echo "✅ Test successful: $RESULT"
else
  echo "❌ Test failed or unexpected response: $RESULT"
fi

echo "✨ Native host update complete!"
echo "📋 Log file: ~/.cache/video-downloader.log"
