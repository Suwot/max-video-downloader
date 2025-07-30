/**
 * VideoItemComponent - Class-based video item with centralized state management
 * Eliminates DOM dataset dependencies and provides clean data access
 */

import { formatDuration } from '../../shared/utils/processing-utils.js';
import { showHoverPreview, hideHoverPreview } from './preview-hover.js';
import { sendPortMessage } from '../communication.js';
import { createLogger } from '../../shared/utils/logger.js';
import { VideoDropdownComponent } from './video-dropdown-component.js';
import { VideoDownloadButtonComponent } from './video-download-button-component.js';
import { isTrackCompatibleWithVideo } from '../../background/processing/container-detector.js';
import { showInfo } from '../ui-utils.js';

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
        } else {
            // This is plain videoData (legacy)
            this.videoData = downloadRequestOrVideoData;
            this.downloadId = downloadId;
            this.filename = null;
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
        this.element.dataset.url = this.videoData.normalizedUrl;
        
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
        // Use filename from download request (includes container extension) or fallback to video title
        const title = this.filename || this.videoData.title || 'Untitled Video';
        
        const htmlTemplate = `
            <div class="preview-column">
                <div class="preview-container has-preview">
                    ${duration ? `<div class="video-duration">${duration}</div>` : ''}
                    <img class="preview-image loaded" src="${previewUrl}" alt="Video preview">
                </div>
            </div>
            <div class="info-column">
                <div class="title-row">
                    <h3 class="video-title item-title">${title}</h3>
                </div>
                <div class="download-group">
                    <div class="custom-dropdown" data-type="${this.videoData.type || 'unknown'}">
                        <div class="selected-option downloading" data-tooltip-content="" data-tooltip-quality="">
                            <span class="label">Preparing...</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Create element and set up basic structure
        this.element = document.createElement('div');
        this.element.className = 'video-item';
        this.element.dataset.url = this.videoData.normalizedUrl;
        
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
        
        // Create retry preview button
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
        
        previewContainer.append(previewImage, loader, retryPreviewBtn);
        
        // Handle preview loading and hover
        this.setupPreviewHandling(previewContainer, previewImage);
        
        previewColumn.appendChild(previewContainer);
        return previewColumn;
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
        title.textContent = this.filename || this.videoData.title || 'Untitled Video';
        
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
        
        // Create dropdown component
        this.dropdown = new VideoDropdownComponent(this.videoData, this.selectedTracks, this.handleTrackSelectionChange);
        const dropdownElement = this.dropdown.render();
        elementsDiv.appendChild(dropdownElement);
        
        // Create download button component
        this.downloadButton = new VideoDownloadButtonComponent(this, elementsDiv);
        this.downloadButton.render();
        
        // Apply initial download state if not default
        if (this.initialDownloadState !== 'default') {
            this.applyInitialDownloadState();
        }
        
        return elementsDiv;
    }
    
    /**
     * Execute download with specified mode
     * @param {string} mode - Download mode ('download', 'download-as', 'extract-audio', 'extract-subs')
     * @param {Object} options - Additional options for the download
     */
    executeDownload(mode = 'download', options = {}) {
        const commands = this.createDownloadCommand(mode, options);
        
        // Handle single command or array of commands (for multi-track extraction)
        const commandArray = Array.isArray(commands) ? commands : [commands];
        
        // Filter out empty commands (e.g., when no subtitles selected)
        const validCommands = commandArray.filter(cmd => cmd && Object.keys(cmd).length > 0);
        
        if (validCommands.length === 0) {
            logger.debug(`No valid commands generated for ${mode}`);
            return;
        }
        
        validCommands.forEach(command => {
            sendPortMessage(command);
            logger.debug(`Executed ${mode} command:`, command);
        });
    }

    /**
     * Create complete download command based on mode and current component state
     * @param {string} mode - Download mode
     * @param {Object} options - Additional options
     * @returns {Object|Array} Complete download command(s)
     */
    createDownloadCommand(mode = 'download', options = {}) {
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
            pageFavicon: this.videoData.pageFavicon
        };
        
        const command = {
            command: 'download',
            selectedOptionOrigText,
            videoData: minimalVideoData, // Use minimal video data instead of full object
            ...baseData
        };
        
        // Add container extension to filename for regular downloads (other modes handle their own extensions)
        if (mode === 'download' && command.container) {
            const baseFilename = command.filename || 'video';
            command.filename = `${baseFilename}.${command.container}`;
        }
        
        // Apply mode-specific modifications
        switch (mode) {
            case 'download-as':
                return { 
                    ...command, 
                    choosePath: true,
                    defaultFilename: `${command.filename || 'video'}.${command.container || 'mp4'}`,
                    ...options 
                };
            case 'extract-audio':
                return this.createAudioExtractionCommands(command, options);
            case 'extract-subs':
                return this.createSubtitleExtractionCommands(command, options);
            case 're-download':
                return { ...command, isRedownload: true, ...options };
            default:
                return { ...command, ...options };
        }
    }

    /**
     * Create audio extraction commands - handles single and multi-track scenarios
     * @param {Object} baseCommand - Base download command
     * @param {Object} options - Additional options
     * @returns {Object|Array} Single command or array of commands for multi-track
     */
    createAudioExtractionCommands(baseCommand, options = {}) {
        const selectedAudioTracks = this.getSelectedAudioTracks();
        const availableAudioTracks = this.videoData.audioTracks || [];
        
        // If no tracks selected, use auto-selection (works for both advanced and simple dropdowns)
        if (selectedAudioTracks.length === 0) {
            // For simple dropdowns, create a basic audio extraction command
            if (availableAudioTracks.length === 0) {
                // Simple dropdown - extract audio from the main video
                const baseFilename = baseCommand.filename || 'video';
                const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
                const container = videoTrack.audioContainer || 'm4a';
                
                return { 
                    ...baseCommand,
                    container: container,
                    filename: `${baseFilename}_audio.${container}`,
                    audioOnly: true,
                    ...options 
                };
            }
            
            // Advanced dropdown - use default or best track
            const autoTrack = this.getDefaultOrBestAudioTrack();
            const container = autoTrack.audioContainer || 'm4a';
            const baseFilename = baseCommand.filename || 'video';
            const audioLabel = autoTrack.label || autoTrack.name || autoTrack.language || autoTrack.lang || 'nolabel';
            
            // Show appropriate toast message
            if (autoTrack.isDefault) {
                showInfo('Extracting default audio track, as nothing was selected');
            } else {
                showInfo('Extracting best-quality audio track, as nothing was selected');
            }
            
            return this.createSingleAudioCommand(baseCommand, autoTrack, baseFilename, audioLabel, container, options);
        }
        
        // Single audio extraction for selected tracks
        if (selectedAudioTracks.length === 1) {
            const audioTrack = selectedAudioTracks[0];
            const container = audioTrack.audioContainer || 'm4a';
            const baseFilename = baseCommand.filename || 'video';
            const audioLabel = audioTrack.label || audioTrack.name || audioTrack.language || audioTrack.lang || 'nolabel';
            
            return this.createSingleAudioCommand(baseCommand, audioTrack, baseFilename, audioLabel, container, options);
        }
        
        // Multi-track audio extraction - send individual commands
        return selectedAudioTracks.map((audioTrack, index) => {
            const container = audioTrack.audioContainer || 'm4a';
            const baseFilename = baseCommand.filename || 'video';
            const audioLabel = audioTrack.label || audioTrack.name || audioTrack.language || audioTrack.lang || `audio_${index + 1}`;
            
            return this.createSingleAudioCommand(baseCommand, audioTrack, baseFilename, audioLabel, container, options);
        });
    }

    /**
     * Create a single audio extraction command
     * @param {Object} baseCommand - Base download command
     * @param {Object} audioTrack - Audio track data
     * @param {string} baseFilename - Base filename
     * @param {string} audioLabel - Audio track label
     * @param {string} container - Audio container
     * @param {Object} options - Additional options
     * @returns {Object} Single audio command
     */
    createSingleAudioCommand(baseCommand, audioTrack, baseFilename, audioLabel, container, options) {
        const command = { 
            ...baseCommand,
            container: container,
            filename: `${baseFilename}_audio_${audioLabel}.${container}`,
            audioOnly: true,
            ...options 
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
            headers: this.videoData.headers || {}
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
                segmentCount: this.selectedTracks.videoTrack?.metaJS?.segmentCount || null
            };
        } else {
            // Simple HLS mode
            const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0];
            return {
                ...baseData,
                downloadUrl: videoTrack?.url,
                container: videoTrack?.videoContainer || 'mp4',
                fileSizeBytes: videoTrack?.metaJS?.estimatedFileSizeBytes || null,
                segmentCount: videoTrack?.metaJS?.segmentCount || null
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
        const videoContainer = this.selectedTracks.videoTrack?.videoContainer || 'mp4';
        
        // Check if any selected tracks are incompatible with video container
        const hasIncompatibleTracks = this.hasIncompatibleTracks(videoContainer);
        
        return hasIncompatibleTracks ? 'mkv' : videoContainer;
    }
    
    /**
     * Check if any selected tracks are incompatible with the video container
     * @param {string} videoContainer - Video container to check against
     * @returns {boolean} True if any tracks are incompatible
     */
    hasIncompatibleTracks(videoContainer) {
        // Check audio tracks
        for (const audioTrack of this.selectedTracks.audioTracks) {
            if (audioTrack.audioContainer && !isTrackCompatibleWithVideo(audioTrack.audioContainer, 'audio', videoContainer)) {
                return true;
            }
        }
        
        // Check subtitle tracks
        for (const subTrack of this.selectedTracks.subtitleTracks) {
            if (subTrack.subtitleContainer && !isTrackCompatibleWithVideo(subTrack.subtitleContainer, 'subtitle', videoContainer)) {
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
    
    /**
     * Create subtitle extraction commands - handles single and multi-track scenarios
     * @param {Object} baseCommand - Base download command
     * @param {Object} options - Additional options
     * @returns {Object|Array} Single command or array of commands for multi-track
     */
    createSubtitleExtractionCommands(baseCommand, options = {}) {
        const selectedSubtitleTracks = this.selectedTracks.subtitleTracks || [];
        const availableSubtitleTracks = this.videoData.subtitleTracks || [];
        
        // If no tracks selected but tracks are available, use default or best track
        if (selectedSubtitleTracks.length === 0 && availableSubtitleTracks.length > 0) {
            const autoTrack = this.getDefaultOrBestSubtitleTrack();
            const container = autoTrack.subtitleContainer || 'srt';
            const baseFilename = baseCommand.filename || 'noname';
            const subsLabel = autoTrack.label || autoTrack.name || autoTrack.language || autoTrack.lang || 'nolabel';
            
            // Show appropriate toast message based on track selection reason
            if (autoTrack.isDefault) {
                showInfo('Extracting default subtitle track, as nothing was selected');
            } else {
                showInfo('Extracting first subtitle track, as nothing was selected');
            }
            
            return this.createSingleSubtitleCommand(baseCommand, autoTrack, baseFilename, subsLabel, container, options);
        }
        
        if (selectedSubtitleTracks.length === 0) {
            // No subtitles available at all - return empty to prevent command execution
            return [];
        }
        
        // Single subtitle extraction
        if (selectedSubtitleTracks.length === 1) {
            const subTrack = selectedSubtitleTracks[0];
            const container = subTrack.subtitleContainer || 'srt';
            const baseFilename = baseCommand.filename || 'video';
            const subsLabel = subTrack.label || subTrack.name || subTrack.language || subTrack.lang || 'nolabel';
            
            return this.createSingleSubtitleCommand(baseCommand, subTrack, baseFilename, subsLabel, container, options);
        }
        
        // Multi-track subtitle extraction - send individual commands
        return selectedSubtitleTracks.map((subTrack, index) => {
            const container = subTrack.subtitleContainer || 'srt';
            const baseFilename = baseCommand.filename || 'video';
            const subsLabel = subTrack.label || subTrack.name || subTrack.language || subTrack.lang || `subtitles_${index + 1}`;
            
            return this.createSingleSubtitleCommand(baseCommand, subTrack, baseFilename, subsLabel, container, options);
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
            label: track.name || track.label || track.lang || `audio_${index + 1}`,
            audioContainer: track.audioContainer || 'm4a'
        }));
    }

    /**
     * Get default or best quality audio track for auto-selection
     * @returns {Object} Audio track with isDefault flag
     */
    getDefaultOrBestAudioTrack() {
        const availableAudioTracks = this.videoData.audioTracks || [];
        
        if (availableAudioTracks.length > 0) {
            // First, look for a track marked as default
            const defaultTrack = availableAudioTracks.find(track => track.default === true);
            if (defaultTrack) {
                return {
                    ...defaultTrack,
                    label: defaultTrack.name || defaultTrack.label || defaultTrack.language || defaultTrack.lang || 'nolabel',
                    audioContainer: defaultTrack.audioContainer || 'm4a',
                    isDefault: true
                };
            }
            
            // If no default track, use the first track (best quality, as tracks are sorted)
            const bestTrack = availableAudioTracks[0];
            return {
                ...bestTrack,
                label: bestTrack.name || bestTrack.label || bestTrack.language || bestTrack.lang || 'nolabel',
                audioContainer: bestTrack.audioContainer || 'm4a',
                isDefault: false
            };
        }
        
        // For simple dropdown or direct videos, use the selected video track's audio
        const videoTrack = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
        return {
            audioContainer: videoTrack.audioContainer || 'm4a',
            label: 'audio',
            isDefault: false
        };
    }

    /**
     * Get default or best quality subtitle track for auto-selection
     * @returns {Object} Subtitle track with isDefault flag
     */
    getDefaultOrBestSubtitleTrack() {
        const availableSubtitleTracks = this.videoData.subtitleTracks || [];
        
        // First, look for a track marked as default
        const defaultTrack = availableSubtitleTracks.find(track => track.default === true);
        if (defaultTrack) {
            return {
                ...defaultTrack,
                label: defaultTrack.name || defaultTrack.label || defaultTrack.language || defaultTrack.lang || 'nolabel',
                subtitleContainer: defaultTrack.subtitleContainer || 'srt',
                isDefault: true
            };
        }
        
        // If no default track, use the first track (best quality, as tracks are sorted)
        const bestTrack = availableSubtitleTracks[0];
        return {
            ...bestTrack,
            label: bestTrack.name || bestTrack.label || bestTrack.language || bestTrack.lang || 'nolabel',
            subtitleContainer: bestTrack.subtitleContainer || 'srt',
            isDefault: false
        };
    }

    /**
     * Create a single subtitle extraction command
     * @param {Object} baseCommand - Base download command
     * @param {Object} subTrack - Subtitle track data
     * @param {string} baseFilename - Base filename
     * @param {string} subsLabel - Subtitle track label
     * @param {string} container - Subtitle container
     * @param {Object} options - Additional options
     * @returns {Object} Single subtitle command
     */
    createSingleSubtitleCommand(baseCommand, subTrack, baseFilename, subsLabel, container, options) {
        const command = { 
            ...baseCommand,
            container: container,
            filename: `${baseFilename}_subtitles_${subsLabel}.${container}`,
            subsOnly: true,
            ...options 
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
            url: this.videoData.normalizedUrl
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
                        this.downloadButton.setIntermediaryText('Stopping...');
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