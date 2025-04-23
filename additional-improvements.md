# Additional Architectural Improvements

We've resolved the immediate connection issues and fixed several bugs in the extension. Here are additional architectural improvements that should be implemented to make the extension more robust:

## 1. Eliminate Duplicate NativeConnection Instances

**Problem**: There are two copies of NativeConnection - one in the service worker (background.js) and another in the popup. They both access the same native host process and can interfere with each other.

**Solution**:

- Keep a single copy of NativeConnection in the background script
- Make popup and content scripts communicate via chrome.runtime.sendMessage
- This eliminates race conditions and avoids having to keep the popup open for keep-alive

**Implementation**:

```javascript
// In popup scripts that need to communicate with native host
async function sendToNativeHost(message) {
  return chrome.runtime.sendMessage({
    type: "native-command",
    command: message.type,
    params: message,
  });
}
```

## 2. Unify Message Schema

**Problem**: Inconsistent message formats between different parts of the application.

**Solution**:

- Standardize on a unified message schema: `{id, type, payload}`
- Always mirror the id in the response
- This enables writing a universal router on both sides
- Eliminates many if/else branches

**Example**:

```javascript
// Request
{
  id: "cmd_1234567890",
  type: "download",
  payload: {
    url: "https://example.com/video.mp4",
    format: "hls",
    filename: "my-video.mp4"
  }
}

// Response
{
  id: "cmd_1234567890",  // Same ID as request
  type: "download",      // Same type as request
  status: "success",     // or "error", "progress", etc.
  payload: {
    // Response data
  }
}
```

## 3. Create Command Structure in Host

**Problem**: The host code can become difficult to maintain as new commands are added.

**Solution**:

- Create a command-to-function mapping table in host (commands.js)
- Makes it easier to add new operations
- Provides a clear overview of which commands are supported

**Example**:

```javascript
// commands.js
const commands = {
  download: require("./commands/download"),
  getQualities: require("./commands/get-qualities"),
  generatePreview: require("./commands/generate-preview"),
  healthCheck: require("./commands/health-check"),
};

module.exports = function handleCommand(message) {
  const command = commands[message.type];
  if (!command) {
    return { error: `Unknown command type: ${message.type}` };
  }
  return command(message.payload);
};
```

## 4. Extract Common Utilities

**Problem**: There's a lot of repeated code for notification handling, progress tracking, etc.

**Solution**:

- Move notification ID generation, progress handling, and filename determination into utility functions
- This could reduce the codebase by ~150 lines
- Makes maintenance easier and code more readable

**Example Utilities**:

- `createNotification(title, message)`
- `updateNotificationProgress(id, progress)`
- `getFilenameFromUrl(url)`
- `handleDownloadProgress(downloadId, callback)`

## 5. Improve Native Host Packaging

**Problem**: Installation of the native host requires manual configuration steps.

**Solution**:

- Package ffmpeg + host in a .app bundle
- Include absolute path to the app in com.videodownloader.app.json
- Users can simply copy the .app to /Applications
- No need to manually edit JSON configuration

This simplifies installation for users and reduces support issues.

## 6. Best Practices for Error Handling

- Implement more robust error handling throughout the codebase
- Add error boundaries for recoverable errors
- Include detailed context in error messages
- Centralize error reporting
- Consider adding error telemetry (with user opt-in)

## 7. Transition to Event-Based Architecture

- Implement a publish/subscribe system for internal events
- Decouple components through event-based communication
- Makes the code more maintainable and extensible
- Facilitates adding new features without modifying existing code

By implementing these architectural improvements, the extension will be more robust, easier to maintain, and provide a better user experience.
