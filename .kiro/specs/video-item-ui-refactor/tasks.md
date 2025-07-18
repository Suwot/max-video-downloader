# Implementation Plan

- [ ] 1. Create ButtonState class for encapsulated button state management
  - Write setState() method for button state management (queued, downloading, success, error, canceled)
  - Implement setProgress() method for progress display
  - Create restore() method to reset to original state
  - Ensure auto-restore functionality for temporary states
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 2. Create DropdownState class for encapsulated dropdown state management
  - Write setProgress() method for progress bar and text updates
  - Implement updateCompatibility() method for track compatibility
  - Create restore() method to reset dropdown to original state
  - Ensure progress text formatting matches existing behavior
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 3. Create VideoElementManager singleton for centralized element operations
  - Write registerComponent() method for component tracking
  - Implement findComponentsByUrl() method for cross-container lookup
  - Create removeComponent() method for cleanup
  - Build internal registry structure for efficient component access
  - _Requirements: 2.1, 2.2_

- [ ] 4. Create VideoItemComponent class with basic lifecycle methods
  - Write constructor to accept video data, container type, and clone flag
  - Implement render() method that creates DOM element with button and dropdown using ButtonState and DropdownState
  - Create attachToContainer() method for DOM insertion
  - Write destroy() method for cleanup and event removal
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 5. Implement VideoItemComponent cloning and storage compatibility
  - Write cloneToDownloads() method that creates managed clone
  - Implement fromStoredHTML() static method for restoration from storage
  - Ensure elementHTML generation for storage compatibility
  - Preserve existing storage format for cross-version compatibility
  - _Requirements: 4.1, 4.2, 4.3_

- [ ] 6. Implement VideoItemComponent progress update handling
  - Write updateProgress() method that coordinates button and dropdown updates
  - Implement state transitions for queued, downloading, success, error, canceled states
  - Create progress restoration logic for component state consistency
  - Ensure dual-container progress display is maintained
  - _Requirements: 3.1, 3.2, 3.3, 5.1, 5.2, 5.3_

- [ ] 7. Implement VideoElementManager cross-container operations
  - Write updateProgressForUrl() method that updates all matching components
  - Create unified element targeting logic to replace duplicate selectors
  - Implement batch operations for multiple component updates
  - Ensure both videos and downloads containers are handled consistently
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

- [ ] 8. Create DownloadFlowManager singleton for download orchestration
  - Write initiateDownload() method for standard downloads
  - Implement clone creation and storage logic within download flow
  - Create progress update distribution system
  - Ensure component registration for progress tracking
  - _Requirements: 6.1, 6.2, 6.3_

- [ ] 9. Implement specialized download options in DownloadFlowManager
  - Write initiateDownloadAs() method preserving filesystem dialog functionality
  - Implement initiateAudioExtraction() method for audio-only downloads
  - Create initiateSubtitleExtraction() method for subtitle downloads
  - Ensure all existing download menu functionality is preserved
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 10. Implement DownloadFlowManager progress handling and distribution
  - Write handleProgressUpdate() method for centralized progress distribution
  - Implement component lookup and update coordination
  - Create completion handling with proper cleanup
  - Ensure download completion resets components to pre-download state
  - _Requirements: 3.4, 6.3, 6.4_

- [ ] 11. Modify video-renderer.js to use VideoItemComponent
  - Replace createVideoElement() calls with VideoItemComponent creation
  - Update addVideoToUI() to use component.render() and component.attachToContainer()
  - Modify updateVideoInUI() to use component.updateTracks() instead of full replacement
  - Ensure removeVideoFromUI() properly calls component.destroy()
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 12. Update video creation flow to use unified component approach
  - Modify createDownloadActions() to be handled within VideoItemComponent.render()
  - Replace separate dropdown and button creation with unified component approach
  - Ensure VideoElementManager registration occurs during component creation
  - Preserve existing DOM structure for CSS compatibility
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 13. Modify download-handler.js to use DownloadFlowManager
  - Replace handleDownload() logic with DownloadFlowManager.initiateDownload()
  - Update cloneVideoItemToDownloads() to use component cloning
  - Modify restoreActiveDownloads() to use VideoItemComponent.fromStoredHTML()
  - Ensure existing storage and restoration behavior is preserved
  - _Requirements: 6.1, 6.2, 4.1, 4.2, 4.3_

- [ ] 14. Replace progress update functions with component-based updates
  - Replace updateDownloadProgress() orchestration with DownloadFlowManager.handleProgressUpdate()
  - Remove updateDownloadButton() and updateDropdown() functions
  - Replace updateSingleDownloadButtonState() and updateSingleDropdown() with component methods
  - Ensure VideoElementManager handles cross-container updates
  - _Requirements: 2.1, 2.2, 2.3, 5.1, 5.2_

- [ ] 15. Remove duplicate selector logic and consolidate element access
  - Remove repeated element targeting patterns from download-handler.js
  - Consolidate element lookup logic in VideoElementManager
  - Remove redundant querySelector calls across multiple functions
  - Ensure single source of truth for element access
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 16. Remove obsolete functions and consolidate state management
  - Remove createDownloadActions() from video-item.js (handled by component)
  - Remove updateDownloadButton() and updateDropdown() from download-handler.js
  - Consolidate button state logic from download-button.js into ButtonState class
  - Remove scattered dropdown update logic in favor of DropdownState class
  - _Requirements: 1.4, 5.4_

- [ ] 17. Test component lifecycle and state management
  - Write unit tests for VideoItemComponent creation, updates, and cleanup
  - Test ButtonState and DropdownState transitions and restoration
  - Verify component cloning and storage HTML generation
  - Test component registration and lookup in VideoElementManager
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3_

- [ ] 18. Test download flow integration and specialized options
  - Test complete download flow from initiation to completion using components
  - Verify specialized download options (Download As, audio extraction, subtitle extraction)
  - Test cross-tab restoration using component-based approach
  - Verify dual-container progress display is maintained
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 19. Validate UX preservation and perform regression testing
  - Verify all existing user behaviors remain identical
  - Test popup reopening scenarios (same tab, different tab, during downloads)
  - Validate storage compatibility and restoration functionality
  - Ensure download completion properly resets component states
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4_
