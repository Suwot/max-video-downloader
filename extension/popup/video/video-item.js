/**
 * VideoItemComponent - Class-based video item with centralized state management
 * Eliminates DOM dataset dependencies and provides clean data access
 */

import { formatDuration } from '../../shared/utils/processing-utils.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { sendPortMessage } from '../communication.js';
import { createLogger } from '../../shared/utils/logger.js';
import { VideoDropdownComponent, isTrackCompatibleWithVideo } from './dropdown.js';
import { VideoDownloadButtonComponent } from './download-button.js';
import { showInfo, showError } from '../ui-utils.js';

const logger = createLogger('VideoItemComponent');

/**
 * VideoItemComponent - Manages complete video item state and UI
 */
export class VideoItemComponent {
    constructor(downloadRequestOrVideoData, initialDownloadState = 'default', downloadId = null, renderingMode = 'full') {
        // Handle both downloadRequest (with filename/downloadId) and plain videoData
        if (downloadRequestOrVideoData.videoData) {
            // This is a downloadRequest object - deconstruct it
            this.videoData = downloadRequestOrVideoData.videoData;
            this.downloadId = downloadRequestOrVideoData.downloadId;
            this.filename = downloadRequestOrVideoData.filename;
            this.resolvedFilename = downloadRequestOrVideoData.resolvedFilename;
        } else {
            // This is plain videoData (legacy)
            this.videoData = downloadRequestOrVideoData;
            this.downloadId = downloadId;
            this.filename = null;
            this.resolvedFilename = null;
        }
        
        this.initialDownloadState = initialDownloadState; // 'default', 'starting', 'downloading', 'queued'
        this.renderingMode = renderingMode; // 'full' or 'simple'
        this.element = null;
        this.dropdown = null;
        this.downloadButton = null;
        this.selectedTracks = this.initializeDefaultSelection();
        
        // Bind methods to preserve context
        this.handleDismiss = this.handleDismiss.bind(this);
        this.handlePreviewRetry = this.handlePreviewRetry.bind(this);
        this.handleTrackSelectionChange = this.handleTrackSelectionChange.bind(this);
    }
    
    /**
     * Initialize default track selection based on video type and available tracks
     * @returns {Object} Default selection state
     */
    initializeDefaultSelection() {
        const selection = {
            videoTrack: null,
            audioTracks: [],
            subtitleTracks: []
        };
        
        // Select first/best video track
        if (this.videoData.videoTracks?.length > 0) {
            selection.videoTrack = this.videoData.videoTracks[0];
        }
        
        // Select default audio tracks
        if (this.videoData.audioTracks?.length > 0) {
            // For advanced mode, select first audio track
            selection.audioTracks = [this.videoData.audioTracks[0]];
        }
        
        // No subtitles selected by default
        selection.subtitleTracks = [];
        
        return selection;
    }
    
    /**
     * Render the complete video item UI
     * @returns {HTMLElement} The rendered video item element
     */
    render() {
        if (this.renderingMode === 'simple') {
            return this.renderSimpleMode();
        }
        
        this.element = document.createElement('div');
        this.element.className = 'video-item';
        this.element.dataset.url = this.videoData.url;
        
        // Set download ID for precise progress mapping (downloads tab only)
        if (this.downloadId) {
            this.element.dataset.downloadId = this.downloadId;
        }
        
        // Store component reference for external access
        this.element._component = this;
        
        const previewColumn = this.createPreviewColumn();
        const infoColumn = this.createInfoColumn();
        
        this.element.append(previewColumn, infoColumn);
        
        return this.element;
    }
    
    /**
     * Render simple mode for downloads tab - minimal structure with hardcoded HTML
     * @returns {HTMLElement} The rendered simple video item element
     */
    renderSimpleMode() {
        // Create hardcoded HTML structure for simple mode
        const previewUrl = this.videoData.previewUrl || this.videoData.poster || chrome.runtime.getURL('icons/video-placeholder.png');
        const duration = this.videoData.duration ? formatDuration(this.videoData.duration) : '';
        // Use resolved filename if available, fallback to original filename, then video title
        const title = this.resolvedFilename || this.filename || this.videoData.title || 'Untitled Video';
        
        // Create status badge HTML if needed
        const statusBadgeHtml = this.createStatusBadgeHtml();
        
        const htmlTemplate = `
            <div class="preview-column">
                <div class="preview-container has-preview">
                    ${duration ? `<div class="video-duration">${duration}</div>` : ''}
                    <img class="preview-image loaded" src="${previewUrl}" alt="Video preview">
                    ${statusBadgeHtml}
                </div>
            </div>
            <div class="info-column">
                <div class="title-row">
                    <h3 class="video-title item-title">${title}</h3>
                </div>
                <div class="download-group">
                    <div class="custom-dropdown" data-type="${this.videoData.type || 'unknown'}">
                        <div class="selected-option downloading" data-tooltip-content="" data-tooltip-quality="">
                            <div class="progress-container"></div>
                            <div class="content-wrapper">
                                <span class="label">Preparing...</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Create element and set up basic structure
        this.element = document.createElement('div');
        this.element.className = 'video-item';
        this.element.dataset.url = this.videoData.url;
        
        // Set download ID for precise progress mapping
        if (this.downloadId) {
            this.element.dataset.downloadId = this.downloadId;
        }
        
        // Store component reference for external access
        this.element._component = this;
        
        // Set innerHTML with template
        this.element.innerHTML = htmlTemplate;
        
        // Create only the download button component (no dropdown)
        this.downloadButton = new VideoDownloadButtonComponent(this, this.element.querySelector('.download-group'));
        this.downloadButton.render();
        
        // Apply initial download state if not default
        if (this.initialDownloadState !== 'default') {
            this.applyInitialDownloadState();
        }
        
        return this.element;
    }
    
    /**
     * Create preview column with image, duration, and status badges
     * @returns {HTMLElement} Preview column element
     */
    createPreviewColumn() {
        const previewColumn = document.createElement('div');
        previewColumn.className = 'preview-column';
        
        const previewContainer = document.createElement('div');
        previewContainer.className = 'preview-container';
        
        const previewImage = document.createElement('img');
        previewImage.className = 'preview-image placeholder';
        previewImage.src = chrome.runtime.getURL('icons/video-placeholder.png');
        previewImage.alt = 'Video preview';
        
        // Add duration display if available
        if (this.videoData.duration) {
            const durationElement = document.createElement('div');
            durationElement.className = 'video-duration';
            durationElement.textContent = formatDuration(this.videoData.duration);
            previewContainer.appendChild(durationElement);
        }
        
        // Add status badges for Live and/or Encrypted
        if (this.videoData.isLive || this.videoData.isEncrypted) {
            const statusBadge = this.createStatusBadge();
            previewContainer.appendChild(statusBadge);
        }
        
        const loader = document.createElement('div');
        loader.className = 'loader';
        
        // Only add retry preview button if not processing and has video tracks
        if (!this.videoData.processing && this.videoData.videoTracks?.length > 0) {
            const retryPreviewBtn = document.createElement('button');
            retryPreviewBtn.className = 'retry-preview-btn';
            retryPreviewBtn.title = 'Generate preview';
            retryPreviewBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-rotate-cw w-3 h-3" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                    <path d="M21 3v5h-5"></path>
                </svg>
            `;
            retryPreviewBtn.addEventListener('click', this.handlePreviewRetry);
            previewContainer.appendChild(retryPreviewBtn);
        }
        
        previewContainer.append(previewImage, loader);
        
        // Handle preview loading and hover
        this.setupPreviewHandling(previewContainer, previewImage);
        
        previewColumn.appendChild(previewContainer);
        return previewColumn;
    }
    
    /**
     * Create status badge HTML for simple mode
     * @returns {string} Status badge HTML string
     */
    createStatusBadgeHtml() {
        if (!this.videoData.isLive && !this.videoData.isEncrypted) {
            return '';
        }
        
        const tooltipText = this.videoData.isEncrypted ? 
            (this.videoData.encryptionType ? 
                `Encryption: ${this.videoData.encryptionType}` : 
                'Encrypted content') : '';
        
        const liveHtml = this.videoData.isLive ? '<span class="live-text">LIVE</span>' : '';
        const lockHtml = this.videoData.isEncrypted ? 
            `<span class="lock-icon"><svg viewBox="0 0 7 8" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6.25 3.5H5.875V2.375C5.875 1.06562 4.80937 0 3.5 0C2.19062 0 1.125 1.06562 1.125 2.375V3.5H0.75C0.335938 3.5 0 3.83594 0 4.25V7.25C0 7.66406 0.335938 8 0.75 8H6.25C6.66406 8 7 7.66406 7 7.25V4.25C7 3.83594 6.66406 3.5 6.25 3.5ZM4.625 3.5H2.375V2.375C2.375 1.75469 2.87969 1.25 3.5 1.25C4.12031 1.25 4.625 1.75469 4.625 2.375V3.5Z" fill="#DB6B67"/>
                </svg></span>` : '';
        
        return `<div class="status-badge" ${tooltipText ? `title="${tooltipText}"` : ''}>${liveHtml}${lockHtml}</div>`;
    }

    /**
     * Create status badge for Live/Encrypted content
     * @returns {HTMLElement} Status badge element
     */
    createStatusBadge() {
        const statusBadge = document.createElement('div');
        statusBadge.className = 'status-badge';
        
        // Set tooltip for encrypted content
        if (this.videoData.isEncrypted) {
            statusBadge.title = this.videoData.encryptionType ? 
                `Encryption: ${this.videoData.encryptionType}` : 
                'Encrypted content';
        }
        
        // Add Live text if applicable
        if (this.videoData.isLive) {
            const liveText = document.createElement('span');
            liveText.className = 'live-text';
            liveText.textContent = 'LIVE';
            statusBadge.appendChild(liveText);
        }
        
        // Add Encrypted lock icon if applicable
        if (this.videoData.isEncrypted) {
            const lockIcon = document.createElement('span');
            lockIcon.className = 'lock-icon';
            lockIcon.innerHTML = `
                <svg viewBox="0 0 7 8" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6.25 3.5H5.875V2.375C5.875 1.06562 4.80937 0 3.5 0C2.19062 0 1.125 1.06562 1.125 2.375V3.5H0.75C0.335938 3.5 0 3.83594 0 4.25V7.25C0 7.66406 0.335938 8 0.75 8H6.25C6.66406 8 7 7.66406 7 7.25V4.25C7 3.83594 6.66406 3.5 6.25 3.5ZM4.625 3.5H2.375V2.375C2.375 1.75469 2.87969 1.25 3.5 1.25C4.12031 1.25 4.625 1.75469 4.625 2.375V3.5Z" fill="#DB6B67"/>
                </svg>
            `;
            statusBadge.appendChild(lockIcon);
        }
        
        return statusBadge;
    }
    
    /**
     * Setup preview image loading and hover functionality
     * @param {HTMLElement} previewContainer - Preview container element
     * @param {HTMLElement} previewImage - Preview image element
     */
    setupPreviewHandling(previewContainer, previewImage) {
        const previewUrl = this.videoData.previewUrl || this.videoData.poster;
        
        // Handle loader visibility and retry button based on preview generation status
        if (this.videoData.generatingPreview) {
            previewContainer.classList.add('loading');
            previewImage.classList.add('generating');
        } else if (previewUrl) {
            previewContainer.classList.add('has-preview');
            previewImage.onload = () => {
                previewImage.classList.remove('placeholder');
                previewImage.classList.add('loaded');
                previewContainer.classList.remove('loading');
            };
            previewImage.src = previewUrl;
            
            // Add hover functionality for preview
            previewContainer.addEventListener('mouseenter', (event) => {
                showHoverPreview(previewUrl, event);
            });
            previewContainer.addEventListener('mousemove', (event) => {
                showHoverPreview(previewUrl, event);
            });
            previewContainer.addEventListener('mouseleave', hideHoverPreview);
        }
    }
    
    /**
     * Create stream icons based on available streams
     * @returns {HTMLElement} Stream icons container
     */
    createStreamIcons() {
        const streamIcons = document.createElement('div');
        streamIcons.className = 'stream-icons';
        
        const availableStreams = this.detectAvailableStreams();
        
        // Video icon
        if (availableStreams.hasVideo) {
            streamIcons.innerHTML += `
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-film w-4 h-4 text-red-500" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M7 3v18"></path><path d="M3 7.5h4"></path><path d="M3 12h18"></path><path d="M3 16.5h4"></path><path d="M17 3v18"></path><path d="M17 7.5h4"></path><path d="M17 16.5h4"></path></svg>
            `;
        }
        
        // Audio icon
        if (availableStreams.hasAudio) {
            streamIcons.innerHTML += `
				<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume2 lucide-volume-2 w-4 h-4 text-blue-500" aria-hidden="true"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19.364 18.364a9 9 0 0 0 0-12.728"></path></svg>
            `;
        }
        
        // Subtitles icon
        if (availableStreams.hasSubtitles) {
            streamIcons.innerHTML += `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="gray" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-captions w-4 h-4 text-green-500" aria-hidden="true"><rect width="18" height="14" x="3" y="5" rx="2" ry="2"></rect><path d="M7 15h4M15 15h2M7 11h2M13 11h4"></path></svg>
            `;
        }
        
        return streamIcons;
    }
    
    /**
     * Calculate text-indent width for title based on stream icons
     * @param {Object} availableStreams - Object with hasVideo, hasAudio, hasSubtitles flags
     * @returns {number} Width in pixels for text-indent
     */
    calculateTextIndent(availableStreams) {
        const iconCount = (availableStreams.hasVideo ? 1 : 0) + 
                         (availableStreams.hasAudio ? 1 : 0) + 
                         (availableStreams.hasSubtitles ? 1 : 0);
        
        if (iconCount === 0) return 0;
        
        // Calculate: (icon widths) + (gaps between icons) + (gap after last icon)
        // Video: 12px, Audio: 14px, Subtitles: 14px, gaps: 4px each
        let totalWidth = 0;
        
        if (availableStreams.hasVideo) totalWidth += 12;
        if (availableStreams.hasAudio) totalWidth += 14;
        if (availableStreams.hasSubtitles) totalWidth += 14;
        
        // Add gaps: (iconCount - 1) gaps between icons + 1 gap after last icon
        totalWidth += iconCount * 4;
        
        return totalWidth;
    }
    
    /**
     * Detect available stream types based on video data
     * Universal fallback chain that works for all cases (advanced/simple dropdowns)
     * @returns {Object} Object with hasVideo, hasAudio, hasSubtitles flags
     */
    detectAvailableStreams() {
        let hasVideo = false;
        let hasAudio = false;
        let hasSubtitles = false;
        
        // Check separate track arrays first (advanced mode)
        const videoTracksLength = this.videoData.videoTracks?.length || 0;
        const audioTracksLength = this.videoData.audioTracks?.length || 0;
        const subtitleTracksLength = this.videoData.subtitleTracks?.length || 0;
        
        // If we have separate audio or subtitle tracks, this is advanced mode
        if (audioTracksLength > 0 || subtitleTracksLength > 0) {
            hasVideo = videoTracksLength > 0;
            hasAudio = audioTracksLength > 0;
            hasSubtitles = subtitleTracksLength > 0;
            return { hasVideo, hasAudio, hasSubtitles };
        }
        
        // If we only have videoTracks (or no separate tracks), check containers
        if (videoTracksLength > 0) {
            // Check all video tracks for available containers
            for (const track of this.videoData.videoTracks) {
                if (track.videoContainer) hasVideo = true;
                if (track.audioContainer) hasAudio = true;
                if (track.subtitleContainer) hasSubtitles = true;
            }
            return { hasVideo, hasAudio, hasSubtitles };
        }
        
        // Fallback: check root video data (direct videos or legacy structure)
        const rootData = this.videoData;
        hasVideo = !!rootData.videoContainer;
        hasAudio = !!rootData.audioContainer;
        hasSubtitles = !!rootData.subtitleContainer;
        
        return { hasVideo, hasAudio, hasSubtitles };
    }
    
    /**
     * Create info column with title, dismiss button, and download actions
     * @returns {HTMLElement} Info column element
     */
    createInfoColumn() {
        const infoColumn = document.createElement('div');
        infoColumn.className = 'info-column';
        
        // Create title row
        const titleRow = document.createElement('div');
        titleRow.className = 'title-row';
        
        const title = document.createElement('h3');
        title.className = 'video-title item-title';
        title.textContent = this.resolvedFilename || this.filename || this.videoData.title || 'Untitled Video';
        
        // Add stream icons and apply text-indent (only in full mode)
        if (this.renderingMode === 'full') {
            const streamIcons = this.createStreamIcons();
            const availableStreams = this.detectAvailableStreams();
            const textIndent = this.calculateTextIndent(availableStreams);
            
            if (textIndent > 0) {
                title.style.textIndent = `${textIndent}px`;
            }
            
            titleRow.appendChild(streamIcons);
        }
        
        // Dismiss (X) button
        const dismissButton = document.createElement('button');
        dismissButton.className = 'dismiss-button';
        dismissButton.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.70396 1.70624C10.0946 1.31562 10.0946 0.681244 9.70396 0.290619C9.31333 -0.100006 8.67896 -0.100006 8.28833 0.290619L4.9977 3.58437L1.70396 0.293744C1.31333 -0.0968812 0.678955 -0.0968812 0.28833 0.293744C-0.102295 0.684369 -0.102295 1.31874 0.28833 1.70937L3.58208 4.99999L0.291455 8.29374C-0.0991699 8.68437 -0.0991699 9.31874 0.291455 9.70937C0.68208 10.1 1.31646 10.1 1.70708 9.70937L4.9977 6.41562L8.29146 9.70624C8.68208 10.0969 9.31646 10.0969 9.70708 9.70624C10.0977 9.31562 10.0977 8.68124 9.70708 8.29062L6.41333 4.99999L9.70396 1.70624Z"/>
            </svg>
        `;
        dismissButton.title = 'Dismiss';
        dismissButton.addEventListener('click', this.handleDismiss);
        
        titleRow.append(title, dismissButton);
        infoColumn.append(titleRow);
        
        // Create download actions
        const downloadActions = this.createDownloadActions();
        infoColumn.appendChild(downloadActions);
        
        return infoColumn;
    }
    
    /**
     * Create download actions (dropdown + button)
     * @returns {HTMLElement} Download actions container
     */
    createDownloadActions() {
        const elementsDiv = document.createElement('div');
        elementsDiv.className = 'download-group';
        
        // Check if we have tracks to show dropdown, otherwise show placeholder
        const hasTracks = this.videoData.videoTracks?.length > 0 || 
                         this.videoData.audioTracks?.length > 0 || 
                         this.videoData.subtitleTracks?.length > 0;
        
        if (hasTracks) {
            // Create dropdown component
            this.dropdown = new VideoDropdownComponent(this.videoData, this.selectedTracks, this.handleTrackSelectionChange);
            const dropdownElement = this.dropdown.render();
            elementsDiv.appendChild(dropdownElement);
        } else {
			logger.debug('creating simple DD with no tracks available');
			
            // Create simple placeholder (no dropdown functionality)
            const placeholderDropdown = document.createElement('div');
            placeholderDropdown.className = 'custom-dropdown';
            placeholderDropdown.innerHTML = `
                <div class="selected-option ${this.videoData.processing ? 'processing' : ''}">
                    <span class="label">${this.videoData.type === 'direct' ? 'Probing...' : 'Parsing...'}</span>
                </div>
            `;
            elementsDiv.appendChild(placeholderDropdown);
        }
        
        // Create download button component
        this.downloadButton = new VideoDownloadButtonComponent(this, elementsDiv);
        this.downloadButton.render();
        
        // Apply initial download state if not default
        if (this.initialDownloadState !== 'default') {
            this.applyInitialDownloadState();
        }
        
        return elementsDiv;
    }
    
    // Execute download with specified mode. Download mode ('download', 'download-as', 'extract-audio', 'extract-subs')
    executeDownload(mode = 'download') {
        const commands = this.createDownloadCommand(mode);
        
        // Handle single command or array of commands (for multi-track extraction)
        const commandArray = Array.isArray(commands) ? commands : [commands];
        
        // Filter out empty commands (e.g., when no subtitles selected)
        const validCommands = commandArray.filter(cmd => cmd && Object.keys(cmd).length > 0);
        
        if (validCommands.length === 0) {
            logger.debug(`No valid commands generated for ${mode}`);
            return;
        }
        
        // Check for missing URLs in commands
        for (const command of validCommands) {
            if (!command.downloadUrl) {
                showError('URL is missing, can\'t download');
                logger.error(`Missing downloadUrl in command for ${mode}:`, command);
                
                // Reset button state to default since operation failed
                if (this.downloadButton) {
                    this.downloadButton.updateState('default');
                }
                return;
            }
        }
        
        validCommands.forEach(command => {
            sendPortMessage(command);
            logger.debug(`Executed ${mode} command:`, command);
        });
    }

    // Create complete download command based on mode and current component state
    createDownloadCommand(mode = 'download') {
        const baseData = this.getDownloadData();
        
        // Get selected option text for UI restoration
        const selectedOptionOrigText = this.getSelectedOptionText();
        
        // Create minimal video data for downloads tab (only essential fields)
        const minimalVideoData = {
            normalizedUrl: this.videoData.normalizedUrl,
            title: this.videoData.title,
            type: this.videoData.type,
            duration: this.videoData.duration,
            previewUrl: this.videoData.previewUrl,
            poster: this.videoData.poster,
            tabId: this.videoData.tabId,
            pageUrl: this.videoData.pageUrl,
            pageFavicon: this.videoData.pageFavicon,
			pageTitle: this.videoData.pageTitle,
            // Include live/encryption status for downloads tab display
            isLive: this.videoData.isLive,
            isEncrypted: this.videoData.isEncrypted,
            encryptionType: this.videoData.encryptionType
        };
        
        // Determine container based on command mode (container-first logic)
        const container = this.determineDownloadContainer(mode, baseData);
        
        const command = {
            command: 'download',  // Always use 'download' command - mode is conveyed via flags
            container: container,  // Single container sent to native host
            audioOnly: mode === 'extract-audio',
            subsOnly: mode === 'extract-subs',
            choosePath: mode === 'download-as',  // Add choosePath flag for download-as mode
            selectedOptionOrigText,
            videoData: minimalVideoData,
            ...baseData
        };

        // Apply mode-specific modifications
        switch (mode) {
            case 'download-as':
                return command;
            case 'extract-audio':
                return this.createAudioExtractionCommands(command);
            case 'extract-subs':
                return this.createSubtitleExtractionCommands(command);
            case 're-download':
                return { ...command, isRedownload: true };
            default:
                return command;
        }
    }

    /**
     * Determine download container based on command mode and available containers
     * @param {string} mode - Download mode (download, extract-audio, extract-subs)
     * @param {Object} baseData - Base download data containing container info
     * @returns {string} Selected container for download
     */
    determineDownloadContainer(mode, baseData) {
        const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0];
        
        switch (mode) {
            case 'download':
            case 'download-as':
                // Container-first logic: video container for mixed content, audio container for audio-only
                return videoTrack?.videoContainer || videoTrack?.audioContainer || baseData.container;
            
            case 'extract-audio':
                // Use audio container for audio extraction
                return videoTrack?.audioContainer;
            
            case 'extract-subs':
                // Use subtitle container for subtitle extraction  
                return videoTrack?.subtitleContainer;
            
            default:
                return videoTrack?.videoContainer || videoTrack?.audioContainer || baseData.container;
        }
    }

    // Create audio extraction commands - handles single and multi-track scenarios
    createAudioExtractionCommands(baseCommand) {
        const selectedAudioTracks = this.getSelectedAudioTracks();
        const availableAudioTracks = this.videoData.audioTracks || [];
        
        // If no tracks selected, use auto-selection (works for both advanced and simple dropdowns)
        if (selectedAudioTracks.length === 0) {
            // For simple dropdowns, create a basic audio extraction command
            if (availableAudioTracks.length === 0) {
                // Simple dropdown - extract audio from the main video
                const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
                
                return { 
                    ...baseCommand,
                    container: videoTrack.audioContainer || 'm4a'
                };
            }
            
            // Advanced dropdown - use default or best track
            const autoTrack = this.getDefaultOrBestAudioTrack();
            const audioLabel = autoTrack.label || autoTrack.name || autoTrack.language || autoTrack.lang || null;
            
            // Show appropriate toast message
            if (autoTrack.default) {
                showInfo('Extracting default audio track, as nothing was selected');
            } else {
                showInfo('Extracting best-quality audio track, as nothing was selected');
            }
            
            return this.createSingleAudioCommand(baseCommand, autoTrack, audioLabel);
        }
        
        // Single audio extraction for selected tracks
        if (selectedAudioTracks.length === 1) {
            const audioTrack = selectedAudioTracks[0];
            const audioLabel = audioTrack.label || audioTrack.name || audioTrack.language || audioTrack.lang || null;
            
            return this.createSingleAudioCommand(baseCommand, audioTrack, audioLabel);
        }
        
        // Multi-track audio extraction - send individual commands
        return selectedAudioTracks.map((audioTrack, index) => {
            const audioLabel = audioTrack.label || audioTrack.name || audioTrack.language || audioTrack.lang || `${index + 1}`;
            
            return this.createSingleAudioCommand(baseCommand, audioTrack, audioLabel);
        });
    }

    /**
     * Create a single audio extraction command
     * @param {Object} baseCommand - Base download command
     * @param {Object} audioTrack - Audio track data
     * @param {string} audioLabel - Audio track label
     * @returns {Object} Single audio command
     */
    createSingleAudioCommand(baseCommand, audioTrack, audioLabel) {
        const command = { 
            ...baseCommand,
            container: audioTrack.audioContainer || 'm4a',
            audioLabel // Pass label to native host for filename generation
        };
        
        // Add track-specific data for DASH/HLS advanced dropdowns
        if (this.videoData.type === 'dash' && audioTrack.ffmpegStreamIndex) {
            command.streamSelection = audioTrack.ffmpegStreamIndex;
            delete command.inputs; // Clear inputs to avoid sending all selected tracks
        } else if (this.videoData.type === 'hls' && audioTrack.url) {
            command.downloadUrl = audioTrack.url;
            delete command.inputs; // Clear inputs array for single audio track download
        }
        // For simple dropdowns, the base command already has the correct downloadUrl and container
        // The audioOnly flag tells the native host to extract only audio from the video
        
        return command;
    }

    /**
     * Get current download data based on selected tracks and video type
     * @returns {Object} Complete download data object
     */
    getDownloadData() {
        const baseData = {
            tabId: this.videoData.tabId,
            filename: this.videoData.title,
            type: this.videoData.type,
            duration: this.videoData.duration || null,
            masterUrl: this.videoData.isMaster ? this.videoData.url : null,
            pageUrl: this.videoData.pageUrl || null,
            pageFavicon: this.videoData.pageFavicon || null,
            headers: this.videoData.headers || {},
            isLive: this.videoData.isLive || false
        };
        
        // Add type-specific data
        switch (this.videoData.type) {
            case 'direct':
                return this.getDirectDownloadData(baseData);
            case 'hls':
                return this.getHlsDownloadData(baseData);
            case 'dash':
                return this.getDashDownloadData(baseData);
            default:
                return { ...baseData, container: 'mp4' };
        }
    }
    
    /**
     * Get download data for direct videos
     * @param {Object} baseData - Base download data
     * @returns {Object} Complete direct download data
     */
    getDirectDownloadData(baseData) {
        const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
        
        return {
            ...baseData,
            downloadUrl: videoTrack.url,
            container: videoTrack.videoContainer || 'mp4',
            fileSizeBytes: videoTrack.fileSize || videoTrack.estimatedFileSizeBytes || null,
            sourceAudioCodec: this.videoData.metaFFprobe?.audioCodec?.name || null,
            sourceAudioBitrate: this.videoData.metaFFprobe?.audioBitrate || null
        };
    }
    
    /**
     * Get download data for HLS videos
     * @param {Object} baseData - Base download data
     * @returns {Object} Complete HLS download data
     */
    getHlsDownloadData(baseData) {
        const hasAdvancedTracks = (this.videoData.audioTracks?.length || 0) > 0 || 
                                 (this.videoData.subtitleTracks?.length || 0) > 0;
        
        if (hasAdvancedTracks) {
            // Advanced HLS mode - multiple inputs
            return {
                ...baseData,
                downloadUrl: this.selectedTracks.videoTrack?.url,
                inputs: this.buildHlsInputsArray(),
                container: this.getOptimalContainer(),
                fileSizeBytes: this.calculateTotalFileSize(),
                segmentCount: this.videoData.segmentCount || null
            };
        } else {
            // Simple HLS mode - use container-first logic
            const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0];
            return {
                ...baseData,
                downloadUrl: videoTrack?.url,
                container: videoTrack?.videoContainer || videoTrack?.audioContainer || 'mp4',
                fileSizeBytes: videoTrack?.metaJS?.estimatedFileSizeBytes || null,
                segmentCount: this.videoData.segmentCount || null
            };
        }
    }
    
    /**
     * Get download data for DASH videos
     * @param {Object} baseData - Base download data
     * @returns {Object} Complete DASH download data
     */
    getDashDownloadData(baseData) {
        return {
            ...baseData,
            downloadUrl: this.selectedTracks.videoTrack?.url || this.videoData.url,
            streamSelection: this.buildDashStreamSelection(),
            container: this.getOptimalContainer(),
            fileSizeBytes: this.calculateTotalFileSize()
        };
    }
    
    /**
     * Build HLS inputs array for advanced mode
     * @returns {Array} Array of input objects with url and streamMap
     */
    buildHlsInputsArray() {
        const inputs = [];
        let streamIndex = 0;
        
        // Add video track
        if (this.selectedTracks.videoTrack?.url) {
            inputs.push({
                url: this.selectedTracks.videoTrack.url,
                streamMap: `${streamIndex++}:v:0`
            });
        }
        
        // Add audio tracks
        this.selectedTracks.audioTracks.forEach(audioTrack => {
            if (audioTrack.url) {
                inputs.push({
                    url: audioTrack.url,
                    streamMap: `${streamIndex++}:a:0`
                });
            }
        });
        
        // Add subtitle tracks
        this.selectedTracks.subtitleTracks.forEach(subTrack => {
            if (subTrack.url) {
                inputs.push({
                    url: subTrack.url,
                    streamMap: `${streamIndex++}:s:0`
                });
            }
        });
        
        return inputs;
    }
    
    /**
     * Build DASH stream selection string
     * @returns {string} Stream selection string (e.g., "0:v:0,0:a:1,0:s:0")
     */
    buildDashStreamSelection() {
        const streams = [];
        
        // Add video stream
        if (this.selectedTracks.videoTrack?.ffmpegStreamIndex) {
            streams.push(this.selectedTracks.videoTrack.ffmpegStreamIndex);
        }
        
        // Add audio streams
        this.selectedTracks.audioTracks.forEach(audioTrack => {
            if (audioTrack.ffmpegStreamIndex) {
                streams.push(audioTrack.ffmpegStreamIndex);
            }
        });
        
        // Add subtitle streams
        this.selectedTracks.subtitleTracks.forEach(subTrack => {
            if (subTrack.ffmpegStreamIndex) {
                streams.push(subTrack.ffmpegStreamIndex);
            }
        });
        
        return streams.join(',');
    }
    
    /**
     * Get optimal container based on selected tracks and compatibility
     * @returns {string} Optimal container format
     */
    getOptimalContainer() {
        // Use container-first logic for optimal container selection
        const videoTrack = this.selectedTracks.videoTrack;
        const primaryContainer = videoTrack?.videoContainer || videoTrack?.audioContainer || 'mp4';
        
        // Check if any selected tracks are incompatible with primary container
        const hasIncompatibleTracks = this.hasIncompatibleTracks(primaryContainer);
        
        return hasIncompatibleTracks ? 'mkv' : primaryContainer;
    }
    
    /**
     * Check if any selected tracks are incompatible with the video container
     * @param {string} videoContainer - Video container to check against
     * @returns {boolean} True if any tracks are incompatible
     */
    hasIncompatibleTracks(videoContainer) {
        // Check audio tracks only - subtitles will be transcoded based on final container
        for (const audioTrack of this.selectedTracks.audioTracks) {
            if (audioTrack.audioContainer && !isTrackCompatibleWithVideo(audioTrack.audioContainer, 'audio', videoContainer)) {
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Calculate total file size from selected tracks
     * @returns {number|null} Total file size in bytes
     */
    calculateTotalFileSize() {
        let totalSize = 0;
        let hasSize = false;
        
        // Add video track size
        if (this.selectedTracks.videoTrack?.estimatedFileSizeBytes) {
            totalSize += this.selectedTracks.videoTrack.estimatedFileSizeBytes;
            hasSize = true;
        } else if (this.selectedTracks.videoTrack?.metaJS?.estimatedFileSizeBytes) {
            totalSize += this.selectedTracks.videoTrack.metaJS.estimatedFileSizeBytes;
            hasSize = true;
        }
        
        // Add audio track sizes
        this.selectedTracks.audioTracks.forEach(audioTrack => {
            if (audioTrack.estimatedFileSizeBytes) {
                totalSize += audioTrack.estimatedFileSizeBytes;
                hasSize = true;
            }
        });
        
        return hasSize ? totalSize : null;
    }
    
    // Create subtitle extraction commands - handles single and multi-track scenarios
    createSubtitleExtractionCommands(baseCommand) {
        const selectedSubtitleTracks = this.selectedTracks.subtitleTracks || [];
        const availableSubtitleTracks = this.videoData.subtitleTracks || [];
        
        // If no tracks selected but tracks are available, use default or best track
        if (selectedSubtitleTracks.length === 0 && availableSubtitleTracks.length > 0) {
            const autoTrack = this.getDefaultOrBestSubtitleTrack();
            const subsLabel = autoTrack.label || autoTrack.name || autoTrack.language || autoTrack.lang || null;
            
            // Show appropriate toast message based on track selection reason
            if (autoTrack.default) {
                showInfo('Extracting default subtitle track, as nothing was selected');
            } else {
                showInfo('Extracting first subtitle track, as nothing was selected');
            }
            
            return this.createSingleSubtitleCommand(baseCommand, autoTrack, subsLabel);
        }
        
        if (selectedSubtitleTracks.length === 0) {
            // No subtitles available at all - return empty to prevent command execution
            return [];
        }
        
        // Single subtitle extraction
        if (selectedSubtitleTracks.length === 1) {
            const subTrack = selectedSubtitleTracks[0];
            const subsLabel = subTrack.label || subTrack.name || subTrack.language || subTrack.lang || null;
            
            return this.createSingleSubtitleCommand(baseCommand, subTrack, subsLabel);
        }
        
        // Multi-track subtitle extraction - send individual commands
        return selectedSubtitleTracks.map((subTrack, index) => {
            const subsLabel = subTrack.label || subTrack.name || subTrack.language || subTrack.lang || `${index + 1}`;
            
            return this.createSingleSubtitleCommand(baseCommand, subTrack, subsLabel);
        });
    }

    /**
     * Get selected audio tracks for multi-audio download
     * @returns {Array} Array of selected audio tracks with container info
     */
    getSelectedAudioTracks() {
        if (!this.selectedTracks.audioTracks || this.selectedTracks.audioTracks.length === 0) {
            // Return empty array - let the command creation handle fallbacks and toasts
            return [];
        }
        
        return this.selectedTracks.audioTracks.map((track, index) => ({
            ...track,
            label: track.name || track.label || track.lang || `${index + 1}`,
            audioContainer: track.audioContainer || 'm4a'
        }));
    }

    /**
     * Get default or best quality audio track for auto-selection
     * @returns {Object} Audio track with default flag
     */
    getDefaultOrBestAudioTrack() {
        const availableAudioTracks = this.videoData.audioTracks || [];
        
        if (availableAudioTracks.length > 0) {
            // First, look for a track marked as default
            const defaultTrack = availableAudioTracks.find(track => track.default === true);
            if (defaultTrack) {
                return {
                    ...defaultTrack,
                    label: defaultTrack.name || defaultTrack.label || defaultTrack.language || defaultTrack.lang || null,
                    audioContainer: defaultTrack.audioContainer || 'mp3'
                };
            }
            
            // If no default track, use the first track (best quality, as tracks are sorted)
            const bestTrack = availableAudioTracks[0];
            return {
                ...bestTrack,
                label: bestTrack.name || bestTrack.label || bestTrack.language || bestTrack.lang || null,
                audioContainer: bestTrack.audioContainer || 'mp3'
            };
        }
        
        // For simple dropdown or direct videos, use the selected video track's audio
        const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
        return {
            audioContainer: videoTrack.audioContainer || 'mp3',
            default: false
        };
    }

    /**
     * Get default or best quality subtitle track for auto-selection
     * @returns {Object} Subtitle track with default flag
     */
    getDefaultOrBestSubtitleTrack() {
        const availableSubtitleTracks = this.videoData.subtitleTracks || [];
        
        // First, look for a track marked as default
        const defaultTrack = availableSubtitleTracks.find(track => track.default === true);
        if (defaultTrack) {
            return {
                ...defaultTrack,
                label: defaultTrack.name || defaultTrack.label || defaultTrack.language || defaultTrack.lang || null,
                subtitleContainer: defaultTrack.subtitleContainer || 'srt',
                default: true
            };
        }
        
        // If no default track, use the first track (best quality, as tracks are sorted)
        const bestTrack = availableSubtitleTracks[0];
        return {
            ...bestTrack,
            label: bestTrack.name || bestTrack.label || bestTrack.language || bestTrack.lang || null,
            subtitleContainer: bestTrack.subtitleContainer || 'srt',
            default: false
        };
    }

    /**
     * Create a single subtitle extraction command
     * @param {Object} baseCommand - Base download command
     * @param {Object} subTrack - Subtitle track data
     * @param {string} subsLabel - Subtitle track label
     * @returns {Object} Single subtitle command
     */
    createSingleSubtitleCommand(baseCommand, subTrack, subsLabel) {
        const command = { 
            ...baseCommand,
            container: subTrack.subtitleContainer || 'srt',
            subsLabel // Pass label to native host for filename generation
        };
        
        // Add track-specific data for DASH/HLS
        if (this.videoData.type === 'dash') {
            command.streamSelection = subTrack.ffmpegStreamIndex;
        } else if (this.videoData.type === 'hls') {
            command.downloadUrl = subTrack.url;
            delete command.inputs; // Clear inputs array for single subtitle track download
        }
        
        return command;
    }
    
    /**
     * Handle track selection changes from dropdown
     * @param {Object} newSelection - New track selection
     */
    handleTrackSelectionChange(newSelection) {
        this.selectedTracks = newSelection;
        logger.debug('Track selection updated:', newSelection);
        
        // Update container compatibility if needed
        if (this.dropdown) {
            this.dropdown.updateCompatibility();
        }
    }
    
    /**
     * Handle dismiss button click
     */
    handleDismiss() {
        sendPortMessage({
            command: 'dismissVideo',
            tabId: this.videoData.tabId,
            url: this.videoData.url
        });
    }
    
    /**
     * Handle preview retry button click
     */
    handlePreviewRetry() {
        sendPortMessage({
            command: 'generatePreview',
            tabId: this.videoData.tabId,
            url: this.videoData.url
        });
    }
    
    /**
     * Update video data (for dynamic updates)
     * @param {Object} newVideoData - Updated video data
     */
    updateVideoData(newVideoData) {
        this.videoData = { ...this.videoData, ...newVideoData };
        
        // Update components if needed
        if (this.dropdown) {
            this.dropdown.updateVideoData(newVideoData);
        }
        if (this.downloadButton) {
            this.downloadButton.updateVideoData(newVideoData);
        }
    }
    
    /**
     * Update resolved filename and refresh UI
     * @param {string} resolvedFilename - The resolved filename from native host
     */
    updateResolvedFilename(resolvedFilename) {
        this.resolvedFilename = resolvedFilename;
        
        // Update title in UI
        const titleElement = this.element?.querySelector('.video-title');
        if (titleElement) {
            titleElement.textContent = resolvedFilename;
        }
    }
    
    /**
     * Apply initial download state for restored downloads
     */
    applyInitialDownloadState() {
        if (!this.downloadButton) return;
        
        // Create cancel handler for active download states
        const cancelHandler = () => {
            const cancelMessage = {
                command: 'cancel-download',
                downloadId: this.getDownloadIdForCancellation(),
                type: this.videoData.type,
                downloadUrl: this.getDownloadData().downloadUrl,
                masterUrl: this.videoData.isMaster ? this.videoData.url : null,
                selectedOptionOrigText: this.getSelectedOptionText()
            };
            sendPortMessage(cancelMessage);
        };
        
        switch (this.initialDownloadState) {
            case 'starting':
                this.downloadButton.updateState('starting', {
                    text: 'Starting...',
                    handler: cancelHandler
                });
                break;
                
            case 'downloading':
                this.downloadButton.updateState('downloading', {
                    text: 'Stop',
                    handler: () => {
                        this.downloadButton.innerHTML = 'Stopping...';
                        cancelHandler();
                    }
                });
                break;
                
            case 'queued':
                this.downloadButton.updateState('queued', {
                    text: 'Cancel',
                    handler: cancelHandler
                });
                break;
        }
    }
    
    /**
     * Get selected option text for UI restoration
     * @returns {string} Selected option text
     */
    getSelectedOptionText() {
        if (this.renderingMode === 'simple') {
            // In simple mode, get text from the hardcoded selected-option element
            const selectedDisplay = this.element?.querySelector('.selected-option .label');
            return selectedDisplay?.textContent || '';
        }
        
        if (!this.dropdown || !this.dropdown.element) return '';
        
        const selectedDisplay = this.dropdown.element.querySelector('.selected-option .label');
        return selectedDisplay?.textContent || '';
    }

    /**
     * Get download ID for cancellation - use stored downloadId or fallback to URL
     * @returns {string} Download ID for cancellation
     */
    getDownloadIdForCancellation() {
        // Use stored downloadId if available (from downloads tab)
        if (this.downloadId) {
            return this.downloadId;
        }
        
        // Fallback to URL for videos tab (no downloadId available)
        const downloadData = this.getDownloadData();
        return downloadData.downloadUrl;
    }
    
    /**
     * Cleanup component resources
     */
    cleanup() {
        if (this.dropdown) {
            this.dropdown.cleanup();
        }
        if (this.downloadButton) {
            this.downloadButton.cleanup();
        }
        if (this.element) {
            this.element._component = null;
        }
    }
}