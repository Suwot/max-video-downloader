/**
 * - Controls main UI elements and interactions
 * - Manages loading states and error messages
 * - Implements theme switching functionality
 * - Provides dialogs and notifications
 * - Manages responsive UI adjustments
 * - Manages tab navigation and content switching
 */

import { getTheme, setTheme } from './state.js';
import { sendPortMessage } from './communication.js';

const logger = console; // Using console directly for UI logging

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

// Theme SVG definitions - single source of truth
const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>',
    dark: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
};

// Tab definitions
const TABS = [
    { id: 'videos', label: 'Videos', isDefault: true },
    { id: 'downloads', label: 'Downloads' },
    { id: 'settings', label: 'Settings' },
    { id: 'about', label: 'About' }
];

let activeTab = 'videos';

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
 * Create tab navigation bar with click handlers
 */
function createTabNavigation() {
    const tabNav = document.createElement('div');
    tabNav.className = 'tab-navigation';
    
    TABS.forEach(tab => {
        const tabButton = document.createElement('button');
        tabButton.className = `tab-button ${tab.isDefault ? 'active' : ''}`;
        tabButton.dataset.tabId = tab.id;
        tabButton.textContent = tab.label;
        
        // Add click handler
        tabButton.addEventListener('click', () => switchTab(tab.id));
        
        tabNav.appendChild(tabButton);
    });
    
    return tabNav;
}

/**
 * Create content containers for all tabs
 */
function createTabContents(videosContainer) {
    const tabContents = document.createElement('div');
    tabContents.className = 'tab-contents';
    
    TABS.forEach(tab => {
        const content = document.createElement('div');
        content.className = `tab-content ${tab.isDefault ? 'active' : ''}`;
        content.dataset.tabId = tab.id;
        
        if (tab.id === 'videos') {
            // Move existing videos container into videos tab
            content.appendChild(videosContainer);
        } else {
            // Create placeholder content for other tabs
            content.appendChild(createPlaceholderContent(tab));
        }
        
        tabContents.appendChild(content);
    });
    
    return tabContents;
}

/**
 * Create placeholder content for non-videos tabs
 */
function createPlaceholderContent(tab) {
    const placeholder = document.createElement('div');
    placeholder.className = 'tab-placeholder';
    
    const icon = document.createElement('div');
    icon.className = 'placeholder-icon';
    
    const title = document.createElement('h3');
    title.textContent = tab.label;
    
    const description = document.createElement('p');
    
    switch (tab.id) {
        case 'downloads':
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
            description.textContent = 'Your downloaded files will appear here';
            break;
        case 'settings':
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>';
            description.textContent = 'Configure your download preferences';
            break;
        case 'about':
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><path d="M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10s10-4.48,10-10S17.52,2,12,2z M13,17h-2v-6h2V17z M13,9h-2V7h2V9z"/></svg>';
            description.textContent = 'Information about MAX Video Downloader';
            break;
    }
    
    placeholder.appendChild(icon);
    placeholder.appendChild(title);
    placeholder.appendChild(description);
    
    return placeholder;
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
 * Initialize the UI - coordinates all UI element creation and setup
 */
export async function initializeUI() {
    const container = document.getElementById('videos');
    if (!container) {
        logger.error('Videos container not found');
        return null;
    }

    const header = document.querySelector('header');
    const mainContainer = container.parentElement;

    // Create main containers
    const leftButtonsContainer = document.createElement('div');
    leftButtonsContainer.className = 'left-buttons-container';
    
    const rightButtonsContainer = document.createElement('div');
    rightButtonsContainer.className = 'right-buttons-container';
    
    // Create UI elements
    const clearCacheButton = createClearCacheButton();
    const themeToggle = await createThemeToggle();
    
    // Assemble header structure
    leftButtonsContainer.append(clearCacheButton);
    rightButtonsContainer.append(themeToggle);
    header.prepend(leftButtonsContainer);
    header.append(rightButtonsContainer);
    
    // Create tab navigation and content structure
    const tabNavigation = createTabNavigation();
    const tabContents = createTabContents(container);
    
    // Clear main container and rebuild structure
    mainContainer.innerHTML = '';
    mainContainer.append(header, tabNavigation, tabContents);

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
    
    return {
        container: tabContents.querySelector('[data-tab-id="videos"]'),
        clearCacheButton,
        themeToggle,
        tabNavigation,
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