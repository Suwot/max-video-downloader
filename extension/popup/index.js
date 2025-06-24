/**
 * - Initializes the popup UI and components
 * - Coordinates interaction between UI components
 * - Handles message passing with background script
 * - Manages video loading and display flow
 * - Coordinates between state management and UI rendering
 * - Handles user interface events and interactions
 * - Implements popup lifecycle management
 */

// Import ServiceInitializer to coordinate service initialization
import {
  initializeUI,
  setScrollPosition,
  getScrollPosition
} from './ui.js';
import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/normalize-url.js';
import * as BackgroundCommunication from './messaging/background-communication.js';

const logger = createLogger('Popup');

// Simple theme management - no service needed
let currentTheme = null;

// Simple group state cache - no service needed
let groupStates = {
  hls: false, // expanded by default
  dash: false, // expanded by default
  direct: false, // expanded by default
  blob: true, // collapsed by default
  unknown: false, // expanded by default
};

// Simple theme management functions
/**
 * Get current theme
 */
function getTheme() {
  return currentTheme || 'dark';
}

/**
 * Set theme and apply to document
 */
async function setTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') {
    logger.error('Invalid theme:', theme);
    return;
  }

  currentTheme = theme;
  logger.debug('Setting theme to:', theme);

  // Apply theme classes
  if (theme === 'dark') {
    document.body.classList.add('theme-dark');
    document.body.classList.remove('theme-light');
  } else {
    document.body.classList.add('theme-light');
    document.body.classList.remove('theme-dark');
  }

  // Save to storage
  try {
    await chrome.storage.sync.set({ theme });
  } catch (error) {
    logger.error('Error saving theme:', error);
  }
}

/**
 * Initialize theme from storage
 */
async function initializeTheme() {
  try {
    const result = await chrome.storage.sync.get(['theme']);
    const prefersDarkMode = window.matchMedia(
      '(prefers-color-scheme: dark)'
    ).matches;
    const theme =
      result.theme !== undefined
        ? result.theme
        : prefersDarkMode
        ? 'dark'
        : 'light';

    await setTheme(theme);

    // Listen for system theme changes
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', async (event) => {
        // Only update if theme was not explicitly set by user
        const currentResult = await chrome.storage.sync.get(['theme']);
        if (currentResult.theme === undefined) {
          await setTheme(event.matches ? 'dark' : 'light');
        }
      });

    return theme;
  } catch (error) {
    logger.error('Error initializing theme:', error);
    await setTheme('dark');
    return 'dark';
  }
}

// Simple group state management functions
/**
 * Get group state for a specific type
 */
function getGroupState(type) {
  return groupStates[type] ?? false;
}

/**
 * Set group state for a specific type
 */
async function setGroupState(type, isCollapsed) {
  groupStates[type] = isCollapsed;
  logger.debug(
    `Setting group state for ${type} to ${
      isCollapsed ? 'collapsed' : 'expanded'
    }`
  );

  try {
    await chrome.storage.local.set({ groupState: groupStates });
  } catch (error) {
    logger.error('Error saving group state:', error);
  }
}

/**
 * Initialize group states from storage
 */
async function initializeGroupStates() {
  try {
    const result = await chrome.storage.local.get(['groupState']);
    if (result.groupState) {
      groupStates = { ...groupStates, ...result.groupState };
    }
    logger.debug('Initialized group states:', groupStates);
    return groupStates;
  } catch (error) {
    logger.error('Error initializing group states:', error);
    return groupStates;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    logger.debug('Popup initializing...');

    // Initialize theme and group states directly
    await initializeTheme();
    await initializeGroupStates();

    // Initialize UI elements
    initializeUI();

    // Get the active tab and initialize communication service
    const activeTab = await getActiveTab();
    BackgroundCommunication.initialize(activeTab.id);

    // Connect to background script
    BackgroundCommunication.connect();

    // Register this popup with the background script
    BackgroundCommunication.register(normalizeUrl(activeTab.url));

    // Request videos directly from background script
    BackgroundCommunication.requestVideos(true);

    // Add Clear Cache button handler - direct cache clearing
    document
      .getElementById('clear-cache-btn')
      ?.addEventListener('click', async () => {
        logger.debug('Clear cache button clicked');
        BackgroundCommunication.clearCaches();
        BackgroundCommunication.requestVideos(true);
      });

    // Set up scroll position handling
    const container = document.getElementById('videos');
    const state = BackgroundCommunication.getState();
    if (container && state.currentTabId) {
      // Save position when scrolling
      container.addEventListener('scroll', () => {
        setScrollPosition(state.currentTabId, container.scrollTop);
      });

      // Restore position for this tab
      getScrollPosition(state.currentTabId, (position) => {
        setTimeout(() => {
          if (container.scrollHeight > container.clientHeight) {
            container.scrollTop = position;
          }
        }, 50);
      });
    }
  } catch (error) {
    logger.error('Initialization error:', error);
    const container = document.getElementById('videos');
    if (container) {
      container.innerHTML = `
                <div class='initial-message'>
                    Failed to initialize the extension. Please try reloading.
                </div>
            `;
    }
  }
});

// Listen for popup unload to notify content script
window.addEventListener('unload', () => {
  // Clean up the refresh interval
  BackgroundCommunication.cleanupPeriodicRefresh();

  // Save final scroll position
  const container = document.getElementById('videos');
  const state = BackgroundCommunication.getState();
  if (container && state.currentTabId) {
    setScrollPosition(state.currentTabId, container.scrollTop);
  }

  // Disconnect from background
  BackgroundCommunication.disconnect();
});

/**
 * Get current active tab
 * @returns {Promise<Object>} Active tab
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) {
    throw new Error('Could not determine active tab');
  }
  return tabs[0];
}

// Export functions for use by other modules
export {
  getTheme,
  setTheme,
  getGroupState,
  setGroupState,
  getActiveTab,
};
