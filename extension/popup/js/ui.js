/**
 * @ai-guide-component UI
 * @ai-guide-description Handles UI components and interactions
 * @ai-guide-responsibilities
 * - Controls main UI elements and interactions
 * - Manages loading states and error messages
 * - Implements theme switching functionality
 * - Provides dialogs and notifications
 * - Manages responsive UI adjustments
 */

import { debounce, formatQualityLabel, formatQualityDetails } from './utilities.js';
import { getTheme, setTheme, applyTheme as applyThemeChange } from './services/theme-service.js';
import { getAllGroupStates } from './services/group-state-service.js';
import { clearCaches, getPreviewCacheStats } from './services/video-state-service.js';
import { updateVideoList } from './video-fetcher.js';

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

/**
 * Apply theme to UI
 * @param {string} theme - Theme to apply ('dark' or 'light')
 */
export function applyTheme(theme) {
    applyThemeChange(theme);
}

/**
 * Initialize the UI
 * @returns {Object} UI elements and functions
 */
export function initializeUI() {
    const container = document.getElementById('videos');
    const refreshContainer = document.createElement('div');
    refreshContainer.className = 'refresh-container';
    
    // Create left button container for action buttons
    const leftButtonsContainer = document.createElement('div');
    leftButtonsContainer.className = 'left-buttons-container';
    
    // Create clear cache button
    const clearCacheButton = document.createElement('button');
    clearCacheButton.className = 'clear-cache-button';
    clearCacheButton.id = 'clear-cache-button';
    clearCacheButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zm2-8h6v8H5v-8zm5-6H6L5 5H2v2h12V5h-3z"/>
        </svg>
        <span>Clear Cache</span>
    `;
    
    // Add event listener for clear cache button
    clearCacheButton.addEventListener('click', async function() {
        const button = this;
        const originalText = button.querySelector('span').textContent;
        
        // Update button text and add loading class
        button.querySelector('svg').classList.add('spinning');
        button.querySelector('span').textContent = 'Clearing';
        button.classList.add('loading');
        button.disabled = true;
        
        try {
            // Use VideoStateService to clear caches
            await clearCaches();
            
            // Force a full refresh with forceRefresh=true
            const { updateVideoList } = await import('./video-fetcher.js');
            await updateVideoList(true);
            
            // Update cache stats after clearing
            updateCacheStats(document.querySelector('.cache-stats'));
            
            // Show confirmation tooltip
            const tooltip = document.createElement('div');
            tooltip.className = 'tooltip';
            tooltip.textContent = 'Cache cleared!';
            button.appendChild(tooltip);
            
            setTimeout(() => {
                tooltip.remove();
            }, 2000);
            
        } catch (error) {
            console.error('Error clearing cache:', error);
        } finally {
            // Restore button text and remove loading class
            button.querySelector('svg').classList.remove('spinning');
            button.querySelector('span').textContent = originalText;
            button.classList.remove('loading');
            button.disabled = false;
        }
    });
    
    // Add button to left container
    leftButtonsContainer.append(clearCacheButton);
    
    // Add cache stats element
    const cacheStatsElement = document.createElement('div');
    cacheStatsElement.className = 'cache-stats';
    cacheStatsElement.textContent = 'Loading cache stats...';
    leftButtonsContainer.appendChild(cacheStatsElement);
    
    // Update cache stats
    updateCacheStats(cacheStatsElement);
    
    // Create right container for theme toggle
    const rightButtonsContainer = document.createElement('div');
    rightButtonsContainer.className = 'right-buttons-container';
    
    // Create theme toggle button
    const themeToggle = document.createElement('button');
    themeToggle.className = 'theme-toggle';
    themeToggle.innerHTML = getTheme() === 'dark'
        ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    
    // Fix: Use setTheme instead of applyTheme to persist the theme change
    themeToggle.addEventListener('click', async () => {
        const newTheme = getTheme() === 'dark' ? 'light' : 'dark';
        await setTheme(newTheme);
        
        // Update the icon based on the new theme
        themeToggle.innerHTML = newTheme === 'dark'
            ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    });
    
    // Add theme toggle to right container
    rightButtonsContainer.appendChild(themeToggle);
    
    // Add both containers to the refresh container
    refreshContainer.appendChild(leftButtonsContainer);
    refreshContainer.appendChild(rightButtonsContainer);
    
    container.parentElement.insertBefore(refreshContainer, container);
        
    return {
        container,
        clearCacheButton,
        themeToggle,
        refreshContainer
    };
}

/**
 * Save scroll position for a specific tab
 * @param {number} tabId - Tab ID
 * @param {number} position - Scroll position
 */
export function setScrollPosition(tabId, position) {
  chrome.storage.local.get(['scrollPositions'], (result) => {
    const scrollPositions = result.scrollPositions || {};
    scrollPositions[tabId] = position;
    chrome.storage.local.set({ scrollPositions });
  });
}

/**
 * Get saved scroll position for a specific tab
 * @param {number} tabId - Tab ID
 * @param {function} callback - Callback function that receives the position
 */
export function getScrollPosition(tabId, callback) {
  chrome.storage.local.get(['scrollPositions'], (result) => {
    const position = result.scrollPositions?.[tabId] || 0;
    callback(position);
  });
}

/**
 * Show error message in the container
 * @param {HTMLElement} container - Container to show error in
 * @param {string} message - Error message
 */
export function showErrorMessage(container, message) {
    container.innerHTML = `
        <div class="initial-message">
            ${message} Try refreshing the page or extension.
        </div>
    `;
}

/**
 * Show loading spinner in the container
 * @param {HTMLElement} container - Container to show loader in
 */
export function showLoader(container) {
    container.innerHTML = `
        <div class="initial-loader">
            <span>Searching for videos...</span>
        </div>
    `;
}

/**
 * Show loading state with optional message
 * @param {string} message - Optional message to display
 */
export function showLoadingState(message = 'Searching for videos...') {
    const container = document.getElementById('videos');
    if (!container) return;
    
    container.innerHTML = `
        <div class="initial-loader">
            <div class="loader"></div>
            <span>${message}</span>
        </div>
    `;
}

/**
 * Hide loading state
 */
export function hideLoadingState() {
    const loader = document.querySelector('.initial-loader');
    if (loader) {
        loader.style.display = 'none';
    }
}

/**
 * Show "no videos found" message
 */
export function showNoVideosMessage() {
    const container = document.getElementById('videos');
    if (!container) return;
    
    // Remove loader if it exists
    const loader = container.querySelector('.initial-loader');
    if (loader) {
        container.removeChild(loader);
    }
    
    // Add message if container is empty
    if (!container.querySelector('.video-group') && !container.querySelector('.no-videos-message')) {
        container.innerHTML = `
            <div class="no-videos-message">
                <svg viewBox="0 0 24 24" width="48" height="48">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.31-3.1L7.1 5.69C8.45 4.63 10.15 4 12 4c4.42 0 8 3.58 8 8 0 1.85-.63 3.55-1.69 4.9z"/>
                </svg>
                <p>No videos found on this page.</p>
                <p>Try playing a video or refreshing the page.</p>
            </div>
        `;
    }
}

/**
 * Show quality selection dialog
 * @param {Array} qualities - Available qualities
 * @returns {Promise} Resolves with selected quality or null if canceled
 */
export function showQualityDialog(qualities) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'quality-dialog-overlay';
        
        const dialog = document.createElement('div');
        dialog.className = 'quality-dialog';
        
        // Sort qualities by resolution (highest first)
        const sortedQualities = [...qualities].sort((a, b) => {
            const [aHeight] = a.resolution.split('x').map(Number).reverse();
            const [bHeight] = b.resolution.split('x').map(Number).reverse();
            return bHeight - aHeight;
        });
        
        dialog.innerHTML = `
            <h3>Select Quality</h3>
            <div class="quality-list">
                ${sortedQualities.map((q, i) => {
                    const details = formatQualityDetails(q);
                    return `
                        <div class="quality-option" data-index="${i}">
                            <div class="quality-info">
                                <div class="quality-resolution">${details.label}</div>
                                <div class="quality-details">
                                    ${details.codecs ? `Codec: ${details.codecs}` : ''}
                                    ${details.bitrate ? ` • ${details.bitrate}` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            <div class="quality-dialog-buttons">
                <button class="cancel-btn">Cancel</button>
                <button class="select-btn">Select</button>
            </div>
        `;

        // Add theme variables
        dialog.style.setProperty('--background', getTheme() === 'dark' ? '#2d2d2d' : '#ffffff');
        dialog.style.setProperty('--border', getTheme() === 'dark' ? '#444' : '#e0e0e0');
        dialog.style.setProperty('--text-secondary', getTheme() === 'dark' ? '#aaa' : '#666');
        dialog.style.setProperty('--hover', getTheme() === 'dark' ? '#3d3d3d' : '#f5f5f5');
        dialog.style.setProperty('--primary', '#1976D2');
        
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        
        let selectedIndex = 0;
        const options = dialog.querySelectorAll('.quality-option');
        options[0].classList.add('selected');
        
        options.forEach(option => {
            option.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                selectedIndex = parseInt(option.dataset.index);
            });
        });
        
        const cleanup = () => {
            document.body.removeChild(overlay);
            document.body.removeChild(dialog);
        };
        
        dialog.querySelector('.cancel-btn').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });
        
        dialog.querySelector('.select-btn').addEventListener('click', () => {
            cleanup();
            resolve(sortedQualities[selectedIndex]);
        });
        
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cleanup();
                resolve(null);
            }
        });
    });
}

/**
 * Toggle theme between light and dark
 */
export async function toggleTheme() {
    // Get current theme from ThemeService
    const currentTheme = getTheme();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    // Set the new theme
    await setTheme(newTheme);
    
    return newTheme;
}

/**
 * Clear all caches and request a fresh data fetch
 */
export async function clearAllCaches() {
    // Use VideoStateService to clear caches
    await clearCaches();
    
    // Show toast notification
    showToast('Caches cleared, reloading data...');
    
    return true;
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {number} duration - Duration in ms
 */
export function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('visible');
    }, 100);
    
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, duration);
}

/**
 * Update cache statistics display
 * @param {HTMLElement} statsElement - The element to update
 */
async function updateCacheStats(statsElement) {
    if (!statsElement) return;
    
    try {
        const stats = await getPreviewCacheStats();
        if (!stats) {
            statsElement.textContent = 'No cache stats available';
            return;
        }
        
        const count = stats.count || 0;
        const sizeInKB = Math.round((stats.size || 0) / 1024);
        
        statsElement.textContent = `${count} previews (${sizeInKB} KB)`;
    } catch (error) {
        console.error('Error getting cache stats:', error);
        statsElement.textContent = 'Cache stats unavailable';
    }
}