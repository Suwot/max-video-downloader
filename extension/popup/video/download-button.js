/**
 * Optimized Download Button Component
 * Self-contained component with direct element references and lazy data extraction
 */

import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('Download Button Component');

// Button state constants for unified management
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
 * Optimized Download Button Component
 * Self-contained component with direct element references and lazy data extraction
 */
class DownloadButtonComponent {
    constructor(video, elementsDiv) {
        // Cache all DOM references
        this.video = video;
        this.elementsDiv = elementsDiv;
        this.buttonWrapper = null;
        this.downloadBtn = null;
        this.menuBtn = null;
        this.menuDropdown = null;
        
        // State management
        this.currentState = BUTTON_STATES.DEFAULT;
        this.restoreTimer = null;
        this.originalHandler = null;
        
        // Pre-bind data extraction context
        this.dataExtractors = {
            hls: (videoData, selectedOption) => this.extractHlsData(videoData, selectedOption),
            dash: (videoData, selectedOption) => this.extractDashData(videoData, selectedOption),
            direct: (videoData, selectedOption) => this.extractDirectData(videoData, selectedOption)
        };
    }

    /**
     * Create and render the complete button UI
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
        
        // Create dropdown menu
        this.menuDropdown = this.createMenuDropdown();
        
        // Assemble UI
        this.buttonWrapper.appendChild(this.downloadBtn);
        this.buttonWrapper.appendChild(this.menuBtn);
        this.buttonWrapper.appendChild(this.menuDropdown);
        this.elementsDiv.appendChild(this.buttonWrapper);
        
        // Store component reference on wrapper for external access
        this.buttonWrapper._component = this;
        
        // Skip setup for blob videos
        if (this.video.type === 'blob') {
            return [this.downloadBtn, this.menuBtn, this.buttonWrapper];
        }
        
        // Setup event handlers
        this.setupEventHandlers();
        
        return [this.downloadBtn, this.menuBtn, this.buttonWrapper];
    }

    /**
     * Setup all event handlers with direct references
     */
    setupEventHandlers() {
        // Setup download handler
        this.originalHandler = async () => {
            const videoData = this.createVideoMetadata();
            this.extractDownloadData(videoData);
            
            const cancelHandler = () => this.sendCancelMessage(videoData);
            this.updateState(BUTTON_STATES.STARTING, {
                text: 'Starting...',
                handler: cancelHandler
            });
            
            // Import and call download handler
            const { handleDownload } = await import('./download-handler.js');
            handleDownload(this.elementsDiv, videoData);
        };
        
        this.downloadBtn.onclick = this.originalHandler;
        
        // Setup menu button handler
        this.menuBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMenuDropdown();
        });
    }

    /**
     * Unified state update method - replaces all external state functions
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
        
        // Update button content and handler
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
     * Create video metadata for download
     * @returns {Object} - Video metadata
     */
    createVideoMetadata() {
        let defaultContainer = this.video.defaultContainer || null;
        
        if (this.video.type === 'hls' && !defaultContainer) {
            defaultContainer = 'mp4';
        }
        
        return {
            filename: this.video.title,
            type: this.video.type,
            defaultContainer: defaultContainer,
            segmentCount: this.video.type === 'hls' ? this.video.variants?.[0].metaJS?.segmentCount : null,
            duration: this.video.duration || null,
            masterUrl: this.video.isMaster ? this.video.url : null,
            pageUrl: this.video.pageUrl || null,
            pageFavicon: this.video.pageFavicon || null,
        };
    }

    /**
     * Extract download data based on user selection (lazy evaluation)
     * @param {Object} videoData - Video metadata to populate
     */
    extractDownloadData(videoData) {
        const selectedOption = this.elementsDiv.querySelector('.selected-option');
        const extractor = this.dataExtractors[videoData.type] || this.dataExtractors.direct;
        extractor(videoData, selectedOption);
        
        // Extract audio codec info for smart format selection (if available)
        if (this.video.metaFFprobe?.audioCodec) {
            videoData.sourceAudioCodec = this.video.metaFFprobe.audioCodec.name || null;
            videoData.sourceAudioBitrate = this.video.metaFFprobe.audioBitrate || null;
            logger.debug('Extracted audio codec info:', { 
                codec: videoData.sourceAudioCodec, 
                bitrate: videoData.sourceAudioBitrate 
            });
        } else {
            logger.debug('No audio codec info available for this video type');
        }
    }

    /**
     * Extract HLS-specific data
     */
    extractHlsData(videoData, selectedOption) {
        videoData.downloadUrl = selectedOption?.dataset.url;
        videoData.fileSizeBytes = selectedOption?.dataset.filesize || null;
    }

    /**
     * Extract DASH-specific data
     */
    extractDashData(videoData, selectedOption) {
        videoData.downloadUrl = selectedOption?.dataset.url;
        videoData.streamSelection = selectedOption?.dataset.trackMap || null;
        videoData.defaultContainer = selectedOption?.dataset.defaultContainer || null;
        videoData.fileSizeBytes = selectedOption?.dataset.totalfilesize || null;
    }

    /**
     * Extract direct video data
     */
    extractDirectData(videoData, selectedOption) {
        videoData.downloadUrl = selectedOption?.dataset.url;
        videoData.fileSizeBytes = selectedOption?.dataset.filesize || null;
    }

    /**
     * Send cancel message for download
     * @param {Object} videoData - Video data with URLs
     */
    sendCancelMessage(videoData) {
        const cancelMessage = {
            command: 'cancel-download',
            type: videoData.type,
            downloadUrl: videoData.downloadUrl,
            masterUrl: videoData.masterUrl || null,
            selectedOptionOrigText: this.elementsDiv.querySelector('.selected-option')?.textContent || ''
        };
        
        import('../communication.js').then(({ sendPortMessage }) => {
            sendPortMessage(cancelMessage);
        });
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
            document.addEventListener('click', (e) => this.handleClickOutside(e), { once: true });
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
                document.addEventListener('click', (e) => this.handleClickOutside(e), { once: true });
            }, 0);
        }
    }

    /**
     * Create dropdown menu for additional options
     * @returns {HTMLElement} - Dropdown element
     */
    createMenuDropdown() {
        const menuDropdown = document.createElement('div');
        menuDropdown.className = 'download-menu-dropdown';
        
        const menuItems = [
            {
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
            },
            {
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-captions w-3 h-3" aria-hidden="true">
                    <rect width="18" height="14" x="3" y="5" rx="2" ry="2"></rect>
                    <path d="M7 15h4M15 15h2M7 11h2M13 11h4"></path>
                </svg>`,
                text: 'Extract Subs',
                action: 'extract-subs'
            },
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
            },
            {
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat w-3 h-3" aria-hidden="true">
                    <path d="M11 19H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h7m0 12l4-4-4-4"></path>
                    <path d="M20 5h-7m7 0l-4 4 4 4"></path>
                </svg>`,
                text: 'Download and Convert',
                action: 'download-convert'
            }
        ];
        
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
                // TODO: Implement subtitle extraction
                break;
            case 'download-as':
                // TODO: Implement format selection
                break;
            case 'copy-url':
                await this.handleCopyUrl();
                break;
            case 'download-convert':
                // TODO: Implement download and convert
                break;
            default:
                logger.debug('Unknown action:', action);
        }
    }

    /**
     * Handle audio extraction
     */
    async handleExtractAudio() {
        const videoData = this.createVideoMetadata();
        this.extractDownloadData(videoData);
        
        // Set audio-only flag
        videoData.audioOnly = true;
        
        if (videoData.type === 'dash') {
            await this.handleDashAudioExtraction(videoData);
        } else {
            // For HLS and direct videos, send single audio extraction command
            await this.sendAudioExtractionCommand(videoData);
        }
    }

    /**
     * Handle DASH audio extraction with multi-track support
     * @param {Object} videoData - Video metadata with streamSelection
     */
    async handleDashAudioExtraction(videoData) {
        const streamSelection = videoData.streamSelection;
        
        if (!streamSelection) {
            logger.debug('No stream selection found for DASH audio extraction');
            await this.sendAudioExtractionCommand(videoData);
            return;
        }
        
        // Parse audio tracks from streamSelection (format: "0:v:11,0:a:0,0:a:1,0:s:0")
        const audioTracks = streamSelection.split(',')
            .filter(track => track.includes(':a:'))
            .map(track => track.trim());
        
        logger.debug('Found audio tracks in DASH:', audioTracks);
        
        if (audioTracks.length === 0) {
            logger.debug('No audio tracks found in selection, sending default audio extraction command for 0:a:0');

            // If no audio tracks, fallback to sending the first audio track as default
            videoData.streamSelection = '0:a:0';
            await this.sendAudioExtractionCommand(videoData);
            return;
        }
        
        if (audioTracks.length === 1) {
            // Single audio track - send as-is but audio-only
            videoData.streamSelection = audioTracks[0];
            await this.sendAudioExtractionCommand(videoData);
        } else {
            // Multiple audio tracks - send separate command for each
            for (let i = 0; i < audioTracks.length; i++) {
                const audioTrackData = { ...videoData };
                audioTrackData.streamSelection = audioTracks[i];
                
                // Add track number to filename for uniqueness
                const originalFilename = audioTrackData.filename || 'audio';
                audioTrackData.filename = `${originalFilename}_audio${i + 1}`;
                
                logger.debug(`Sending audio extraction command ${i + 1}/${audioTracks.length}:`, audioTracks[i]);
                await this.sendAudioExtractionCommand(audioTrackData);
            }
        }
    }

    /**
     * Send audio extraction command
     * @param {Object} videoData - Video metadata with audioOnly flag
     */
    async sendAudioExtractionCommand(videoData) {
        const cancelHandler = () => this.sendCancelMessage(videoData);
        this.updateState(BUTTON_STATES.STARTING, {
            text: 'Extracting...',
            handler: cancelHandler
        });
        
        // Import and call download handler with audio-only data
        const { handleDownload } = await import('./download-handler.js');
        handleDownload(this.elementsDiv, videoData);
    }

    /**
     * Handle URL copying
     */
    async handleCopyUrl() {
        const videoData = this.createVideoMetadata();
        this.extractDownloadData(videoData);
        
        const urlToCopy = this.elementsDiv.querySelector('.selected-option')?.dataset.url;
        
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
            }
        }
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

/**
 * Backward compatibility API for external state management
 * Uses component references for optimized performance
 */

/**
 * Create minimal fallback component for cloned elements
 * @param {HTMLElement} buttonWrapper - Button wrapper element
 * @param {HTMLElement} elementsDiv - Parent container
 * @returns {Object} - Minimal component with updateState method
 */
function createFallbackComponent(buttonWrapper, elementsDiv) {
    const downloadBtn = buttonWrapper.querySelector('.download-btn');
    const menuBtn = buttonWrapper.querySelector('.download-menu-btn');
    
    return {
        buttonWrapper,
        downloadBtn,
        menuBtn,
        elementsDiv,
        currentState: BUTTON_STATES.DEFAULT,
        restoreTimer: null,
        
        updateState(state, options = {}) {
            // Clear restore timer
            if (this.restoreTimer) {
                clearTimeout(this.restoreTimer);
                this.restoreTimer = null;
            }

            // Update state and classes
            this.currentState = state;
            this.buttonWrapper.className = `download-btn-wrapper btn-${state}`;
            
            // Update button content and attach handlers for cancel/stop actions
            switch (state) {
                case BUTTON_STATES.DEFAULT:
                    this.downloadBtn.innerHTML = DOWNLOAD_BUTTON_ORIGINAL_HTML;
                    this.downloadBtn.onclick = null;
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
                    this.downloadBtn.onclick = null;
                    break;
                    
                case BUTTON_STATES.SUCCESS:
                    this.downloadBtn.innerHTML = options.text || 'Completed!';
                    this.downloadBtn.onclick = null;
                    break;
                    
                case BUTTON_STATES.CANCELED:
                    this.downloadBtn.innerHTML = options.text || 'Canceled';
                    this.downloadBtn.onclick = null;
                    break;
            }

            // Auto-restore if requested
            if (options.autoRestore) {
                this.restoreTimer = setTimeout(() => {
                    this.updateState(BUTTON_STATES.DEFAULT);
                }, options.autoRestoreDelay || 2000);
            }
        },
        
        setIntermediaryText(text) {
            this.downloadBtn.innerHTML = text;
        }
    };
}

/**
 * Set button state via component interface
 * @param {HTMLElement} elementsDiv - Parent container
 * @param {string} state - Button state
 * @param {Object} options - State options
 */
export function setButtonState(elementsDiv, state, options = {}) {
    const buttonWrapper = elementsDiv.querySelector('.download-btn-wrapper');
    let component = buttonWrapper?._component;
    
    // Self-healing: create component if missing (for cloned elements)
    if (!component && buttonWrapper) {
        component = createFallbackComponent(buttonWrapper, elementsDiv);
        buttonWrapper._component = component;
    }
    
    if (!component) {
        logger.warn('Button component not found for state change:', state);
        return;
    }
    
    component.updateState(state, options);
}

/**
 * Set intermediary text via component interface
 * @param {HTMLElement} elementsDiv - Parent container
 * @param {string} text - Intermediary text
 */
export function setButtonIntermediaryState(elementsDiv, text) {
    const buttonWrapper = elementsDiv.querySelector('.download-btn-wrapper');
    let component = buttonWrapper?._component;
    
    // Self-healing: create component if missing (for cloned elements)
    if (!component && buttonWrapper) {
        component = createFallbackComponent(buttonWrapper, elementsDiv);
        buttonWrapper._component = component;
    }
    
    if (component) {
        component.setIntermediaryText(text);
    }
}

/**
 * Restore button to original state via component interface
 * @param {HTMLElement} elementsDiv - Parent container
 */
export function restoreButtonState(elementsDiv) {
    const buttonWrapper = elementsDiv.querySelector('.download-btn-wrapper');
    let component = buttonWrapper?._component;
    
    // Self-healing: create component if missing (for cloned elements)
    if (!component && buttonWrapper) {
        component = createFallbackComponent(buttonWrapper, elementsDiv);
        buttonWrapper._component = component;
    }
    
    if (component) {
        component.updateState(BUTTON_STATES.DEFAULT);
    }
}

/**
 * Create download button with optimized component architecture
 * @param {Object} video - Video object
 * @param {HTMLElement} elementsDiv - Parent container for the button
 * @param {HTMLElement} dropdown - Dropdown element reference (not used but kept for compatibility)
 * @returns {Array} - Array containing [downloadBtn, menuBtn, buttonWrapper]
 */
export function createDownloadButton(video, elementsDiv, dropdown) {
    const component = new DownloadButtonComponent(video, elementsDiv);
    return component.render();
}
