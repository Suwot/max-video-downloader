/**
 * VideoDownloadButtonComponent - Class-based download button with centralized state
 * Handles download initiation, progress updates, and multi-audio extraction
 */

import { sendPortMessage } from '../communication.js';

// Button state constants
const BUTTON_STATES = {
    DEFAULT: 'default',
    STARTING: 'starting', 
    DOWNLOADING: 'downloading',
    QUEUED: 'queued',
    STOPPING: 'stopping',
    ERROR: 'error',
    SUCCESS: 'success',
    CANCELED: 'canceled'
};

// Original download button HTML template
const DOWNLOAD_BUTTON_ORIGINAL_HTML = `<span>Download</span>`;

/**
 * VideoDownloadButtonComponent - Manages download button state and actions
 */
export class VideoDownloadButtonComponent {
    constructor(videoItemComponent, elementsDiv) {
        this.videoItemComponent = videoItemComponent;
        this.elementsDiv = elementsDiv;
        this.buttonWrapper = null;
        this.downloadBtn = null;
        this.menuBtn = null;
        this.menuDropdown = null;
        
        // State management
        this.currentState = BUTTON_STATES.DEFAULT;
        this.restoreTimer = null;
        this.originalHandler = null; // Will be set in setupEventHandlers
        
        // Bind methods to preserve context
        this.handleMenuClick = this.handleMenuClick.bind(this);
        this.handleClickOutside = this.handleClickOutside.bind(this);
    }
    
    /**
     * Render the complete button UI
     * @returns {Array} - [downloadBtn, menuBtn, buttonWrapper]
     */
    render() {
        // Create button wrapper
        this.buttonWrapper = document.createElement('div');
        this.buttonWrapper.className = 'download-btn-wrapper btn-default';
        
        // Create main download button
        this.downloadBtn = document.createElement('button');
        this.downloadBtn.className = 'download-btn';
        this.downloadBtn.innerHTML = DOWNLOAD_BUTTON_ORIGINAL_HTML;
        
        // Create menu button
        this.menuBtn = document.createElement('button');
        this.menuBtn.className = 'download-menu-btn';
        this.menuBtn.title = 'More options';
        this.menuBtn.innerHTML = `
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="5" cy="5" r="1" fill="#FAFAFA"/>
                <circle cx="5" cy="8" r="1" fill="#FAFAFA"/>
                <circle cx="5" cy="11" r="1" fill="#FAFAFA"/>
            </svg>
        `;
        this.menuBtn.addEventListener('click', this.handleMenuClick);
        
        // Create dropdown menu
        this.menuDropdown = this.createMenuDropdown();
        
        // Assemble UI
        this.buttonWrapper.appendChild(this.downloadBtn);
        this.buttonWrapper.appendChild(this.menuBtn);
        this.buttonWrapper.appendChild(this.menuDropdown);
        this.elementsDiv.appendChild(this.buttonWrapper);
        
        // Store component reference on wrapper for external access
        this.buttonWrapper._component = this;
        
        // Setup event handlers after DOM is ready
        this.setupEventHandlers();
        
        return [this.downloadBtn, this.menuBtn, this.buttonWrapper];
    }
    
    /**
     * Setup event handlers with preserved original handler (like old system)
     */
    setupEventHandlers() {
        // Detect if this is an audio-only advanced scenario
        const hasVideoTracks = (this.videoItemComponent.videoData.videoTracks?.length || 0) > 0;
        const hasAudioTracks = (this.videoItemComponent.videoData.audioTracks?.length || 0) > 0;
        const isAdvancedMode = this.videoItemComponent.dropdown?.isAdvancedMode;
        
        // If advanced mode but no video tracks, wire to audio extraction
        if (isAdvancedMode && !hasVideoTracks && hasAudioTracks) {
            this.originalHandler = async () => {
                const cancelHandler = () => this.sendCancelMessage();
                this.updateState(BUTTON_STATES.STARTING, {
                    text: 'Extracting...',
                    handler: cancelHandler
                });
                
                await this.videoItemComponent.executeDownload('extract-audio');
            };
        } else {
            // Standard video download handler
            this.originalHandler = async () => {
                const cancelHandler = () => this.sendCancelMessage();
                this.updateState(BUTTON_STATES.STARTING, {
                    text: 'Starting...',
                    handler: cancelHandler
                });
                
                await this.videoItemComponent.executeDownload('download');
            };
        }
        
        // Set the determined handler as the default click handler
        this.downloadBtn.onclick = this.originalHandler;
    }
    
    /**
     * Handle menu button click
     * @param {Event} e - Click event
     */
    handleMenuClick(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Toggle menu state
        const isVisible = this.menuBtn.classList.contains('open');
        
        if (isVisible) {
            this.menuBtn.classList.remove('open');
        } else {
            // Close all other dropdowns and button menus (mutually exclusive)
            document.querySelectorAll('.custom-dropdown.open, .download-menu-btn.open').forEach(menu => {
                if (menu !== this.menuBtn) {
                    menu.classList.remove('open');
                }
            });
            
            this.menuBtn.classList.add('open');
            
            // Setup click outside handler
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
        
        // Update body expanded state - check for any open menu
        const anyMenuOpen = document.querySelector('.custom-dropdown.open, .download-menu-btn.open') !== null;
        document.body.classList.toggle('expanded', anyMenuOpen);
    }
    
    /**
     * Get selected option text for UI restoration
     * @returns {string} Selected option text
     */
    getSelectedOptionText() {
        const selectedDisplay = this.elementsDiv.querySelector('.selected-option .label');
        return selectedDisplay?.textContent || '';
    }
    
    /**
     * Unified state update method
     * @param {string} state - Button state
     * @param {Object} options - State options
     */
    updateState(state, options = {}) {
        // Clear restore timer
        if (this.restoreTimer) {
            clearTimeout(this.restoreTimer);
            this.restoreTimer = null;
        }

        // Update state and classes
        this.currentState = state;
        this.buttonWrapper.className = `download-btn-wrapper btn-${state}`;
        
        // Update button content and handler (same as old system)
        switch (state) {
            case BUTTON_STATES.DEFAULT:
                this.downloadBtn.innerHTML = DOWNLOAD_BUTTON_ORIGINAL_HTML;
                this.downloadBtn.onclick = this.originalHandler;
                break;
                
            case BUTTON_STATES.STARTING:
                this.downloadBtn.innerHTML = options.text || 'Starting...';
                this.downloadBtn.onclick = options.handler || null;
                break;
                
            case BUTTON_STATES.DOWNLOADING:
                this.downloadBtn.innerHTML = options.text || 'Stop';
                this.downloadBtn.onclick = options.handler || null;
                break;
                
            case BUTTON_STATES.QUEUED:
                this.downloadBtn.innerHTML = options.text || 'Cancel';
                this.downloadBtn.onclick = options.handler || null;
                break;
                
            case BUTTON_STATES.STOPPING:
                this.downloadBtn.innerHTML = options.text || 'Stopping...';
                this.downloadBtn.onclick = null; // Disable clicks during stopping
                break;
                
            case BUTTON_STATES.ERROR:
                this.downloadBtn.innerHTML = options.text || 'Error';
                this.downloadBtn.onclick = this.originalHandler;
                break;
                
            case BUTTON_STATES.SUCCESS:
                this.downloadBtn.innerHTML = options.text || 'Completed!';
                this.downloadBtn.onclick = this.originalHandler;
                break;
                
            case BUTTON_STATES.CANCELED:
                this.downloadBtn.innerHTML = options.text || 'Canceled';
                this.downloadBtn.onclick = this.originalHandler;
                break;
        }
    }
    
    /**
     * Create dropdown menu for additional options
     * @returns {HTMLElement} - Dropdown element
     */
    createMenuDropdown() {
        const menuDropdown = document.createElement('div');
        menuDropdown.className = 'download-menu-dropdown';

        const menuItems = [];

        // Conditionally add menu items
        if (this.videoItemComponent.hasAudio) {
            menuItems.push({
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-audio-lines w-3 h-3" aria-hidden="true">
                    <path d="M2 10v3"></path>
                    <path d="M6 6v11"></path>
                    <path d="M10 3v18"></path>
                    <path d="M14 8v7"></path>
                    <path d="M18 5v13"></path>
                    <path d="M22 10v3"></path>
                </svg>`,
                text: 'Extract Audio',
                action: 'extract-audio'
            });
        }

        if (this.videoItemComponent.hasSubtitles) {
            menuItems.push({
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-captions w-3 h-3" aria-hidden="true">
                    <rect width="18" height="14" x="3" y="5" rx="2" ry="2"></rect>
                    <path d="M7 15h4M15 15h2M7 11h2M13 11h4"></path>
                </svg>`,
                text: 'Extract Subs',
                action: 'extract-subs'
            });
        }

        menuItems.push(
            {
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-down w-3 h-3" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14,2 14,8 20,8"></polyline>
                    <path d="M12 18v-6"></path>
                    <path d="M9 15l3 3 3-3"></path>
                </svg>`,
                text: 'Download As',
                action: 'download-as'
            },
            {
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy w-3 h-3" aria-hidden="true">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
                </svg>`,
                text: 'Copy URL',
                action: 'copy-url'
            }
        );

        menuItems.forEach(item => {
            const menuItem = document.createElement('button');
            menuItem.className = 'download-menu-item';
            menuItem.innerHTML = `${item.icon}<span>${item.text}</span>`;
            menuItem.dataset.action = item.action;

            menuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleMenuItemClick(item.action);
                
                // Close menu after selection
                this.menuBtn.classList.remove('open');
                
                // Update body expanded state
                const anyMenuOpen = document.querySelector('.custom-dropdown.open, .download-menu-btn.open') !== null;
                document.body.classList.toggle('expanded', anyMenuOpen);
            });

            menuDropdown.appendChild(menuItem);
        });

        return menuDropdown;
    }

    /**
     * Handle menu item clicks
     * @param {string} action - Action identifier
     */
    async handleMenuItemClick(action) {
        console.debug('Menu item clicked:', action);
        
        switch (action) {
            case 'extract-audio':
                await this.handleExtractAudio();
                break;
            case 'extract-subs':
                await this.handleExtractSubs();
                break;
            case 'download-as':
                await this.handleDownloadAs();
                break;
            case 'copy-url':
                await this.handleCopyUrl();
                break;
            default:
                console.debug('Unknown action:', action);
        }
    }
    
    /**
     * Handle audio extraction with multi-track support
     */
    async handleExtractAudio() {
        const cancelHandler = () => this.sendCancelMessage();
        this.updateState(BUTTON_STATES.STARTING, {
            text: 'Extracting...',
            handler: cancelHandler
        });
        
        await this.videoItemComponent.executeDownload('extract-audio');
    }

    /**
     * Handle subtitle extraction with multi-track support
     */
    async handleExtractSubs() {
        const cancelHandler = () => this.sendCancelMessage();
        this.updateState(BUTTON_STATES.STARTING, {
            text: 'Extracting...',
            handler: cancelHandler
        });
        
        await this.videoItemComponent.executeDownload('extract-subs');
    }
    
    /**
     * Handle URL copying
     */
    async handleCopyUrl() {
        const downloadData = this.videoItemComponent.getDownloadData();
        const urlToCopy = downloadData.downloadUrl;
        
        if (urlToCopy) {
            try {
                await navigator.clipboard.writeText(urlToCopy);
                console.debug('URL copied to clipboard:', urlToCopy);
                
                // Show temporary feedback
                this.downloadBtn.innerHTML= 'Copied!';
                setTimeout(() => {
                    this.updateState(BUTTON_STATES.DEFAULT);
                }, 1000);
            } catch (error) {
                console.error('Failed to copy URL:', error);
                this.updateState(BUTTON_STATES.DEFAULT);
            }
        }
    }
    
    /**
     * Handle Download As functionality
     */
    async handleDownloadAs() {
        this.downloadBtn.innerHTML = 'Choosing...';
        const cancelHandler = () => this.sendCancelMessage();
        this.updateState(BUTTON_STATES.STARTING, {
            text: 'Starting...',
            handler: cancelHandler
        });
        
        await this.videoItemComponent.executeDownload('download-as');
    }
    
    /**
     * Send cancel message for download
     */
    sendCancelMessage() {
        const cancelMessage = {
            command: 'cancel-download',
            downloadId: this.videoItemComponent.getDownloadIdForCancellation()
        };
        
        sendPortMessage(cancelMessage);
    }
    
    /**
     * Handle clicks outside dropdown
     * @param {Event} e - Click event
     */
    handleClickOutside(e) {
        if (!this.menuDropdown.contains(e.target)) {
            this.menuBtn.classList.remove('open');
            
            // Update body expanded state - check for any remaining open menu
            const anyMenuOpen = document.querySelector('.custom-dropdown.open, .download-menu-btn.open') !== null;
            document.body.classList.toggle('expanded', anyMenuOpen);
        } else {
            // Re-add listener if clicked inside
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
    }
}