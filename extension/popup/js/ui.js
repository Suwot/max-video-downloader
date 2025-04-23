import { debounce } from './utilities.js';
import { getCurrentTheme, setCurrentTheme, getAllGroupStates } from './state.js';
import { updateVideoList } from './video-fetcher.js';

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

/**
 * Apply theme to UI
 * @param {string} theme - Theme to apply ('dark' or 'light')
 */
export function applyTheme(theme) {
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(`theme-${theme}`);
    setCurrentTheme(theme);
    
    // Update theme toggle button icon
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) {
        themeToggle.innerHTML = theme === 'dark' 
            ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    }
}

/**
 * Initialize the UI
 * @returns {Object} UI elements and functions
 */
export function initializeUI() {
    const container = document.getElementById('videos');
    const refreshContainer = document.createElement('div');
    refreshContainer.className = 'refresh-container';
    
    // Create refresh button
    const refreshButton = document.createElement('button');
    refreshButton.className = 'refresh-button';
    refreshButton.id = 'refresh-button';
    refreshButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
        </svg>
        Refresh
    `;
    
    const debouncedUpdate = debounce(async () => {
        refreshButton.classList.add('loading');
        refreshButton.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            Refreshing...
        `;
        await updateVideoList(true);
        refreshButton.classList.remove('loading');
        refreshButton.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            Refresh
        `;
    }, 300);
    
    refreshButton.addEventListener('click', debouncedUpdate);
    
    // Add direct event listener for UI feedback
    refreshButton.addEventListener('click', async function() {
        const button = this;
        const originalText = button.textContent;
        
        // Update button text and add loading class
        button.textContent = 'Refreshing...';
        button.classList.add('loading');
        button.disabled = true;
        
        try {
            await updateVideoList(true);
        } catch (error) {
            console.error('Error refreshing videos:', error);
        } finally {
            // Restore button text and remove loading class
            button.textContent = originalText;
            button.classList.remove('loading');
            button.disabled = false;
        }
    });
    
    // Create theme toggle button
    const themeToggle = document.createElement('button');
    themeToggle.className = 'theme-toggle';
    themeToggle.innerHTML = getCurrentTheme() === 'dark'
        ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    
    themeToggle.addEventListener('click', () => {
        const newTheme = getCurrentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
    });
    
    refreshContainer.append(refreshButton, themeToggle);
    container.parentElement.insertBefore(refreshContainer, container);
    
    // Save scroll position on scroll
    container.addEventListener('scroll', function() {
        setScrollPosition(this.scrollTop);
    });
    
    return {
        container,
        refreshButton,
        themeToggle,
        refreshContainer
    };
}

/**
 * Restore scroll position with a slight delay
 * @param {HTMLElement} container - Scroll container
 * @param {number} scrollPosition - Position to scroll to
 */
export function restoreScrollPosition(container, scrollPosition) {
    setTimeout(() => {
        if (container.scrollHeight > container.clientHeight) {
            container.scrollTop = scrollPosition;
        }
    }, 50);
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
 * Save scroll position before closing
 */
export function setupScrollPersistence() {
    window.addEventListener('beforeunload', function() {
        const scrollPosition = document.getElementById('videos').scrollTop;
        localStorage.setItem('popupScrollPosition', scrollPosition.toString());
    });
}

/**
 * Scroll to last saved position
 */
export function scrollToLastPosition() {
    const scrollPosition = parseInt(localStorage.getItem('popupScrollPosition') || '0');
    if (scrollPosition > 0) {
        // Add a small delay to ensure content is rendered
        setTimeout(() => {
            document.getElementById('videos').scrollTop = scrollPosition;
        }, 50);
    }
}

/**
 * Save scroll position
 * @param {number} position - Position to save
 */
export function setScrollPosition(position) {
    if (typeof position !== 'number') return;
    try {
        localStorage.setItem('popupScrollPosition', position.toString());
    } catch (error) {
        console.error('Error saving scroll position:', error);
    }
}

/**
 * Show a notification to the user
 * @param {Object} options - Notification options
 * @param {string} options.type - Notification type ('info', 'warning', 'error', 'success')
 * @param {string} options.title - Notification title
 * @param {string} options.message - Notification message
 * @param {number} options.duration - Time in ms to display the notification (0 for no auto-hide)
 * @param {Array} options.actions - Optional array of action buttons
 * @returns {HTMLElement} The notification element
 */
export function showNotification(options) {
    const { type = 'info', title, message, duration = 5000, actions = [] } = options;
    
    // Create notification container if it doesn't exist
    let notificationsContainer = document.querySelector('.notifications-container');
    if (!notificationsContainer) {
        notificationsContainer = document.createElement('div');
        notificationsContainer.className = 'notifications-container';
        document.body.appendChild(notificationsContainer);
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    // Get icon based on type
    const iconMap = {
        info: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1zm1-8h-2V7h2v2z"/></svg>',
        warning: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1zm1-8h-2V7h2v2z"/></svg>',
        error: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.59-13L12 10.59 8.41 7 7 8.41 10.59 12 7 15.59 8.41 17 12 13.41 15.59 17 17 15.59 13.41 12 17 8.41z"/></svg>',
        success: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm4.59-12.42L10 14.17l-2.59-2.58L6 13l4 4 8-8-1.41-1.42z"/></svg>'
    };
    
    // Create notification content
    notification.innerHTML = `
        <div class="notification-icon">${iconMap[type] || iconMap.info}</div>
        <div class="notification-content">
            ${title ? `<div class="notification-title">${title}</div>` : ''}
            ${message ? `<div class="notification-message">${message}</div>` : ''}
        </div>
        <button class="notification-close">&times;</button>
    `;
    
    // Add action buttons if provided
    if (actions.length > 0) {
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'notification-actions';
        
        actions.forEach(action => {
            const button = document.createElement('button');
            button.className = 'notification-action-button';
            button.textContent = action.label;
            button.addEventListener('click', () => {
                if (typeof action.callback === 'function') {
                    action.callback();
                }
                // Close notification after action unless specified otherwise
                if (action.keepOpen !== true) {
                    notification.remove();
                }
            });
            actionsContainer.appendChild(button);
        });
        
        notification.querySelector('.notification-content').appendChild(actionsContainer);
    }
    
    // Add close button functionality
    notification.querySelector('.notification-close').addEventListener('click', () => {
        notification.classList.add('notification-hiding');
        setTimeout(() => notification.remove(), 300);
    });
    
    // Add notification to container
    notificationsContainer.appendChild(notification);
    
    // Add show class after a small delay to trigger transition
    setTimeout(() => notification.classList.add('notification-visible'), 10);
    
    // Auto-hide after duration (if duration is not 0)
    if (duration > 0) {
        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('notification-hiding');
                setTimeout(() => notification.remove(), 300);
            }
        }, duration);
    }
    
    return notification;
} 