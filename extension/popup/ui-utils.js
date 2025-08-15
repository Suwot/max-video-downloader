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
	let activeTab = null;

    if (activeTab === tabId) return;
    
    // Update active tab
    activeTab = tabId;
    
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.toggle('active', button.dataset.tabId === tabId);
    });
    
    // Update tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.dataset.tabId === tabId);
    });
}

/**
 * Initialize global tooltip system for any [data-tooltip] element
 */
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
    }
    
    // Use pointer events (better than mouse events)
    document.addEventListener('pointerover', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) showTooltip(target);
    }, { passive: true });
    
    document.addEventListener('pointerout', (e) => {
        if (!activeTooltip) return;
        // Don't hide if moving to child element
        if (e.relatedTarget && activeTooltip.el.contains(e.relatedTarget)) return;
        hideTooltip();
    }, { passive: true });
    
    // Export cleanup function for manual use
    window.hideActiveTooltip = hideTooltip;
}
