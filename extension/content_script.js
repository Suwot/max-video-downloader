console.log('Content script loaded');

function findVideos() {
    const videoSources = new Set();

    // Find direct video elements and their sources
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
        // Check direct src attribute
        if (video.src && !video.src.startsWith('blob:')) {
            videoSources.add(video.src);
        }
        
        // Check source elements within video
        const sources = video.querySelectorAll('source');
        sources.forEach(source => {
            if (source.src) {
                videoSources.add(source.src);
            }
        });
    });

    return Array.from(videoSources);
}

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'findVideos') {
        const videos = findVideos();
        console.log('Videos found:', videos);
        sendResponse(videos);
    }
    return true;
});