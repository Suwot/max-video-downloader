// extension/popup/popup.js

// Cache and state management
let cachedVideos = null;
let resolutionCache = new Map();
let scrollPosition = 0;
let videoGroups = {};
let groupState = {}; // To track collapsed state of groups
let posterCache = new Map(); // For preserving video posters
let currentTheme = 'dark'; // Default theme

// Reusable tooltip element
const sharedTooltip = document.createElement('div');
sharedTooltip.className = 'tooltip';

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Format resolution
function formatResolution(width, height, fps, bitrate) {
    if (!width || !height) return 'Unknown resolution';
    
    let label = `${width}x${height}`;
    
    // Add common resolution label
    if (height >= 2160) label += ' (4K)';
    else if (height >= 1440) label += ' (2K)';
    else if (height >= 1080) label += ' (FHD)';
    else if (height >= 720) label += ' (HD)';
    
    // Add framerate if available
    if (fps) label += ` @ ${Math.round(fps)}fps`;
    
    // Add bitrate if available
    if (bitrate) {
        const formattedBitrate = formatBitrate(bitrate);
        if (formattedBitrate) label += ` • ${formattedBitrate}`;
    }
    
    console.log('Formatted resolution:', { width, height, fps, bitrate, result: label });
    return label;
}

// Format bitrate
function formatBitrate(bitrate) {
    if (!bitrate) return null;
    
    // Convert to number if it's a string
    const rate = typeof bitrate === 'string' ? parseInt(bitrate, 10) : bitrate;
    
    if (isNaN(rate) || rate <= 0) return null;
    
    if (rate >= 1000000) {
        return `${(rate / 1000000).toFixed(1)} Mbps`;
    } else if (rate >= 1000) {
        return `${(rate / 1000).toFixed(0)} Kbps`;
    } else {
        return `${rate} bps`;
    }
}

// Apply theme to UI
function applyTheme(theme) {
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(`theme-${theme}`);
    currentTheme = theme;
    
    // Save theme preference
    chrome.storage.sync.set({ theme });
    
    // Update theme toggle button icon
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) {
        themeToggle.innerHTML = theme === 'dark' 
            ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    }
}

// Check if we should group videos together (based on same source/content but different resolutions)
function shouldGroupVideos(video1, video2) {
    // Check if it's the same base URL (ignoring quality parameters)
    const baseUrl1 = getBaseUrl(video1.url);
    const baseUrl2 = getBaseUrl(video2.url);
    
    // Group together if same base URL and both have resolution info
    return (baseUrl1 === baseUrl2) && 
           video1.resolution && video2.resolution && 
           (video1.resolution.width !== video2.resolution.width || 
            video1.resolution.height !== video2.resolution.height);
}

// Get the base URL without query parameters
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.origin + urlObj.pathname;
    } catch {
        return url;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Wait for chrome.storage to be available
        if (!chrome.storage) {
            throw new Error('Chrome storage API not available');
        }

        // Notify content script that popup is open
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'popupOpened' })
                        .catch(err => console.log('Content script not ready yet'));
                }
            });
        } catch (e) {
            console.log('Error notifying content script:', e);
        }

        // Load preferences and cached data
        const result = await chrome.storage.sync.get(['theme']);
        const localData = await chrome.storage.local.get(['groupState', 'cachedVideos', 'currentTabId', 'posterCache']);
        
        // Get system theme preference
        const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const defaultTheme = prefersDarkMode ? 'dark' : 'light';
        
        // Set theme based on stored preference or system default
        currentTheme = result.theme || defaultTheme;
        applyTheme(currentTheme);
        
        groupState = localData.groupState || { 
            hls: false, 
            dash: false, 
            direct: false, 
            blob: true, // Blob group collapsed by default
            unknown: false 
        };
        
        // Restore poster cache
        if (localData.posterCache) {
            try {
                posterCache = new Map(JSON.parse(localData.posterCache));
            } catch (e) {
                console.error('Failed to restore poster cache:', e);
            }
        }
        
        // Get current tab to check if we're on the same page as before
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTabId = currentTab.id;
        
        // Only use cached videos if we're on the same tab as before
        if (localData.cachedVideos && localData.currentTabId === currentTabId) {
            cachedVideos = localData.cachedVideos;
        }
        
        // Store current tab ID
        chrome.storage.local.set({ currentTabId });
        
        // Initialize UI elements
        initializeUI();
        
        // Initial video list update - render cached videos immediately if available
        if (cachedVideos) {
            renderVideos(cachedVideos);
        }
        
        // Always update in background to get fresh data
        updateVideoList(true);
        
        // Setup auto-detection - always enabled now
        setupAutoDetection();
        
        // Save scroll position on scroll
        document.getElementById('videos').addEventListener('scroll', function() {
            scrollPosition = this.scrollTop;
        });
    } catch (error) {
        console.error('Initialization error:', error);
        const container = document.getElementById('videos');
        if (container) {
            container.innerHTML = `
                <div class="initial-message">
                    Failed to initialize the extension. Please try reloading.
                </div>
            `;
        }
    }
});

function initializeUI() {
    const container = document.getElementById('videos');
    const refreshContainer = document.createElement('div');
    refreshContainer.className = 'refresh-container';
    
    // Create refresh button
    const refreshButton = document.createElement('button');
    refreshButton.className = 'refresh-button';
    refreshButton.id = 'refresh-button';
    refreshButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
        </svg>
        Refresh
    `;
    
    const debouncedUpdate = debounce(async () => {
        refreshButton.classList.add('loading');
        refreshButton.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            Refreshing...
        `;
        await updateVideoList(true);
        refreshButton.classList.remove('loading');
        refreshButton.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            Refresh
        `;
    }, 300);
    
    refreshButton.addEventListener('click', debouncedUpdate);
    
    // Add direct event listener for UI feedback
    refreshButton.addEventListener('click', async function() {
        const button = this;
        const originalText = button.textContent;
        
        // Update button text and add loading class
        button.textContent = 'Refreshing...';
        button.classList.add('loading');
        button.disabled = true;
        
        try {
            await updateVideoList(true);
        } catch (error) {
            console.error('Error refreshing videos:', error);
        } finally {
            // Restore button text and remove loading class
            button.textContent = originalText;
            button.classList.remove('loading');
            button.disabled = false;
        }
    });
    
    // Create theme toggle button
    const themeToggle = document.createElement('button');
    themeToggle.className = 'theme-toggle';
    themeToggle.innerHTML = currentTheme === 'dark'
        ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5S14.76,7,12,7L12,7z M2,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1H2 c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13h2c0.55,0,1-0.45,1-1s-0.45-1-1-1h-2c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2 c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1 S11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0 s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06 c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41 c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36 c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z" /></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z" /></svg>';
    
    themeToggle.addEventListener('click', () => {
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
    });
    
    refreshContainer.append(refreshButton, themeToggle);
    container.parentElement.insertBefore(refreshContainer, container);
}

// Sets up communication for automatic detection of new videos
function setupAutoDetection() {
    // Listen for messages from background script about new videos
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'newVideoDetected') {
            // Always update when new videos detected
            updateVideoList(true);
            sendResponse({ received: true });
        }
        return true;
    });
    
    // Tell content script to start detecting
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { 
                action: 'startBackgroundDetection',
                enabled: true
            }).catch(err => console.log('Content script not ready yet'));
        }
    });
}

async function updateVideoList(forceRefresh = false) {
    const container = document.getElementById('videos');
    
    // Save current scroll position
    if (container.scrollTop) {
        scrollPosition = container.scrollTop;
    }
    
    if (!forceRefresh && cachedVideos) {
        renderVideos(cachedVideos);
        return;
    }
    
    // Only show loader if there are no videos currently displayed
    if (!cachedVideos) {
        container.innerHTML = `
            <div class="initial-loader">
                <span>Searching for videos...</span>
            </div>
        `;
    }
    
    try {
        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const videos = [];
        let contentScriptError = null;
        let backgroundScriptError = null;
        
        // Set a timeout for video searching
        const searchTimeout = setTimeout(() => {
            if (container.querySelector('.initial-loader')) {
                container.innerHTML = `
                    <div class="initial-message">
                        Search is taking too long. Try refreshing the page or extension.
                    </div>
                `;
            }
        }, 10000); // 10 second timeout
        
        // Get videos from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'findVideos' });
            if (response && response.length) {
                videos.push(...response);
            }
        } catch (error) {
            console.error('Content script error:', error);
            contentScriptError = error;
        }
        
        // Get videos from background script
        try {
            const backgroundVideos = await chrome.runtime.sendMessage({ 
                action: 'getVideos', 
                tabId: tab.id 
            });
            
            if (backgroundVideos && backgroundVideos.length) {
                // Merge with videos from content script, avoiding duplicates
                const existingUrls = new Set(videos.map(v => v.url));
                for (const video of backgroundVideos) {
                    if (!existingUrls.has(video.url)) {
                        videos.push(video);
                        existingUrls.add(video.url);
                    }
                }
            }
        } catch (error) {
            console.error('Background script error:', error);
            backgroundScriptError = error;
        }
        
        // Legacy support: Get HLS playlists from background script
        try {
            const playlists = await chrome.runtime.sendMessage({ 
                action: 'getStoredPlaylists', 
                tabId: tab.id 
            });
            
            if (playlists && playlists.length) {
                // Add HLS playlists that aren't already in the list
                const existingUrls = new Set(videos.map(v => v.url));
                for (const url of playlists) {
                    if (!existingUrls.has(url)) {
                        videos.push({ 
                            url, 
                            type: 'hls',
                            title: getFilenameFromUrl(url),
                            source: 'legacy' 
                        });
                        existingUrls.add(url);
                    }
                }
            }
        } catch (error) {
            console.error('Legacy HLS error:', error);
            // Not critical, so don't update backgroundScriptError
        }
        
        // Clear the timeout since we've completed the search
        clearTimeout(searchTimeout);
        
        if (videos.length === 0 && (contentScriptError || backgroundScriptError)) {
            let errorMessage = 'Failed to find videos. ';
            if (contentScriptError) errorMessage += 'Page scanning failed. ';
            if (backgroundScriptError) errorMessage += 'Video detection failed. ';
            throw new Error(errorMessage);
        }
        
        // Group videos immediately and render
        const groupedVideos = groupVideos(videos);
        cachedVideos = groupedVideos;
        
        // Save to storage for persistence between popup sessions
        chrome.storage.local.set({ cachedVideos });
        renderVideos(groupedVideos);
        
        // Start fetching resolution info in the background
        fetchVideoInfo(videos, tab.id);
        
    } catch (error) {
        console.error('Failed to get videos:', error);
        // Only show error if we don't have cached videos already rendered
        if (!cachedVideos || container.querySelector('.initial-loader')) {
            container.innerHTML = `
                <div class="initial-message">
                    ${error.message} Try refreshing the page or extension.
                </div>
            `;
        }
    }
}

// Separate function to fetch and update resolution info
async function fetchVideoInfo(videos, tabId) {
    // Process videos in parallel batches to improve performance
    const batchSize = 5; // Process 5 videos at a time
    const batches = [];

    // Create batches of videos
    for (let i = 0; i < videos.length; i += batchSize) {
        batches.push(videos.slice(i, i + batchSize));
    }

    // Process each batch in parallel
    for (const batch of batches) {
        await Promise.all(batch.map(async (video) => {
            try {
                if (!video.resolution) {
                    console.log('Fetching resolution for:', video.url);
                    const resolution = await getStreamResolution(video.url, video.type, tabId);
                    console.log('Resolution result:', resolution);
                    
                    if (resolution !== 'Resolution unknown' && resolution !== 'Resolution unavailable for blob') {
                        // Parse resolution into width/height/fps
                        const match = resolution.match(/(\d+)x(\d+)(?:\s+\(.*?\))?(?:\s+@\s+(\d+)fps)?/);
                        if (match) {
                            video.resolution = {
                                width: parseInt(match[1]),
                                height: parseInt(match[2]),
                                fps: match[3] ? parseInt(match[3]) : null
                            };
                            
                            // Update the resolution display in UI
                            updateVideoResolution(video.url, video.resolution);
                            
                            // Update cached videos with new resolution
                            if (cachedVideos) {
                                const cachedVideo = cachedVideos.find(v => v.url === video.url);
                                if (cachedVideo) {
                                    cachedVideo.resolution = video.resolution;
                                    chrome.storage.local.set({ cachedVideos });
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Error fetching info for video:', video.url, error);
            }
        }));
    }
}

// Update resolution display for a specific video
function updateVideoResolution(url, resolution) {
    const videoElement = document.querySelector(`.video-item[data-url="${url}"]`);
    if (videoElement) {
        const resolutionInfo = videoElement.querySelector('.resolution-info');
        if (resolutionInfo) {
            console.log('Updating resolution for', url, resolution);
            const { width, height, fps, bitrate } = resolution;
            resolutionInfo.textContent = formatResolution(width, height, fps, bitrate);
        }
    }
}

// Group videos by same source but different resolutions
function groupVideos(videos) {
    const groupedVideos = [];
    const processed = new Set();
    
    // First pass: find groups
    for (let i = 0; i < videos.length; i++) {
        if (processed.has(i)) continue;
        
        const video = videos[i];
        const group = [video];
        processed.add(i);
        
        // Look for related videos
        for (let j = i + 1; j < videos.length; j++) {
            if (processed.has(j)) continue;
            
            const otherVideo = videos[j];
            if (shouldGroupVideos(video, otherVideo)) {
                group.push(otherVideo);
                processed.add(j);
            }
        }
        
        if (group.length > 1) {
            // Create a group entry
            const baseVideo = { ...group[0] };
            // Sort resolutions from highest to lowest
            baseVideo.resolutionOptions = group
                .sort((a, b) => {
                    if (!a.resolution || !b.resolution) return 0;
                    return (b.resolution.height - a.resolution.height);
                })
                .map(v => ({
                    url: v.url,
                    width: v.resolution?.width,
                    height: v.resolution?.height,
                    fps: v.resolution?.fps
                }));
            groupedVideos.push(baseVideo);
        } else {
            groupedVideos.push(video);
        }
    }
    
    return groupedVideos;
}

function renderVideos(videos) {
    const container = document.getElementById('videos');
    
    if (!videos || videos.length === 0) {
        container.innerHTML = `
            <div class="initial-message">
                No videos found on this page. Try playing a video first or refreshing.
            </div>
        `;
        return;
    }
    
    // Group videos by type
    videoGroups = {
        hls: [],
        dash: [],
        direct: [],
        blob: [],
        unknown: []
    };
    
    videos.forEach(video => {
        const type = video.type || 'unknown';
        if (videoGroups[type]) {
            videoGroups[type].push(video);
        } else {
            videoGroups.unknown.push(video);
        }
    });
    
    // Create document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Create type groups
    for (const [type, typeVideos] of Object.entries(videoGroups)) {
        if (typeVideos.length === 0) continue;
        
        const group = createTypeGroup(type, typeVideos);
        fragment.appendChild(group);
    }
    
    container.innerHTML = '';
    container.appendChild(fragment);
    
    // Restore scroll position with a slight delay to ensure content is rendered
    setTimeout(() => {
        if (container.scrollHeight > container.clientHeight) {
            container.scrollTop = scrollPosition;
        }
    }, 50);
}

function createTypeGroup(type, videos) {
    const group = document.createElement('div');
    group.className = 'media-type-group';
    
    // Create header
    const header = document.createElement('div');
    header.className = `media-type-header ${type}`;
    
    const title = document.createElement('div');
    title.className = 'media-type-title';
    title.innerHTML = `
        ${type.toUpperCase()}
        <span class="media-type-count">${videos.length}</span>
    `;
    
    const toggle = document.createElement('div');
    toggle.className = 'media-type-toggle';
    toggle.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
        </svg>
    `;
    
    if (groupState[type]) {
        toggle.classList.add('collapsed');
    }
    
    header.append(title, toggle);
    
    // Create content
    const content = document.createElement('div');
    content.className = 'media-type-content';
    
    if (groupState[type]) {
        content.classList.add('collapsed');
    }
    
    // Add videos to group
    videos.forEach(video => {
        const videoElement = createVideoElement(video);
        content.appendChild(videoElement);
    });
    
    // Toggle event
    header.addEventListener('click', () => {
        toggle.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
        
        // Update and save state
        groupState[type] = content.classList.contains('collapsed');
        chrome.storage.local.set({ groupState });
    });
    
    group.append(header, content);
    return group;
}

function createVideoElement(video) {
    const element = document.createElement('div');
    element.className = 'video-item';
    element.dataset.url = video.url;

    // Create preview column
    const previewColumn = document.createElement('div');
    previewColumn.className = 'preview-column';
    
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    
    const previewImage = document.createElement('img');
    previewImage.className = 'preview-image placeholder';
    previewImage.src = chrome.runtime.getURL('icons/video-placeholder.png');
    previewImage.alt = 'Video preview';
    
    // Add type badge to preview container
    const typeBadge = document.createElement('div');
    typeBadge.className = `type-badge ${video.type || 'unknown'}`;
    typeBadge.textContent = video.type ? video.type.toUpperCase() : 'UNKNOWN';
    previewContainer.appendChild(typeBadge);
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.style.display = 'block'; // Always show loader initially
    
    const regenerateButton = document.createElement('button');
    regenerateButton.className = 'regenerate-button hidden';
    regenerateButton.textContent = 'Regenerate';
    
    previewContainer.append(previewImage, loader, regenerateButton);
    previewColumn.appendChild(previewContainer);
    
    // Track if preview has been generated
    let previewGenerated = false;
    
    // Use cached poster if available
    if (posterCache.has(video.url)) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        };
        previewImage.src = posterCache.get(video.url);
        previewGenerated = true;
    }
    // If we already have a preview URL, use it
    else if (video.previewUrl) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
            
            // Cache the poster
            posterCache.set(video.url, video.previewUrl);
            savePosterCache();
        };
        previewImage.src = video.previewUrl;
        previewGenerated = true;
    } 
    // If we have a poster, use it directly
    else if (video.poster) {
        previewImage.onload = () => {
            previewImage.classList.remove('placeholder');
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
            
            // Cache the poster
            posterCache.set(video.url, video.poster);
            savePosterCache();
        };
        previewImage.src = video.poster;
        previewGenerated = true;
    } 
    // No preview available yet
    else {
        // Only attempt to generate a preview if it's not a blob URL without poster
        if (!(video.type === 'blob' && !video.poster)) {
            generatePreview(video.url, loader, previewImage, regenerateButton);
        } else {
            // For blob URLs without a poster, still show the placeholder
            previewImage.classList.add('loaded');
            loader.style.display = 'none';
        }
    }
    
    // Show regenerate button if preview generation failed
    if (!previewGenerated && !loader.style.display) {
        regenerateButton.classList.remove('hidden');
    }
    
    regenerateButton.addEventListener('click', () => {
        regenerateButton.classList.add('hidden');
        loader.style.display = 'block';
        generatePreview(video.url, loader, previewImage, regenerateButton);
    });
    
    // Create info column
    const infoColumn = document.createElement('div');
    infoColumn.className = 'info-column';
    
    // Create title row
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    
    const title = document.createElement('h3');
    title.className = 'video-title';
    title.textContent = video.title || getFilenameFromUrl(video.url);
    
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14">
            <path d="M16 1H4C3 1 2 2 2 3v14h2V3h12V1zm3 4H8C7 5 6 6 6 7v14c0 1 1 2 2 2h11c1 0 2-1 2-2V7c0-1-1-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
    `;
    
    copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(video.url);
        
        // Create a new tooltip element each time
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.textContent = 'Copied!';
        
        // Position the tooltip
        copyButton.appendChild(tooltip);
        
        // Remove after 2 seconds
        setTimeout(() => {
            tooltip.remove();
        }, 2000);
    });
    
    titleRow.append(title, copyButton);
    
    // Create file info section with media type information
    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    
    // Determine media content type
    const mediaTypeInfo = document.createElement('div');
    mediaTypeInfo.className = 'media-type-info';
    
    // Default to "Video & Audio" unless we know otherwise
    let mediaContentType = "Video & Audio";
    
    // Check for audio-only files based on URL patterns or media info
    if (video.url.includes('/audio_') || video.url.includes('_audio') || 
        (video.mediaInfo && !video.mediaInfo.hasVideo && video.mediaInfo.hasAudio)) {
        mediaContentType = "Audio Only";
    } else if (video.mediaInfo) {
        if (video.mediaInfo.hasVideo && !video.mediaInfo.hasAudio) {
            mediaContentType = "Video Only";
        } else if (!video.mediaInfo.hasVideo && video.mediaInfo.hasAudio) {
            mediaContentType = "Audio Only";
        }
    }
    
    // Select the appropriate icon based on media type
    let mediaIcon = '';
    if (mediaContentType === "Audio Only") {
        mediaIcon = '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>';
    } else if (mediaContentType === "Video Only") {
        mediaIcon = '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>';
    } else {
        mediaIcon = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/><path d="M9 8h2v8H9zm4 0h2v8h-2z"/>';
    }
    
    mediaTypeInfo.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
            ${mediaIcon}
        </svg>
        <span>${mediaContentType}</span>
    `;
    
    // Create a separate container for media type info
    const mediaTypeContainer = document.createElement('div');
    mediaTypeContainer.className = 'media-type-container';
    mediaTypeContainer.appendChild(mediaTypeInfo);
    fileInfo.appendChild(mediaTypeContainer);
    
    // Resolution info in its own container
    const resolutionContainer = document.createElement('div');
    resolutionContainer.className = 'resolution-container';
    
    const resolutionInfo = document.createElement('div');
    resolutionInfo.className = 'resolution-info';
    
    // Use resolution from video object if available, otherwise use width/height directly
    let width, height, fps, bitrate;
    
    if (video.resolution) {
        width = video.resolution.width;
        height = video.resolution.height;
        fps = video.resolution.fps;
        bitrate = video.resolution.bitrate;
    } else {
        width = video.width;
        height = video.height;
        fps = video.fps;
        bitrate = video.bitrate;
    }
    
    // Log resolution values for debugging
    console.log('Resolution values:', { width, height, fps, bitrate, url: video.url });
    
    resolutionInfo.textContent = formatResolution(width, height, fps, bitrate);
    
    resolutionContainer.appendChild(resolutionInfo);
    fileInfo.appendChild(resolutionContainer);
    
    // Progress bar (initially hidden)
    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressContainer.appendChild(progressBar);
    
    // For blob URLs, add warning about potential limitations
    if (video.type === 'blob') {
        const blobWarning = document.createElement('div');
        blobWarning.className = 'blob-warning';
        blobWarning.textContent = 'Blob URL: May not work for all sites';
        infoColumn.append(titleRow, fileInfo, blobWarning, progressContainer);
    } else {
        infoColumn.append(titleRow, fileInfo, progressContainer);
    }
    
    // Create download button 
    const downloadGroup = document.createElement('div');
    downloadGroup.className = 'download-group';
    
    const downloadButton = document.createElement('button');
    downloadButton.className = 'download-btn';
    downloadButton.textContent = 'Download';
    downloadButton.dataset.url = video.resolutionOptions ? 
        video.resolutionOptions[0].url : video.url;
    
    const debouncedDownload = debounce(async (event) => {
        const button = event.target;
        const url = button.dataset.url || video.url;
        await handleDownload(button, url, video.type);
    }, 300);
    
    downloadButton.addEventListener('click', debouncedDownload);
    
    downloadGroup.appendChild(downloadButton);
    infoColumn.appendChild(downloadGroup);
    
    // Assemble video item
    element.append(previewColumn, infoColumn);
    
    return element;
}

// Save poster cache to storage
function savePosterCache() {
    // Convert Map to array for storage
    const posterData = JSON.stringify(Array.from(posterCache.entries()));
    chrome.storage.local.set({ posterCache: posterData });
}

function generatePreview(url, loader, previewImage, regenerateButton) {
    // Ensure loader is visible
    loader.style.display = 'block';
    
    // Get the current tab ID
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        
        chrome.runtime.sendMessage({
            type: 'generatePreview',
            url: url,
            tabId: tabId // Pass tabId for caching
        }, response => {
            if (response && response.previewUrl) {
                // Add load handler before setting src
                previewImage.onload = () => {
                    previewImage.classList.remove('placeholder');
                    previewImage.classList.add('loaded');
                    loader.style.display = 'none';
                    regenerateButton.classList.add('hidden');
                    
                    // Cache the poster
                    posterCache.set(url, response.previewUrl);
                    savePosterCache();
                };
                
                // Handle load errors
                previewImage.onerror = () => {
                    console.error('Failed to load preview image');
                    loader.style.display = 'none';
                    regenerateButton.classList.remove('hidden');
                };
                
                previewImage.src = response.previewUrl;
            } else {
                loader.style.display = 'none';
                regenerateButton.classList.remove('hidden');
            }
        });
    });
}

async function getStreamResolution(url, type, tabId = null) {
    // Check cache first
    if (resolutionCache.has(url)) {
        return resolutionCache.get(url);
    }
    
    if (type === 'blob') {
        return 'Resolution unavailable for blob';
    }
    
    try {
        // Get current tab ID if not provided
        if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
        }
        
        const response = await chrome.runtime.sendMessage({
            type: 'getHLSQualities',
            url: url,
            tabId: tabId // Pass tabId for caching
        });
        
        if (response && response.streamInfo) {
            const { width, height, fps, bitrate, hasVideo, hasAudio } = response.streamInfo;
            if (width && height) {
                const resolution = formatResolution(width, height, fps, bitrate);
                resolutionCache.set(url, resolution);
                
                // Update cached video with media type info
                if (cachedVideos) {
                    const cachedVideo = cachedVideos.find(v => v.url === url);
                    if (cachedVideo) {
                        cachedVideo.resolution = { width, height, fps, bitrate };
                        cachedVideo.mediaInfo = { hasVideo, hasAudio };
                        chrome.storage.local.set({ cachedVideos });
                        
                        // Immediately update the UI
                        updateVideoResolution(url, { width, height, fps, bitrate });
                    }
                }
                
                return resolution;
            }
        }
    } catch (error) {
        console.error('Failed to get resolution:', error);
    }
    return 'Resolution unknown';
}

async function handleDownload(button, url, type) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Downloading...';
    
    try {
        // For blob URLs with blob: protocol, we need special handling
        if (type === 'blob' && url.startsWith('blob:')) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch blob');
                
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                
                // Use Chrome's download API
                chrome.downloads.download({
                    url: blobUrl,
                    filename: 'video_blob.mp4'
                }, downloadId => {
                    if (chrome.runtime.lastError) {
                        showError('Failed to download: ' + chrome.runtime.lastError.message);
                        resetDownloadButton();
                    } else {
                        setTimeout(() => resetDownloadButton(), 2000);
                    }
                    
                    // Clean up the blob URL
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                });
                
                return;
            } catch (error) {
                console.error('Blob download failed:', error);
                showError('Blob download failed - try using the copy URL button');
                resetDownloadButton();
                return;
            }
        }
        
        // Regular video files can be downloaded with the native host
        const messageType = (type === 'hls' || type === 'dash') ? 'downloadHLS' : 'download';
        
        chrome.runtime.sendMessage({
            type: messageType,
            url: url
        }, response => {
            if (response && response.success) {
                setTimeout(() => resetDownloadButton(), 2000);
            } else if (response && response.error) {
                showError(response.error);
                resetDownloadButton();
            }
            // Ignore progress updates - we just stay in "Downloading..." state
        });
        
    } catch (error) {
        console.error('Download failed:', error);
        showError('Failed to start download');
        resetDownloadButton();
    }
    
    function resetDownloadButton() {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function showError(message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/48.png',
        title: 'Download Error',
        message: message
    });
}

function getFilenameFromUrl(url) {
    if (url.startsWith('blob:')) {
        return 'video_blob';
    }
    
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        
        if (filename && filename.length > 0) {
            // Clean up filename
            return decodeURIComponent(filename)
                .replace(/[?#].*$/, '') // Remove query params
                .replace(/\.(m3u8|mpd)$/, '.mp4'); // Replace manifest extensions with mp4
        }
    } catch {}
    
    return 'video';
}

// Listen for popup unload to notify content script
window.addEventListener('unload', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            try {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'popupClosed' });
            } catch (e) {
                // Suppress errors on unload
            }
        }
    });
});

// Improve scroll position management
function scrollToLastPosition() {
    const scrollPosition = parseInt(localStorage.getItem('popupScrollPosition') || '0');
    if (scrollPosition > 0) {
        // Add a small delay to ensure content is rendered
        setTimeout(() => {
            document.getElementById('videos').scrollTop = scrollPosition;
        }, 50);
    }
}

// Save scroll position before closing
window.addEventListener('beforeunload', function() {
    const scrollPosition = document.getElementById('videos').scrollTop;
    localStorage.setItem('popupScrollPosition', scrollPosition.toString());
});

// Call this after videos are loaded
function initializeEvents() {
    // ... existing code ...
    
    // Restore scroll position
    scrollToLastPosition();
}