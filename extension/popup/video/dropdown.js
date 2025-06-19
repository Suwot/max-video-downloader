/**
 * Custom dropdown component for video quality selection
 * Supports both simple selection (HLS/Direct) and multi-track selection (DASH)
 */

import { formatSize } from '../../shared/utils/video-utils.js';

/**
 * Creates all dropdown elements at once with proper structure
 * @param {string} type - Video type
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
    
    // Store element references for quick access
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
    
    // Create all dropdown elements at once
    const container = createDropdownElements(type);
    const { selectedDisplay, optionsContainer } = container.elements;
    
    // Setup event handlers for dropdown interactions
    setupDropdownEvents(container, type);
    
    // Fill with content based on video type
    if (type === 'dash') {
        const tracks = {
            videoTracks: video.videoTracks || [],
            audioTracks: video.audioTracks || [],
            subtitleTracks: video.subtitleTracks || []
        };
        
        const initialSelection = {
            selectedVideo: tracks.videoTracks?.[0]?.id,
            selectedAudio: tracks.audioTracks?.[0]?.id,
            selectedSubs: tracks.subtitleTracks?.[0]?.id
        };
        
        // Set initial trackMap on the selected display
        const indices = [
            tracks.videoTracks?.[0]?.ffmpegStreamIndex,
            tracks.audioTracks?.[0]?.ffmpegStreamIndex,
            tracks.subtitleTracks?.[0]?.ffmpegStreamIndex
        ].filter(Boolean);
        
        selectedDisplay.dataset.trackMap = indices.join(',');
        selectedDisplay.dataset.url = url;
        
        createDashOptions(optionsContainer, tracks, initialSelection, (selection) => {
            updateSelectedDisplay(selectedDisplay, selection, type);
            if (onChange) onChange(selection);
            container.classList.remove('open');
        });
        
        // Initialize selected display
        updateSelectedDisplay(selectedDisplay, initialSelection, type);
    } else {
        // HLS, Direct, Blob use simple options
        const variants = video.variants && video.variants.length > 0 ? video.variants : [video];
        const initialSelection = variants[0];
        
        createSimpleOptions(optionsContainer, variants, initialSelection, (selection) => {
            updateSelectedDisplay(selectedDisplay, selection, type);
            if (onChange) onChange(selection);
            container.classList.remove('open');
        });
        
        // Initialize selected display
        updateSelectedDisplay(selectedDisplay, initialSelection, type);
    }
    
    return container;
}

/**
 * Sets up event handlers for dropdown interactions
 * @param {HTMLElement} container - Dropdown container element
 * @param {string} type - Video type
 */
function setupDropdownEvents(container, type) {
    const { selectedDisplay } = container.elements;
    
    // Helper function to update body expanded state based on open dropdowns
    const updateBodyExpandedState = () => {
        const anyDropdownOpen = document.querySelector('.custom-dropdown.open') !== null;
        document.body.classList.toggle('expanded', anyDropdownOpen);
    };
    
    // Toggle dropdown when clicking the selected display
    selectedDisplay.addEventListener('click', () => {
        container.classList.toggle('open');
        
        // Close other dropdowns
        document.querySelectorAll('.custom-dropdown.open').forEach(dropdown => {
            if (dropdown !== container) {
                dropdown.classList.remove('open');
            }
        });
        
        // Ensure radio buttons match selected classes when dropdown is opened
        if (container.classList.contains('open') && type === 'dash') {
            // Sync selected state with radio button state for tracks
            const videoOptions = container.querySelectorAll('.column .track-option');
            videoOptions.forEach(option => {
                const input = option.querySelector('input');
                if (input) {
                    input.checked = option.classList.contains('selected');
                }
            });

            const columnsContainer = container.querySelector('.tracks-columns-container');
            if (columnsContainer) {
                const selectedVideo = columnsContainer.querySelector('.column.video .track-option.selected');
                if (selectedVideo) {
                    updateTracksCompatibility(selectedVideo.dataset.container, columnsContainer);
                }
            }
        }
        
        // Update body expanded state
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
 * Create options for simple dropdown (HLS/Direct)
 * @param {HTMLElement} container - Options container element
 * @param {Array} variants - Available quality variants
 * @param {Object} initialSelection - Initially selected variant
 * @param {Function} onSelect - Callback when an option is selected
 */
function createSimpleOptions(container, variants, initialSelection, onSelect) {
    if (!variants || variants.length === 0) return;
    console.log('Creating simple options for variants:', variants);
    
    variants.forEach(variant => {
        const option = document.createElement('div');
        option.className = 'dropdown-option';
        if (initialSelection && variant.url === initialSelection.url) {
            option.classList.add('selected');
        }
        
        // Pass the container's type or fallback to 'direct'
        const mediaType = container.closest('.custom-dropdown')?.dataset.type || 'direct';
        option.textContent = formatVariantLabel(variant, mediaType);
        option.dataset.url = variant.url;
        
        // Add filesize data attribute based on the media type
        if (mediaType === 'hls') {
            // For HLS, use metaJS.estimatedFileSizeBytes
            if (variant.metaJS?.estimatedFileSizeBytes) {
                option.dataset.filesize = variant.metaJS.estimatedFileSizeBytes;
            }
        } else {
            // For direct/blob, use contentLength with fallback to estimatedFileSizeBytes
            const filesize = variant.metadata?.contentLength || 
                            variant.metaFFprobe?.sizeBytes || 
                            variant.metaFFprobe?.estimatedFileSizeBytes;
            
            if (filesize) {
                option.dataset.filesize = filesize;
            }
        }
        
        option.addEventListener('click', () => {
            container.querySelectorAll('.dropdown-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            option.classList.add('selected');
            onSelect(variant);
        });
        
        container.appendChild(option);
    });
}

/**
 * Create column-based options for DASH
 * @param {HTMLElement} container - Options container element
 * @param {Object} tracks - Object containing video, audio, and subtitle tracks
 * @param {Object} initialSelection - Initially selected tracks
 * @param {Function} onSelect - Callback when selection is applied
 */
function createDashOptions(container, tracks, initialSelection, onSelect) {
    const { videoTracks = [], audioTracks = [], subtitleTracks = [] } = tracks || {};
    
     // Create columns container
    const columnsContainer = document.createElement('div');
    columnsContainer.className = 'tracks-columns-container';
    
    // Create column for video tracks
    const videoColumn = createTrackColumn('VIDEO', videoTracks, 'video', initialSelection?.selectedVideo, true, columnsContainer);
    columnsContainer.appendChild(videoColumn);
    
    // Create column for audio tracks
    const audioColumn = createTrackColumn('AUDIO', audioTracks, 'audio', initialSelection?.selectedAudio, false, columnsContainer);
    columnsContainer.appendChild(audioColumn);
    
    // Create column for subtitle tracks
    if (subtitleTracks.length > 0) {
        const subsColumn = createTrackColumn('SUBS', subtitleTracks, 'subtitle', initialSelection?.selectedSubs, false, columnsContainer);
        columnsContainer.appendChild(subsColumn);
    }
    
    // Create Apply button
    const applyButton = document.createElement('button');
    applyButton.className = 'apply-button';
    applyButton.textContent = 'Apply';
    
    // Function to update button text based on track compatibility
    const updateButtonAndSelectedOption = () => {
        const selectedVideoTrack = videoColumn.querySelector('.track-option.selected');
        if (!selectedVideoTrack) {
            applyButton.textContent = 'Apply';
            return;
        }
        
        const videoContainer = selectedVideoTrack.dataset.container;
        if (!videoContainer) {
            applyButton.textContent = 'Apply';
            return;
        }
        
        // Check if any selected track is incompatible
        const hasIncompatibleTracks = columnsContainer.querySelectorAll('.track-option.selected.incompatible').length > 0;
        
        if (hasIncompatibleTracks) {
            applyButton.textContent = `Apply as .mkv`;
            applyButton.dataset.container = 'mkv';
        } else {
            applyButton.textContent = `Apply as .${videoContainer}`;
            applyButton.dataset.container = videoContainer;
        }
        
        // Calculate total file size from all selected tracks
        let totalSizeBytes = 0;
        columnsContainer.querySelectorAll('.track-option.selected').forEach(option => {
            if (option.dataset.filesize) {
                totalSizeBytes += parseInt(option.dataset.filesize, 10);
            }
        });
        
        // Also set the container format and totalfilesize on the closest selectedDisplay element
        const dropdown = columnsContainer.closest('.custom-dropdown');
        const selectedDisplay = dropdown?.elements?.selectedDisplay;
         
        if (selectedDisplay) {
            if (applyButton.dataset.container) {
                selectedDisplay.dataset.container = applyButton.dataset.container;
            }
            selectedDisplay.dataset.totalfilesize = totalSizeBytes;
        }
    };
    
    // Update button text on initial render (after a small delay to ensure compatibility classes are set)
    setTimeout(updateButtonAndSelectedOption, 0);
    
    // Listen for click events on the entire columnsContainer to catch any track option clicks
    columnsContainer.addEventListener('click', (e) => {
        const trackOption = e.target.closest('.track-option');
        if (trackOption) {
            // Small delay to ensure classes are updated first
            setTimeout(updateButtonAndSelectedOption, 0);
        }
    });
    
    applyButton.addEventListener('click', () => {
        // Collect selected tracks with their ffmpegStreamIndex values
        const selectedVideoTrack = videoColumn.querySelector('.track-option.selected');
        const selectedVideoIndex = selectedVideoTrack ? 
            videoTracks.find(track => track.id === selectedVideoTrack.dataset.id)?.ffmpegStreamIndex : null;
        
        // Get all selected audio tracks' ffmpegStreamIndex values
        const selectedAudioIndices = [...audioColumn.querySelectorAll('.track-option.selected')]
            .map(el => {
                const trackId = el.dataset.id;
                return audioTracks.find(track => track.id === trackId)?.ffmpegStreamIndex;
            })
            .filter(Boolean);
            
        // Get all selected subtitle tracks' ffmpegStreamIndex values
        const selectedSubIndices = subtitleTracks.length > 0 ? 
            [...columnsContainer.querySelector('.column.subtitle').querySelectorAll('.track-option.selected')]
            .map(el => {
                const trackId = el.dataset.id;
                return subtitleTracks.find(track => track.id === trackId)?.ffmpegStreamIndex;
            })
            .filter(Boolean) : [];
        
        // Collect track IDs for UI reference
        const selectedVideoId = selectedVideoTrack?.dataset.id;
        const selectedAudioIds = [...audioColumn.querySelectorAll('.track-option.selected')].map(el => el.dataset.id);
        const selectedSubIds = subtitleTracks.length > 0 ? 
            [...columnsContainer.querySelector('.column.subtitle').querySelectorAll('.track-option.selected')]
            .map(el => el.dataset.id) : [];
        
        // Create selection object with direct ffmpegStreamIndex values
        const trackMap = [
            ...(selectedVideoIndex ? [selectedVideoIndex] : []),
            ...selectedAudioIndices,
            ...selectedSubIndices
        ].join(',');
        
        // Calculate total file size from all selected tracks
        let totalSizeBytes = 0;
        columnsContainer.querySelectorAll('.track-option.selected').forEach(option => {
            if (option.dataset.filesize) {
                totalSizeBytes += parseInt(option.dataset.filesize, 10);
            }
        });
        
        // Get container format from button's dataset
        const containerFormat = applyButton.dataset.container || 'mkv';
        
        const selection = {
            selectedVideo: selectedVideoId,
            selectedAudio: selectedAudioIds,
            selectedSubs: selectedSubIds,
            trackMap,
            container: containerFormat,
            totalfilesize: totalSizeBytes
        };
        
        // Pass to callback
        onSelect(selection);
    });
    
    container.appendChild(columnsContainer);
    container.appendChild(applyButton);
}

/**
 * Create a column for track selection
 * @param {string} title - Column title (VIDEO, AUDIO, SUBS)
 * @param {Array} tracks - Track options
 * @param {string} type - Track type (video, audio, subtitle)
 * @param {Array|string} selectedIds - Initially selected track ids
 * @param {boolean} [singleSelect=false] - Whether only one option can be selected
 * @param {HTMLElement} columnsContainer - Container for all columns
 * @returns {HTMLElement} Column element
 */
function createTrackColumn(title, tracks, type, selectedIds = [], singleSelect = false, columnsContainer = null) {
    const column = document.createElement('div');
    column.className = `column ${type}`;
    
    // Create column title
    const columnTitle = document.createElement('div');
    columnTitle.className = 'column-title';
    columnTitle.textContent = title;
    column.appendChild(columnTitle);
    
    // Convert single selectedId to array for consistent processing
    const selectedArray = Array.isArray(selectedIds) ? selectedIds : (selectedIds ? [selectedIds] : []);
    
    // Create track options
    tracks.forEach(track => {
        const option = document.createElement('div');
        option.className = 'track-option';
        option.dataset.id = track.id;
        
        // Add MIME type as data attribute
        if (track.mimeType) {
            option.dataset.mimeType = track.mimeType;
            // Extract container format (e.g., "video/mp4" → "mp4")
            const container = track.mimeType.split('/')[1]?.split(';')[0];
            if (container) {
                option.dataset.container = container;
            }
        }

        // Add file size as data attribute
        if (track.estimatedFileSizeBytes) {
            option.dataset.filesize = track.estimatedFileSizeBytes;
        }
        
        // Ensure selected class is added for initial state
        if (selectedArray.includes(track.id)) {
            option.classList.add('selected');
        }
        
        // Create checkbox/radio input
        const input = document.createElement('input');
        input.type = singleSelect ? 'radio' : 'checkbox';
        input.name = `track-${type}`;
        
        // Create track label
        const label = document.createElement('span');
        label.className = 'track-label';
        label.textContent = formatTrackLabel(track, type);
        
        option.appendChild(input);
        option.appendChild(label);
        
        option.addEventListener('click', () => {
            if (singleSelect) {
                // Deselect all others
                column.querySelectorAll('.track-option').forEach(opt => {
                    opt.classList.remove('selected');
                    opt.querySelector('input').checked = false;
                });

                // If this is a video track, update compatibility status of audio and subtitle tracks
                if (type === 'video' && columnsContainer) {
                    const videoContainer = option.dataset.container;
                    if (videoContainer) {
                        updateTracksCompatibility(videoContainer, columnsContainer);
                    }
                }
            }
            
            // Toggle selection
            option.classList.toggle('selected');
            input.checked = option.classList.contains('selected');
        });
        
        column.appendChild(option);
    });
    
    return column;
}

/**
 * Format the label for a track option
 * @param {Object} track - Track data
 * @param {string} type - Track type
 * @returns {string} Formatted label
 */
function formatTrackLabel(track, type) {
    if (type === 'video') {
        const res = track.standardizedResolution  || null;
        const fps = track.frameRate || null;
        const formattedResolution = res ? 
        ((fps && fps !== 30) ? `${res}${fps}` : res) : null;
        
        const fileSizeBytes = formatSize(track.estimatedFileSizeBytes) || null;
        const codecs = track.codecs ? track.codecs.split('.')[0] : null;
        // const bitrate = track.bandwidth ? `${Math.round(track.bandwidth/1000)} Kbps` : '';

        return [formattedResolution, fileSizeBytes, codecs]
            .filter(Boolean)
            .join(' • '); 

    } else if (type === 'audio') {
        const label = track.label || null
        const lang = track.language || null;
        const codecs = track.codecs ? track.codecs.split('.')[0] : null;
        const channels = track.channels ? `${track.channels}ch` : null;
        // const bitrate = track.bandwidth ? `${Math.round(track.bandwidth / 1000)} Kbps` : null;
        const fileSizeBytes = track.estimatedFileSizeBytes ? 
        formatSize(track.estimatedFileSizeBytes) : null;

        return [label, lang, channels, fileSizeBytes, codecs]
            .filter(Boolean)
            .join(' • ');

    } else {
        // Subtitle
        return track.label || track.language || 'unknown';
    }
}

/**
 * Get formatted codecs based on media type
 * @param {Object} media - Media object (variant or track)
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
    
    // For direct/blob videos
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
 * Format the displayed label for a variant
 * @param {Object} variant - Variant data
 * @param {string} [type='direct'] - Media type ('hls', 'direct', 'blob')
 * @returns {string} Formatted label
 */
function formatVariantLabel(variant, type = 'direct') {
    if (!variant) return "Unknown Quality";

    // Extract common properties with consistent paths
    if (type === 'hls') {
        const meta = variant.metaJS || {};
        const res = meta.standardizedResolution || null;
        const fps = meta.fps || null;
        const formattedResolution = res ? 
            ((fps && fps !== 30) ? `${res}${fps}` : res) : null;
            
        const fileSizeBytes = meta.estimatedFileSizeBytes ? 
            formatSize(meta.estimatedFileSizeBytes) : null;
            
        const fullResolution = meta.resolution || null;
        const formattedCodecs = getFormattedCodecs(variant, 'hls');
        
        return [formattedResolution, fileSizeBytes, fullResolution, formattedCodecs]
            .filter(Boolean)
            .join(' • ') || 'Unknown Quality';
    } else {
        // Direct/blob video formatting
        const res = variant.standardizedResolution || null;
        const fps = variant.metaFFprobe?.fps || null;
        const formattedResolution = res ? 
            ((fps && fps !== 30) ? `${res}${fps}` : res) : null;

        const fileSize = variant.fileSize ? formatSize(variant.fileSize) : 
            (variant.estimatedFileSizeBytes ? formatSize(variant.estimatedFileSizeBytes) : null);
        
        const formattedCodecs = getFormattedCodecs(variant, 'direct');
        
        return [formattedResolution, fileSize, formattedCodecs]
            .filter(Boolean)
            .join(' • ') || 'Unknown Quality';
    }
}

/**
 * Update the selected display with the current selection
 * @param {HTMLElement} display - The selected display element
 * @param {Object} selection - The current selection
 * @param {string} type - Video type
 */
function updateSelectedDisplay(display, selection, type) {
    if (!selection) {
        display.querySelector('.label')?.remove();
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = 'Select quality';
        display.prepend(label);
        return;
    }
    
    display.querySelector('.label')?.remove();
    
    if (type === 'dash' && typeof selection === 'object') {
        // For DASH, show a summary of selected tracks
        const label = document.createElement('span');
        label.className = 'label';
        
        // Store the track map for download, preserving any existing value
        display.dataset.trackMap = selection.trackMap || display.dataset.trackMap || '';   

        // Store the container format for download
        if (selection.container) {
            display.dataset.container = selection.container;
        }
        
        // Store the total file size from selection
        if (selection.totalfilesize !== undefined) {
            display.dataset.totalfilesize = selection.totalfilesize;
        }
        
        // Find tracks from selected IDs
        const parentDropdown = display.closest('.custom-dropdown');
        let totalSizeBytes = 0;
        let resolutionText = '';
        
        // Get video track details and selected audio/subtitle counts from DOM
        if (parentDropdown) {
            const tracks = parentDropdown.querySelector('.tracks-columns-container');
            
            if (tracks) {
                // Get all selected tracks at once for size calculation
                const selectedTracks = tracks.querySelectorAll('.column.video .track-option.selected, .column.audio .track-option.selected');
                let totalSizeBytes = 0;
                
                // Calculate total size
                selectedTracks.forEach(option => {
                    if (option.dataset.filesize) {
                        totalSizeBytes += parseInt(option.dataset.filesize, 10);
                    }
                });
                
                // Extract video details (if there's a selected video track)
                const selectedVideoOption = tracks.querySelector('.column.video .track-option.selected');
                if (selectedVideoOption) {
                    // Extract resolution
                    const trackLabel = selectedVideoOption.querySelector('.track-label')?.textContent;
                    if (trackLabel) {
                        // Extract resolution (e.g., "1080p • 351.4 MB" → "1080p")
                        const resMatch = trackLabel.match(/(\d+)p/);
                        const fpsMatch = trackLabel.match(/(\d+)p(\d+)/); // for fps like 1080p60
                        
                        if (resMatch) {
                            resolutionText = resMatch[0];
                            if (fpsMatch && fpsMatch[2]) {
                                resolutionText = `${resMatch[0]}${fpsMatch[2]}`;
                            }
                        }
                    }
                }
                
                // Get counts for UI display
                const audioCount = tracks.querySelectorAll('.column.audio .track-option.selected').length;
                const subsCount = tracks.querySelectorAll('.column.subtitle .track-option.selected').length;
                
                // Create summary label
                let summary = '';
                
                // Resolution part
                if (resolutionText) {
                    summary = resolutionText;
                } else {
                    summary = 'Custom';
                }
                
                // Tracks count part for selected audio/subtitle tracks
                const trackCounts = [];
                
                // Add audio info to track counts
                if (selectedVideoOption) {
                    if (audioCount === 0) {
                        trackCounts.push('no audio');
                    } else {
                        trackCounts.push(`${audioCount} audio`);
                    }
                }
                
                // Add subtitle info to track counts
                if (subsCount > 0) {
                    trackCounts.push(`${subsCount} subs`);
                }
                
                // Add the track counts to the summary
                if (trackCounts.length > 0) {
                    summary += ` (${trackCounts.join(', ')})`;
                }
                
                // Size part
                if (totalSizeBytes > 0) {
                    summary += ` ≈ ${formatSize(totalSizeBytes)}`;
                }
                
                label.textContent = summary || 'Select tracks';
            }
        }
        
        display.prepend(label);
    } else {
        // For HLS/Direct, show the selected quality
        const label = document.createElement('span');
        label.className = 'label';
        const parts = formatVariantLabel(selection, type).split(' • ');
        label.textContent = parts.slice(0, 2).join(' • '); // show just the first 2 parts
        display.dataset.url = selection.url || '';
        
        // Set filesize attribute based on the media type
        if (type === 'hls') {
            if (selection.metaJS?.estimatedFileSizeBytes) {
                display.dataset.filesize = selection.metaJS.estimatedFileSizeBytes;
            }
        } else {
            // For direct/blob, use contentLength with fallback to estimatedFileSizeBytes
            const filesize = selection.metadata?.contentLength || 
                            selection.metaFFprobe?.sizeBytes || 
                            selection.metaFFprobe?.estimatedFileSizeBytes;
            
            if (filesize) {
                display.dataset.filesize = filesize;
            }
        }
        
        display.prepend(label);
    }
}

/**
 * Check if a track is compatible with the selected video container
 * @param {string} trackType - Type of track ('audio' or 'subtitle')
 * @param {string} trackContainer - Container format of the track
 * @param {string} trackMimeType - MIME type of the track
 * @param {string} videoContainer - Container format of the selected video
 * @returns {boolean} Whether the track is compatible
 */
function isTrackCompatible(trackType, trackContainer, trackMimeType, videoContainer) {
    if (trackType === 'audio') {
        // For audio, container must match video container
        return trackContainer === videoContainer;
    } else if (trackType === 'subtitle') {
        // For subtitles, most formats work with both containers except specific ones
        if (trackMimeType && trackMimeType.includes('application/mp4')) {
            // MP4-specific subtitle formats
            return videoContainer === 'mp4';
        }
        // Most subtitle formats like text/vtt are compatible with both containers
        return true;
    }
    return true;
}

/**
 * Update track compatibility status based on selected video container
 * @param {string} videoContainer - The container format of the selected video track (e.g., 'mp4', 'webm')
 * @param {HTMLElement} columnsContainer - The container element for all columns
 */
function updateTracksCompatibility(videoContainer, columnsContainer) {
    // Early return if parameters are invalid
    if (!videoContainer || !columnsContainer) {
        console.warn('Cannot update tracks compatibility: missing parameters', { videoContainer, columnsContainer });
        return;
    }
    
    // Update audio tracks compatibility
    updateTrackTypeCompatibility(videoContainer, columnsContainer, 'audio');
    
    // Update subtitle tracks compatibility (if they exist)
    const subtitleColumn = columnsContainer.querySelector('.column.subtitle');
    if (subtitleColumn) {
        updateTrackTypeCompatibility(videoContainer, columnsContainer, 'subtitle');
    }
}

/**
 * Update compatibility status for a specific track type
 * @param {string} videoContainer - The container format of selected video
 * @param {HTMLElement} columnsContainer - The container for all columns
 * @param {string} trackType - Type of track ('audio' or 'subtitle')
 */
function updateTrackTypeCompatibility(videoContainer, columnsContainer, trackType) {
    const column = columnsContainer.querySelector(`.column.${trackType}`);
    if (!column) return;
    
    const tracks = column.querySelectorAll('.track-option');
    let firstCompatibleTrack = null;
    let hasSelectedTrack = false;
    
    // Process each track
    tracks.forEach(track => {
        const trackContainer = track.dataset.container;
        const mimeType = track.dataset.mimeType;
        
        // Remove existing compatibility classes
        track.classList.remove('compatible', 'incompatible');
        
        // Check compatibility using helper function
        const isCompatible = isTrackCompatible(trackType, trackContainer, mimeType, videoContainer);
        
        // Apply compatibility class
        track.classList.add(isCompatible ? 'compatible' : 'incompatible');
        
        if (isCompatible && !firstCompatibleTrack) {
            firstCompatibleTrack = track;
        }
        
        // Check if any track is still selected
        if (track.classList.contains('selected')) {
            hasSelectedTrack = true;
        }
    });
}