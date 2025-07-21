# Implementation Plan

- [x] 1. Create Settings Manager class for background service worker
  - Create `extension/background/state/settings-manager.js` with Settings Manager class
  - Implement in-memory state management with settings defaults and constraints
  - Add initialize() method to load from storage.local or create defaults
  - Add get(key) method for background components to access settings
  - Add getAll() method to return complete settings object for popup
  - Add updateAll(settings) method to update both memory and storage.local
  - _Requirements: 2.1, 2.2, 2.5_

- [x] 2. Initialize Settings Manager in background service worker
  - Modify `extension/background/index.js` to import and initialize Settings Manager
  - Call settingsManager.initialize() during background service startup
  - Ensure Settings Manager is available before other services that depend on it
  - Export settingsManager instance for use by other background modules
  - _Requirements: 1.1, 2.1_

- [x] 3. Add settings message handling to popup communication
  - Modify `extension/background/messaging/popup-communication.js` to handle settings messages
  - Add handlers for 'getSettings' and 'updateSettings' commands
  - Route settings requests to Settings Manager methods
  - Send settings responses back to popup with current settings object
  - _Requirements: 2.5, 3.2_

- [x] 4. Create input component styles for settings UI
  - Add input styling to `extension/popup/styles/_components.scss` following existing design patterns
  - Create styles for number inputs, toggles, and text inputs that match current theme system
  - Include focus states, validation states, and hover effects consistent with existing components
  - Use existing CSS variables from `_variables.scss` for colors and transitions
  - _Requirements: 5.2, 5.3, 5.4_

- [x] 5. Implement settings tab UI component
  - Create `extension/popup/settings-tab.js` to replace placeholder content
  - Implement settings rendering using existing section header and content patterns
  - Add concurrent downloads limit input with min=1, max=10 constraints
  - Structure component to support future grouped settings (downloads, detection, history)
  - Send getSettings message on initialization and updateSettings on any change
  - _Requirements: 1.3, 3.1, 5.1, 5.4_

- [x] 6. Integrate settings tab with popup initialization and communication
  - Modify `extension/popup/index.js` to import and initialize settings tab
  - Modify `extension/popup/communication.js` to handle settings response messages
  - Ensure settings tab requests current values from background on popup open
  - Wire up settings tab to existing tab navigation system
  - _Requirements: 3.3, 3.4_

- [x] 7. Modify download manager to use Settings Manager
  - Replace hardcoded MAX_CONCURRENT_DOWNLOADS constant in `extension/background/download/download-manager.js`
  - Import settingsManager and use settingsManager.get('maxConcurrentDownloads') in queue logic
  - Update startDownload and processNextDownload functions to use dynamic limit
  - Ensure existing downloads continue when limit is reduced, new downloads queue appropriately
  - _Requirements: 1.2, 1.4, 1.5_

- [x] 8. Test settings integration and edge cases
  - Verify Settings Manager initializes correctly with and without existing storage
  - Test settings persist across browser restarts and service worker hibernation
  - Test multiple popup instances show consistent values from Settings Manager
  - Verify download queue behavior when concurrent limit is changed
  - Test graceful handling when storage.local operations fail
  - _Requirements: 1.5, 2.1, 3.3, 3.4_
