# Requirements Document

## Introduction

This feature implements a centralized settings system for the MAX Video Downloader Chrome extension. The system uses a Settings Manager class in the background service worker to maintain in-memory state and handle all settings operations. Settings are accessed through a dedicated UI tab and support various types including download limits, preview generation, file filtering, and native host operations.

## Requirements

### Requirement 1

**User Story:** As a user, I want to configure the maximum number of simultaneous downloads, so that I can control system performance based on my preferences.

#### Acceptance Criteria

1. WHEN the extension starts THEN the Settings Manager SHALL initialize with default maxConcurrentDownloads: 1 from storage.local or create defaults
2. WHEN the download manager needs the concurrent limit THEN it SHALL read from Settings Manager in-memory state
3. WHEN a user opens the settings tab THEN the popup SHALL request current settings from background and display the limit in a number input
4. WHEN a user changes the input value THEN the popup SHALL send the full settings object to background for immediate update
5. WHEN settings are updated THEN the Settings Manager SHALL update both storage.local and in-memory state

### Requirement 2

**User Story:** As a developer, I want a Settings Manager class that provides efficient access to all settings, so that background components can read settings without storage operations.

#### Acceptance Criteria

1. WHEN the service worker initializes THEN the Settings Manager SHALL load all settings from storage.local into memory
2. WHEN background components need settings THEN they SHALL read from Settings Manager in-memory state (no storage.local reads)
3. WHEN settings are updated THEN the Settings Manager SHALL overwrite the entire settings object in storage.local
4. WHEN adding new settings THEN only the settings schema and default values need to be defined
5. WHEN the Settings Manager receives updates THEN it SHALL validate and apply changes to both memory and storage

### Requirement 3

**User Story:** As a user, I want settings changes to apply immediately without save buttons, so that the interface is streamlined and responsive.

#### Acceptance Criteria

1. WHEN a setting input changes THEN the popup SHALL send the complete updated settings object to background immediately
2. WHEN the Settings Manager receives updates THEN it SHALL update in-memory state and storage.local synchronously
3. WHEN multiple popup instances exist THEN each SHALL request fresh settings from background on open
4. WHEN background components access settings THEN they SHALL always get current values from in-memory state

### Requirement 4

**User Story:** As a user, I want to configure various extension behaviors including preview generation, file filtering, and save paths, so that I can customize the extension to my workflow.

#### Acceptance Criteria

1. WHEN configuring preview generation THEN the setting SHALL control automatic preview creation in video processing
2. WHEN setting minimal file size THEN the video detector SHALL filter out files below the threshold
3. WHEN configuring default save path THEN the system SHALL use native host OS access for path selection with file-system command
4. WHEN setting history limits THEN the system SHALL enforce maximum history size and auto-removal intervals
5. WHEN any setting affects background processes THEN those processes SHALL read updated values from Settings Manager

### Requirement 5

**User Story:** As a user, I want the settings interface to feel consistent with the existing extension design, so that it integrates seamlessly with the current UI.

#### Acceptance Criteria

1. WHEN the settings tab is displayed THEN it SHALL replace the placeholder content with organized settings sections
2. WHEN settings inputs are rendered THEN they SHALL use new input component styles following existing design patterns
3. WHEN the settings layout is created THEN it SHALL use existing section headers and content structure
4. WHEN new settings are added THEN they SHALL follow the established visual hierarchy and grouping