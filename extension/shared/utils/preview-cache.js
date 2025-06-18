/**
 * Preview Cache Service
 * Simple IndexedDB wrapper for caching video preview images
 */

// Database configuration
const DB_NAME = "VideoPreviewCache";
const STORE_NAME = "previews";
const DB_VERSION = 1;

// Create a logger instance
import { createLogger } from "./logger.js";
const logger = createLogger("Preview Cache");

/**
 * Initialize the database
 * @returns {Promise<IDBDatabase>} The database instance
 */
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      logger.error("Database failed to open:", event.target.error);
      reject(new Error("Database failed to open"));
    };

    request.onsuccess = (event) => {
      logger.debug("Database opened successfully");
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      logger.debug("Database upgrade needed, creating object store");
      const db = event.target.result;

      // Create the object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        logger.debug("Created object store:", STORE_NAME);
      }
    };
  });
}

/**
 * Store a preview in the cache
 * @param {string} url - Normalized URL of the video
 * @param {string} previewDataUrl - Base64 data URL of the preview image
 * @returns {Promise<void>}
 */
async function storePreview(url, previewDataUrl) {
  try {
    // Convert data URL to Blob for more efficient storage
    const response = await fetch(previewDataUrl);
    const blob = await response.blob();

    const db = await initDB();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise((resolve, reject) => {
      const request = store.put({
        url,
        previewImage: blob,
        createdAt: Date.now(),
      });

      request.onsuccess = () => {
        logger.debug(`Stored preview for: ${url}`);
        resolve();
      };

      request.onerror = (event) => {
        logger.error(`Failed to store preview for ${url}:`, event.target.error);
        reject(event.target.error);
      };
    });
  } catch (error) {
    logger.error("Failed to store preview in cache:", error);
    // Fail gracefully - don't let caching errors disrupt the app
  }
}

/**
 * Get a preview from the cache
 * @param {string} url - Normalized URL of the video
 * @returns {Promise<string|null>} Data URL of the preview or null if not found
 */
async function getPreview(url) {
  try {
    const db = await initDB();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);

    const result = await new Promise((resolve, reject) => {
      const request = store.get(url);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = (event) => {
        logger.error(
          `Failed to retrieve preview for ${url}:`,
          event.target.error
        );
        reject(event.target.error);
      };
    });

    if (!result) {
      logger.debug(`No cached preview found for: ${url}`);
      return null;
    }

    logger.debug(`Found cached preview for: ${url}`);

    // Convert Blob back to data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(result.previewImage);
    });
  } catch (error) {
    logger.error("Failed to retrieve preview from cache:", error);
    return null; // Return null if anything goes wrong
  }
}

/**
 * Clear all cached previews
 * @returns {Promise<boolean>} True if successful
 */
async function clearPreviewCache() {
  try {
    const db = await initDB();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        logger.debug("Preview cache cleared successfully");
        resolve();
      };

      request.onerror = (event) => {
        logger.error("Failed to clear preview cache:", event.target.error);
        reject(event.target.error);
      };
    });

    return true;
  } catch (error) {
    logger.error("Failed to clear preview cache:", error);
    return false;
  }
}

/**
 * Get cache statistics
 * @returns {Promise<{count: number, size: number}>} Number of cached items and total size in bytes
 */
async function getCacheStats() {
  try {
    const db = await initDB();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);

    let count = 0;
    let size = 0;

    await new Promise((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          count++;
          if (cursor.value.previewImage) {
            size += cursor.value.previewImage.size;
          }
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = (event) => {
        logger.error("Failed to get cache stats:", event.target.error);
        reject(event.target.error);
      };
    });

    logger.debug(`Cache stats: ${count} items, ${Math.round(size / 1024)} KB`);
    return { count, size };
  } catch (error) {
    logger.error("Failed to get cache stats:", error);
    return { count: 0, size: 0 };
  }
}

export { getPreview, storePreview, clearPreviewCache, getCacheStats };
