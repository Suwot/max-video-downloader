# Design Document

## Overview

This design refactors the video item UI management system from scattered function-based patterns to a unified component-based architecture. The refactoring eliminates code duplication, consolidates state management, and provides consistent interfaces while preserving all existing UX behaviors including dual-container progress display, cross-tab download restoration, and specialized download options.

## Architecture

### Component Hierarchy

```
VideoElementManager (Singleton)
├── VideoItemComponent (videos container)
│   ├── ButtonState
│   └── DropdownState
├── VideoItemComponent (downloads container - cloned)
│   ├── ButtonState
│   └── DropdownState
└── DownloadFlowManager (Singleton)
```

### Data Flow

```
User Action → VideoItemComponent → DownloadFlowManager → Background
Background Progress → VideoElementManager → VideoItemComponent(s) → UI Update
```

## Components and Interfaces

### VideoItemComponent

**Purpose:** Unified component for video item lifecycle management in both containers

**Key Methods:**
- `constructor(video, container, isClone = false)`
- `render()` - Creates DOM element with button + dropdown
- `updateProgress(progressData)` - Handles all progress state updates
- `updateTracks(tracksData)` - Handles track compatibility updates
- `cloneToDownloads()` - Creates managed clone with storage HTML
- `destroy()` - Cleanup and event removal

**State Management:**
- Encapsulates button state (queued, downloading, success, error, canceled)
- Encapsulates dropdown state (progress bar, track selection, compatibility)
- Coordinates sub-component updates through single interface

### VideoElementManager

**Purpose:** Centralized element registration and cross-container operations

**Key Methods:**
- `registerComponent(url, component)` - Register component for lookup
- `findComponentsByUrl(url)` - Get all components for URL (videos + downloads)
- `updateProgressForUrl(url, progressData)` - Update all matching components
- `removeComponent(url, container)` - Unregister component

**Responsibilities:**
- Eliminates duplicate selector logic
- Provides single point for cross-container operations
- Maintains component registry for efficient lookups

### DownloadFlowManager

**Purpose:** Orchestrates complete download lifecycle

**Key Methods:**
- `initiateDownload(videoData, sourceComponent)` - Handle download initiation
- `initiateDownloadAs(videoData, sourceComponent)` - Handle "Download As" flow
- `initiateAudioExtraction(videoData, sourceComponent)` - Handle audio extraction
- `initiateSubtitleExtraction(videoData, sourceComponent)` - Handle subtitle extraction
- `handleProgressUpdate(progressData)` - Distribute progress to components

**Responsibilities:**
- Manages clone creation and storage
- Preserves all specialized download options
- Coordinates with background download manager
- Handles progress distribution

### ButtonState & DropdownState

**Purpose:** Encapsulated state management for sub-components

**ButtonState Methods:**
- `setState(state, options)` - Set button state (queued, downloading, etc.)
- `setProgress(percentage)` - Update progress display
- `restore()` - Reset to original state

**DropdownState Methods:**
- `setProgress(percentage, details)` - Update progress bar and text
- `updateCompatibility(videoContainer)` - Update track compatibility
- `restore()` - Reset to original state

## Data Models

### Component Registration

```javascript
// VideoElementManager internal structure
{
  componentRegistry: Map<string, {
    videos: VideoItemComponent | null,
    downloads: VideoItemComponent | null
  }>
}
```

### Progress Update Flow

```javascript
// Progress data structure (unchanged from current)
{
  command: 'download-progress' | 'download-success' | 'download-error' | 'download-canceled',
  downloadUrl: string,
  masterUrl?: string,
  progress?: number,
  selectedOptionOrigText?: string,
  // ... other existing fields
}
```

### Clone Data Structure

```javascript
// Clone creation result
{
  component: VideoItemComponent,
  elementHTML: string // For storage compatibility
}
```

## Error Handling

### Component Creation Errors
- Graceful fallback to current function-based creation if component creation fails
- Logging of component creation failures for debugging
- Validation of required video data before component instantiation

### Progress Update Errors
- Skip updates for non-existent components without throwing
- Log missing component warnings for debugging
- Preserve existing progress data if component update fails

### Clone Management Errors
- Fallback to current DOM cloning if component cloning fails
- Preserve elementHTML generation for storage compatibility
- Handle restoration failures gracefully with error logging

## Testing Strategy

### Unit Testing
- **VideoItemComponent:** Test creation, updates, cloning, and cleanup
- **VideoElementManager:** Test registration, lookup, and cross-container operations
- **DownloadFlowManager:** Test download initiation and progress distribution
- **State Classes:** Test state transitions and restoration

### Integration Testing
- **Download Flow:** Test complete flow from initiation to completion
- **Cross-Tab Restoration:** Test storage and restoration across different tabs
- **Dual Container Updates:** Test progress updates in both containers
- **Specialized Downloads:** Test "Download As", audio extraction, subtitle extraction

### Regression Testing
- **UX Preservation:** Verify all existing behaviors remain identical
- **Storage Compatibility:** Verify elementHTML storage/restoration works
- **Progress Display:** Verify dual-container progress display
- **Download Options:** Verify all download menu options function correctly

## Migration Strategy

### Phase 1: Component Infrastructure
1. Create VideoItemComponent class
2. Create VideoElementManager singleton
3. Create DownloadFlowManager singleton
4. Implement basic component lifecycle methods

### Phase 2: Integration Points
1. Modify video-renderer.js to use VideoItemComponent
2. Update download-handler.js to use DownloadFlowManager
3. Replace selector-based updates with component-based updates
4. Preserve existing storage/restoration logic

### Phase 3: Cleanup and Optimization
1. Remove redundant functions from existing files
2. Consolidate state management logic
3. Remove duplicate selector patterns
4. Optimize component registration and lookup

### Backward Compatibility
- Maintain existing storage format for cross-version compatibility
- Preserve existing message formats with background
- Keep existing DOM structure for CSS compatibility
- Maintain existing event handling patterns during transition