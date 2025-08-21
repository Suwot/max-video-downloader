/**
 * Settings Tab Component - Streamlined settings UI
 */

import { createLogger } from '../shared/utils/logger.js';
import { sendPortMessage } from './communication.js';
import { showConfirmModal } from './ui-utils.js';
import { renderHistoryItems } from './video/video-renderer.js';

const logger = createLogger('SettingsTab');

let currentSettings = null;

// Setting configurations with validation and display logic
const SETTING_CONFIGS = {
  maxConcurrentDownloads: { type: 'number', min: 1, max: 10 },
  defaultSavePath: { type: 'path' },
  showDownloadNotifications: { type: 'boolean' },
  minFileSizeFilter: { 
    type: 'unit-number',
    min: 0, 
    max: 100,  // max value in either unit
    units: [
      { label: 'KB', multiplier: 1024 },
      { label: 'MB', multiplier: 1048576 }
    ]
  },
  autoGeneratePreviews: { type: 'boolean' },
  saveDownloadsInHistory: { type: 'boolean' },
  maxHistorySize: { type: 'number', min: 0, max: 200, confirmReduce: true },
  historyAutoRemoveInterval: { type: 'number', min: 1, max: 365 },
  theme: {
    type: 'unit',
    units: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' }
    ]
  }
};

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

    // Settings HTML is now in popup.html - just set up event listeners
    setupEventListeners();

    // Tooltips now handled by global system
    
    // Set up native host status handlers
    setupNativeHostStatus();

    // Request current settings from background
    sendPortMessage({ command: 'getSettings' });
}

/**
 * Set up unified event listeners for all settings inputs
 */
function setupEventListeners() {
    // Set up listeners for all settings inputs using data attributes
    Object.keys(SETTING_CONFIGS).forEach(settingKey => {
        const config = SETTING_CONFIGS[settingKey];
        const element = document.querySelector(`[data-setting="${settingKey}"]`);
        
        if (!element) return;

        if (config.type === 'path') {
            element.addEventListener('click', () => handleChooseSavePath());
        } else if (config.type === 'boolean') {
            element.addEventListener('change', (e) => {
                handleSettingChange(settingKey, e.target.checked);
                // Show success feedback on toggle switch
                const toggleSwitch = e.target.closest('.toggle-switch');
                if (toggleSwitch) {
                    toggleSwitch.classList.add('success');
                    setTimeout(() => toggleSwitch.classList.remove('success'), 500);
                }
            });
        } else if (config.type === 'number') {
            element.addEventListener('blur', (e) => handleNumberInput(settingKey, e.target));
            addKeyboardHandlers(element);
        } else if (config.type === 'unit-number') {
            element.addEventListener('blur', (e) => handleUnitNumberInput(settingKey, e.target));
            addKeyboardHandlers(element);
            
            // Set up unit toggle listeners
            const unitToggle = document.querySelector(`[data-unit-toggle="${settingKey}"]`);
            if (unitToggle) {
                unitToggle.addEventListener('click', (e) => {
                    if (e.target.classList.contains('unit-option')) {
                        handleUnitToggleClick(settingKey, e.target);
                    }
                });
            }
        } else if (config.type === 'unit') {
            // For unit type, the element itself is the unit-toggle
            if (element) {
                element.addEventListener('click', (e) => {
                    if (e.target.classList.contains('unit-option')) {
                        handleUnitClick(settingKey, e.target);
                    }
                });
            }
        }
    });
}

/**
 * Unified setting change handler - always send all settings immediately
 */
function handleSettingChange(settingKey, value) {
    if (!currentSettings) return;

    const config = SETTING_CONFIGS[settingKey];
    
    // Transform value if needed (e.g., KB to bytes)
    const transformedValue = config.transform ? config.transform(value) : value;

    // Update all settings immediately - simple and robust
    updateSettings({ ...currentSettings, [settingKey]: transformedValue });
    showSuccessFeedback(document.querySelector(`[data-setting="${settingKey}"]`));
}

/**
 * Handle number input validation and change
 */
async function handleNumberInput(settingKey, input) {
    const config = SETTING_CONFIGS[settingKey];
    let value = parseInt(input.value, 10);

    // Store original value for potential restoration
    const originalDisplayValue = config.display ? config.display(currentSettings[settingKey]) : currentSettings[settingKey];

    // Clamp to valid range
    if (isNaN(value) || value < config.min) value = config.min;
    if (value > config.max) value = config.max;

    input.value = value;
    input.classList.remove('error');

    // Get display value for comparison
    const currentValue = config.display ? config.display(currentSettings[settingKey]) : currentSettings[settingKey];
    
    if (currentSettings && currentValue !== value) {
        // For settings that need confirmation, handle specially
        if (config.confirmReduce && value < currentValue) {
            const confirmed = await confirmHistoryReduction(value, input);
            if (!confirmed) {
                // Restore original value
                input.value = originalDisplayValue;
                return;
            }
        }
        
        handleSettingChange(settingKey, value);
        showSuccessFeedback(input);
    }
}

/**
 * Handle save path selection
 */
async function handleChooseSavePath() {
    try {
        sendPortMessage({ command: 'chooseSavePath' });
    } catch (error) {
        logger.error('Error choosing save path:', error);
    }
}

/**
 * Confirm history reduction with actual count check
 */
async function confirmHistoryReduction(newLimit, triggerElement) {
    try {
        const result = await chrome.storage.local.get(['downloads_history']);
        const currentCount = (result.downloads_history || []).length;
        
        if (currentCount > newLimit) {
            const itemsToRemove = currentCount - newLimit;
            return await showConfirmModal(
                `${itemsToRemove} items will be removed from history - are you sure?`,
                null, // onConfirm handled by promise
                null, // onCancel handled by promise  
                triggerElement // Pass trigger element for positioning
            );
        }
        return true;
    } catch (error) {
        logger.error('Error checking history count:', error);
        return true; // Continue without confirmation if we can't check
    }
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
 * Update settings UI with current values - unified approach
 */
export function updateSettingsUI(settings) {
    logger.debug('Updating settings UI:', settings);
    currentSettings = settings;
    
    // Apply theme immediately when settings are loaded
    if (settings.theme) {
        applyThemeFromSettings(settings.theme);
    }

    // Update all settings inputs using unified approach
    Object.entries(SETTING_CONFIGS).forEach(([settingKey, config]) => {
        const element = document.querySelector(`[data-setting="${settingKey}"]`);
        if (!element || settings[settingKey] === undefined) return;

        element.classList.remove('error');

        if (config.type === 'boolean') {
            element.checked = settings[settingKey];
        } else if (config.type === 'path') {
            element.value = settings[settingKey] || '';
            element.placeholder = settings[settingKey] ? '' : 'Click to choose folder';
        } else if (config.type === 'number') {
            element.value = settings[settingKey];
        } else if (config.type === 'unit-number') {
            // Handle unit-number inputs - use stored unit preference
            const bytes = settings[settingKey];
            const preferredUnit = settings[settingKey + 'Unit'] || 1024; // Default to KB
            
            // Set the display value with decimal precision
            const displayValue = bytes / preferredUnit;
            
            // Format with up to 2 decimal places, using user's locale
            const formattedValue = displayValue.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2,
                useGrouping: false
            });
            
            element.value = formattedValue;
            
            // Set dynamic max constraint based on unit
            const maxBytes = 100 * 1048576; // 100 MB in bytes
            const maxValueForUnit = maxBytes / preferredUnit;
            element.max = maxValueForUnit;
            
            // Store original bytes for change detection
            element.dataset.originalBytes = bytes.toString();
            
            // Set active unit toggle
            const unitToggle = document.querySelector(`[data-unit-toggle="${settingKey}"]`);
            if (unitToggle) {
                unitToggle.querySelectorAll('.unit-option').forEach(opt => {
                    const isActive = parseInt(opt.dataset.multiplier, 10) === preferredUnit;
                    opt.classList.toggle('active', isActive);
                });
            }
        } else if (config.type === 'unit') {
            // Handle simple unit toggles (like theme) - element is the unit-toggle itself
            if (element) {
                element.querySelectorAll('.unit-option').forEach(opt => {
                    const isActive = opt.dataset.value === settings[settingKey];
                    opt.classList.toggle('active', isActive);
                });
            }
        }
    });
}

/**
 * Handle unit-number input (value with unit toggle)
 */
async function handleUnitNumberInput(settingKey, input) {
    const config = SETTING_CONFIGS[settingKey];
    let value = parseFloat(input.value.replace(',', '.')); // Support both . and , decimal separators

    // Get active unit multiplier
    const activeUnit = getActiveUnitOption(settingKey);
    if (!activeUnit) return;
    
    const multiplier = parseInt(activeUnit.dataset.multiplier, 10);

    // Calculate dynamic max based on unit (100 MB total limit)
    const maxBytes = 100 * 1048576; // 100 MB in bytes
    const maxValueForUnit = maxBytes / multiplier;

    // Clamp to valid range
    if (isNaN(value) || value < config.min) value = config.min;
    if (value > maxValueForUnit) value = maxValueForUnit;

    // Format value with up to 2 decimal places, using user's locale
    const formattedValue = value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
        useGrouping: false
    });
    
    input.value = formattedValue;
    input.classList.remove('error');

    // Calculate bytes and check if changed (round to avoid floating point issues)
    const newBytes = Math.round(value * multiplier);
    const originalBytes = parseInt(input.dataset.originalBytes || '0', 10);

    if (currentSettings && newBytes !== originalBytes) {
        // Update both the bytes value and the unit preference
        const updatedSettings = {
            ...currentSettings,
            [settingKey]: newBytes,
            [settingKey + 'Unit']: multiplier
        };
        
        updateSettings(updatedSettings);
        showSuccessFeedback(input);
        
        // Update stored original bytes
        input.dataset.originalBytes = newBytes.toString();
    }
}

/**
 * Handle unit toggle click - convert display value only, don't save until input changes
 */
function handleUnitToggleClick(settingKey, clickedUnit) {
    const input = document.querySelector(`[data-setting="${settingKey}"].unit-number-input`);
    const unitToggle = document.querySelector(`[data-unit-toggle="${settingKey}"]`);
    const config = SETTING_CONFIGS[settingKey];
    
    if (!input || !unitToggle || !currentSettings) return;

    // Don't do anything if clicking the already active unit
    if (clickedUnit.classList.contains('active')) return;

    // Update active state
    unitToggle.querySelectorAll('.unit-option').forEach(opt => opt.classList.remove('active'));
    clickedUnit.classList.add('active');

    // Get current bytes and new multiplier
    const currentBytes = currentSettings[settingKey];
    const newMultiplier = parseInt(clickedUnit.dataset.multiplier, 10);
    
    // Convert to new unit with decimal precision
    const newDisplayValue = currentBytes / newMultiplier;
    
    // Format with up to 2 decimal places, using user's locale
    const formattedValue = newDisplayValue.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
        useGrouping: false
    });
    
    // Update input value and dynamic max constraint
    input.value = formattedValue;
    
    // Calculate dynamic max based on unit (100 MB total limit)
    const maxBytes = 100 * 1048576; // 100 MB in bytes
    const maxValueForUnit = maxBytes / newMultiplier;
    input.max = maxValueForUnit;
    
    // Store original bytes for change detection
    input.dataset.originalBytes = currentBytes.toString();
    
    // No success feedback needed for unit toggle - only for actual value changes
}

/**
 * Get active unit option for a setting
 */
function getActiveUnitOption(settingKey) {
    const unitToggle = document.querySelector(`[data-unit-toggle="${settingKey}"]`);
    return unitToggle ? unitToggle.querySelector('.unit-option.active') : null;
}

/**
 * Handle unit toggle click for simple unit settings (like theme)
 */
function handleUnitClick(settingKey, clickedUnit) {
    const unitToggle = document.querySelector(`[data-setting="${settingKey}"]`);
    
    if (!unitToggle || !currentSettings) return;

    // Don't do anything if clicking the already active unit
    if (clickedUnit.classList.contains('active')) return;

    // Update active state
    unitToggle.querySelectorAll('.unit-option').forEach(opt => opt.classList.remove('active'));
    clickedUnit.classList.add('active');

    // Get the new value and update settings
    const newValue = clickedUnit.dataset.value;
    handleSettingChange(settingKey, newValue);
    
    // Apply theme immediately if this is the theme setting
    if (settingKey === 'theme') {
        applyThemeFromSettings(newValue);
    }
}

/**
 * Apply theme from settings value - direct DOM manipulation
 */
function applyThemeFromSettings(themeValue) {
    if (!themeValue || (themeValue !== 'dark' && themeValue !== 'light')) {
        logger.warn('Invalid theme value, using dark as fallback:', themeValue);
        themeValue = 'dark';
    }
    
    // Apply theme to DOM directly - same as other settings
    if (themeValue === 'dark') {
        document.body.classList.add('theme-dark');
        document.body.classList.remove('theme-light');
    } else {
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
    }
    
    logger.debug('Applied theme from settings:', themeValue);
}

/**
 * Add keyboard handlers for number inputs
 */
function addKeyboardHandlers(input) {
    let originalValue = input.value;
    
    input.addEventListener('focus', () => {
        originalValue = input.value;
    });
    
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            input.value = originalValue;
            input.blur();
            
            setTimeout(() => {
                input.classList.add('error');
                setTimeout(() => input.classList.remove('error'), 1000);
            }, 10);
        }
    });
}

/**
 * Set up native host status handlers
 */
function setupNativeHostStatus() {
    // Set up button event listeners
    const reconnectButton = document.getElementById('reconnect-button');
    const reconnectIcon = document.getElementById('reconnect-icon');
    const downloadButton = document.getElementById('download-button');
    const helpButton = document.getElementById('help-button');
    
    if (reconnectButton) {
        reconnectButton.addEventListener('click', handleReconnectClick);
    }
    
    if (reconnectIcon) {
        reconnectIcon.addEventListener('click', handleReconnectClick);
    }
    
    if (downloadButton) {
        downloadButton.addEventListener('click', handleDownloadClick);
    }
    
    if (helpButton) {
        helpButton.addEventListener('click', handleHelpClick);
    }

    
    // Request initial native host state
    sendPortMessage({ command: 'getNativeHostState' });
}

/**
 * Handle reconnect button click
 */
async function handleReconnectClick() {
    try {
        sendPortMessage({ command: 'reconnectNativeHost' });
        // Connection state updates will be handled automatically via nativeHostConnectionState
    } catch (error) {
        logger.error('Error sending reconnect command:', error);
    }
}

/**
 * Handle download button click
 */
function handleDownloadClick() {
    // Open download page for native host
    chrome.tabs.create({ 
        url: 'https://github.com/maxvideodownloader/releases/latest',
        active: true 
    });
}

/**
 * Handle help button click
 */
function handleHelpClick() {
    // Open help/troubleshooting page
    chrome.tabs.create({ 
        url: 'https://github.com/maxvideodownloader/wiki/Native-Host-Troubleshooting',
        active: true 
    });
}

/**
 * Handle clear history button click
 */
export async function handleClearHistoryClick() {
    const button = document.getElementById('clear-history-button');
    const originalText = button?.textContent;
    
    button.disabled = true;
    await chrome.storage.local.remove(['downloads_history']);
    await renderHistoryItems(true);
    
    button.classList.add('success');
    button.textContent = 'History Cleared';
    setTimeout(() => {
        button.classList.remove('success');
        button.textContent = originalText;
        button.disabled = false;
    }, 1000);
}

/**
 * Update native host connection status display
 */
export function updateNativeHostStatus(connectionState) {
    const { state, info, error } = connectionState;
    
    updateConnectionStatus(state, info, getStatusText(state, info, error));
}

/**
 * Update connection status UI elements
 */
function updateConnectionStatus(state, info, statusText) {
    const statusDot = document.getElementById('connection-status-dot');
    const statusTextElement = document.getElementById('connection-status-text');
    const statusVersion = document.getElementById('connection-version');
    const statusLocation = document.getElementById('connection-location');
    const statusLocationLine = document.getElementById('connection-location-line');
    const statusFFmpeg = document.getElementById('connection-ffmpeg');
    const statusFFmpegLine = document.getElementById('connection-ffmpeg-line');
    const statusActions = document.getElementById('status-actions');
    const reconnectButton = document.getElementById('reconnect-button');
    const reconnectIcon = document.getElementById('reconnect-icon');
    
    if (statusDot) {
        statusDot.className = `status-dot ${state}`;
    }
    
    if (statusTextElement) {
        statusTextElement.textContent = statusText;
    }
    
    // Differentiate "not found" vs "found but disconnected"
    const coappFound = info && (info.version || info.location || info.ffmpegVersion);
    
    if (coappFound) {
        // CoApp found - show info lines and reconnect icon, hide action buttons
        
        // Update status text to include version
        if (statusTextElement && info?.version) {
            statusTextElement.textContent = `${statusText} (v${info.version})`;
        }
        
        // Hide redundant version display
        if (statusVersion) {
            statusVersion.style.display = 'none';
        }
        
        // Show location info
        if (statusLocation && statusLocationLine && info?.location) {
            statusLocation.textContent = info.location;
            statusLocationLine.style.display = 'flex';
        } else if (statusLocationLine) {
            statusLocationLine.style.display = 'none';
        }
        
        // Show FFmpeg info
        if (statusFFmpeg && statusFFmpegLine && info?.ffmpegVersion) {
            statusFFmpeg.textContent = `v${info.ffmpegVersion} (custom)`;
            statusFFmpegLine.style.display = 'flex';
        } else if (statusFFmpegLine) {
            statusFFmpegLine.style.display = 'none';
        }
        
        // Hide action buttons when CoApp is found
        if (statusActions) {
            statusActions.classList.add('hidden');
        }
        
        // Show reconnect icon when CoApp is found (any state)
        if (reconnectIcon) {
            reconnectIcon.classList.remove('hidden');
        }
        
    } else {
        // CoApp not found - show action buttons, hide info lines and reconnect icon
        if (statusVersion) {
            statusVersion.style.display = 'none';
        }
        
        // Hide info lines
        if (statusLocationLine) {
            statusLocationLine.style.display = 'none';
        }
        if (statusFFmpegLine) {
            statusFFmpegLine.style.display = 'none';
        }
        
        // Show action buttons when CoApp is not found
        if (statusActions) {
            statusActions.classList.remove('hidden');
        }
        
        // Hide reconnect icon when CoApp is not found
        if (reconnectIcon) {
            reconnectIcon.classList.add('hidden');
        }
    }
    
    if (reconnectButton) {
        const isConnecting = state === 'connecting' || state === 'validating';
        reconnectButton.disabled = isConnecting;
        reconnectButton.innerHTML = isConnecting ? 'Reconnecting...' : `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M1 4v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Reconnect
        `;
    }
}

/**
 * Get status text based on connection state
 */
function getStatusText(state, info, _error) {
    switch (state) {
        case 'connected':
            return 'Connected';
        case 'connecting':
            return 'Connecting...';
        case 'validating':
            return 'Validating...';
        case 'disconnected':
            // Differentiate between "found but disconnected" vs "not found"
            return info ? 'Disconnected' : 'Not found';
        case 'error':
            // Differentiate between "found but error" vs "not found"
            return info ? 'Connection Error' : 'Not found';
        default:
            return 'Unknown';
    }
}