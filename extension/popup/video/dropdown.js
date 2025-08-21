/**
 * VideoDropdownComponent - Class-based dropdown with centralized track management
 * Eliminates DOM dataset dependencies and provides clean track selection
 */

import { formatSize, buildTrackLabel } from '../../shared/utils/processing-utils.js';
import { createLogger } from '../../shared/utils/logger.js';

const logger = createLogger('VideoDropdownComponent');

// Container compatibility matrix for track muxing
const CONTAINER_COMPATIBILITY = {
    // MP4 container compatibility
    mp4: {
        video: ['mp4'],           // MP4 video tracks
        audio: ['mp4', 'm4a'],    // MP4 video + AAC/MP4 audio (m4a is MP4 with audio)
        subtitle: ['srt', 'ttml'] // MP4 supports SRT and TTML, but NOT VTT natively
    },
    
    // WebM container compatibility  
    webm: {
        video: ['webm'],          // WebM video tracks
        audio: ['webm'],          // WebM video + Opus/Vorbis audio
        subtitle: ['vtt']         // WebM primarily supports VTT subtitles
    },
    
    // MKV container compatibility (most flexible)
    mkv: {
        video: ['mp4', 'webm', 'mkv', 'ogg'], // MKV can contain almost any video
        audio: ['mp3', 'm4a', 'webm', 'ogg', 'flac', 'wav', 'mkv'], // MKV can contain any audio
        subtitle: ['srt', 'ass', 'vtt', 'ttml'] // MKV supports all subtitle formats
    },
    
    // OGG container compatibility
    ogg: {
        video: ['ogg'],           // OGG video tracks (Theora)
        audio: ['ogg'],           // OGG audio tracks (Vorbis)
        subtitle: ['srt']         // OGG has limited subtitle support
    }
};

// VideoDropdownComponent - Manages dropdown state and track selection
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
    
    // Determine if this should use advanced (multi-track) mode. True = advanced
    determineMode() {
        const hasAudioTracks = (this.videoData.audioTracks?.length || 0) > 0;
        const hasSubtitleTracks = (this.videoData.subtitleTracks?.length || 0) > 0;
        
        // Advanced mode if we have any audio or subtitle tracks
        return hasAudioTracks || hasSubtitleTracks;
    }
    
    // Render the dropdown component
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
        
        // Create progress container
        const progressContainer = document.createElement('div');
        progressContainer.className = 'progress-container';
        
        // Create content wrapper
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'content-wrapper';
        
        const dropdownIcon = document.createElement('div');
        dropdownIcon.className = 'dropdown-icon';
        dropdownIcon.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L5 5L9 1" stroke="#FAFAFA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        
        this.optionsContainer = document.createElement('div');
        this.optionsContainer.className = 'options-container';
        
        // Assemble structure
        contentWrapper.appendChild(dropdownIcon);
        this.selectedDisplay.appendChild(progressContainer);
        this.selectedDisplay.appendChild(contentWrapper);
        this.element.appendChild(this.selectedDisplay);
        this.element.appendChild(this.optionsContainer);
        
        // Setup event handlers
        this.selectedDisplay.addEventListener('click', this.handleClick);
        
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
	
    // Handle dropdown click to toggle open/close
    handleClick(e) {
        e.preventDefault();
		e.stopPropagation();
		
        this.element.classList.toggle('open');
        
        // Close all other dropdowns and button menus (mutually exclusive)
        document.querySelectorAll('.custom-dropdown.open, .download-menu-btn.open').forEach(menu => {
            if (menu !== this.element) {
                menu.classList.remove('open');
            }
        });
        
        // Update body expanded state - check for any open menu
        const anyMenuOpen = document.querySelector('.custom-dropdown.open, .download-menu-btn.open') !== null;
        document.body.classList.toggle('expanded', anyMenuOpen);
        
        // Setup click outside handler when opened
        if (this.element.classList.contains('open')) {
            setTimeout(() => {
                document.addEventListener('click', this.handleClickOutside, { once: true });
            }, 0);
        }
    }
    
    // Handle clicks outside dropdown to close it. e - click event
    handleClickOutside(e) {
        if (!this.element.contains(e.target)) {
            this.element.classList.remove('open');
            
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
    
    // Create simple options for single-track selection
    createSimpleOptions() {
        // For direct videos during processing, videoTracks might not exist yet
        const videoTracks = this.videoData.videoTracks?.length > 0 ? 
            this.videoData.videoTracks : [this.videoData];
        
        videoTracks.forEach((track, index) => {
            const option = document.createElement('div');
            option.className = 'dropdown-option';
            option.dataset.url = track.url;
            
            // First option is selected by default
            if (index === 0) {
                option.classList.add('selected');
            }
            
            const labelSpan = document.createElement('span');
            labelSpan.className = 'label';
            
            // Build and store label on track object to avoid duplication
            if (!track._cachedLabel) {
                track._cachedLabel = buildTrackLabel(track, 'video', this.videoData.type);
            }
            labelSpan.textContent = track._cachedLabel;
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
                
                // Close dropdown and update body expanded state (simple mode closes immediately)
                this.element.classList.remove('open');
                const anyMenuOpen = document.querySelector('.custom-dropdown.open, .download-menu-btn.open') !== null;
                document.body.classList.toggle('expanded', anyMenuOpen);
            });
            
            this.optionsContainer.appendChild(option);
        });
    }
    
    // Create advanced options for multi-track selection
    createAdvancedOptions() {
        const columnsContainer = document.createElement('div');
        columnsContainer.className = 'tracks-columns-container';
        
        const { videoTracks = [], audioTracks = [], subtitleTracks = [] } = this.videoData;
        
        // Create video column
        if (videoTracks?.length > 0) {
            const videoColumn = this.createTrackColumn('VIDEO', videoTracks, 'video', true);
            columnsContainer.appendChild(videoColumn);
        }
        
        // Create audio column
        if (audioTracks?.length > 0) {
            const audioColumn = this.createTrackColumn('AUDIO', audioTracks, 'audio', false);
            columnsContainer.appendChild(audioColumn);
        }
        
        // Create subtitle column
        if (subtitleTracks?.length > 0) {
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
            
            // Build and store label on track object to avoid duplication
            if (!track._cachedLabel) {
                track._cachedLabel = buildTrackLabel(track, type, this.videoData.type);
            }
            label.textContent = track._cachedLabel;
            
            option.appendChild(input);
            option.appendChild(label);
            
            option.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
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
        
        // Update display and notify (but don't close dropdown - let user continue selecting)
        this.updateSelectedDisplay();
        this.onSelectionChange(this.selectedTracks);
    }
    
    // Update the selected display based on current selection
    updateSelectedDisplay() {
        const contentWrapper = this.selectedDisplay.querySelector('.content-wrapper');
        if (!contentWrapper) return;
        
        // Remove existing label
        contentWrapper.querySelector('.label')?.remove();
        
        const label = document.createElement('span');
        label.className = 'label';
        
        // Show processing text based on video type
        if (this.videoData.processing) {
            if (this.videoData.type === 'hls' || this.videoData.type === 'dash') {
                label.textContent = 'Parsing...';
            } else if (this.videoData.type === 'direct') {
                label.textContent = 'Probing...';
            } else {
                label.textContent = 'Processing...';
            }
            this.selectedDisplay.classList.add('processing');
        } else {
            this.selectedDisplay.classList.remove('processing');
            
            if (this.isAdvancedMode) {
                label.textContent = this.buildAdvancedSummary();
            } else {
                const track = this.selectedTracks.videoTrack || this.videoData.videoTracks?.[0] || this.videoData;
                // Use cached label or build if not available
                const fullLabel = track._cachedLabel || buildTrackLabel(track, 'video', this.videoData.type);
                const parts = fullLabel.split(' • ');
                label.textContent = parts.slice(0, 2).join(' • ');
            }
        }
        
        // Insert label before dropdown icon
        const dropdownIcon = contentWrapper.querySelector('.dropdown-icon');
        contentWrapper.insertBefore(label, dropdownIcon);
    }
    
    // Build summary text for advanced mode
    buildAdvancedSummary() {
        let summary = '';
        let totalSize = 0;
        
        // Get resolution from video track using cached label
        if (this.selectedTracks.videoTrack) {
            const trackLabel = this.selectedTracks.videoTrack._cachedLabel || buildTrackLabel(this.selectedTracks.videoTrack, 'video', this.videoData.type);
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
    
    // Update track compatibility when video track changes
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
        
        // Find track by matching cached label
        return tracks?.find(track => track._cachedLabel === trackLabel);
    }
}

/**
 * Check if a specific track type is compatible with a video container
 * @param {string} trackContainer - Container of the track to check
 * @param {string} trackType - Type of track ('audio' or 'subtitle')
 * @param {string} videoContainer - Container of the video track
 * @returns {boolean} True if compatible
 */
export function isTrackCompatibleWithVideo(trackContainer, trackType, videoContainer) {
    const videoRules = CONTAINER_COMPATIBILITY[videoContainer];
    if (!videoRules || !trackContainer) return false;
    
    const compatibleContainers = videoRules[trackType];
    return compatibleContainers ? compatibleContainers.includes(trackContainer) : false;
}