# Design Document

## Overview

The settings system uses a centralized Settings Manager class in the background service worker to maintain in-memory state and provide efficient access to all extension settings. The design eliminates redundant storage.local reads by caching settings in memory and using message passing between popup and background for all settings operations.

## Architecture

### Settings Manager Class Strategy

**In-Memory State Management**: The Settings Manager class maintains all settings in memory after initial load from storage.local. This approach:
- Eliminates storage.local reads on every background operation
- Provides immediate access to settings for all background components
- Ensures single source of truth in background service worker
- Handles storage synchronization and validation centrally

**Storage Structure**:
```javascript
// storage.local key: 'settings'
{
  maxConcurrentDownloads: 1,
  autoGeneratePreviews: true,
  defaultSavePath: null,
  minFileSizeFilter: 1024, // bytes
  maxHistorySize: 50,
  historyAutoRemoveInterval: 30 // days
}
```

### Component Architecture

```
Background Service Worker
├── Settings Manager Class (new)
│   ├── In-memory settings state
│   ├── Initialize from storage.local on startup
│   ├── Handle settings updates via messages
│   └── Provide getter methods for all components
├── Download Manager (modified)
│   └── Reads from Settings Manager.get('maxConcurrentDownloads')
├── Video Detector (modified)
│   └── Reads from Settings Manager.get('minFileSizeFilter')
└── Video Processor (modified)
    └── Reads from Settings Manager.get('autoGeneratePreviews')

Popup UI (stateless)
├── Settings Tab (modified)
│   ├── Requests current settings from background on render
│   ├── Sends complete settings object to background on change
│   └── Uses new input component styles
├── Communication (modified)
│   └── Handles settings get/set message passing
└── SCSS Styles (modified)
    └── New input component styles following existing patterns
```

## Components and Interfaces

### 1. Settings Manager Class (Background)

**Location**: `extension/background/state/settings-manager.js`

**Responsibilities**:
- Maintain in-memory state of all settings
- Initialize from storage.local on service worker startup
- Create and save default settings if none exist
- Handle settings updates from popup via message passing
- Provide getter methods for background components
- Validate settings values and constraints

**Key Methods**:
```javascript
class SettingsManager {
  // Initialize from storage, create defaults if needed
  async initialize()
  
  // Get single setting value (used by background components)
  get(key)
  
  // Get all settings (used by popup)
  getAll()
  
  // Update all settings (used by popup updates)
  async updateAll(settingsObject)
  
  // Handle message from popup
  handleMessage(message)
}
```

### 2. Settings Tab UI (Popup)

**Location**: `extension/popup/settings-tab.js`

**Responsibilities**:
- Replace existing `.tab-placeholder` content in settings tab
- Request current settings from background on initialization
- Render settings using existing UI layout patterns (section headers, content areas)
- Send complete settings object to background on any input change
- Create input styling that matches existing design system
- Structure to support grouped settings (downloads, previews, filtering, etc.)

**Message Flow**:
```javascript
// On tab initialization
sendPortMessage({ command: 'getSettings' })

// On any setting change
sendPortMessage({ 
  command: 'updateSettings', 
  settings: completeSettingsObject 
})
```

### 3. Background Component Integration

**Download Manager**: Reads `settingsManager.get('maxConcurrentDownloads')` instead of hardcoded constant

**Video Detector**: Reads `settingsManager.get('minFileSizeFilter')` for filtering

**Video Processor**: Reads `settingsManager.get('autoGeneratePreviews')` for preview generation

**Native Host Operations**: Uses `settingsManager.get('defaultSavePath')` for save dialogs

## Data Models

### Settings Schema

```javascript
const SETTINGS_DEFAULTS = {
  // Download settings
  maxConcurrentDownloads: 1,
  defaultSavePath: null,
  
  // Detection settings  
  minFileSizeFilter: 1024, // 1KB minimum
  autoGeneratePreviews: true,
  
  // History settings
  maxHistorySize: 50,
  historyAutoRemoveInterval: 30, // days
};

const SETTINGS_CONSTRAINTS = {
  maxConcurrentDownloads: { min: 1, max: 10 },
  minFileSizeFilter: { min: 0, max: 100 * 1024 * 1024 }, // 100MB max
  maxHistorySize: { min: 10, max: 1000 },
  historyAutoRemoveInterval: { min: 1, max: 365 }
};
```

### Message Protocol

```javascript
// Popup → Background
{
  command: 'getSettings'
}

{
  command: 'updateSettings',
  settings: { /* complete settings object */ }
}

// Background → Popup  
{
  command: 'settingsResponse',
  settings: { /* complete settings object */ }
}
```

## Error Handling

### Settings Manager Initialization
- If storage.local fails, use hardcoded defaults and log error
- If settings object is corrupted, merge with defaults and save corrected version
- Validate all loaded settings against constraints

### Message Handling
- Validate incoming settings updates against constraints
- Reject invalid values and respond with current valid settings
- Log validation errors for debugging

### Background Component Access
- Settings Manager getter methods never fail (return defaults if needed)
- Background components continue operation with fallback values
- No blocking operations for settings access

## Testing Strategy

### Unit Testing
- Settings Manager initialization with various storage states
- Settings validation and constraint enforcement
- Message handling and state updates

### Integration Testing
- Settings changes affect background component behavior
- Multiple popup instances receive consistent settings
- Storage persistence across service worker hibernation

### Manual Testing Scenarios
1. Change concurrent downloads and verify queue behavior
2. Toggle preview generation and verify video processing
3. Adjust file size filter and verify detection results
4. Test native host save path selection
5. Verify settings persistence across browser restarts

## Implementation Approach

### Phase 1: Settings Manager Infrastructure
1. Create Settings Manager class with in-memory state management
2. Add initialization from storage.local with default creation
3. Implement message handling for get/set operations
4. Add settings validation and constraints

### Phase 2: Background Integration
1. Initialize Settings Manager in background service worker startup
2. Modify download manager to use Settings Manager instead of constants
3. Add settings access to other background components as needed
4. Test background component behavior with dynamic settings

### Phase 3: UI Implementation
1. Create settings tab component with organized sections
2. Implement message passing for settings get/set operations
3. Create input component styles following existing design patterns
4. Replace placeholder content and integrate with tab navigation

### Phase 4: Advanced Settings & Polish
1. Add remaining settings (previews, filtering, history)
2. Implement native host integration for save path selection
3. Add input validation and user feedback in UI
4. Test all settings integration and edge cases