/**
 * Settings Tab Component - Streamlined settings UI
 */

import { createLogger } from '../shared/utils/logger.js';
import { sendPortMessage } from './communication.js';
import { showConfirmModal } from './ui-utils.js';

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
  maxHistorySize: { type: 'number', min: 0, max: 200, confirmReduce: true },
  historyAutoRemoveInterval: { type: 'number', min: 1, max: 365 }
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

    // Replace placeholder content with settings UI
    settingsTab.innerHTML = createSettingsHTML();

    // Set up event listeners
    setupEventListeners();

    // Set up tooltip functionality
    setupTooltips();

    // Request current settings from background
    sendPortMessage({ command: 'getSettings' });
}

/**
 * Create the settings HTML structure using existing patterns
 */
function createSettingsHTML() {
    return `
        <section class="settings-container">
            <!-- Downloads Settings Section -->
            <div class="settings-section">
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
							data-setting="maxConcurrentDownloads"
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
							data-setting="defaultSavePath"
							class="input-field path-input clickable" 
							readonly
							placeholder="Click to choose folder"
						/>
						<div class="input-constraint">Do not choose root folders!</div>
					</div>
				</div>
				
				<div class="input-group horizontal">
					<label class="input-label">
						Show Download Notifications
						<div class="tooltip-icon" data-tooltip="Show system notifications when downloads start and complete">
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
							data-setting="showDownloadNotifications"
							checked
						/>
						<span class="toggle-slider"></span>
					</label>
				</div>
            </div>

            <!-- Detection Settings Section -->
            <div class="settings-section">
				<div class="input-group horizontal">
					<label class="input-label">
						Min. File Size
						<div class="tooltip-icon" data-tooltip="Skip video files smaller than this size">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
								<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
								<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
								<path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						</div>
					</label>
					<div class="input-container">
						<div class="unit-input-group">
							<div class="unit-toggle" data-unit-toggle="minFileSizeFilter">
								<button type="button" class="unit-option active" data-multiplier="1024">KB</button>
								<button type="button" class="unit-option" data-multiplier="1048576">MB</button>
							</div>
							<input 
								type="number" 
								data-setting="minFileSizeFilter"
								class="input-field unit-number-input" 
								min="0" 
								max="102400"
								step="0.01"
								value="100"
								placeholder="100"
							/>
						</div>
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
							data-setting="autoGeneratePreviews"
							checked
						/>
						<span class="toggle-slider"></span>
					</label>
				</div>
            </div>

            <!-- History Settings Section -->
            <div class="settings-section">
				<div class="input-group horizontal">
					<label class="input-label">
						Max. History Items
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
							data-setting="maxHistorySize"
							class="input-field" 
							min="0" 
							max="200"
							value="50"
							placeholder="50"
						/>
						<div class="input-constraint">Range: 0-200</div>
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
							data-setting="historyAutoRemoveInterval"
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
        </section>
    `;
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
 * Set up tooltip functionality
 */
function setupTooltips() {
    const tooltipIcons = document.querySelectorAll('.tooltip-icon');

    tooltipIcons.forEach(icon => {
        let tooltip = null;

        icon.addEventListener('mouseenter', () => {
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
 * Update settings UI with current values - unified approach
 */
export function updateSettingsUI(settings) {
    logger.debug('Updating settings UI:', settings);
    currentSettings = settings;

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

