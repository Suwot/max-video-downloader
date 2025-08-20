/* 
* Helpers for UI operations
*/

// Unified toast system with progress bar and hover pause
export function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // Create message container
    const messageDiv = document.createElement('div');
    messageDiv.className = 'toast-message';
    messageDiv.textContent = message;
    
    // Create progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'toast-progress';
    
    toast.appendChild(messageDiv);
    toast.appendChild(progressBar);
    document.body.appendChild(toast);
    
    let startTime = Date.now();
    let totalDuration = duration;
    let remainingTime = duration;
    let animationId = null;
    let timeoutId = null;
    let isPaused = false;
    
    // Progress animation function
    function updateProgress() {
        if (isPaused) return;
        
        const elapsed = Date.now() - startTime;
        const timeLeft = Math.max(0, remainingTime - elapsed);
        const progress = timeLeft / totalDuration;
        progressBar.style.transform = `scaleX(${progress})`;
        
        if (timeLeft > 0) {
            animationId = requestAnimationFrame(updateProgress);
        }
    }
    
    // Auto-dismiss function
    function dismiss() {
        if (animationId) cancelAnimationFrame(animationId);
        if (timeoutId) clearTimeout(timeoutId);
        
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }
    
    // Hover pause/resume
    toast.addEventListener('mouseenter', () => {
        if (!isPaused) {
            isPaused = true;
            // Calculate how much time has passed and update remaining time
            const elapsed = Date.now() - startTime;
            remainingTime = Math.max(0, remainingTime - elapsed);
            
            if (timeoutId) clearTimeout(timeoutId);
            if (animationId) cancelAnimationFrame(animationId);
        }
    });
    
    toast.addEventListener('mouseleave', () => {
        if (isPaused) {
            isPaused = false;
            startTime = Date.now(); // Reset start time for next cycle
            
            timeoutId = setTimeout(dismiss, remainingTime);
            updateProgress();
        }
    });
    
    // Click to dismiss
    toast.addEventListener('click', dismiss);
    
    // Show toast immediately
    toast.classList.add('show');
    updateProgress();
    timeoutId = setTimeout(dismiss, duration);
}

// Convenience functions for different toast types
export function showError(message, duration = 4000) {
    showToast(message, 'error', duration);
}

export function showSuccess(message, duration = 3000) {
    showToast(message, 'success', duration);
}

export function showInfo(message, duration = 3000) {
    showToast(message, 'info', duration);
}

// Confirmation modal
export function showConfirmModal(message, onConfirm, onCancel = null, triggerElement = null) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'confirm-modal';
        
        const content = document.createElement('div');
        content.className = 'confirm-modal-content';
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'confirm-modal-message';
        messageDiv.textContent = message;
        
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'confirm-modal-buttons';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-small';
        cancelBtn.textContent = 'Cancel';
        
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn btn-primary btn-small';
        confirmBtn.textContent = 'Confirm';
        
        // Cancel on left, Confirm on right (LTR)
        buttonsDiv.appendChild(cancelBtn);
        buttonsDiv.appendChild(confirmBtn);
        
        content.appendChild(messageDiv);
        content.appendChild(buttonsDiv);
        modal.appendChild(content);
        
        // Smart positioning relative to trigger element
        if (triggerElement) {
            const rect = triggerElement.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const headerHeight = 98; // Sticky header height
            const modalWidth = 150; // Updated modal width
            const modalHeight = 80; // Approximate modal height
            
            let top, left;
            
            // Check if there's space above (considering header)
            const spaceAbove = rect.top - headerHeight;
            
            if (spaceAbove >= modalHeight) {
                // Position above with 3px gap
                top = rect.top - modalHeight - 27;
            } else {
                // Position below with 3px gap
                top = rect.bottom + 27;
            }
            
            // Check horizontal positioning
            const spaceRight = windowWidth - rect.left;
            const spaceLeft = rect.right;
            
            if (spaceRight >= modalWidth) {
                // Align left edge with trigger element
                left = rect.left;
            } else if (spaceLeft >= modalWidth) {
                // Align right edge with trigger element
                left = rect.right - modalWidth;
            } else {
                // Center in available space
                left = Math.max(8, (windowWidth - modalWidth) / 2);
            }
            
            content.style.position = 'fixed';
            content.style.top = `${Math.max(headerHeight + 8, top)}px`;
            content.style.left = `${Math.max(8, Math.min(windowWidth - modalWidth - 8, left))}px`;
            content.style.transform = 'none';
            
            // Bring trigger element above modal backdrop
            const originalZIndex = triggerElement.style.zIndex;
            triggerElement.style.zIndex = '2001';
            
            // Store original z-index for restoration
            modal.dataset.originalZIndex = originalZIndex;
        }
        
        document.body.appendChild(modal);
        
        function cleanup() {
            // Restore original z-index if it was modified
            if (modal.dataset.originalZIndex !== undefined) {
                triggerElement.style.zIndex = modal.dataset.originalZIndex;
            }
            
            modal.classList.remove('show');
            setTimeout(() => {
                if (modal.parentNode) {
                    modal.parentNode.removeChild(modal);
                }
            }, 200);
        }
        
        confirmBtn.addEventListener('click', () => {
            cleanup();
            if (onConfirm) onConfirm();
            resolve(true);
        });
        
        cancelBtn.addEventListener('click', () => {
            cleanup();
            if (onCancel) onCancel();
            resolve(false);
        });
        
        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                cleanup();
                if (onCancel) onCancel();
                resolve(false);
            }
        });
        
        // Show modal
        setTimeout(() => modal.classList.add('show'), 10);
    });
}


/**
 * Unified UI counters update function
 * @param {Object} params - { videos, downloads }
 *   videos: { hls, dash, direct, unknown, total } (optional)
 *   downloads: { total } (optional)
 */
export function updateUICounters(params = {}) {
    // Videos tab counters
    if (params.videos) {
        const counts = params.videos;
        // Main tab counter
        const tabCounter = document.querySelector('.tab-button[data-tab-id="videos-tab"] .counter');
        if (tabCounter) {
            tabCounter.textContent = counts.total > 0 ? String(counts.total) : '';
        }
        // Per-group counters
        const types = ['hls', 'dash', 'direct', 'unknown'];
        types.forEach(type => {
            const group = document.querySelector(`#videos-list .video-type-group[data-video-type="${type}"] .counter`);
            if (group) {
                group.textContent = counts[type] > 0 ? String(counts[type]) : '';
            }
        });
    }
    // Downloads tab counter
    if (params.downloads) {
        const count = params.downloads.total;
        const tabCounter = document.querySelector('.tab-button[data-tab-id="downloads-tab"] .counter');
        if (tabCounter) {
            tabCounter.textContent = count > 0 ? String(count) : '';
        }
    }
}

/**
 * Switch to specified tab
 */
export function switchTab(tabId) {
    // Check if tab is already active (read from DOM state)
    const currentActiveTab = document.querySelector('.tab-button.active')?.dataset.tabId;
    if (currentActiveTab === tabId) return;
    
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.toggle('active', button.dataset.tabId === tabId);
    });
    
    // Update tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.dataset.tabId === tabId);
    });

    // Show header controls only on videos tab. Clear inline style when showing.
    // const headerControls = document.querySelector('header .controls');
    // if (headerControls) headerControls.style.display = (tabId === 'videos-tab') ? '' : 'none';
}

/**
 * Initialize filter and search components
 */
export function initializeFiltersAndSearch() {
    initializeSortControls();
    initializeFilterDropdown();
    initializeSearchInput();
    
    // Apply initial filter state if any filter is unchecked
    const activeFilters = getCurrentFilters();
    const isFilterActive = activeFilters.length < 3;
    
    if (isFilterActive) {
        const filterDropdown = document.getElementById('filter-dropdown');
        if (filterDropdown) {
            filterDropdown.classList.add('active');
        }
        updateGroupVisibilityWithFilters(activeFilters, isFilterActive);
    }
}

/**
 * Initialize sort controls functionality
 */
function initializeSortControls() {
    const sortButtons = document.querySelectorAll('.sort-btn');
    
    sortButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            handleSortButtonClick(e.target);
        });
    });
}

/**
 * Handle sort button clicks with 2-state behavior (asc/desc)
 */
function handleSortButtonClick(button) {
    const sortType = button.dataset.sort;
    const isCurrentlyActive = button.classList.contains('active');
    const isCurrentlyDescending = button.classList.contains('descending');
    
    if (!isCurrentlyActive) {
        // Make this button active, deactivate others
        document.querySelectorAll('.sort-btn').forEach(btn => {
            btn.classList.remove('active', 'ascending', 'descending');
        });
        
        // Set this button to active descending (default first state)
        button.classList.add('active', 'descending');
    } else {
        // Toggle between ascending and descending
        if (isCurrentlyDescending) {
            button.classList.remove('descending');
            button.classList.add('ascending');
        } else {
            button.classList.remove('ascending');
            button.classList.add('descending');
        }
    }
    
    // Apply sorting
    const direction = button.classList.contains('descending') ? 'descending' : 'ascending';
    applySorting({ type: sortType, direction });
}

/**
 * Apply sorting to video groups
 */
function applySorting(sortConfig) {
    const videoGroups = document.querySelectorAll('.video-type-group');
    
    videoGroups.forEach(group => {
        const sectionContent = group.querySelector('.section-content');
        if (!sectionContent) return;
        
        const videoItems = Array.from(sectionContent.querySelectorAll('.video-item'));
        if (videoItems.length <= 1) return; // No need to sort single items
        
        // Apply sorting
        videoItems.sort((a, b) => sortVideoItems(a, b, sortConfig));
        
        // Re-append items in sorted order
        videoItems.forEach(item => sectionContent.appendChild(item));
    });
}

/**
 * Sort video items with live stream duration handling
 */
function sortVideoItems(a, b, sortConfig) {
    const aComponent = a._component;
    const bComponent = b._component;
    
    if (!aComponent || !bComponent) return 0;
    
    const { type, direction } = sortConfig;
    let comparison = 0;
    
    switch (type) {
        case 'detection-time':
            const aTime = aComponent.videoData?.timestampDetected || 0;
            const bTime = bComponent.videoData?.timestampDetected || 0;
            comparison = aTime - bTime;
            break;
            
        case 'duration':
            const aDuration = aComponent.videoData?.duration || 0;
            const bDuration = bComponent.videoData?.duration || 0;
            
            // Live streams (duration = 0) go to the end, with fallback sorting by timestampDetected
            if (aDuration === 0 && bDuration === 0) {
                // Both are live streams - sort by detection time descending (newest first)
                const aTime = aComponent.videoData?.timestampDetected || 0;
                const bTime = bComponent.videoData?.timestampDetected || 0;
                comparison = bTime - aTime;
            } else if (aDuration === 0) {
                // a is live stream - goes to end
                comparison = 1;
            } else if (bDuration === 0) {
                // b is live stream - goes to end
                comparison = -1;
            } else {
                // Both have duration - normal comparison
                comparison = aDuration - bDuration;
            }
            break;
            
        case 'title':
            const aTitle = (aComponent.resolvedFilename || aComponent.filename || aComponent.videoData?.title || 'Untitled Video').toLowerCase();
            const bTitle = (bComponent.resolvedFilename || bComponent.filename || bComponent.videoData?.title || 'Untitled Video').toLowerCase();
            comparison = aTitle.localeCompare(bTitle);
            break;
            
        default:
            return 0;
    }
    
    // Apply direction
    return direction === 'descending' ? -comparison : comparison;
}

/**
 * Initialize filter dropdown functionality
 */
function initializeFilterDropdown() {
    const filterDropdown = document.getElementById('filter-dropdown');
    const filterBtn = document.getElementById('filter-btn');
    const filterOptions = document.getElementById('filter-options');
    
    if (!filterDropdown || !filterBtn || !filterOptions) return;
    
    // Toggle dropdown on button click
    filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = filterOptions.classList.contains('open');
        
        // Close all other dropdowns first
        document.querySelectorAll('.filter-options.open').forEach(options => {
            options.classList.remove('open');
        });
        
        // Toggle this dropdown
        filterOptions.classList.toggle('open', !isOpen);
        
        // Add/remove expanded class on body when dropdown opens/closes
        if (!isOpen) {
            document.body.classList.add('expanded');
        } else {
            document.body.classList.remove('expanded');
        }
    });
    
    // Handle filter option changes
    filterOptions.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
            handleFilterChange();
        }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!filterDropdown.contains(e.target)) {
            filterOptions.classList.remove('open');
            // Remove expanded class when closing dropdown
            document.body.classList.remove('expanded');
        }
    });
}

/**
 * Handle filter changes
 */
function handleFilterChange() {
    const activeFilters = getCurrentFilters();
    const isFilterActive = activeFilters.length < 3; // Not all types selected
    
    // Update filter button visual state
    const filterDropdown = document.getElementById('filter-dropdown');
    if (filterDropdown) {
        filterDropdown.classList.toggle('active', isFilterActive);
    }
    
    // Apply group-level filtering
    updateGroupVisibilityWithFilters(activeFilters, isFilterActive);
}

/**
 * Initialize search input functionality
 */
function initializeSearchInput() {
    const searchContainer = document.getElementById('search-container');
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear-btn');
    
    if (!searchContainer || !searchInput || !clearBtn) return;
    
    // Handle input changes
    searchInput.addEventListener('input', (e) => {
        const hasValue = e.target.value.length > 0;
        clearBtn.style.display = hasValue ? 'flex' : 'none';
        handleSearchInput(e.target.value);
    });
    
    // Handle clear button click
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        handleSearchInput('');
        searchInput.focus();
    });
    
    // Focus input when clicking anywhere on search container
    searchContainer.addEventListener('click', (e) => {
        // Don't focus if clicking on the clear button
        if (e.target !== clearBtn && !clearBtn.contains(e.target)) {
            searchInput.focus();
        }
    });
    
    // Handle focus/blur for better UX
    searchInput.addEventListener('focus', () => {
        searchContainer.classList.add('focused');
    });
    
    searchInput.addEventListener('blur', () => {
        searchContainer.classList.remove('focused');
    });
    
    // Handle escape key to clear
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault(); // Prevent popup from closing
            e.stopPropagation(); // Stop event bubbling
            searchInput.value = '';
            clearBtn.style.display = 'none';
            handleSearchInput('');
            searchInput.blur();
        }
    });
}

/**
 * Handle search input changes with debouncing
 */
let searchDebounceTimer = null;
function handleSearchInput(searchTerm) {
    // Clear previous timer
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
    }
    
    // Debounce search execution (300ms)
    searchDebounceTimer = setTimeout(() => {
        filterVideosBySearch(searchTerm.trim());
    }, 300);
}

/**
 * Filter videos by search term
 */
function filterVideosBySearch(searchTerm) {
    const videoItems = document.querySelectorAll('.video-item');
    const hasSearch = searchTerm.length > 0;
    
    videoItems.forEach(item => {
        if (!hasSearch) {
            // No search term - show all items
            item.classList.remove('search-hidden');
            return;
        }
        
        // Check if video matches search term
        const component = item._component;
        const title = component?.videoData?.title || '';
        const matches = title.toLowerCase().includes(searchTerm.toLowerCase());
        
        item.classList.toggle('search-hidden', !matches);
    });
}

/**
 * Update group visibility based on filter state and content
 */
function updateGroupVisibilityWithFilters(activeFilters, isFilterActive) {
    document.querySelectorAll('.video-type-group').forEach(group => {
        const type = group.dataset.videoType;
        const hasContent = group.querySelector('.section-content').children.length > 0;
        
        if (isFilterActive) {
            // Filter is active - only show if type is selected AND has content
            const shouldShow = activeFilters.includes(type) && hasContent;
            group.style.display = shouldShow ? 'flex' : 'none';
        } else {
            // No filter active - show based on content only
            group.style.display = hasContent ? 'flex' : 'none';
        }
    });
    
    // Show/hide initial message
    updateInitialMessageVisibility();
}

/**
 * Update initial message visibility based on visible groups
 */
export function updateInitialMessageVisibility() {
    const container = document.getElementById('videos-list');
    if (!container) return;
    
    const hasVisibleGroups = Array.from(container.querySelectorAll('.video-type-group'))
        .some(group => group.style.display !== 'none');
    
    const initialMessage = container.querySelector('.initial-message');
    if (initialMessage) {
        initialMessage.style.display = hasVisibleGroups ? 'none' : 'flex';
    }
}

/**
 * Apply current search filter to a newly rendered video item
 */
export function applySearchToVideoItem(videoElement) {
    const searchTerm = getCurrentSearchTerm();
    if (searchTerm.length === 0) return;
    
    const component = videoElement._component;
    const title = component?.videoData?.title || '';
    const matches = title.toLowerCase().includes(searchTerm.toLowerCase());
    
    videoElement.classList.toggle('search-hidden', !matches);
}

/**
 * Get current filter state
 */
export function getCurrentFilters() {
    const checkboxes = document.querySelectorAll('#filter-options input[type="checkbox"]');
    return Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);
}

/**
 * Get current search term
 */
export function getCurrentSearchTerm() {
    const searchInput = document.getElementById('search-input');
    return searchInput ? searchInput.value.trim() : '';
}

/**
 * Apply current sorting when videos are added/updated
 */
export function applySortingToGroups() {
    // Get current active sort state
    const activeSortBtn = document.querySelector('.sort-btn.active');
    if (!activeSortBtn) {
        // No active sorting - apply default (detection time descending)
        applySorting({ type: 'detection-time', direction: 'descending' });
        return;
    }
    
    const sortConfig = {
        type: activeSortBtn.dataset.sort,
        direction: activeSortBtn.classList.contains('descending') ? 'descending' : 'ascending'
    };
    
    applySorting(sortConfig);
}

export function initializeTooltips() {
    let activeTooltip = null; // { el, tip }
    
    function hideTooltip() {
        if (!activeTooltip) return;
        activeTooltip.tip.remove();
        activeTooltip = null;
    }
    
    function showTooltip(element) {
        hideTooltip();
        
        const text = element.getAttribute('data-tooltip');
        if (!text) return;
        
        const tip = document.createElement('div');
        tip.className = 'tooltip';
        tip.textContent = text;
        document.body.appendChild(tip);
        
        // Position tooltip with boundary detection
        const rect = element.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const headerHeight = 98;
        
        // Vertical: above if space, otherwise below
        const top = rect.top - headerHeight >= tipRect.height + 8 
            ? rect.top - tipRect.height - 8
            : rect.bottom + 8;
            
        // Horizontal: centered, bounded to viewport
        const left = Math.max(8, Math.min(
            window.innerWidth - tipRect.width - 8,
            rect.left + rect.width / 2 - tipRect.width / 2
        ));
        
        Object.assign(tip.style, {
            position: 'fixed',
            left: `${left}px`,
            top: `${Math.max(headerHeight + 8, top)}px`,
            transform: 'none',
            pointerEvents: 'none'
        });
        
        activeTooltip = { el: element, tip };
        
        // Liveness check (runs only while visible) - safety net for missed removals
        requestAnimationFrame(function tick() {
            if (!activeTooltip) return;
            if (!activeTooltip.el.isConnected) return hideTooltip(); // element removed
            requestAnimationFrame(tick);
        });
    }
    
    // Use pointer events (better than mouse events)
    document.addEventListener('pointerover', (e) => {
        const target = e.target.closest('[data-tooltip]');
		if (!target) return;
        if (activeTooltip && activeTooltip.el === target) return; // Avoid recreating on same element
        showTooltip(target);
    }, { passive: true });
    
    document.addEventListener('pointerout', (e) => {
        if (!activeTooltip) return;
        // Don't hide if moving to child element
        if (e.relatedTarget && activeTooltip.el.contains(e.relatedTarget)) return;
        hideTooltip();
    }, { passive: true });
	
    // Hide on scroll/resize (position becomes invalid)
    window.addEventListener('scroll', () => hideTooltip(), { passive: true });
    window.addEventListener('resize', () => hideTooltip());
    
    // Export cleanup function for manual use
    window.hideActiveTooltip = hideTooltip;
}
