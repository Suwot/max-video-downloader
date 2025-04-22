// extension/popup/popup.js

// Cache and state management
let cachedVideos = null;
let backgroundLoadingEnabled = false;
let resolutionCache = new Map();

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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Wait for chrome.storage to be available
        if (!chrome.storage) {
            throw new Error('Chrome storage API not available');
        }

        // Load background loading preference
        const result = await chrome.storage.local.get('backgroundLoading');
        backgroundLoadingEnabled = result.backgroundLoading || false;
        
        // Initialize UI elements
        initializeUI();
        
        // Initial video list update
        await updateVideoList();
        
        // Set up background loading observer if enabled
        if (backgroundLoadingEnabled) {
            setupBackgroundObserver();
        }
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
    refreshButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
        </svg>
        Refresh
    `;
    
    const debouncedUpdate = debounce(async () => {
        refreshButton.classList.add('loading');
        await updateVideoList(true);
        refreshButton.classList.remove('loading');
    }, 300);
    
    refreshButton.addEventListener('click', debouncedUpdate);
    
    // Create background loading option
    const backgroundOption = document.createElement('label');
    backgroundOption.className = 'background-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = backgroundLoadingEnabled;
    checkbox.addEventListener('change', (e) => {
        backgroundLoadingEnabled = e.target.checked;
        chrome.storage.local.set({ backgroundLoading: backgroundLoadingEnabled });
        if (backgroundLoadingEnabled) {
            setupBackgroundObserver();
        }
    });
    backgroundOption.append(checkbox, 'Load videos in background');
    
    refreshContainer.append(refreshButton, backgroundOption);
    container.parentElement.insertBefore(refreshContainer, container);
}

async function updateVideoList(forceRefresh = false) {
    const container = document.getElementById('videos');
    
    if (!forceRefresh && cachedVideos) {
        renderVideos(cachedVideos);
        return;
    }
    
    container.innerHTML = `
        <div class="initial-loader">
            <span>Searching for videos...</span>
        </div>
    `;
    
    try {
        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const videos = [];
        let contentScriptError = null;
        let backgroundScriptError = null;
        
        // Get videos from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'findVideos' });
            if (response) {
                videos.push(...response.map(url => ({ url, type: 'regular' })));
            }
        } catch (error) {
            console.error('Content script error:', error);
            contentScriptError = error;
        }
        
        // Get HLS playlists from background script
        try {
            const playlists = await chrome.runtime.sendMessage({ 
                action: 'getStoredPlaylists', 
                tabId: tab.id 
            });
            
            if (playlists && playlists.length) {
                videos.push(...playlists.map(url => ({ url, type: 'hls' })));
            }
        } catch (error) {
            console.error('Background script error:', error);
            backgroundScriptError = error;
        }
        
        if (videos.length === 0 && (contentScriptError || backgroundScriptError)) {
            let errorMessage = 'Failed to find videos. ';
            if (contentScriptError) errorMessage += 'Page scanning failed. ';
            if (backgroundScriptError) errorMessage += 'HLS detection failed. ';
            throw new Error(errorMessage);
        }
        
        cachedVideos = videos;
        renderVideos(videos);
        
    } catch (error) {
        console.error('Failed to get videos:', error);
        container.innerHTML = `
            <div class="initial-message">
                ${error.message} Try refreshing the page.
            </div>
        `;
    }
}

function renderVideos(videos) {
    const container = document.getElementById('videos');
    
    if (!videos || videos.length === 0) {
        container.innerHTML = `
            <div class="initial-message">
                No videos found on this page.
            </div>
        `;
        return;
    }
    
    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();
    videos.forEach(video => {
        const videoElement = createVideoElement(video);
        fragment.appendChild(videoElement);
    });
    
    container.innerHTML = '';
    container.appendChild(fragment);
}

function createVideoElement(video) {
    const element = document.createElement('div');
    element.className = 'video-item';
    
    // Create preview column
    const previewColumn = document.createElement('div');
    previewColumn.className = 'preview-column';
    
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    
    const previewImage = document.createElement('img');
    previewImage.className = 'preview-image placeholder';
    previewImage.src = chrome.runtime.getURL('icons/video-placeholder.png');
    previewImage.alt = 'Video preview';
    
    const loader = document.createElement('div');
    loader.className = 'loader';
    
    const regenerateButton = document.createElement('button');
    regenerateButton.className = 'regenerate-button hidden';
    regenerateButton.textContent = 'Regenerate';
    
    previewContainer.append(previewImage, loader);
    previewColumn.append(previewContainer, regenerateButton);
    
    function generatePreview() {
        loader.style.display = 'block';
        regenerateButton.classList.add('hidden');
        previewImage.classList.add('placeholder');
        
        chrome.runtime.sendMessage({
            type: 'generatePreview',
            url: video.url
        }, response => {
            if (response && response.previewUrl) {
                previewImage.onload = () => {
                    previewImage.classList.remove('placeholder');
                    loader.style.display = 'none';
                    regenerateButton.classList.add('hidden');
                };
                previewImage.src = response.previewUrl;
            } else {
                loader.style.display = 'none';
                regenerateButton.classList.remove('hidden');
            }
        });
    }
    
    regenerateButton.addEventListener('click', generatePreview);
    generatePreview();
    
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
        <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M16 1H4C3 1 2 2 2 3v14h2V3h12V1zm3 4H8C7 5 6 6 6 7v14c0 1 1 2 2 2h11c1 0 2-1 2-2V7c0-1-1-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
    `;
    
    copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(video.url);
        sharedTooltip.textContent = 'Copied!';
        copyButton.appendChild(sharedTooltip);
        setTimeout(() => sharedTooltip.remove(), 2000);
    });
    
    titleRow.append(title, copyButton);
    
    // Create resolution info
    const resolutionInfo = document.createElement('div');
    resolutionInfo.className = 'resolution-info';
    resolutionInfo.textContent = 'Loading resolution...';
    
    getStreamResolution(video.url).then(resolution => {
        resolutionInfo.textContent = resolution;
    });
    
    // Create download buttons
    const downloadGroup = document.createElement('div');
    downloadGroup.className = 'download-group';
    
    const downloadButton = document.createElement('button');
    downloadButton.className = 'download-btn';
    downloadButton.textContent = 'Download';
    
    const debouncedDownload = debounce(async () => {
        await handleDownload(downloadButton, video.url);
    }, 300);
    
    downloadButton.addEventListener('click', debouncedDownload);
    
    const saveAsButton = document.createElement('button');
    saveAsButton.className = 'save-as-btn';
    saveAsButton.textContent = 'Save as...';
    
    const debouncedSaveAs = debounce(async () => {
        await handleDownload(saveAsButton, video.url, true);
    }, 300);
    
    saveAsButton.addEventListener('click', debouncedSaveAs);
    
    downloadGroup.append(downloadButton, saveAsButton);
    
    // Assemble info column
    infoColumn.append(titleRow, resolutionInfo, downloadGroup);
    
    // Assemble video item
    element.append(previewColumn, infoColumn);
    
    return element;
}

async function getStreamResolution(url) {
    // Check cache first
    if (resolutionCache.has(url)) {
        return resolutionCache.get(url);
    }
    
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'getHLSQualities',
            url: url
        });
        
        if (response && response.streamInfo) {
            const { width, height, fps } = response.streamInfo;
            if (width && height) {
                const resolution = `${width}x${height}${fps ? ` @ ${fps}fps` : ''}`;
                resolutionCache.set(url, resolution);
                return resolution;
            }
        }
    } catch (error) {
        console.error('Failed to get resolution:', error);
    }
    return 'Resolution unknown';
}

async function handleDownload(button, url, saveAs = false) {
    const originalText = button.textContent;
    button.disabled = true;
    button.innerHTML = '<div class="button-loader"></div>';
    
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'downloadHLS',
            url: url,
            saveAs: saveAs
        });
        
        if (response && response.progress) {
            button.textContent = `${response.progress}%`;
        }
    } catch (error) {
        console.error('Download failed:', error);
        showError('Failed to start download');
    } finally {
        setTimeout(() => {
            button.disabled = false;
            button.textContent = originalText;
        }, 1000);
    }
}

function setupBackgroundObserver() {
    const observer = new MutationObserver(debounce(async (mutations) => {
        // Only update if relevant changes are detected
        const hasRelevantChanges = mutations.some(mutation => {
            return Array.from(mutation.addedNodes).some(node => 
                node.nodeName === 'VIDEO' || 
                node.querySelector?.('video, source[type*="video"]')
            );
        });
        
        if (backgroundLoadingEnabled && hasRelevantChanges) {
            await updateVideoList(true);
        }
    }, 1000));
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
    });
}

function showError(message) {
    const container = document.getElementById('videos');
    container.innerHTML = `
        <div class="initial-message">
            ${message}. Please try again.
        </div>
    `;
}

function getFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        return pathname.split('/').pop() || 'video';
    } catch {
        return 'video';
    }
}