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
  getScrollPosition,
  hideInitMessage,
} from './ui.js';
import { renderVideos } from './video/video-renderer.js';
import {
  updateDownloadProgress,
  checkForActiveDownloads,
} from './video/download-handler.js';
import { createLogger } from '../shared/utils/logger.js';
import { normalizeUrl } from '../shared/utils/normalize-url.js';

const logger = createLogger('Popup');

// Global port connection for communicating with the background script
let backgroundPort = null;
let currentTabId = null;
let refreshInterval = null;
let isEmptyState = true; // Track if we're currently showing 'No videos found'
let currentVideos = []; // Simple local video cache for current popup session
let lastFetchTime = 0; // Track last fetch time to prevent excessive requests

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

/**
 * Establish a connection to the background script
 * @returns {Port} The connection port object
 */
function getBackgroundPort() {
  if (!backgroundPort) {
    try {
      backgroundPort = chrome.runtime.connect({ name: 'popup' });
      logger.debug('Connected to background script via port');

      // Set up disconnect handler
      backgroundPort.onDisconnect.addListener(() => {
        logger.debug('Port disconnected from background script');
        backgroundPort = null;
      });

      // Set up message handler
      backgroundPort.onMessage.addListener(handlePortMessage);
    } catch (e) {
      logger.error('Failed to connect to background script:', e);
      return null;
    }
  }
  return backgroundPort;
}

/**
 * Handle messages received via the port connection
 * @param {Object} message - Message received from background script
 */
function handlePortMessage(message) {
  logger.debug('Received port message:', message);

  switch (message.command) {
    case 'videoStateUpdated':
      if (message.videos) {
        logger.debug(`Received ${message.videos.length} videos via port`);
        currentVideos = message.videos; // Update local cache
        updateVideoDisplay(message.videos);
      } else {
        logger.warn('videoStateUpdated message missing videos property:', message);
      }
      break;

    // new case 'cachesCleared' – show initial message instad of video list
    case 'cachesCleared':
      logger.debug('Caches cleared, showing initial message');
      // write function to show initial message
      const container = document.getElementById('videos');
      container.innerHTML = 
        `<div class="initial-message">
            <p>No videos found on the page.</p>
            <p>Play a video or Refresh the page.</p>
        </div>`;
      break;

    case 'progress':
      logger.debug(
        'Received download progress:',
        message.downloadUrl,
        message.progress + '%'
      );
      updateDownloadProgress(
        null, // video object not needed
        message.progress || 0,
        message
      );
      break;

    case 'error':
      logger.debug('Received download error:', message.downloadUrl);
      updateDownloadProgress(null, 0, { ...message, error: true });
      break;

    case 'videoUpdated':
      logger.debug('Received unified video update:', message.url);
      // Update video in local cache
      const index = currentVideos.findIndex((v) => v.url === message.url);
      if (index !== -1) {
        currentVideos[index] = { ...currentVideos[index], ...message.video };
      }
      // Update the UI element directly
      import('./video/video-renderer.js').then((module) => {
        module.updateVideoElement(message.url, message.video);
      });
      break;

    case 'activeDownloadsList':
      if (message.downloads) {
        logger.debug('Received active downloads list:', message.downloads);
        message.downloads.forEach((download) => {
          const downloadUrl = download.url;
          const progressData = download.progress;

          logger.debug(
            'Restoring download state for URL:',
            downloadUrl,
            progressData ? 'with progress' : 'without progress'
          );

					// Find the matching video item and restore download state
					const videoItem = document.querySelector(
					`.video-item[data-url='${downloadUrl}']`
					);
					if (videoItem) {
						const button = videoItem.querySelector('.download-btn');
						const buttonWrapper = videoItem.querySelector('.download-btn-wrapper');

						if (button && buttonWrapper) {
							if (progressData) {
								// Restore with last known progress
								updateDownloadProgress(
									null,
									progressData.progress || 0,
									progressData
								);
							} else {
								// Fallback to generic downloading state
								if (!buttonWrapper.classList.contains('downloading')) {
									buttonWrapper.classList.add('downloading');
									button.innerHTML = `<span>Downloading...</span>`;
								}
							}
						}
					}
        });
      } else {
        logger.warn('activeDownloadsList message missing downloads property:', message);
      }
      break;

    case 'previewCacheStats':
      logger.debug('Received preview cache stats:', message.stats);
      // Trigger cache stats update directly
      const cacheStatsElement = document.querySelector('.cache-stats');
      if (cacheStatsElement) {
        updateCacheStatsDisplay(cacheStatsElement, message.stats);
      }
      break;

    default:
      logger.warn('Unknown command received in port message:', message.command, message);
      break;
  }
}

/**
 * Single entry point for updating videos in the UI
 * @param {Array} videos - The videos to display
 */
function updateVideoDisplay(videos) {
  logger.debug('Updating video display with', videos.length, 'videos');

  const hasVideos = videos.length > 0;
  isEmptyState = !hasVideos;

  renderVideos(videos);
  hideInitMessage();

  logger.debug(
    hasVideos
      ? `Updated UI with ${videos.length} videos`
      : 'No videos to display, showing empty state'
  );
}

/**
 * Send a message to the background script using the port connection
 * @param {Object} message - Message to send to the background script
 * @returns {Boolean} - Success status
 */
function sendPortMessage(message) {
  const port = getBackgroundPort();
  if (port) {
    try {
      port.postMessage(message);
      return true;
    } catch (e) {
      logger.error('Error sending message via port:', e);
      backgroundPort = null;
      return false;
    }
  }
  logger.warn('No port connection available', message);
  return false;
}

/**
 * Request videos for the current tab
 * @param {boolean} forceRefresh - Whether to force a refresh from the background
 */
function requestVideos(forceRefresh = false) {
  if (!currentTabId) return;

  const now = Date.now();

  // Only fetch if forced or it's been a while since last fetch
  if (!forceRefresh && now - lastFetchTime < 2000) {
    logger.debug('Skipping fetch, too soon since last request');
    return;
  }

  lastFetchTime = now;
  logger.debug(
    'Fetching videos for tab:',
    currentTabId,
    forceRefresh ? '(forced)' : ''
  );

  sendPortMessage({
    command: 'getVideos',
    tabId: currentTabId,
    forceRefresh,
  });
}

/**
 * Clear all caches and video data
 */
function clearCaches() {
  logger.debug('Clearing caches');

  // Clear local cache
  currentVideos = [];

  // Request background to clear all caches
  sendPortMessage({
    command: 'clearCaches',
  });

  // Reset last fetch time to force refresh next time
  lastFetchTime = 0;

  // Update UI to show empty state
  updateVideoDisplay([]);
}

/**
 * Get preview cache statistics
 */
function getPreviewCacheStats() {
  sendPortMessage({
    command: 'getPreviewCacheStats',
  });
}

/**
 * Update cache stats display element
 * @param {HTMLElement} statsElement - The stats display element
 * @param {Object} stats - The cache stats
 */
function updateCacheStatsDisplay(statsElement, stats) {
  if (!statsElement) {
    logger.warn('No stats element provided to updateCacheStatsDisplay');
    return;
  }

  if (!stats) {
    statsElement.textContent = 'No cache stats available';
    return;
  }

  const count = stats.count || 0;
  const sizeInKB = Math.round((stats.size || 0) / 1024);

  statsElement.textContent = `${count} previews (${sizeInKB} KB)`;
}

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

/**
 * Set up a periodic refresh to check for new videos
 * Especially important if popup was opened before videos were detected
 */
function setupPeriodicRefresh() {
  // Clear any existing interval
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  // Create a new interval - refresh every 2.5 seconds if we're in empty state
  refreshInterval = setInterval(() => {
    if (isEmptyState) {
      logger.debug('Performing periodic check for new videos...');
      requestVideos(true);
    }
  }, 2500);
}

/**
 * Clean up the periodic refresh interval
 */
function cleanupPeriodicRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
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

    // Connect to background script via port
    getBackgroundPort();

    // Get the active tab ID and register with background
    const activeTab = await getActiveTab();
    currentTabId = activeTab.id;

    // Register this popup with the background script
    sendPortMessage({
      command: 'register',
      tabId: currentTabId,
      url: normalizeUrl(activeTab.url),
    });

    // Request videos directly from background script
    requestVideos(true);

    // Set up periodic refresh to check for new videos
    setupPeriodicRefresh();

    // Check for active downloads from previous popup sessions
    checkForActiveDownloads().catch((err) => {
      logger.error('Error checking for active downloads:', err);
    });

    // Add Clear Cache button handler - direct cache clearing
    document
      .getElementById('clear-cache-btn')
      ?.addEventListener('click', async () => {
        logger.debug('Clear cache button clicked');
        clearCaches();
        requestVideos(true);
      });

    // Set up scroll position handling
    const container = document.getElementById('videos');
    if (container && currentTabId) {
      // Save position when scrolling
      container.addEventListener('scroll', () => {
        setScrollPosition(currentTabId, container.scrollTop);
      });

      // Restore position for this tab
      getScrollPosition(currentTabId, (position) => {
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
  cleanupPeriodicRefresh();

  // Save final scroll position
  const container = document.getElementById('videos');
  if (container && currentTabId) {
    setScrollPosition(currentTabId, container.scrollTop);
  }

  // Disconnect port
  if (backgroundPort) {
    try {
      backgroundPort.disconnect();
      backgroundPort = null;
    } catch (e) {
      // Suppress errors during unload
    }
  }
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
  currentTabId,
  clearCaches,
  getPreviewCacheStats,
  updateCacheStatsDisplay,
  getTheme,
  setTheme,
  getGroupState,
  setGroupState,
  getActiveTab,
  sendPortMessage,
  getBackgroundPort,
};
