/**
 * Custom dropdown component for video quality selection
 * Supports both simple selection (HLS/Direct) and multi-track selection (DASH)
 */

import { formatSize } from './video-utils.js';

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
    document.body.classList.add('expanded');
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
        
        const selection = {
            selectedVideo: selectedVideoId,
            selectedAudio: selectedAudioIds,
            selectedSubs: selectedSubIds,
            trackMap
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
        
        // Ensure selected class is added for initial state
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
 * Format the label for a track option
 * @param {Object} track - Track data
 * @param {string} type - Track type
 * @returns {string} Formatted label
 */
function formatTrackLabel(track, type) {
    if (type === 'video') {
        const res = track.height  || null;
        const fileSizeBytes = formatSize(track.estimatedFileSizeBytes) || null;
        // const bitrate = track.bandwidth ? `${Math.round(track.bandwidth/1000)} Kbps` : '';
        return `${res}p • ${fileSizeBytes}`;
    } else if (type === 'audio') {
        const label = track.label || null
        const lang = track.language || null;
        const codecs = track.codecs ? track.codecs.split('.')[0] : null;
        const channels = track.channels ? `${track.channels}ch` : null;
        // const bitrate = track.bandwidth ? `${Math.round(track.bandwidth / 1000)} Kbps` : null;
        const fileSizeBytes = track.estimatedFileSizeBytes ? formatSize(track.estimatedFileSizeBytes) : null;

        return [label, lang, codecs, channels, fileSizeBytes]
            .filter(Boolean)
            .join(' • ');
    } else {
        // Subtitle
        const label = track.label || track.language || null;
        const fileSizeBytes = track.estimatedFileSizeBytes ? formatSize(track.estimatedFileSizeBytes) : null;

        return [label, fileSizeBytes]
            .filter(Boolean)
            .join(' • ');   
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

    // Different sources have different data structures
    if (type === 'hls') {
        // HLS-specific formatting
        const resolutionP = variant.metaJS?.height ? 
            ((variant.metaJS.fps && variant.metaJS.fps !== 30) ? `${variant.metaJS.height}p${variant.metaJS.fps}` : `${variant.metaJS.height}p`) : null;
        
        const fileSizeBytes = variant.metaJS?.estimatedFileSizeBytes ? 
            formatSize(variant.metaJS.estimatedFileSizeBytes) : null;

        // const bitrate = variant.metaJS?.bandwidth ? `${Math.round(variant.metaJS.bandwidth/1000)} Kbps` : null;

        const resolution = variant.metaJS?.resolution || null;
        const formattedCodecs = variant.metaJS?.codecs ? variant.metaJS.codecs
        .split(',')
        .map(codec => codec.split('.')[0]) // Keep only the part before first dot
        .join(' & ') : null;

        return [resolutionP, fileSizeBytes, resolution, formattedCodecs]
            .filter(Boolean)
            .join(' • ') || 'Unknown Quality';
    } else {
        // Direct/blob video formatting
        const height = variant.metaFFprobe?.height || null;
        const fps = variant.metaFFprobe?.fps || null;
        const resolutionP = height ? 
            ((fps && fps !== 30) ? `${height}p${fps}` : `${height}p`) : null;
        
        // Get file size info from fileSize or estimatedFileSizeBytes
        const fileSize = variant.fileSize ? formatSize(variant.fileSize) : 
            (variant.estimatedFileSizeBytes ? formatSize(variant.estimatedFileSizeBytes) : null);
        
        // Get codec info from metaFFprobe (which contains videoCodec and audioCodec objects)
        const videoCodec = variant.metaFFprobe?.videoCodec?.name || null;
        const audioCodec = variant.metaFFprobe?.audioCodec?.name || null;
        const audioChannels = variant.metaFFprobe?.audioCodec?.channels ? 
            `${variant.metaFFprobe.audioCodec.channels}ch` : null;
        
        let formattedCodecs = null;
        if (videoCodec && audioCodec && audioChannels) {
            formattedCodecs = `${videoCodec} & ${audioCodec} (${audioChannels})`;
        } else if (videoCodec && audioCodec) {
            formattedCodecs = `${videoCodec} & ${audioCodec}`;
        } else {
            formattedCodecs = videoCodec || audioCodec || null;
        }
        
        return [resolutionP, fileSize, formattedCodecs]
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
        
        // Store the track map for download
        display.dataset.trackMap = selection.trackMap || '';
        
        // Find tracks from selected IDs
        const parentDropdown = display.closest('.custom-dropdown');
        let totalSizeBytes = 0;
        let resolutionText = '';
        
        // Get video track details and selected audio/subtitle counts from DOM
        if (parentDropdown) {
            const tracks = parentDropdown.querySelector('.tracks-columns-container');
            
            if (tracks) {
                // Get video details
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
                        
                        // Extract size
                        const sizeMatch = trackLabel.match(/[\d.]+\s*[KMGT]B/i);
                        if (sizeMatch) {
                            totalSizeBytes += estimateSizeInBytes(sizeMatch[0]);
                        }
                    }
                }
                
                // Get audio details from DOM
                const selectedAudioOptions = tracks.querySelectorAll('.column.audio .track-option.selected');
                selectedAudioOptions.forEach(option => {
                    const trackLabel = option.querySelector('.track-label')?.textContent;
                    const sizeMatch = trackLabel?.match(/[\d.]+\s*[KMGT]B/i);
                    if (sizeMatch) {
                        totalSizeBytes += estimateSizeInBytes(sizeMatch[0]);
                    }
                });
                
                // Get subtitle details from DOM
                const selectedSubOptions = tracks.querySelectorAll('.column.subtitle .track-option.selected');
                selectedSubOptions.forEach(option => {
                    const trackLabel = option.querySelector('.track-label')?.textContent;
                    const sizeMatch = trackLabel?.match(/[\d.]+\s*[KMGT]B/i);
                    if (sizeMatch) {
                        totalSizeBytes += estimateSizeInBytes(sizeMatch[0]);
                    }
                });
                
                // Create summary label
                let summary = '';
                
                // Resolution part
                if (resolutionText) {
                    summary = resolutionText;
                } else {
                    summary = 'Custom';
                }
                
                // Add "no audio" indicator if no audio tracks are selected
                const audioCount = selectedAudioOptions.length;
                if (audioCount === 0 && selectedVideoOption) {
                    summary += ' (no audio)';
                }
                
                // Tracks count part for selected audio/subtitle tracks
                const trackCounts = [];
                const subsCount = selectedSubOptions.length;
                
                if (audioCount > 0) trackCounts.push(`${audioCount} audio`);
                if (subsCount > 0) trackCounts.push(`${subsCount} subs`);
                
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
        display.prepend(label);
    }
}

/**
 * Estimates size in bytes from formatted size string
 * @param {string} sizeStr - Formatted size string (e.g. "10.5 MB")
 * @returns {number} Size in bytes
 */
function estimateSizeInBytes(sizeStr) {
    if (!sizeStr) return 0;
    
    const match = sizeStr.match(/([\d.]+)\s*([KMGT]B)/i);
    if (!match) return 0;
    
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    
    switch(unit) {
        case 'KB': return value * 1024;
        case 'MB': return value * 1024 * 1024;
        case 'GB': return value * 1024 * 1024 * 1024;
        case 'TB': return value * 1024 * 1024 * 1024 * 1024;
        default: return value;
    }
}