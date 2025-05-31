/**
 * Custom dropdown component for video quality selection
 * Supports both simple selection (HLS/Direct) and multi-track selection (DASH)
 */

/**
 * Creates a custom dropdown component
 * @param {Object} options - Configuration options
 * @param {string} options.type - Video type ('hls', 'dash', 'direct', 'blob')
 * @param {Array} options.variants - Available quality variants
 * @param {Function} options.onChange - Callback when selection changes
 * @param {Object} [options.initialSelection] - Initially selected variant/tracks
 * @param {Object} [options.tracks] - For DASH: {videoTracks, audioTracks, subtitleTracks}
 * @returns {HTMLElement} The custom dropdown component
 */
export function createCustomDropdown(options) {
    const { type, variants, onChange, initialSelection, tracks } = options;
    
    // Create main container
    const container = document.createElement('div');
    container.className = 'custom-dropdown';
    container.dataset.type = type;
    
    // Create selected display element (always visible)
    const selectedDisplay = document.createElement('div');
    selectedDisplay.className = 'selected-option';
    
    // Create dropdown icon
    const dropdownIcon = document.createElement('div');
    dropdownIcon.className = 'dropdown-icon';
    dropdownIcon.innerHTML = `
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L5 5L9 1" stroke="#FAFAFA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
    
    // Create options container (hidden by default)
    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'options-container';
    
    // Handle click to toggle dropdown
    selectedDisplay.appendChild(dropdownIcon);
    container.appendChild(selectedDisplay);
    container.appendChild(optionsContainer);
    
    // Toggle dropdown when clicking the selected display
    selectedDisplay.addEventListener('click', () => {
        container.classList.toggle('open');
        
        // Close other dropdowns
        document.querySelectorAll('.custom-dropdown.open').forEach(dropdown => {
            if (dropdown !== container) {
                dropdown.classList.remove('open');
            }
        });
        
        // Position the dropdown
        positionDropdown(container, optionsContainer);
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
        }
    });
    
    // Fill with content based on video type
    if (type === 'dash') {
        createDashOptions(optionsContainer, tracks, initialSelection, (selection) => {
            updateSelectedDisplay(selectedDisplay, selection, type);
            if (onChange) onChange(selection);
            container.classList.remove('open');
        });
    } else {
        // HLS, Direct, Blob use the same simple options list
        createSimpleOptions(optionsContainer, variants, initialSelection, (selection) => {
            updateSelectedDisplay(selectedDisplay, selection, type);
            if (onChange) onChange(selection);
            container.classList.remove('open');
        });
    }
    
    // Initialize selected display
    updateSelectedDisplay(selectedDisplay, initialSelection || (variants?.[0]), type);
    
    return container;
}

/**
 * Position the dropdown options container
 * @param {HTMLElement} container - Main dropdown container
 * @param {HTMLElement} optionsContainer - Options container element
 */
function positionDropdown(container, optionsContainer) {
    // Get container position
    const rect = container.getBoundingClientRect();
    
    // Calculate space below
    const spaceBelow = window.innerHeight - rect.bottom;
    
    // Ensure the dropdown options are visible with proper height
    // Always position below
    optionsContainer.style.top = '100%';
    optionsContainer.style.bottom = 'auto';
    
    // Always add expanded class to ensure maximum space
    document.body.classList.add('expanded');
    
    // Use setTimeout to ensure the expanded class has been applied and layout recalculated
    setTimeout(() => {
        // Get the new available space (after expanded class is applied)
        const newSpaceBelow = window.innerHeight - rect.bottom;
        // Set height with a minimum of 200px if available
        optionsContainer.style.maxHeight = `${Math.max(200, Math.min(300, newSpaceBelow - 10))}px`;
    }, 0);
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
    
    variants.forEach(variant => {
        const option = document.createElement('div');
        option.className = 'dropdown-option';
        if (initialSelection && variant.url === initialSelection.url) {
            option.classList.add('selected');
        }
        
        option.textContent = formatVariantLabel(variant);
        option.dataset.url = variant.url;
        
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
    const videoColumn = createTrackColumn('VIDEO', videoTracks, 'video', initialSelection?.selectedVideo, true);
    columnsContainer.appendChild(videoColumn);
    
    // Create column for audio tracks
    const audioColumn = createTrackColumn('AUDIO', audioTracks, 'audio', initialSelection?.selectedAudio);
    columnsContainer.appendChild(audioColumn);
    
    // Create column for subtitle tracks
    if (subtitleTracks.length > 0) {
        const subsColumn = createTrackColumn('SUBS', subtitleTracks, 'subtitle', initialSelection?.selectedSubs);
        columnsContainer.appendChild(subsColumn);
    }
    
    // Create Apply button
    const applyButton = document.createElement('button');
    applyButton.className = 'apply-button';
    applyButton.textContent = 'Apply';
    applyButton.addEventListener('click', () => {
        // Collect selected tracks
        const selectedVideo = videoColumn.querySelector('.track-option.selected')?.dataset.id;
        const selectedAudio = [...audioColumn.querySelectorAll('.track-option.selected')]
            .map(el => el.dataset.id);
        const selectedSubs = subtitleTracks.length > 0 ? 
            [...columnsContainer.querySelector('.column.subtitle').querySelectorAll('.track-option.selected')]
            .map(el => el.dataset.id) : [];
        
        // Create selection object with mapping
        const selection = {
            selectedVideo,
            selectedAudio,
            selectedSubs,
            trackMap: buildTrackMap(selectedVideo, selectedAudio, selectedSubs)
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
 * @returns {HTMLElement} Column element
 */
function createTrackColumn(title, tracks, type, selectedIds = [], singleSelect = false) {
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
        
        if (selectedArray.includes(track.id)) {
            option.classList.add('selected');
        }
        
        // Create checkbox/radio input
        const input = document.createElement('input');
        input.type = singleSelect ? 'radio' : 'checkbox';
        input.name = `track-${type}`;
        input.checked = selectedArray.includes(track.id);
        
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
 * Build a track map string for DASH download
 * @param {string} videoTrackId - Selected video track ID
 * @param {Array} audioTrackIds - Selected audio track IDs
 * @param {Array} subTrackIds - Selected subtitle track IDs
 * @returns {string} Track map string (e.g., "0:v:0,0:a:1,0:s:0")
 */
function buildTrackMap(videoTrackId, audioTrackIds, subTrackIds) {
    const parts = [];
    
    // Add video track if selected
    if (videoTrackId) {
        parts.push(`0:v:${videoTrackId}`);
    }
    
    // Add audio tracks
    if (audioTrackIds && audioTrackIds.length > 0) {
        audioTrackIds.forEach(id => {
            parts.push(`0:a:${id}`);
        });
    }
    
    // Add subtitle tracks
    if (subTrackIds && subTrackIds.length > 0) {
        subTrackIds.forEach(id => {
            parts.push(`0:s:${id}`);
        });
    }
    
    return parts.join(',');
}

/**
 * Format the label for a track option
 * @param {Object} track - Track data
 * @param {string} type - Track type
 * @returns {string} Formatted label
 */
function formatTrackLabel(track, type) {
    if (type === 'video') {
        const res = track.width && track.height ? `${track.width}×${track.height}` : '';
        const bitrate = track.bandwidth ? `${Math.round(track.bandwidth/1000)} Kbps` : '';
        return `${res} ${bitrate}`.trim();
    } else if (type === 'audio') {
        const lang = track.language || '';
        const channels = track.channels || '';
        const bitrate = track.bandwidth ? `${Math.round(track.bandwidth/1000)} Kbps` : '';
        return `${lang} ${channels}ch ${bitrate}`.trim();
    } else {
        // Subtitle
        return track.language || 'Unknown';
    }
}

/**
 * Format the displayed label for a variant
 * @param {Object} variant - Variant data
 * @returns {string} Formatted label
 */
function formatVariantLabel(variant) {
    if (!variant) return "Unknown Quality";
    
    let label = '';
    
    // Add resolution if available
    if (variant.resolution) {
        label += variant.resolution;
    } else if (variant.width && variant.height) {
        label += `${variant.width}×${variant.height}`;
    } else if (variant.height) {
        label += `${variant.height}p`;
    }
    
    // Add bitrate if available
    if (variant.bandwidth) {
        const kbps = Math.round(variant.bandwidth / 1000);
        label += label ? ` • ${kbps} Kbps` : `${kbps} Kbps`;
    }
    
    // Add file size if available
    if (variant.fileSize) {
        const size = formatFileSize(variant.fileSize);
        label += label ? ` • ${size}` : size;
    }
    
    // Fallback if no info available
    if (!label) {
        label = variant.codecs || 'Alternative Quality';
    }
    
    return label;
}

/**
 * Format file size for display
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    if (!bytes) return '';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
        
        // Store the track map for download
        display.dataset.trackMap = selection.trackMap || '';
        
        // Show selected quality info
        if (selection.selectedVideo) {
            label.textContent = 'Custom Quality';
        } else {
            label.textContent = 'Select tracks';
        }
        
        display.prepend(label);
    } else {
        // For HLS/Direct, show the selected quality
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = formatVariantLabel(selection);
        display.dataset.url = selection.url || '';
        display.prepend(label);
    }
}