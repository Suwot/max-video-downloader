/**
 * Settings Tab Component
 * Replaces placeholder content and provides settings UI
 */

import { createLogger } from '../shared/utils/logger.js';
import { sendPortMessage } from './communication.js';

const logger = createLogger('SettingsTab');

// Settings state
let currentSettings = null;
let settingsTimeouts = new Map(); // Track timeouts for each setting

/**
 * Initialize settings tab - replace placeholder and set up UI
 */
export async function initializeSettingsTab() {
    logger.debug('Initializing settings tab');

    const settingsTab = document.querySelector('.tab-content[data-tab-id="settings-tab"]');
    if (!settingsTab) {
        logger.error('Settings tab container not found');
        return;
    }

    // Replace placeholder content with settings UI
    settingsTab.innerHTML = createSettingsHTML();

    // Set up event listeners
    setupEventListeners();

    // Set up tooltip functionality
    setupTooltips();

    // Request current settings from background
    requestCurrentSettings();
}

/**
 * Create the settings HTML structure using existing patterns
 */
function createSettingsHTML() {
    return `
        <section class="settings-container">
            <!-- Downloads Settings Section -->
            <div class="settings-section">
                <div class="section-content">
                    <div class="input-group horizontal">
                        <label class="input-label">
                            Concurrent Downloads
                            <div class="tooltip-icon" data-tooltip="Maximum number of simultaneous downloads">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
                        <div class="input-container">
                            <input 
                                type="number" 
                                id="max-concurrent-downloads" 
                                class="input-field" 
                                min="1" 
                                max="10" 
                                value="1"
                                placeholder="1"
                            />
                            <div class="input-constraint">Range: 1-10</div>
                        </div>
                    </div>
                    
                    <div class="input-group horizontal path-input-group">
                        <label class="input-label">
                            Default Save Path
                            <div class="tooltip-icon" data-tooltip="Default folder for saving downloaded videos">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
						<div class="input-container">
							<input 
								type="text" 
								id="default-save-path" 
								class="input-field path-input clickable" 
								readonly
								placeholder="Click to choose folder"
							/>
							<div class="input-constraint">Do not choose root folders!</div>
						</div>
                    </div>
                </div>
            </div>

            <!-- Detection Settings Section -->
            <div class="settings-section">
                <div class="section-content">
                    <div class="input-group horizontal">
                        <label class="input-label">
                            Minimum File Size (KB)
                            <div class="tooltip-icon" data-tooltip="Skip video files smaller than this size">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
                        <div class="input-container">
                            <input 
                                type="number" 
                                id="min-file-size-filter" 
                                class="input-field" 
                                min="0" 
                                max="102400"
                                value="100"
                                placeholder="100"
                            />
                            <div class="input-constraint">Max: 100 MB</div>
                        </div>
                    </div>
                    
                    <div class="input-group horizontal">
                        <label class="input-label">
                            Auto-Generate Previews
                            <div class="tooltip-icon" data-tooltip="Automatically generate video thumbnails for detected videos">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
                        <label class="toggle-switch">
                            <input 
                                type="checkbox" 
                                id="auto-generate-previews"
                                checked
                            />
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- History Settings Section -->
            <div class="settings-section">
                <div class="section-content">
                    <div class="input-group horizontal">
                        <label class="input-label">
                            Maximum History Items
                            <div class="tooltip-icon" data-tooltip="Maximum number of download history items to keep">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
                        <div class="input-container">
                            <input 
                                type="number" 
                                id="max-history-size" 
                                class="input-field" 
                                min="0" 
                                max="1000"
                                value="50"
                                placeholder="50"
                            />
                            <div class="input-constraint">Range: 0-1000</div>
                        </div>
                    </div>
                    
                    <div class="input-group horizontal">
                        <label class="input-label">
                            Auto-Remove After (Days)
                            <div class="tooltip-icon" data-tooltip="Automatically remove history items older than this many days">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </label>
                        <div class="input-container">
                            <input 
                                type="number" 
                                id="history-auto-remove-interval" 
                                class="input-field" 
                                min="1" 
                                max="365"
                                value="30"
                                placeholder="30"
                            />
                            <div class="input-constraint">Range: 1-365</div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    `;
}

/**
 * Set up event listeners for settings inputs
 */
function setupEventListeners() {
    // Concurrent downloads
    const maxConcurrentInput = document.getElementById('max-concurrent-downloads');
    if (maxConcurrentInput) {
        maxConcurrentInput.addEventListener('input', handleConcurrentDownloadsChange);
        maxConcurrentInput.addEventListener('blur', validateConcurrentDownloadsInput);
    }

    // Default save path - make input clickable
    const defaultSavePathInput = document.getElementById('default-save-path');
    if (defaultSavePathInput) {
        defaultSavePathInput.addEventListener('click', handleChooseSavePath);
        defaultSavePathInput.style.cursor = 'pointer';
    }

    // Minimum file size filter
    const minFileSizeInput = document.getElementById('min-file-size-filter');
    if (minFileSizeInput) {
        minFileSizeInput.addEventListener('input', handleMinFileSizeChange);
        minFileSizeInput.addEventListener('blur', validateMinFileSizeInput);
    }

    // Auto-generate previews toggle
    const autoPreviewsToggle = document.getElementById('auto-generate-previews');
    if (autoPreviewsToggle) {
        autoPreviewsToggle.addEventListener('change', handleAutoPreviewsChange);
    }

    // Max history size
    const maxHistoryInput = document.getElementById('max-history-size');
    if (maxHistoryInput) {
        maxHistoryInput.addEventListener('input', handleMaxHistoryChange);
        maxHistoryInput.addEventListener('blur', validateMaxHistoryInput);
    }

    // History auto-remove interval
    const historyIntervalInput = document.getElementById('history-auto-remove-interval');
    if (historyIntervalInput) {
        historyIntervalInput.addEventListener('input', handleHistoryIntervalChange);
        historyIntervalInput.addEventListener('blur', validateHistoryIntervalInput);
    }
}

/**
 * Handle concurrent downloads input change with delayed update
 */
function handleConcurrentDownloadsChange(event) {
    const input = event.target;
    const value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear existing timeout
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
    }

    // Validate range
    if (isNaN(value) || value < 1 || value > 10) {
        input.classList.add('error');
        input.classList.remove('success');
        return;
    }

    input.classList.remove('error');

    // Set delayed update with success feedback
    const timeoutId = setTimeout(() => {
        if (currentSettings) {
            const updatedSettings = {
                ...currentSettings,
                maxConcurrentDownloads: value
            };

            updateSettings(updatedSettings);
            showSuccessFeedback(input);
        }
        settingsTimeouts.delete(inputId);
    }, 1000);

    settingsTimeouts.set(inputId, timeoutId);
}

/**
 * Validate and fix concurrent downloads input on blur
 */
function validateConcurrentDownloadsInput(event) {
    const input = event.target;
    let value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear any pending timeout since we're validating now
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
        settingsTimeouts.delete(inputId);
    }

    // Fix invalid values
    if (isNaN(value) || value < 1) {
        value = 1;
    } else if (value > 10) {
        value = 10;
    }

    input.value = value;
    input.classList.remove('error');

    // Update settings with corrected value and show success
    if (currentSettings) {
        const updatedSettings = {
            ...currentSettings,
            maxConcurrentDownloads: value
        };

        updateSettings(updatedSettings);
        showSuccessFeedback(input);
    }
}

/**
 * Handle choose save path button click
 */
async function handleChooseSavePath() {
    logger.debug('Choosing save path');

    try {
        // Send message to background to open folder chooser
        sendPortMessage({
            command: 'chooseSavePath'
        });
    } catch (error) {
        logger.error('Error choosing save path:', error);
    }
}

/**
 * Handle minimum file size input change with delayed update
 */
function handleMinFileSizeChange(event) {
    const input = event.target;
    const value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear existing timeout
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
    }

    // Validate range (convert KB to bytes for storage)
    if (isNaN(value) || value < 0 || value > 102400) {
        input.classList.add('error');
        input.classList.remove('success');
        return;
    }

    input.classList.remove('error');

    // Set delayed update with success feedback
    const timeoutId = setTimeout(() => {
        if (currentSettings) {
            const updatedSettings = {
                ...currentSettings,
                minFileSizeFilter: value * 1024
            };

            updateSettings(updatedSettings);
            showSuccessFeedback(input);
        }
        settingsTimeouts.delete(inputId);
    }, 1000);

    settingsTimeouts.set(inputId, timeoutId);
}

/**
 * Validate and fix minimum file size input on blur
 */
function validateMinFileSizeInput(event) {
    const input = event.target;
    let value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear any pending timeout since we're validating now
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
        settingsTimeouts.delete(inputId);
    }

    // Fix invalid values
    if (isNaN(value) || value < 0) {
        value = 0;
    } else if (value > 102400) {
        value = 102400;
    }

    input.value = value;
    input.classList.remove('error');

    // Update settings with corrected value (convert KB to bytes) and show success
    if (currentSettings) {
        const updatedSettings = {
            ...currentSettings,
            minFileSizeFilter: value * 1024
        };

        updateSettings(updatedSettings);
        showSuccessFeedback(input);
    }
}

/**
 * Handle auto-generate previews toggle change
 */
function handleAutoPreviewsChange(event) {
    const checkbox = event.target;
    const value = checkbox.checked;

    // Update settings immediately for toggles (no delay needed)
    if (currentSettings) {
        const updatedSettings = {
            ...currentSettings,
            autoGeneratePreviews: value
        };

        updateSettings(updatedSettings);

        // Show brief success feedback on the toggle container
        const toggleSwitch = checkbox.closest('.toggle-switch');
        if (toggleSwitch) {
            toggleSwitch.classList.add('success');
            setTimeout(() => {
                toggleSwitch.classList.remove('success');
            }, 500);
        }
    }
}

/**
 * Handle max history size input change with delayed update
 */
function handleMaxHistoryChange(event) {
    const input = event.target;
    const value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear existing timeout
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
    }

    // Validate range
    if (isNaN(value) || value < 0 || value > 1000) {
        input.classList.add('error');
        input.classList.remove('success');
        return;
    }

    input.classList.remove('error');

    // Set delayed update with success feedback
    const timeoutId = setTimeout(() => {
        if (currentSettings) {
            const updatedSettings = {
                ...currentSettings,
                maxHistorySize: value
            };

            updateSettings(updatedSettings);
            showSuccessFeedback(input);
        }
        settingsTimeouts.delete(inputId);
    }, 1000);

    settingsTimeouts.set(inputId, timeoutId);
}

/**
 * Validate and fix max history size input on blur
 */
function validateMaxHistoryInput(event) {
    const input = event.target;
    let value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear any pending timeout since we're validating now
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
        settingsTimeouts.delete(inputId);
    }

    // Fix invalid values
    if (isNaN(value) || value < 0) {
        value = 0;
    } else if (value > 1000) {
        value = 1000;
    }

    input.value = value;
    input.classList.remove('error');

    // Update settings with corrected value and show success
    if (currentSettings) {
        const updatedSettings = {
            ...currentSettings,
            maxHistorySize: value
        };

        updateSettings(updatedSettings);
        showSuccessFeedback(input);
    }
}

/**
 * Handle history auto-remove interval input change with delayed update
 */
function handleHistoryIntervalChange(event) {
    const input = event.target;
    const value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear existing timeout
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
    }

    // Validate range
    if (isNaN(value) || value < 1 || value > 365) {
        input.classList.add('error');
        input.classList.remove('success');
        return;
    }

    input.classList.remove('error');

    // Set delayed update with success feedback
    const timeoutId = setTimeout(() => {
        if (currentSettings) {
            const updatedSettings = {
                ...currentSettings,
                historyAutoRemoveInterval: value
            };

            updateSettings(updatedSettings);
            showSuccessFeedback(input);
        }
        settingsTimeouts.delete(inputId);
    }, 1000);

    settingsTimeouts.set(inputId, timeoutId);
}

/**
 * Validate and fix history auto-remove interval input on blur
 */
function validateHistoryIntervalInput(event) {
    const input = event.target;
    let value = parseInt(input.value, 10);
    const inputId = input.id;

    // Clear any pending timeout since we're validating now
    if (settingsTimeouts.has(inputId)) {
        clearTimeout(settingsTimeouts.get(inputId));
        settingsTimeouts.delete(inputId);
    }

    // Fix invalid values
    if (isNaN(value) || value < 1) {
        value = 1;
    } else if (value > 365) {
        value = 365;
    }

    input.value = value;
    input.classList.remove('error');

    // Update settings with corrected value and show success
    if (currentSettings) {
        const updatedSettings = {
            ...currentSettings,
            historyAutoRemoveInterval: value
        };

        updateSettings(updatedSettings);
        showSuccessFeedback(input);
    }
}

/**
 * Request current settings from background
 */
function requestCurrentSettings() {
    logger.debug('Requesting current settings from background');
    sendPortMessage({ command: 'getSettings' });
}

/**
 * Update settings in background
 */
function updateSettings(settings) {
    logger.debug('Updating settings:', settings);
    currentSettings = settings;

    sendPortMessage({
        command: 'updateSettings',
        settings: settings
    });
}

/**
 * Show success feedback for input
 */
function showSuccessFeedback(input) {
    input.classList.add('success');

    // Remove success class after 1 second
    setTimeout(() => {
        input.classList.remove('success');
    }, 1000);
}

/**
 * Set up tooltip functionality
 */
function setupTooltips() {
    const tooltipIcons = document.querySelectorAll('.tooltip-icon');

    tooltipIcons.forEach(icon => {
        let tooltip = null;

        icon.addEventListener('mouseenter', (e) => {
            const tooltipText = icon.getAttribute('data-tooltip');
            if (!tooltipText) return;

            // Create tooltip element
            tooltip = document.createElement('div');
            tooltip.className = 'tooltip';
            tooltip.textContent = tooltipText;
            document.body.appendChild(tooltip);

            // Position tooltip
            const rect = icon.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();

            tooltip.style.left = `${rect.left + rect.width / 2 - tooltipRect.width / 2}px`;
            tooltip.style.top = `${rect.top - tooltipRect.height - 8}px`;
        });

        icon.addEventListener('mouseleave', () => {
            if (tooltip) {
                tooltip.remove();
                tooltip = null;
            }
        });
    });
}

/**
 * Update settings UI with current values
 */
export function updateSettingsUI(settings) {
    logger.debug('Updating settings UI:', settings);
    currentSettings = settings;

    // Concurrent downloads
    const maxConcurrentInput = document.getElementById('max-concurrent-downloads');
    if (maxConcurrentInput && settings.maxConcurrentDownloads !== undefined) {
        maxConcurrentInput.value = settings.maxConcurrentDownloads;
        maxConcurrentInput.classList.remove('error');
    }

    // Default save path
    const defaultSavePathInput = document.getElementById('default-save-path');
    if (defaultSavePathInput && settings.defaultSavePath !== undefined) {
        defaultSavePathInput.value = settings.defaultSavePath || '';
        defaultSavePathInput.placeholder = settings.defaultSavePath ? '' : 'Click to choose folder';
    }

    // Minimum file size filter (convert bytes to KB for display)
    const minFileSizeInput = document.getElementById('min-file-size-filter');
    if (minFileSizeInput && settings.minFileSizeFilter !== undefined) {
        minFileSizeInput.value = Math.round(settings.minFileSizeFilter / 1024);
        minFileSizeInput.classList.remove('error');
    }

    // Auto-generate previews
    const autoPreviewsToggle = document.getElementById('auto-generate-previews');
    if (autoPreviewsToggle && settings.autoGeneratePreviews !== undefined) {
        autoPreviewsToggle.checked = settings.autoGeneratePreviews;
    }

    // Max history size
    const maxHistoryInput = document.getElementById('max-history-size');
    if (maxHistoryInput && settings.maxHistorySize !== undefined) {
        maxHistoryInput.value = settings.maxHistorySize;
        maxHistoryInput.classList.remove('error');
    }

    // History auto-remove interval
    const historyIntervalInput = document.getElementById('history-auto-remove-interval');
    if (historyIntervalInput && settings.historyAutoRemoveInterval !== undefined) {
        historyIntervalInput.value = settings.historyAutoRemoveInterval;
        historyIntervalInput.classList.remove('error');
    }
}

