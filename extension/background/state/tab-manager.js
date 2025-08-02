/**
 * Tab Tracker Service
 * Tracks tab events for cleanup and management
 */

// Add static imports at the top
import { createLogger } from "../../shared/utils/logger.js";

import { cleanupMPDContextForTab } from "../detection/video-detector.js";
import {
  cleanupVideosForTab,
  getVideosForDisplay,
} from "../processing/video-store.js";


// Create a logger instance for the Tab Tracker module
const logger = createLogger("Tab Tracker");

// Track domain (origin) for each tab to detect domain changes
// Map<tabId, origin> - tracks the current domain for each tab
const tabDomains = new Map();

/**
 * Check if navigation represents a domain change that requires cleanup
 * @param {number} tabId - Tab ID
 * @param {string} newUrl - New URL after navigation
 * @returns {boolean} - True if domain changed and cleanup is needed
 */
function shouldCleanupOnNavigation(tabId, newUrl) {
  if (!newUrl) return false;

  try {
    const newOrigin = new URL(newUrl).origin;
    const currentOrigin = tabDomains.get(tabId);

    // If we don't have a current origin, store the new one and don't cleanup
    if (!currentOrigin) {
      tabDomains.set(tabId, newOrigin);
      return false;
    }

    // If origins are the same, no cleanup needed
    if (currentOrigin === newOrigin) {
      return false;
    }

    // Domain changed - update tracking and return true for cleanup
    tabDomains.set(tabId, newOrigin);
    logger.debug(
      `Domain change detected for tab ${tabId}: ${currentOrigin} -> ${newOrigin}`
    );
    return true;
  } catch (error) {
    logger.warn(`Error checking domain change for tab ${tabId}:`, error);
    return false;
  }
}

/**
 * Update extension icon for a specific tab
 * @param {number} [tabId] - Tab ID to update icon for; if omitted, resets all tracked tabs
 */
function updateTabIcon(tabId) {
  // Handle global reset case
  if (typeof tabId === "undefined") {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        chrome.action
          .setIcon({
            tabId: tab.id,
            path: "../icons/128-bw.png",
          })
          .catch(() => {
            // Silently ignore all errors - tabs may close during reset
          });
      });
    });
    return;
  }

  // Use getVideosForDisplay to check for valid videos
  const hasValidVideos = getVideosForDisplay(tabId).length > 0;
  const iconPath = hasValidVideos ? "../icons/128.png" : "../icons/128-bw.png";

  // Set icon and silently ignore all errors
  // Tabs can close at any time during async operations - this is normal
  chrome.action
    .setIcon({
      tabId,
      path: iconPath,
    })
    .catch(() => {
      // Silently ignore all errors
      // Tab closure during icon update is a normal race condition
    });
}

/**
 * Initialize tab tracking
 * @returns {Promise<boolean>} Success status
 */
function initTabTracking() {
  logger.info("Initializing tab tracking service");

  try {
    // Listen for tab removal events
    chrome.tabs.onRemoved.addListener((tabId) => {
      logger.debug("Tab removed:", tabId);

      // Cleanup all tab-related data
      cleanupVideosForTab(tabId, false);
      cleanupMPDContextForTab(tabId);

      // Clean up domain tracking
      if (tabDomains.has(tabId)) {
        tabDomains.delete(tabId);
      }
    });

    // Listen for tab activation (when a tab becomes visible/active)
    chrome.tabs.onActivated.addListener((activeInfo) => {
      logger.debug("Tab activated:", activeInfo.tabId);
      updateTabIcon(activeInfo.tabId);
    });

    // Listen for tab updates - only update icon when tab is complete
    // This is needed because Chrome resets extension icons on page load
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
      if (changeInfo.status === "complete") {
        logger.debug("Tab loaded completely:", tabId);
        updateTabIcon(tabId);
      }
    });

    // Listen for page navigation to clear videos only on domain change
    chrome.webNavigation.onCommitted.addListener((details) => {
      // Only handle main frame navigation (not iframes)
      if (details.frameId === 0) {
        if (shouldCleanupOnNavigation(details.tabId, details.url)) {
          logger.debug(
            `Domain change detected, cleaning up tab ${details.tabId}`
          );
          cleanupVideosForTab(details.tabId);
          // Icon will be updated by onUpdated when page completes loading
        } else {
          logger.debug(
            `Same domain navigation for tab ${details.tabId}, preserving videos`
          );
          // Icon will be updated by onUpdated when page completes loading
        }
      }
    });

    return true;
  } catch (error) {
    logger.error("Failed to initialize tab tracking:", error);
    return false;
  }
}

export { initTabTracking, updateTabIcon };
