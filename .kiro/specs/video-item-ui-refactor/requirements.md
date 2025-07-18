# Requirements Document

## Introduction

This feature refactors the video item UI management system in the Chrome extension popup to eliminate redundant code, unify component patterns, and streamline the data flow while preserving all existing UX behaviors. The refactoring addresses scattered state management, mixed component patterns (classes vs functions), and duplicate element targeting logic that currently exists across video creation, updates, and download flows.

## Requirements

### Requirement 1

**User Story:** As a developer maintaining the extension, I want unified component architecture so that video item creation and updates follow consistent patterns.

#### Acceptance Criteria

1. WHEN video items are created THEN they SHALL use a single VideoItemComponent class pattern
2. WHEN video items are updated THEN they SHALL use the same component interface regardless of container (videos vs downloads)
3. WHEN components are managed THEN they SHALL follow consistent lifecycle methods (render, update, destroy)
4. IF existing mixed function/class patterns exist THEN they SHALL be replaced with unified class-based components

### Requirement 2

**User Story:** As a developer maintaining the extension, I want consolidated element targeting so that duplicate selector logic is eliminated.

#### Acceptance Criteria

1. WHEN elements need to be found by URL THEN the system SHALL use a single VideoElementManager
2. WHEN progress updates target multiple containers THEN they SHALL use unified targeting logic
3. WHEN download operations need element access THEN they SHALL use centralized element management
4. IF duplicate selector patterns exist across multiple functions THEN they SHALL be consolidated into single reusable methods

### Requirement 3

**User Story:** As a user downloading videos, I want to see download progress in both the current tab's video list and the global downloads tab so that I have contextual and global visibility.

#### Acceptance Criteria

1. WHEN a download is initiated from a video in the current tab THEN progress SHALL be visible in both videos container and downloads container
2. WHEN popup is opened on a different tab during download THEN progress SHALL be visible in the downloads container only
3. WHEN popup is reopened on the same tab during download THEN progress SHALL be visible in both containers
4. WHEN download completes THEN the video item SHALL be removed from active downloads and moved to history via download-success or download-error message handling, as it happens now, with original video items reset to pre-download state

### Requirement 4

**User Story:** As a user accessing downloads from any tab, I want the downloads tab to show all active downloads regardless of which tab initiated them so that I have global download management.

#### Acceptance Criteria

1. WHEN popup opens on any tab THEN downloads tab SHALL show all active downloads from storage
2. WHEN downloads are restored from storage THEN they SHALL maintain full functionality (progress updates, cancellation)
3. WHEN elementHTML is stored for downloads THEN it SHALL enable cross-tab restoration
4. WHEN download is initiated THEN elementHTML SHALL be preserved in storage for restoration

### Requirement 5

**User Story:** As a developer maintaining the extension, I want unified state management so that button and dropdown states are coordinated and consistent.

#### Acceptance Criteria

1. WHEN download progress updates occur THEN button and dropdown states SHALL be updated through single component interface
2. WHEN component state changes THEN all sub-components (button, dropdown) SHALL be coordinated
3. WHEN state restoration occurs THEN component state SHALL be consistent across all instances
4. IF scattered state logic exists across multiple files THEN it SHALL be consolidated within component instances

### Requirement 6

**User Story:** As a developer maintaining the extension, I want streamlined download flow orchestration so that download initiation, cloning, and progress handling follow predictable patterns.

#### Acceptance Criteria

1. WHEN download is initiated THEN DownloadFlowManager SHALL orchestrate the complete flow
2. WHEN video item cloning occurs THEN it SHALL be managed within component lifecycle
3. WHEN progress updates are received THEN they SHALL be distributed through centralized management
4. WHEN download completion occurs THEN cleanup SHALL follow consistent component patterns

### Requirement 7

**User Story:** As a user initiating downloads, I want all current download options preserved so that I can use "Download As", audio extraction, subtitle extraction, and other specialized download features.

#### Acceptance Criteria

1. WHEN "Download As" option is selected THEN the system SHALL preserve filesystem dialog functionality
2. WHEN audio extraction is requested THEN the system SHALL preserve audio-only download capability
3. WHEN subtitle extraction is requested THEN the system SHALL preserve subtitle download functionality
4. WHEN any specialized download option is used THEN it SHALL work identically to current behavior
5. IF existing download menu functionality exists THEN it SHALL be preserved in the refactored component system