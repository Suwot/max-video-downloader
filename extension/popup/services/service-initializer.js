/**
 * - Provides centralized service initialization
 * - Ensures proper initialization order
 * - Manages state migration from old state.js to new services
 * - Coordinates initial data loading across services
 */

import { themeService } from './theme-service.js';
import { groupStateService } from './group-state-service.js';
import { videoStateService } from './video-state-service.js';

/**
 * Initialize all services in the correct order
 * @returns {Promise<Object>} Service initialization status
 */
export async function initializeServices() {
    // Step 1: Initialize base services first
    const theme = await themeService.initialize();
    const groupState = await groupStateService.initialize();
    
    // Step 2: Initialize video state service which depends on the others
    const videoState = await videoStateService.initialize();
    
    console.log('[ServiceInitializer] All services initialized');
    
    return {
        theme,
        groupState,
        videoState,
        isInitialized: true
    };
}

/**
 * Re-export all services for convenient access
 */
export {
    themeService,
    groupStateService,
    videoStateService
};

/**
 * Get current active tab
 * @returns {Promise<Object>} Active tab
 */
export async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) {
        throw new Error('Could not determine active tab');
    }
    return tabs[0];
}

/**
 * Helper to detect system dark mode preference
 * @returns {boolean} True if system prefers dark mode
 */
export function systemPrefersDarkMode() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}