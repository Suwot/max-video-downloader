/**
 * VideoDropdownComponent - Class-based dropdown with centralized track management
 * Eliminates DOM dataset dependencies and provides clean track selection
 */

import { formatSize } from '../../shared/utils/processing-utils.js';
import { isTrackCompatibleWithVideo } from '../../background/processing/container-detector.js';
import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('VideoDropdownComponent');

/**
 * VideoDropdownComponent - Manages dropdown state and track selection
 */
export class VideoDropdownComponent {
    constructor(videoData, selectedTracks, onSelectionChange) {
        this.videoData = videoData;
        this.selectedTracks = selectedTracks;
        this.onSelectionChange = onSelectionChange;
        this.element = null;
        this.selectedDisplay = null;
        this.optionsContainer = null;
        this.isAdvancedMode = this.determineMode();
        
        // Bind methods to preserve context
        this.handleClick = this.handleClick.bind(this);
        this.handleClickOutside = this.handleClickOutside.bind(this);
    }
    
    /**
     * Determine if this should use advanced (multi-track) mode
     * @returns {boolean} True if advanced mode should be used
     */
    determineMode() {
        const hasOnlyVideoTracks = (this.videoData.audioTracks?.length || 0) === 0 && 
                                  (this.videoData.subtitleTracks?.length || 0) === 0;
        return !hasOnlyVideoTracks;
    }
    
    /**
     * Render the dropdown component
     * @returns {HTMLElement} The rendered dropdown element
     */
    render() {
        this.element = document.createElement('div');
        this.element.className = 'custom-dropdown';
        this.element.dataset.type = this.videoData.type;
        
        if (this.isAdvancedMode) {
            this.element.classList.add('advanced');
        }
        
        // Store component reference
        this.element._component = this;
        
        this.selectedDisplay = document.createElement('div');
        this.selectedDisplay.className = 'selected-option';
        
        const dropdownIcon = document.createElement('div');
        dropdownIcon.className = 'dropdown-icon';
        dropdownIcon.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L5 5L9 1" stroke="#FAFAFA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        
        this.optionsContainer = document.createElement('div');
        this.optionsContainer.className = 'options-container';
        
        this.selectedDisplay.appendChild(dropdownIcon);
        this.element.appendChild(this.selectedDisplay);
        this.element.appendChild(this.optionsContainer);
        
        // Setup event handlers
        this.setupEventHandlers();
        
        // Create options based on mode
        if (this.isAdvancedMode) {
            this.createAdvancedOptions();
        } else {
            this.createSimpleOptions();
        }
        
        // Initialize display
        this.updateSelectedDisplay();
        
        return this.element;
    }
    
    /**
     * Setup event handlers for dropdown interactions
     */
    setupEventHandlers() {
        this.selectedDisplay.addEventListener('click', this.handleClick);
    }
    
    /**
     * Handle dropdown click to toggle open/close
     */
    handleClick() {
        this.element.classList.toggle('open');
        
        // Close other dropdowns
        document.querySelectorAll('.custom-dropdown.open').forEach(dropdown => {
            if (dropdown !== this.element) {
                dropdown.classList.remove('open');
            }
        });
        
        // Update body expanded state
        const anyDropdownOpen = document.querySelector('.custom-dropdown.open') !== null;
        document.body.classList.toggle('expanded', anyDropdownOpen);
        
        // Setup click outside handler when opened
        if (this.element.classList.contains('open')) {
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
    }
    
    /**
     * Handle clicks outside dropdown to close it
     * @param {Event} e - Click event
     */
    handleClickOutside(e) {
        if (!this.element.contains(e.target)) {
            this.element.classList.remove('open');
            
            // Update body expanded state
            const anyDropdownOpen = document.querySelector('.custom-dropdown.open') !== null;
            document.body.classList.toggle('expanded', anyDropdownOpen);
        } else {
            // Re-add listener if clicked inside
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
    }
    
    /**
     * Create simple options for single-track selection
     */
    createSimpleOptions() {
        const videoTracks = this.videoData.videoTracks?.length > 0 ? 
            this.videoData.videoTracks : [this.videoData];
        
        videoTracks.forEach((track, index) => {
            const option = document.createElement('div');
            option.className = 'dropdown-option';
            
            // First option is selected by default
            if (index === 0) {
                option.classList.add('selected');
            }
            
            const labelSpan = document.createElement('span');
            labelSpan.className = 'label';
            labelSpan.textContent = this.formatVariantLabel(track);
            option.appendChild(labelSpan);
            
            option.addEventListener('click', () => {
                // Update selection
                this.optionsContainer.querySelectorAll('.dropdown-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                option.classList.add('selected');
                
                // Update selected tracks
                this.selectedTracks.videoTrack = track;
                
                // Update display and notify
                this.updateSelectedDisplay();
                this.onSelectionChange(this.selectedTracks);
                
                // Close dropdown
                this.element.classList.remove('open');
            });
            
            this.optionsContainer.appendChild(option);
        });
    }
    
    /**
     * Create advanced options for multi-track selection
     */
    createAdvancedOptions() {
        const columnsContainer = document.createElement('div');
        columnsContainer.className = 'tracks-columns-container';
        
        const { videoTracks = [], audioTracks = [], subtitleTracks = [] } = this.videoData;
        
        // Create video column
        if (videoTracks.length > 0) {
            const videoColumn = this.createTrackColumn('VIDEO', videoTracks, 'video', true);
            columnsContainer.appendChild(videoColumn);
        }
        
        // Create audio column
        if (audioTracks.length > 0) {
            const audioColumn = this.createTrackColumn('AUDIO', audioTracks, 'audio', false);
            columnsContainer.appendChild(audioColumn);
        }
        
        // Create subtitle column
        if (subtitleTracks.length > 0) {
            const subsColumn = this.createTrackColumn('SUBS', subtitleTracks, 'subtitle', false);
            columnsContainer.appendChild(subsColumn);
        }
        
        this.optionsContainer.appendChild(columnsContainer);
        
        // Update compatibility based on initial video selection
        this.updateCompatibility();
    }
    
    /**
     * Create a column for track selection
     * @param {string} title - Column title
     * @param {Array} tracks - Track options
     * @param {string} type - Track type (video, audio, subtitle)
     * @param {boolean} singleSelect - Whether only one option can be selected
     * @returns {HTMLElement} Column element
     */
    createTrackColumn(title, tracks, type, singleSelect) {
        const column = document.createElement('div');
        column.className = `column ${type}`;
        
        const columnTitle = document.createElement('div');
        columnTitle.className = 'column-title';
        columnTitle.textContent = title;
        column.appendChild(columnTitle);
        
        tracks.forEach((track, index) => {
            const option = document.createElement('div');
            option.className = 'track-option';
            
            const input = document.createElement('input');
            input.type = singleSelect ? 'radio' : 'checkbox';
            input.name = `track-${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Check if this track should be selected by default
            const isSelected = this.isTrackSelected(track, type);
            if (isSelected) {
                option.classList.add('selected');
                input.checked = true;
            }
            
            const label = document.createElement('span');
            label.className = 'track-label';
            label.textContent = this.formatTrackLabel(track, type);
            
            option.appendChild(input);
            option.appendChild(label);
            
            option.addEventListener('click', () => {
                this.handleTrackOptionClick(option, input, track, type, singleSelect, column);
            });
            
            column.appendChild(option);
        });
        
        return column;
    }
    
    /**
     * Check if a track is currently selected
     * @param {Object} track - Track to check
     * @param {string} type - Track type
     * @returns {boolean} True if track is selected
     */
    isTrackSelected(track, type) {
        switch (type) {
            case 'video':
                return this.selectedTracks.videoTrack?.id === track.id;
            case 'audio':
                return this.selectedTracks.audioTracks.some(t => t.id === track.id);
            case 'subtitle':
                return this.selectedTracks.subtitleTracks.some(t => t.id === track.id);
            default:
                return false;
        }
    }
    
    /**
     * Handle track option click
     * @param {HTMLElement} option - Option element
     * @param {HTMLElement} input - Input element
     * @param {Object} track - Track data
     * @param {string} type - Track type
     * @param {boolean} singleSelect - Whether single select mode
     * @param {HTMLElement} column - Column element
     */
    handleTrackOptionClick(option, input, track, type, singleSelect, column) {
        if (singleSelect) {
            // Deselect all others in this column
            column.querySelectorAll('.track-option').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('input').checked = false;
            });
            
            // Select this option
            option.classList.add('selected');
            input.checked = true;
            
            // Update selected tracks
            if (type === 'video') {
                this.selectedTracks.videoTrack = track;
                // Update compatibility when video track changes
                this.updateCompatibility();
            }
        } else {
            // Toggle selection
            option.classList.toggle('selected');
            input.checked = option.classList.contains('selected');
            
            // Update selected tracks array
            if (type === 'audio') {
                if (input.checked) {
                    if (!this.selectedTracks.audioTracks.some(t => t.id === track.id)) {
                        this.selectedTracks.audioTracks.push(track);
                    }
                } else {
                    this.selectedTracks.audioTracks = this.selectedTracks.audioTracks.filter(t => t.id !== track.id);
                }
            } else if (type === 'subtitle') {
                if (input.checked) {
                    if (!this.selectedTracks.subtitleTracks.some(t => t.id === track.id)) {
                        this.selectedTracks.subtitleTracks.push(track);
                    }
                } else {
                    this.selectedTracks.subtitleTracks = this.selectedTracks.subtitleTracks.filter(t => t.id !== track.id);
                }
            }
        }
        
        // Update display and notify
        this.updateSelectedDisplay();
        this.onSelectionChange(this.selectedTracks);
    }
    
    /**
     * Update the selected display based on current selection
     */
    updateSelectedDisplay() {
        // Remove existing label
        this.selectedDisplay.querySelector('.label')?.remove();
        
        const label = document.createElement('span');
        label.className = 'label';
        
        if (this.isAdvancedMode) {
            label.textContent = this.buildAdvancedSummary();
        } else {
            const track = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
            const parts = this.formatVariantLabel(track).split(' • ');
            label.textContent = parts.slice(0, 2).join(' • ');
        }
        
        this.selectedDisplay.prepend(label);
    }
    
    /**
     * Build summary text for advanced mode
     * @returns {string} Summary text
     */
    buildAdvancedSummary() {
        let summary = '';
        let totalSize = 0;
        
        // Get resolution from video track
        if (this.selectedTracks.videoTrack) {
            const trackLabel = this.formatTrackLabel(this.selectedTracks.videoTrack, 'video');
            const resMatch = trackLabel.match(/(\d+p\d*)/);
            summary = resMatch?.[0] || 'Custom';
            
            // Add video file size
            const videoSize = this.selectedTracks.videoTrack.estimatedFileSizeBytes || 
                             this.selectedTracks.videoTrack.metaJS?.estimatedFileSizeBytes;
            if (videoSize) {
                totalSize += videoSize;
            }
        } else {
            summary = 'Custom';
        }
        
        // Add audio sizes
        this.selectedTracks.audioTracks.forEach(audio => {
            const audioSize = audio.estimatedFileSizeBytes;
            if (audioSize) {
                totalSize += audioSize;
            }
        });
        
        // Build track counts
        const trackCounts = [];
        if (this.selectedTracks.audioTracks.length === 0 && this.selectedTracks.videoTrack) {
            trackCounts.push('no audio');
        } else if (this.selectedTracks.audioTracks.length > 0) {
            trackCounts.push(`${this.selectedTracks.audioTracks.length} audio`);
        }
        
        if (this.selectedTracks.subtitleTracks.length > 0) {
            trackCounts.push(`${this.selectedTracks.subtitleTracks.length} subs`);
        }
        
        if (trackCounts.length > 0) {
            summary += ` (${trackCounts.join(', ')})`;
        }
        
        if (totalSize > 0) {
            summary += ` ≈ ${formatSize(totalSize)}`;
        }
        
        return summary;
    }
    
    /**
     * Update track compatibility when video track changes
     */
    updateCompatibility() {
        if (!this.isAdvancedMode || !this.selectedTracks.videoTrack?.videoContainer) {
            return;
        }
        
        const videoContainer = this.selectedTracks.videoTrack.videoContainer;
        const columnsContainer = this.optionsContainer.querySelector('.tracks-columns-container');
        
        if (!columnsContainer) return;
        
        // Check all audio tracks
        columnsContainer.querySelectorAll('.column.audio .track-option').forEach(option => {
            const trackData = this.getTrackFromOption(option, 'audio');
            const isCompatible = trackData?.audioContainer ? 
                isTrackCompatibleWithVideo(trackData.audioContainer, 'audio', videoContainer) : false;
            
            option.classList.remove('compatible', 'incompatible');
            option.classList.add(isCompatible ? 'compatible' : 'incompatible');
        });
        
        // Check all subtitle tracks
        columnsContainer.querySelectorAll('.column.subtitle .track-option').forEach(option => {
            const trackData = this.getTrackFromOption(option, 'subtitle');
            const isCompatible = trackData?.subtitleContainer ? 
                isTrackCompatibleWithVideo(trackData.subtitleContainer, 'subtitle', videoContainer) : false;
            
            option.classList.remove('compatible', 'incompatible');
            option.classList.add(isCompatible ? 'compatible' : 'incompatible');
        });
    }
    
    /**
     * Get track data from option element
     * @param {HTMLElement} option - Track option element
     * @param {string} type - Track type
     * @returns {Object|null} Track data
     */
    getTrackFromOption(option, type) {
        const trackLabel = option.querySelector('.track-label')?.textContent;
        if (!trackLabel) return null;
        
        const tracks = type === 'audio' ? this.videoData.audioTracks : this.videoData.subtitleTracks;
        
        // Find track by matching label (simple approach)
        return tracks?.find(track => {
            const formattedLabel = this.formatTrackLabel(track, type);
            return formattedLabel === trackLabel;
        });
    }
    
    /**
     * Format the label for a track option
     * @param {Object} track - Track data
     * @param {string} type - Track type
     * @returns {string} Formatted label
     */
    formatTrackLabel(track, type) {
        if (type === 'video') {
            // Handle both DASH and HLS video tracks
            let res, fps, fileSizeBytes, codecs;
            
            if (track.metaJS) {
                // HLS video track structure
                res = track.metaJS.standardizedResolution || null;
                fps = track.metaJS.fps || null;
                fileSizeBytes = track.metaJS.estimatedFileSizeBytes ? 
                    formatSize(track.metaJS.estimatedFileSizeBytes) : null;
                codecs = track.metaJS.codecs ? track.metaJS.codecs.split('.')[0] : null;
            } else {
                // DASH video track structure
                res = track.standardizedResolution || null;
                fps = track.frameRate || null;
                fileSizeBytes = track.estimatedFileSizeBytes ? 
                    formatSize(track.estimatedFileSizeBytes) : null;
                codecs = track.codecs ? track.codecs.split('.')[0] : null;
            }
            
            const formattedResolution = res ? 
                ((fps && fps !== 30) ? `${res}${fps}` : res) : null;

            return [formattedResolution, fileSizeBytes, codecs]
                .filter(Boolean)
                .join(' • '); 

        } else if (type === 'audio') {
            // Handle both DASH and HLS audio tracks
            let language, channels, fileSizeBytes, codecs;
            
            if (track.name !== undefined) {
                // HLS audio track structure
                language = track.default ? `${track.name || track.language}*` : 
                          (track.name || track.language);
                channels = track.channels || null;
                fileSizeBytes = null; // HLS audio tracks don't have individual file sizes
                codecs = null; // HLS audio codecs not specified in master
            } else {
                // DASH audio track structure
                language = track.isDefault ? `${track.label || track.lang}*` : 
                          (track.label || track.lang);
                channels = track.channels ? `${track.channels}ch` : null;
                fileSizeBytes = track.estimatedFileSizeBytes ? 
                    formatSize(track.estimatedFileSizeBytes) : null;
                codecs = track.codecs ? track.codecs.split('.')[0] : null;
            }

            return [language, channels, fileSizeBytes, codecs]
                .filter(Boolean)
                .join(' • ');

        } else {
            // Subtitle tracks - handle both DASH and HLS
            let language;
            
            if (track.name !== undefined) {
                // HLS subtitle track structure
                language = track.default ? `${track.name || track.language || 'Subtitle'}*` : 
                          (track.name || track.language || 'Subtitle');
            } else {
                // DASH subtitle track structure
                language = track.isDefault ? `${track.label || track.lang || 'Subtitle'}*` : 
                          (track.label || track.lang || 'Subtitle');
            }

            return language;
        }
    }
    
    /**
     * Format the displayed label for a video track (simple mode)
     * @param {Object} videoTrack - Video track data
     * @returns {string} Formatted label
     */
    formatVariantLabel(videoTrack) {
        if (!videoTrack) return "Unknown Quality";

        if (this.videoData.type === 'hls') {
            const meta = videoTrack.metaJS || {};
            const res = meta.standardizedResolution || null;
            const fps = meta.fps || null;
            const formattedResolution = res ? 
                ((fps && fps !== 30) ? `${res}${fps}` : res) : null;
                
            const fileSizeBytes = meta.estimatedFileSizeBytes ? 
                formatSize(meta.estimatedFileSizeBytes) : null;
                
            const fullResolution = meta.resolution || null;
            const formattedCodecs = this.getFormattedCodecs(videoTrack, 'hls');
            
            return [formattedResolution, fileSizeBytes, fullResolution, formattedCodecs]
                .filter(Boolean)
                .join(' • ') || 'Unknown Quality';
        } else {
            // Direct video formatting
            const res = videoTrack.standardizedResolution || null;
            const fps = videoTrack.metaFFprobe?.fps || null;
            const formattedResolution = res ? 
                ((fps && fps !== 30) ? `${res}${fps}` : res) : null;

            const fileSize = videoTrack.fileSize ? formatSize(videoTrack.fileSize) : 
                (videoTrack.estimatedFileSizeBytes ? formatSize(videoTrack.estimatedFileSizeBytes) : null);
            
            const formattedCodecs = this.getFormattedCodecs(videoTrack, 'direct');
            
            return [formattedResolution, fileSize, formattedCodecs]
                .filter(Boolean)
                .join(' • ') || 'Unknown Quality';
        }
    }
    
    /**
     * Get formatted codecs based on media type
     * @param {Object} media - Media object (video track)
     * @param {string} type - Media type
     * @returns {string|null} Formatted codecs string
     */
    getFormattedCodecs(media, type) {
        if (type === 'hls') {
            return media.metaJS?.codecs ? 
                media.metaJS.codecs
                    .split(',')
                    .map(codec => codec.split('.')[0])
                    .join(' & ') 
                : null;
        }
        
        if (media.codecs) {
            return media.codecs.split('.')[0];
        }
        
        // For direct videos
        const videoCodec = media.metaFFprobe?.videoCodec?.name || null;
        const audioCodec = media.metaFFprobe?.audioCodec?.name || null;
        const audioChannels = media.metaFFprobe?.audioCodec?.channels ? 
            `${media.metaFFprobe.audioCodec.channels}ch` : null;
        
        if (videoCodec && audioCodec && audioChannels) {
            return `${videoCodec} & ${audioCodec} (${audioChannels})`;
        } else if (videoCodec && audioCodec) {
            return `${videoCodec} & ${audioCodec}`;
        } else {
            return videoCodec || audioCodec || null;
        }
    }
    
    /**
     * Update video data (for dynamic updates)
     * @param {Object} newVideoData - Updated video data
     */
    updateVideoData(newVideoData) {
        this.videoData = { ...this.videoData, ...newVideoData };
        // Could re-render if needed, but typically not necessary
    }
    
    /**
     * Cleanup component resources
     */
    cleanup() {
        if (this.element) {
            this.element._component = null;
        }
    }
}