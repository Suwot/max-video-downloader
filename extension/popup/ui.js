/**
 * - Controls main UI elements and interactions
 * - Manages loading states and error messages
 * - Implements theme switching functionality
 * - Provides dialogs and notifications
 * - Manages responsive UI adjustments
 * - Manages tab navigation and content switching
 */

import { sendPortMessage } from './communication.js';
import { switchTab } from './ui-utils.js'

const logger = console; // Using console directly for UI logging

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

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
        } catch (error) {
            logger.error('Error clearing cache:', error);
            cacheStats.textContent = 'Failed to clear cache';
        } finally {
            button.disabled = false;
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
 * Initialize the UI - coordinates all UI element creation and setup
 */
export async function initializeUI() {
    const header = document.querySelector('header');
    const videosContainer = document.getElementById('videos-list');
    const tabNavigation = document.querySelector('.tab-navigation');
    const tabContents = document.querySelector('.tab-contents');

    // Create UI elements for header
    const clearCacheButton = createClearCacheButton();
    
    // Assemble header structure
    header.querySelector('.left-buttons-container').append(clearCacheButton);
    
    // Attach click handlers to existing tab buttons
    tabNavigation.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tabId));
    });

    // Initialize collapsible sections
    await initializeCollapsibleSections();
    
    return {
        container: videosContainer,
        clearCacheButton,
        tabContents,
        switchTab
    };
}

/**
 * Initialize collapsible sections throughout the UI
 * Finds all .section-header.collapsible elements and adds toggle functionality
 * Handles state restoration for downloads sections (global) differently from video sections (tab-specific)
 */
export async function initializeCollapsibleSections() {
    const headers = document.querySelectorAll('.section-header.collapsible');
    
    for (const header of headers) {
        // Skip if already initialized (has toggle icon)
        if (header.querySelector('.toggle-icon')) {
            continue;
        }
        
        // Add toggle icon using innerHTML for efficiency
        const toggleIcon = document.createElement('div');
        toggleIcon.className = 'toggle-icon';
        toggleIcon.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1.70833 3.125C1.31771 2.73438 0.683333 2.73438 0.292708 3.125C-0.0979167 3.51562 -0.0979167 4.15 0.292708 4.54062L4.29271 8.54062C4.68333 8.93125 5.31771 8.93125 5.70833 8.54062L9.70833 4.54062C10.099 4.15 10.099 3.51562 9.70833 3.125C9.31771 2.73438 8.68333 2.73438 8.29271 3.125L5 6.41875L1.70833 3.125Z"/>
            </svg>
        `;
        
        // Insert toggle icon at the end of header
        header.appendChild(toggleIcon);
        
        // Determine section type and restore state
        const section = header.closest('.active-downloads-section, .downloads-history-section');
        const content = header.nextElementSibling;
        
        if (section && content?.classList.contains('section-content')) {
            // Downloads sections - restore global state
            let sectionKey = null;
            if (section.classList.contains('active-downloads-section')) {
                sectionKey = 'active';
            } else if (section.classList.contains('downloads-history-section')) {
                sectionKey = 'history';
            }
            
            if (sectionKey) {
                // Simple toggle without persistence - sections start expanded
                header.addEventListener('click', () => {
                    content.classList.toggle('collapsed');
                    toggleIcon.classList.toggle('rotated');
                });
            }
        } else if (content?.classList.contains('section-content')) {
            // Video sections - basic toggle (state managed elsewhere by video rendering logic)
            header.addEventListener('click', () => {
                content.classList.toggle('collapsed');
                toggleIcon.classList.toggle('rotated');
            });
        }
    }
}