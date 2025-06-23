/**
 * - Controls main UI elements and interactions
 * - Manages loading states and error messages
 * - Implements theme switching functionality
 * - Provides dialogs and notifications
 * - Manages responsive UI adjustments
 */

import { clearCaches, getPreviewCacheStats, updateCacheStatsDisplay, getTheme, setTheme } from './index.js';

const logger = console; // Using console directly for UI logging

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

// Theme SVG definitions - single source of truth
const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>',
    dark: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
};

/**
 * Create clear cache button with icon and text
 */
function createClearCacheButton() {
    const button = document.createElement('button');
    button.className = 'clear-cache-button';
    button.id = 'clear-cache-button';
    button.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zm2-8h6v8H5v-8zm5-6H6L5 5H2v2h12V5h-3z"/>
        </svg>
    `;
    return button;
}

/**
 * Create cache stats display element
 */
function createCacheStatsElement() {
    const element = document.createElement('div');
    element.className = 'cache-stats';
    element.textContent = 'Loading cache stats...';
    getPreviewCacheStats(); // Request stats via port message
    return element;
}

/**
 * Create theme toggle button with current theme icon
 */
function createThemeToggle() {
    const button = document.createElement('button');
    button.className = 'theme-toggle';
    button.innerHTML = THEME_ICONS[getTheme()];
    return button;
}

/**
 * Handle clear cache button click with loading states
 */
async function handleClearCacheClick(event) {
    const button = event.target.closest('.clear-cache-button');
    if (!button) {
        logger.error('Clear cache button not found in event target');
        return;
    }

    button.disabled = true;
    
    try {
        clearCaches();
        
        // Request updated cache stats
        const cacheStats = document.querySelector('.cache-stats');
        if (cacheStats) {
            getPreviewCacheStats(); // This will trigger updateCacheStatsDisplay via port message
        }
        
        // Show success using shared tooltip
        showTooltipOnElement(button, 'Cache cleared!', 2000);
        
    } catch (error) {
        logger.error('Error clearing cache:', error);
        showTooltipOnElement(button, 'Failed to clear cache', 2000);
    } finally {
        // Restore button state
        button.disabled = false;
    }
}

/**
 * Handle theme toggle button click
 */
async function handleThemeToggleClick(event) {
    const button = event.target.closest('.theme-toggle');
    if (!button) {
        logger.error('Theme toggle button not found in event target');
        return;
    }

    const currentTheme = getTheme();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    try {
        await setTheme(newTheme);
        button.innerHTML = THEME_ICONS[newTheme];
    } catch (error) {
        logger.error('Error toggling theme:', error);
    }
}

/**
 * Show tooltip on specific element using shared tooltip
 */
function showTooltipOnElement(element, message, duration = 2000) {
    sharedTooltip.textContent = message;
    element.appendChild(sharedTooltip);
    
    setTimeout(() => {
        if (sharedTooltip.parentNode === element) {
            sharedTooltip.remove();
        }
    }, duration);
}

/**
 * Initialize the UI - coordinates all UI element creation and setup
 */
export function initializeUI() {
    const container = document.getElementById('videos');
    if (!container) {
        logger.error('Videos container not found');
        return null;
    }

    const header = document.querySelector('header');

    // Create main containers
    const leftButtonsContainer = document.createElement('div');
    leftButtonsContainer.className = 'left-buttons-container';
    
    const rightButtonsContainer = document.createElement('div');
    rightButtonsContainer.className = 'right-buttons-container';
    
    // Create UI elements
    const clearCacheButton = createClearCacheButton();
    const cacheStatsElement = createCacheStatsElement();
    const themeToggle = createThemeToggle();
    
    // Assemble DOM structure
    leftButtonsContainer.append(clearCacheButton, cacheStatsElement);
    rightButtonsContainer.appendChild(themeToggle);
    header.prepend(leftButtonsContainer);
    header.append(rightButtonsContainer);
    
    // Insert into page
    container.parentElement.insertBefore(header, container);

    // Attach event handlers
    clearCacheButton.addEventListener('click', handleClearCacheClick);
    themeToggle.addEventListener('click', handleThemeToggleClick);
    
    // Apply current theme
    getTheme();
    
    return {
        container,
        clearCacheButton,
        themeToggle
    };
}


// Scroll position management
export function setScrollPosition(tabId, position) {
    chrome.storage.local.get(['scrollPositions'], (result) => {
        const scrollPositions = result.scrollPositions || {};
        scrollPositions[tabId] = position;
        chrome.storage.local.set({ scrollPositions });
    });
}

export function getScrollPosition(tabId, callback) {
    chrome.storage.local.get(['scrollPositions'], (result) => {
        const position = result.scrollPositions?.[tabId] || 0;
        callback(position);
    });
}

// Notification utilities
export function showError(message) {
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    requestAnimationFrame(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(-50%) translateY(0)';
    });
    
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

export function hideInitMessage() {
    const initialMessage = document.querySelector('.initial-message');
    if (initialMessage) {
        initialMessage.remove();
    }
}

export function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('visible'), 100);
    
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => document.body.removeChild(toast), 300);
    }, duration);
}

// Utility functions for external use
export async function toggleTheme() {
    const currentTheme = getTheme();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    await setTheme(newTheme);
    return newTheme;
}