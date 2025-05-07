/**
 * This script allows us to toggle between the old and new video store implementations
 * for testing purposes. It's loaded by the popup to choose which implementation to use.
 */

// Flag to control which implementation to use
const USE_NEW_STORE = true;

// Dynamically import the appropriate video-fetcher module
// This approach allows us to test the new architecture without replacing the old one
async function getVideoFetcher() {
  if (USE_NEW_STORE) {
    console.log('🔄 Using new VideoStore-based implementation');
    return import('./temp-video-fetcher.js');
  } else {
    console.log('🔄 Using original implementation');
    return import('./video-fetcher.js');
  }
}

export { getVideoFetcher };