/**
 * VideoDownloadButtonComponent - Class-based download button with centralized state
 * Handles download initiation, progress updates, and multi-audio extraction
 */

import { createLogger } from '../../shared/utils/logger.js';
import { sendPortMessage } from '../communication.js';

const logger = createLogger('VideoDownloadButtonComponent');

// Button state constants
const BUTTON_STATES = {
    DEFAULT: 'default',
    STARTING: 'starting', 
    DOWNLOADING: 'downloading',
    QUEUED: 'queued',
    ERROR: 'error',
    SUCCESS: 'success',
    CANCELED: 'canceled'
};

// Original download button HTML template
const DOWNLOAD_BUTTON_ORIGINAL_HTML = `<span class="download-btn-icon">
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g clip-path="url(#clip0_43_340)">
            <path d="M5.0625 0.5625C5.0625 0.251367 4.81113 0 4.5 0C4.18887 0 3.9375 0.251367 3.9375 0.5625V4.82871L2.64727 3.53848C2.42754 3.31875 2.0707 3.31875 1.85098 3.53848C1.63125 3.7582 1.63125 4.11504 1.85098 4.33477L4.10098 6.58477C4.3207 6.80449 4.67754 6.80449 4.89727 6.58477L7.14727 4.33477C7.36699 4.11504 7.36699 3.7582 7.14727 3.53848C6.92754 3.31875 6.5707 3.31875 6.35098 3.53848L5.0625 4.82871V0.5625ZM1.125 6.1875C0.504492 6.1875 0 6.69199 0 7.3125V7.875C0 8.49551 0.504492 9 1.125 9H7.875C8.49551 9 9 8.49551 9 7.875V7.3125C9 6.69199 8.49551 6.1875 7.875 6.1875H6.09082L5.29453 6.98379C4.85508 7.42324 4.14316 7.42324 3.70371 6.98379L2.90918 6.1875H1.125ZM7.59375 7.17188C7.70564 7.17188 7.81294 7.21632 7.89206 7.29544C7.97118 7.37456 8.01562 7.48186 8.01562 7.59375C8.01562 7.70564 7.97118 7.81294 7.89206 7.89206C7.81294 7.97118 7.70564 8.01562 7.59375 8.01562C7.48186 8.01562 7.37456 7.97118 7.29544 7.89206C7.21632 7.81294 7.17188 7.70564 7.17188 7.59375C7.17188 7.48186 7.21632 7.37456 7.29544 7.29544C7.37456 7.21632 7.48186 7.17188 7.59375 7.17188Z" fill="#FAFAFA"/>
        </g>
        <defs>
            <clipPath id="clip0_43_340">
                <path d="M0 0H9V9H0V0Z" fill="white"/>
            </clipPath>
        </defs>
    </svg>
</span><span>Download</span>`;

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
        // Create and preserve the original download handler
        this.originalHandler = async () => {
            const cancelHandler = () => this.sendCancelMessage();
            this.updateState(BUTTON_STATES.STARTING, {
                text: 'Starting...',
                handler: cancelHandler
            });
            
            this.videoItemComponent.executeDownload('download');
        };
        
        // Set the original handler as the default click handler
        this.downloadBtn.onclick = this.originalHandler;
    }
    
    /**
     * Handle menu button click
     * @param {Event} e - Click event
     */
    handleMenuClick(e) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleMenuDropdown();
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

        // Auto-restore if requested
        if (options.autoRestore) {
            this.restoreTimer = setTimeout(() => {
                this.updateState(BUTTON_STATES.DEFAULT);
            }, options.autoRestoreDelay || 2000);
        }
    }
    
    /**
     * Set intermediary text without changing state
     * @param {string} text - Text to display
     */
    setIntermediaryText(text) {
        this.downloadBtn.innerHTML = text;
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
        if (this.hasAudio()) {
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

        if (this.hasSubs()) {
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
                this.hideMenuDropdown();
            });

            menuDropdown.appendChild(menuItem);
        });

        return menuDropdown;
    }
    
    /**
     * Check if video has audio track(s)
     * @returns {boolean}
     */
    hasAudio() {
        const videoData = this.videoItemComponent.videoData;
        const type = videoData.type;
        
        if (type === 'hls') {
            if (videoData.isMaster) {
                return videoData.audioTracks?.length > 0 || videoData.videoTracks?.[0]?.metaJS?.hasAudioCodec;
            } else {
                return true; // assume audio exists in a variant
            }
        } else if (type === 'direct') {
            return videoData.metaFFprobe?.hasAudio === true;
        } else if (type === 'dash') {
            return videoData.audioTracks?.length > 0;
        }
        return false;
    }
    
    /**
     * Check if video has subtitles
     * @returns {boolean}
     */
    hasSubs() {
        const videoData = this.videoItemComponent.videoData;
        const type = videoData.type;
        
        if (type === 'hls' || type === 'dash') {
            return videoData.subtitleTracks?.length > 0;
        }
        if (type === 'direct') {
            return videoData.metaFFprobe?.hasSubs === true;
        }
        return false;
    }
    
    /**
     * Handle menu item clicks
     * @param {string} action - Action identifier
     */
    async handleMenuItemClick(action) {
        logger.debug('Menu item clicked:', action);
        
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
                logger.debug('Unknown action:', action);
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
        
        this.videoItemComponent.executeDownload('extract-audio');
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
        
        this.videoItemComponent.executeDownload('extract-subs');
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
                logger.debug('URL copied to clipboard:', urlToCopy);
                
                // Show temporary feedback
                this.setIntermediaryText('Copied!');
                setTimeout(() => {
                    this.updateState(BUTTON_STATES.DEFAULT);
                }, 1500);
            } catch (error) {
                logger.error('Failed to copy URL:', error);
                this.updateState(BUTTON_STATES.DEFAULT);
            }
        }
    }
    
    /**
     * Handle Download As functionality
     */
    async handleDownloadAs() {
        this.setIntermediaryText('Choosing...');
        const cancelHandler = () => this.sendCancelMessage();
        this.updateState(BUTTON_STATES.STARTING, {
            text: 'Starting...',
            handler: cancelHandler
        });
        
        this.videoItemComponent.executeDownload('download-as');
    }
    
    /**
     * Send cancel message for download
     */
    sendCancelMessage() {
        const downloadData = this.videoItemComponent.getDownloadData();
        const cancelMessage = {
            command: 'cancel-download',
            downloadId: this.videoItemComponent.getDownloadIdForCancellation(),
            type: downloadData.type,
            downloadUrl: downloadData.downloadUrl,
            masterUrl: downloadData.masterUrl || null,
            selectedOptionOrigText: this.getSelectedOptionText()
        };
        
        sendPortMessage(cancelMessage);
    }
    
    /**
     * Toggle menu dropdown visibility
     */
    toggleMenuDropdown() {
        const isVisible = this.menuDropdown.classList.contains('show');
        
        if (isVisible) {
            this.hideMenuDropdown();
        } else {
            this.showMenuDropdown();
        }
    }
    
    /**
     * Show menu dropdown
     */
    showMenuDropdown() {
        // Hide other dropdowns
        document.querySelectorAll('.download-menu-dropdown.show').forEach(dropdown => {
            if (dropdown !== this.menuDropdown) {
                dropdown.classList.remove('show');
            }
        });

        this.menuDropdown.classList.add('show');
        
        // Setup click outside handler
        setTimeout(() => {
            document.addEventListener('click', this.handleClickOutside, { once: true });
        }, 0);
    }
    
    /**
     * Hide menu dropdown
     */
    hideMenuDropdown() {
        this.menuDropdown.classList.remove('show');
    }
    
    /**
     * Handle clicks outside dropdown
     * @param {Event} e - Click event
     */
    handleClickOutside(e) {
        if (!this.menuDropdown.contains(e.target)) {
            this.hideMenuDropdown();
        } else {
            // Re-add listener if clicked inside
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
    }
    
    /**
     * Update video data (for dynamic updates)
     * @param {Object} newVideoData - Updated video data
     */
    updateVideoData(newVideoData) {
        // Update reference in video item component
        this.videoItemComponent.updateVideoData(newVideoData);
    }
    
    /**
     * Cleanup component resources
     */
    cleanup() {
        if (this.restoreTimer) {
            clearTimeout(this.restoreTimer);
            this.restoreTimer = null;
        }
        
        if (this.buttonWrapper) {
            this.buttonWrapper._component = null;
        }
    }
}