export async function getVideosFromContentScript(tabId) {
    return new Promise((resolve, reject) => {
        try {
            // Attempt to execute script in tab
            chrome.scripting.executeScript({
                target: { tabId },
                function: () => {
                    // Return a list of videos
                    const sendVideosBack = (videos) => {
                        return videos;
                    };

                    // Check if window.vdVideos exists (from our content script)
                    if (window.vdVideos && Array.isArray(window.vdVideos)) {
                        return sendVideosBack(window.vdVideos);
                    }

                    // If content script videos aren't available, do our own scan
                    const videos = [];
                    const mediaElements = [...document.querySelectorAll('video, audio')];
                    const videoSources = [];

                    // Check media elements
                    mediaElements.forEach((media) => {
                        const src = media.src;
                        if (src && src.startsWith('http') && src !== window.location.href) {
                            // Check if it's an HLS video
                            const isHls = isHlsVideo(src);
                            
                            videoSources.push({
                                url: src,
                                type: isHls ? 'hls' : (media.tagName.toLowerCase() === 'video' ? 'video' : 'audio'),
                                title: getTitleFromUrl(src),
                                source: 'element'
                            });
                        }

                        // Check source elements within media element
                        const sourceElements = media.querySelectorAll('source');
                        sourceElements.forEach((source) => {
                            const src = source.src;
                            if (src && src.startsWith('http') && src !== window.location.href) {
                                // Check MIME type and URL for better detection
                                const type = source.type;
                                const isHls = isHlsVideo(src, type);
                                
                                videoSources.push({
                                    url: src,
                                    type: isHls ? 'hls' : (
                                        type?.includes('audio/') ? 'audio' : 
                                        type?.includes('video/') ? 'video' : 
                                        media.tagName.toLowerCase()
                                    ),
                                    title: getTitleFromUrl(src),
                                    source: 'source'
                                });
                            }
                        });
                    });

                    // Add sources to videos if not already included
                    const existingUrls = new Set();
                    videoSources.forEach((source) => {
                        if (!existingUrls.has(source.url)) {
                            videos.push(source);
                            existingUrls.add(source.url);
                        }
                    });

                    return sendVideosBack(videos);

                    // Helper function to determine if URL is HLS video
                    function isHlsVideo(url, mimeType) {
                        // Check for common HLS patterns in URL
                        const urlPatterns = [
                            /\.m3u8(\?|$)/i,
                            /\.m3u(\?|$)/i,
                            /\/playlist\//i,
                            /\/manifest\//i,
                            /\/playlist\.json(\?|$)/i,
                            /\/manifest\.json(\?|$)/i,
                            /\/master\.json(\?|$)/i
                        ];

                        // Check URL patterns first
                        if (urlPatterns.some(pattern => pattern.test(url))) {
                            return true;
                        }

                        // Check MIME type if available
                        if (mimeType) {
                            return mimeType.includes('application/x-mpegURL') || 
                                   mimeType.includes('application/vnd.apple.mpegURL') ||
                                   mimeType.includes('vnd.apple.mpegurl');
                        }

                        return false;
                    }

                    // Helper function to get title from URL
                    function getTitleFromUrl(url) {
                        try {
                            const urlObj = new URL(url);
                            const pathSegments = urlObj.pathname.split('/');
                            const filename = pathSegments[pathSegments.length - 1];
                            
                            // Remove query parameters and decode
                            const filenameNoQuery = filename.split('?')[0];
                            return filenameNoQuery || 'Video';
                        } catch (e) {
                            return 'Video';
                        }
                    }
                }
            }, (results) => {
                if (chrome.runtime.lastError) {
                    console.error("Error executing script:", chrome.runtime.lastError);
                    resolve([]); // Resolve with empty array rather than reject to avoid breaking the chain
                    return;
                }
                
                if (!results || !results[0]) {
                    console.log('No results from content script');
                    resolve([]);
                    return;
                }
                
                const videos = results[0].result || [];
                resolve(videos);
            });
        } catch (error) {
            console.error('Error executing content script:', error);
            resolve([]); // Resolve with empty array rather than reject
        }
    });
} 