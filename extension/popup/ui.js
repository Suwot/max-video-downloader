/**
 * - Controls main UI elements and interactions
 * - Manages loading states and error messages
 * - Implements theme switching functionality
 * - Provides dialogs and notifications
 * - Manages responsive UI adjustments
 * - Manages tab navigation and content switching
 */

import { getTheme, setTheme, getVideos } from './state.js';
import { sendPortMessage, downloadCounts } from './communication.js';

const logger = console; // Using console directly for UI logging

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

// Theme SVG definitions - single source of truth
const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>',
    dark: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
};

let activeTab = 'videos-tab';

/**
 * Create clear cache button with icon, text, and click handler
 */
function createClearCacheButton() {
    const button = document.createElement('button');
    button.className = 'clear-cache-button';
    button.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zm2-8h6v8H5v-8zm5-6H6L5 5H2v2h12V5h-3z"/>
        </svg>
    `;

    const cacheStats = document.createElement('div');
    cacheStats.className = 'cache-stats';
    cacheStats.textContent = 'Loading cache stats...';
    sendPortMessage({ command: 'getPreviewCacheStats' }); // Request stats via communication service

    button.appendChild(cacheStats);

    // Attach click handler directly
    button.addEventListener('click', async (event) => {
        button.disabled = true;

        try {
            sendPortMessage({ command: 'clearCaches' });
            cacheStats.textContent = 'Cache cleared!';
            setTimeout(() => {
                sendPortMessage({ command: 'getPreviewCacheStats' });
            }, 2000);
        } catch (error) {
            logger.error('Error clearing cache:', error);
            cacheStats.textContent = 'Failed to clear cache';
            setTimeout(() => {
                sendPortMessage({ command: 'getPreviewCacheStats' });
            }, 2000);
        } finally {
            button.disabled = false;
        }
    });

    return button;
}

/**
 * Create theme toggle button with current theme icon and click handler
 */
async function createThemeToggle() {
    const button = document.createElement('button');
    button.className = 'theme-toggle';
    const currentTheme = await getTheme();
    button.innerHTML = THEME_ICONS[currentTheme];

    // Attach click handler directly
    button.addEventListener('click', async (event) => {
        const currentTheme = await getTheme();
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        try {
            await setTheme(newTheme);
            button.innerHTML = THEME_ICONS[newTheme];
        } catch (error) {
            logger.error('Error toggling theme:', error);
        }
    });

    return button;
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
 * Switch to specified tab
 */
function switchTab(tabId) {
    if (activeTab === tabId) return;
    
    // Update active tab
    activeTab = tabId;
    
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.toggle('active', button.dataset.tabId === tabId);
    });
    
    // Update tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.dataset.tabId === tabId);
    });
    
    logger.log(`Switched to tab: ${tabId}`);
}

// Export switchTab function for external use
export { switchTab };

/**
 * Update tab counter badge
 */
export function updateTabCounter(uiTabId) {
    if (uiTabId === 'videos-tab') {
        const count = getVideos().length;
        const counter = document.querySelector(`[data-tab-id="${uiTabId}"] .tab-counter`);
        counter.textContent = count > 0 ? count : '';
    } else if (uiTabId === 'downloads-tab') {
        const count = downloadCounts.total;
        const counter = document.querySelector(`[data-tab-id="${uiTabId}"] .tab-counter`);
        counter.textContent = count > 0 ? count : '';
    } else {
        logger.warn(`No counter update logic for tab: ${uiTabId}`);
    }
}

/**
 * Initialize the UI - coordinates all UI element creation and setup
 */
export async function initializeUI() {
    const header = document.querySelector('header');
    const videosContainer = document.getElementById('videos-list');
    const tabNavigation = document.querySelector('.tab-navigation');
    const tabContents = document.querySelector('.tab-contents');

    // Create UI elements for header
    const clearCacheButton = createClearCacheButton();
    const themeToggle = await createThemeToggle();
    
    // Assemble header structure
    header.querySelector('.left-buttons-container').append(clearCacheButton);
    header.querySelector('.right-buttons-container').append(themeToggle);
    
    // Attach click handlers to existing tab buttons
    tabNavigation.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tabId));
    });

    // Apply current theme on initialization
    try {
        const theme = await getTheme();
        await setTheme(theme); // This will apply the theme to DOM
        
        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)')
            .addEventListener('change', async (event) => {
                const currentResult = await chrome.storage.local.get(['theme']);
                if (currentResult.theme === undefined) {
                    const newTheme = event.matches ? 'dark' : 'light';
                    await setTheme(newTheme);
                }
            });
    } catch (error) {
        logger.error('Error applying theme:', error);
        await setTheme('dark'); // fallback
    }
    
    // Initialize collapsible sections
    initializeCollapsibleSections();
    
    return {
        container: videosContainer,
        clearCacheButton,
        themeToggle,
        tabContents,
        switchTab
    };
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

/**
 * Initialize collapsible sections throughout the UI
 * Finds all .section-header.collapsible elements and adds toggle functionality
 */
export function initializeCollapsibleSections() {
    document.querySelectorAll('.section-header.collapsible').forEach(header => {
        // Skip if already initialized (has toggle icon)
        if (header.querySelector('.toggle-icon')) {
            return;
        }
        
        // Add toggle icon using innerHTML for efficiency
        const toggleIcon = document.createElement('div');
        toggleIcon.className = 'toggle-icon';
        toggleIcon.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
            </svg>
        `;
        
        // Insert toggle icon at the end of header
        header.appendChild(toggleIcon);
        
        // Add click handler
        header.addEventListener('click', () => {
            const content = header.nextElementSibling;
            if (content?.classList.contains('section-content')) {
                content.classList.toggle('collapsed');
                toggleIcon.classList.toggle('rotated');
            }
        });
    });
}