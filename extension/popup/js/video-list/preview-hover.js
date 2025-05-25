// extension/popup/js/video-list/preview-hover.js

// Cache the hover preview elements for better performance
let hoverPreviewContainer = null;
let hoverPreviewImg = null;

/**
 * Initialize hover preview elements
 */
function initHoverPreview() {
    if (!hoverPreviewContainer) {
        hoverPreviewContainer = document.getElementById('preview-hover');
        hoverPreviewImg = document.getElementById('hover-preview-img');
    }
}

/**
 * Show hover preview at specific position
 * @param {string} previewUrl - URL of the full-size preview image
 * @param {MouseEvent} event - Mouse event to position the preview
 */
export function showHoverPreview(previewUrl, event) {
    initHoverPreview();
    
    // Only proceed if we have both the container and a valid preview URL
    if (!hoverPreviewContainer || !hoverPreviewImg || !previewUrl) return;
    
    // Set the image source
    hoverPreviewImg.src = previewUrl;
    
    // Position the preview near the cursor but within viewport bounds
    const rect = hoverPreviewContainer.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Initial positioning
    let left = event.clientX + 10;
    let top = event.clientY - 10;
    
    // Adjust horizontal position if it goes off screen
    if (left + rect.width > viewportWidth - 20) {
        left = event.clientX - rect.width - 10;
    }
    
    // Adjust vertical position if it goes off screen
    if (top + rect.height > viewportHeight - 20) {
        top = viewportHeight - rect.height - 20;
    }
    
    // Make sure we don't go off the top or left either
    left = Math.max(10, left);
    top = Math.max(10, top);
    
    // Apply the position
    hoverPreviewContainer.style.left = `${left}px`;
    hoverPreviewContainer.style.top = `${top}px`;
    
    // Show the preview
    hoverPreviewContainer.style.display = 'block';
    
    // Use requestAnimationFrame to ensure display property change takes effect before adding the visible class
    requestAnimationFrame(() => {
        hoverPreviewContainer.classList.add('visible');
    });
}

/**
 * Hide the hover preview
 */
export function hideHoverPreview() {
    if (hoverPreviewContainer) {
        // First remove the visible class to trigger transition
        hoverPreviewContainer.classList.remove('visible');
        
        // Then hide after transition completes
        setTimeout(() => {
            hoverPreviewContainer.style.display = 'none';
        }, 200); // Matching the transition duration
    }
}
