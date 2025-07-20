/**
 * Custom dropdown component for video quality selection
 * Supports simple selection (HLS/Direct) and advanced multi-track selection (DASH)
 */

import { formatSize } from '../../shared/utils/processing-utils.js';
import { isTrackCompatibleWithVideo } from '../../background/processing/container-detector.js';

/**
 * Creates dropdown structure with proper elements
 * @param {string} type - Video type (direct, hls, dash)
 * @returns {HTMLElement} Container with nested elements
 */
function createDropdownElements(type) {
    const container = document.createElement('div');
    container.className = 'custom-dropdown';
    container.dataset.type = type;
    
    const selectedDisplay = document.createElement('div');
    selectedDisplay.className = 'selected-option';
    
    const dropdownIcon = document.createElement('div');
    dropdownIcon.className = 'dropdown-icon';
    dropdownIcon.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1L5 5L9 1" stroke="#FAFAFA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    
    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'options-container';
    
    selectedDisplay.appendChild(dropdownIcon);
    container.appendChild(selectedDisplay);
    container.appendChild(optionsContainer);
    
    container.elements = { selectedDisplay, optionsContainer };
    return container;
}

/**
 * Creates a custom dropdown component
 * @param {Object} video - Complete video object with all data
 * @param {Function} [onChange] - Optional callback when selection changes
 * @returns {HTMLElement} The custom dropdown component
 */
export function createCustomDropdown(video, onChange = null) {
    const { type, url } = video;
    
    const container = createDropdownElements(type);
    const { selectedDisplay, optionsContainer } = container.elements;
    
    setupDropdownEvents(container);
    
    // Determine if this should use advanced (multi-track) mode
    const hasOnlyVideoTracks = (video.audioTracks?.length || 0) === 0 && 
                              (video.subtitleTracks?.length || 0) === 0;
    const useAdvancedMode = !hasOnlyVideoTracks;
    
    if (useAdvancedMode) {
        const tracks = {
            videoTracks: video.videoTracks || [],
            audioTracks: video.audioTracks || [],
            subtitleTracks: video.subtitleTracks || []
        };
        
        selectedDisplay.dataset.url = url;
        createAdvancedOptions(optionsContainer, tracks, selectedDisplay, onChange);
        initializeAdvancedSelection(selectedDisplay, tracks, type);
    } else {
        // Simple mode - use videoTracks for all video types
        const videoTracks = video.videoTracks?.length > 0 ? video.videoTracks : [video];
        
        createSimpleOptions(optionsContainer, videoTracks, selectedDisplay, type, onChange);
        initializeSimpleSelection(selectedDisplay, videoTracks[0], type);
    }
    
    return container;
}

/**
 * Sets up event handlers for dropdown interactions
 * @param {HTMLElement} container - Dropdown container element
 */
function setupDropdownEvents(container) {
    const { selectedDisplay } = container.elements;
    
    const updateBodyExpandedState = () => {
        const anyDropdownOpen = document.querySelector('.custom-dropdown.open') !== null;
        document.body.classList.toggle('expanded', anyDropdownOpen);
    };
    
    selectedDisplay.addEventListener('click', () => {
        container.classList.toggle('open');
        
        // Close other dropdowns
        document.querySelectorAll('.custom-dropdown.open').forEach(dropdown => {
            if (dropdown !== container) {
                dropdown.classList.remove('open');
            }
        });
        
        updateBodyExpandedState();
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
            updateBodyExpandedState();
        }
    });
}

/**
 * Create options for simple dropdown (all video types in simple mode)
 * @param {HTMLElement} container - Options container element
 * @param {Array} videoTracks - Available video tracks (presorted, best first)
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {string} type - Video type
 * @param {Function} onChange - Callback when selection changes
 */
function createSimpleOptions(container, videoTracks, selectedDisplay, type, onChange) {
    if (!videoTracks?.length) return;
    
    videoTracks.forEach((track, index) => {
        const option = document.createElement('div');
        option.className = 'dropdown-option';
        
        // First option is selected by default (presorted data)
        if (index === 0) {
            option.classList.add('selected');
        }
        
        const labelSpan = document.createElement('span');
        labelSpan.className = 'label';
        labelSpan.textContent = formatVariantLabel(track, type);
        option.appendChild(labelSpan);
        
        option.dataset.url = track.url;
        setVariantFilesize(option, track, type);
        
        option.addEventListener('click', () => {
            container.querySelectorAll('.dropdown-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            option.classList.add('selected');
            
            updateSimpleSelection(selectedDisplay, track, type);
            if (onChange) onChange(track);
            container.closest('.custom-dropdown').classList.remove('open');
        });
        
        container.appendChild(option);
    });
}

/**
 * Create advanced multi-track options (DASH and future HLS with media groups)
 * @param {HTMLElement} container - Options container element
 * @param {Object} tracks - Object containing video, audio, and subtitle tracks
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {Function} onChange - Callback when selection changes
 */
function createAdvancedOptions(container, tracks, selectedDisplay, onChange) {
    const { videoTracks = [], audioTracks = [], subtitleTracks = [] } = tracks;
    
    const columnsContainer = document.createElement('div');
    columnsContainer.className = 'tracks-columns-container';
    
    // Store track data on the container for easy access
    columnsContainer.tracksData = { videoTracks, audioTracks, subtitleTracks };
    
    // Create columns for each track type
    const videoColumn = createTrackColumn('VIDEO', videoTracks, 'video', true, columnsContainer, selectedDisplay, onChange);
    columnsContainer.appendChild(videoColumn);
    
    const audioColumn = createTrackColumn('AUDIO', audioTracks, 'audio', false, columnsContainer, selectedDisplay, onChange);
    columnsContainer.appendChild(audioColumn);
    
    if (subtitleTracks.length > 0) {
        const subsColumn = createTrackColumn('SUBS', subtitleTracks, 'subtitle', false, columnsContainer, selectedDisplay, onChange);
        columnsContainer.appendChild(subsColumn);
    }
    
    container.appendChild(columnsContainer);
}

/**
 * Create a column for track selection
 * @param {string} title - Column title (VIDEO, AUDIO, SUBS)
 * @param {Array} tracks - Track options (presorted, best first)
 * @param {string} type - Track type (video, audio, subtitle)
 * @param {boolean} singleSelect - Whether only one option can be selected
 * @param {HTMLElement} columnsContainer - Container for all columns
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {Function} onChange - Callback when selection changes
 * @returns {HTMLElement} Column element
 */
function createTrackColumn(title, tracks, type, singleSelect, columnsContainer, selectedDisplay, onChange) {
    const column = document.createElement('div');
    column.className = `column ${type}`;
    
    const columnTitle = document.createElement('div');
    columnTitle.className = 'column-title';
    columnTitle.textContent = title;
    column.appendChild(columnTitle);
    
    tracks.forEach((track, index) => {
        const option = document.createElement('div');
        option.className = 'track-option';
        option.dataset.id = track.id;
        
        // Store file size for calculations
        if (track.estimatedFileSizeBytes) {
            option.dataset.filesize = track.estimatedFileSizeBytes;
        }
        
        // First track is selected by default (presorted data)
        if (index === 0) {
            option.classList.add('selected');
        }
        
        const input = document.createElement('input');
        input.type = singleSelect ? 'radio' : 'checkbox';
        input.name = `track-${type}`;
        input.checked = index === 0;
        
        const label = document.createElement('span');
        label.className = 'track-label';
        label.textContent = formatTrackLabel(track, type);
        
        option.appendChild(input);
        option.appendChild(label);
        
        option.addEventListener('click', () => {
            if (singleSelect) {
                // Deselect all others in this column
                column.querySelectorAll('.track-option').forEach(opt => {
                    opt.classList.remove('selected');
                    opt.querySelector('input').checked = false;
                });
                
                // Update compatibility when video track changes
                if (type === 'video') {
                    const trackData = getTrackByIdFromColumn(column, track.id);
                    if (trackData?.videoContainer) {
                        updateTracksCompatibility(trackData.videoContainer, columnsContainer);
                    }
                }
            }
            
            // Toggle selection
            option.classList.toggle('selected');
            input.checked = option.classList.contains('selected');
            
            // Update selection immediately
            updateAdvancedSelection(selectedDisplay, columnsContainer);
            if (onChange) onChange(getAdvancedSelection(columnsContainer));
        });
        
        column.appendChild(option);
    });
    
    return column;
}

/**
 * Set filesize data attribute for video track option
 * @param {HTMLElement} option - Option element
 * @param {Object} videoTrack - Video track data
 * @param {string} type - Video type
 */
function setVariantFilesize(option, videoTrack, type) {
    if (type === 'hls') {
        if (videoTrack.metaJS?.estimatedFileSizeBytes) {
            option.dataset.filesize = videoTrack.metaJS.estimatedFileSizeBytes;
        }
    } else {
        const filesize = videoTrack.metadata?.contentLength || 
                        videoTrack.metaFFprobe?.sizeBytes || 
                        videoTrack.metaFFprobe?.estimatedFileSizeBytes ||
                        videoTrack.fileSize ||
                        videoTrack.estimatedFileSizeBytes;
        if (filesize) {
            option.dataset.filesize = filesize;
        }
    }
}

/**
 * Initialize simple selection (first video track selected by default)
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {Object} videoTrack - First video track
 * @param {string} type - Video type
 */
function initializeSimpleSelection(selectedDisplay, videoTrack, type) {
    updateSimpleSelection(selectedDisplay, videoTrack, type);
}

/**
 * Update simple selection display
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {Object} videoTrack - Selected video track
 * @param {string} type - Video type
 */
function updateSimpleSelection(selectedDisplay, videoTrack, type) {
    selectedDisplay.querySelector('.label')?.remove();
    
    const label = document.createElement('span');
    label.className = 'label';
    const parts = formatVariantLabel(videoTrack, type).split(' • ');
    label.textContent = parts.slice(0, 2).join(' • ');
    
    selectedDisplay.dataset.url = videoTrack.url || '';
    setVariantFilesize(selectedDisplay, videoTrack, type);
    selectedDisplay.prepend(label);
}

/**
 * Initialize advanced selection (first track from each column selected by default)
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {Object} tracks - Track data
 * @param {string} _type - Video type (unused)
 */
function initializeAdvancedSelection(selectedDisplay, tracks, _type) {
    const { videoTracks = [], audioTracks = [], subtitleTracks = [] } = tracks;
    
    // Set initial trackMap
    const indices = [
        videoTracks[0]?.ffmpegStreamIndex,
        audioTracks[0]?.ffmpegStreamIndex,
        subtitleTracks[0]?.ffmpegStreamIndex
    ].filter(Boolean);
    
    selectedDisplay.dataset.trackMap = indices.join(',');
    
    // Update compatibility based on first video track
    if (videoTracks[0]?.videoContainer) {
        const container = selectedDisplay.closest('.custom-dropdown');
        const columnsContainer = container?.querySelector('.tracks-columns-container');
        if (columnsContainer) {
            updateTracksCompatibility(videoTracks[0].videoContainer, columnsContainer);
        }
    }
    
    updateAdvancedSelection(selectedDisplay, null);
}

/**
 * Update advanced selection display
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {HTMLElement} columnsContainer - Columns container (optional, will find if not provided)
 */
function updateAdvancedSelection(selectedDisplay, columnsContainer) {
    if (!columnsContainer) {
        columnsContainer = selectedDisplay.closest('.custom-dropdown')?.querySelector('.tracks-columns-container');
    }
    if (!columnsContainer) return;
    
    selectedDisplay.querySelector('.label')?.remove();
    
    const label = document.createElement('span');
    label.className = 'label';
    
    // Get selected tracks info
    const selectedVideo = columnsContainer.querySelector('.column.video .track-option.selected');
    const selectedAudio = columnsContainer.querySelectorAll('.column.audio .track-option.selected');
    const selectedSubs = columnsContainer.querySelectorAll('.column.subtitle .track-option.selected');
    
    // Calculate total size and build summary
    let totalSize = 0;
    let resolutionText = '';
    
    // Get resolution from video track
    if (selectedVideo) {
        const trackLabel = selectedVideo.querySelector('.track-label')?.textContent;
        const resMatch = trackLabel?.match(/(\d+p\d*)/);
        resolutionText = resMatch?.[0] || 'Custom';
        
        if (selectedVideo.dataset.filesize) {
            totalSize += parseInt(selectedVideo.dataset.filesize, 10);
        }
    }
    
    // Add audio sizes
    selectedAudio.forEach(audio => {
        if (audio.dataset.filesize) {
            totalSize += parseInt(audio.dataset.filesize, 10);
        }
    });
    
    // Build summary text
    let summary = resolutionText || 'Custom';
    
    const trackCounts = [];
    if (selectedAudio.length === 0 && selectedVideo) {
        trackCounts.push('no audio');
    } else if (selectedAudio.length > 0) {
        trackCounts.push(`${selectedAudio.length} audio`);
    }
    
    if (selectedSubs.length > 0) {
        trackCounts.push(`${selectedSubs.length} subs`);
    }
    
    if (trackCounts.length > 0) {
        summary += ` (${trackCounts.join(', ')})`;
    }
    
    if (totalSize > 0) {
        summary += ` ≈ ${formatSize(totalSize)}`;
    }
    
    label.textContent = summary;
    selectedDisplay.prepend(label);
    
    // Update data attributes for download
    updateAdvancedDataAttributes(selectedDisplay, columnsContainer);
}

/**
 * Update data attributes for advanced selection
 * @param {HTMLElement} selectedDisplay - Selected display element
 * @param {HTMLElement} columnsContainer - Columns container
 */
function updateAdvancedDataAttributes(selectedDisplay, columnsContainer) {
    const selection = getAdvancedSelection(columnsContainer);
    
    selectedDisplay.dataset.trackMap = selection.trackMap;
    selectedDisplay.dataset.defaultContainer = selection.defaultContainer;
    selectedDisplay.dataset.totalfilesize = selection.totalfilesize;
}

/**
 * Get current advanced selection data
 * @param {HTMLElement} columnsContainer - Columns container
 * @returns {Object} Selection data
 */
function getAdvancedSelection(columnsContainer) {
    const selectedVideo = columnsContainer.querySelector('.column.video .track-option.selected');
    const selectedAudio = columnsContainer.querySelectorAll('.column.audio .track-option.selected');
    const selectedSubs = columnsContainer.querySelectorAll('.column.subtitle .track-option.selected');
    
    // Get ffmpeg stream indices
    const videoIndex = selectedVideo?.dataset.id ? 
        getTrackByIdFromColumn(columnsContainer.querySelector('.column.video'), selectedVideo.dataset.id)?.ffmpegStreamIndex : null;
    
    const audioIndices = [...selectedAudio].map(el => 
        getTrackByIdFromColumn(columnsContainer.querySelector('.column.audio'), el.dataset.id)?.ffmpegStreamIndex
    ).filter(Boolean);
    
    const subIndices = [...selectedSubs].map(el => 
        getTrackByIdFromColumn(columnsContainer.querySelector('.column.subtitle'), el.dataset.id)?.ffmpegStreamIndex
    ).filter(Boolean);
    
    const trackMap = [
        ...(videoIndex ? [videoIndex] : []),
        ...audioIndices,
        ...subIndices
    ].join(',');
    
    // Calculate total file size
    let totalfilesize = 0;
    [selectedVideo, ...selectedAudio, ...selectedSubs].forEach(option => {
        if (option?.dataset.filesize) {
            totalfilesize += parseInt(option.dataset.filesize, 10);
        }
    });
    
    // Determine container format - simple logic
    const videoTrack = selectedVideo ? getTrackByIdFromColumn(columnsContainer.querySelector('.column.video'), selectedVideo.dataset.id) : null;
    const videoContainer = videoTrack?.videoContainer || 'mp4';
    
    // Check if any selected tracks are incompatible with video container
    const hasIncompatible = columnsContainer.querySelectorAll('.track-option.selected.incompatible').length > 0;
    const defaultContainer = hasIncompatible ? 'mkv' : videoContainer;
    
    return {
        trackMap,
        defaultContainer,
        totalfilesize,
        selectedVideo: selectedVideo?.dataset.id,
        selectedAudio: [...selectedAudio].map(el => el.dataset.id),
        selectedSubs: [...selectedSubs].map(el => el.dataset.id)
    };
}

/**
 * Get track data by ID from a column
 * @param {HTMLElement} column - Track column
 * @param {string} trackId - Track ID
 * @returns {Object|null} Track data
 */
function getTrackByIdFromColumn(column, trackId) {
    const columnsContainer = column.closest('.tracks-columns-container');
    if (!columnsContainer?.tracksData) return null;
    
    const { videoTracks, audioTracks, subtitleTracks } = columnsContainer.tracksData;
    
    // Find track in appropriate array based on column type
    if (column.classList.contains('video')) {
        return videoTracks.find(track => track.id === trackId);
    } else if (column.classList.contains('audio')) {
        return audioTracks.find(track => track.id === trackId);
    } else if (column.classList.contains('subtitle')) {
        return subtitleTracks.find(track => track.id === trackId);
    }
    
    return null;
}

/**
 * Format the label for a track option
 * @param {Object} track - Track data
 * @param {string} type - Track type
 * @returns {string} Formatted label
 */
function formatTrackLabel(track, type) {
    if (type === 'video') {
        const res = track.standardizedResolution || null;
        const fps = track.frameRate || null;
        const formattedResolution = res ? 
            ((fps && fps !== 30) ? `${res}${fps}` : res) : null;
        
        const fileSizeBytes = formatSize(track.estimatedFileSizeBytes) || null;
        const codecs = track.codecs ? track.codecs.split('.')[0] : null;

        return [formattedResolution, fileSizeBytes, codecs]
            .filter(Boolean)
            .join(' • '); 

    } else if (type === 'audio') {
        const language = track.isDefault ? `${track.label || track.lang || null}*` : track.label || track.lang || null;
        const codecs = track.codecs ? track.codecs.split('.')[0] : null;
        const channels = track.channels ? `${track.channels}ch` : null;
        const fileSizeBytes = track.estimatedFileSizeBytes ? 
            formatSize(track.estimatedFileSizeBytes) : null;

        return [language, channels, fileSizeBytes, codecs]
            .filter(Boolean)
            .join(' • ');

    } else {
        // Subtitle - prioritize displayLanguage, show accessibility indicators
        const language = track.isDefault ? `${track.label || track.lang || 'Unknown'}*` : track.label || track.lang || 'Unknown';

        return language
    }
}

/**
 * Get formatted codecs based on media type
 * @param {Object} media - Media object (video track)
 * @param {string} type - Media type
 * @returns {string|null} Formatted codecs string
 */
function getFormattedCodecs(media, type) {
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
 * Format the displayed label for a video track
 * @param {Object} videoTrack - Video track data
 * @param {string} [type='direct'] - Media type ('hls', 'direct')
 * @returns {string} Formatted label
 */
function formatVariantLabel(videoTrack, type = 'direct') {
    if (!videoTrack) return "Unknown Quality";

    if (type === 'hls') {
        const meta = videoTrack.metaJS || {};
        const res = meta.standardizedResolution || null;
        const fps = meta.fps || null;
        const formattedResolution = res ? 
            ((fps && fps !== 30) ? `${res}${fps}` : res) : null;
            
        const fileSizeBytes = meta.estimatedFileSizeBytes ? 
            formatSize(meta.estimatedFileSizeBytes) : null;
            
        const fullResolution = meta.resolution || null;
        const formattedCodecs = getFormattedCodecs(videoTrack, 'hls');
        
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
        
        const formattedCodecs = getFormattedCodecs(videoTrack, 'direct');
        
        return [formattedResolution, fileSize, formattedCodecs]
            .filter(Boolean)
            .join(' • ') || 'Unknown Quality';
    }
}

/**
 * Update track compatibility when video track changes - simple iterative check
 * @param {string} videoContainer - The container format of the selected video track
 * @param {HTMLElement} columnsContainer - The container element for all columns
 */
function updateTracksCompatibility(videoContainer, columnsContainer) {
    if (!videoContainer || !columnsContainer) return;
    
    // Check all audio tracks
    columnsContainer.querySelectorAll('.column.audio .track-option').forEach(track => {
        const trackData = getTrackByIdFromColumn(columnsContainer.querySelector('.column.audio'), track.dataset.id);
        const isCompatible = trackData?.audioContainer ? 
            isTrackCompatibleWithVideo(trackData.audioContainer, 'audio', videoContainer) : false;
        
        track.classList.remove('compatible', 'incompatible');
        track.classList.add(isCompatible ? 'compatible' : 'incompatible');
    });
    
    // Check all subtitle tracks
    columnsContainer.querySelectorAll('.column.subtitle .track-option').forEach(track => {
        const trackData = getTrackByIdFromColumn(columnsContainer.querySelector('.column.subtitle'), track.dataset.id);
        const isCompatible = trackData?.subtitleContainer ? 
            isTrackCompatibleWithVideo(trackData.subtitleContainer, 'subtitle', videoContainer) : false;
        
        track.classList.remove('compatible', 'incompatible');
        track.classList.add(isCompatible ? 'compatible' : 'incompatible');
    });
}