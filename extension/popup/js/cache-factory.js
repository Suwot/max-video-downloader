/**
 * @ai-guide-component CacheFactory
 * @ai-guide-description Centralized cache management system 
 * @ai-guide-responsibilities
 * - Provides a consistent interface for all cache types
 * - Handles TTL and versioning for cached data
 * - Implements LRU eviction policies
 * - Manages persistence across browser sessions
 * - Supports storage with Chrome APIs
 */

// Cache constants used across all cache instances
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_VERSION = "1.0"; // Version of the cache schema
const CACHE_VERSION_KEY = "cacheVersion";

// Debug logging helper
function logDebug(...args) {
    console.log('[Cache System]', new Date().toISOString(), ...args);
}

/**
 * Base Cache class with consistent interface and behavior
 */
class Cache {
    /**
     * Create a new cache instance
     * @param {string} name - Name of the cache for logging and storage
     * @param {number} maxSize - Maximum size limit for the cache
     * @param {boolean} autoSave - Whether to automatically save on changes
     */
    constructor(name, maxSize, autoSave = true) {
        this.name = name;
        this.maxSize = maxSize;
        this.autoSave = autoSave;
        this.data = new Map();
        this.storageSaveTimeoutId = null;
    }

    /**
     * Set an item in the cache with proper TTL and version
     * @param {string} key - Cache item key
     * @param {any} value - The value to cache
     * @returns {boolean} Success status
     */
    set(key, value) {
        try {
            // Add timestamps and version
            const cacheEntry = {
                data: value,
                timestamp: Date.now(),
                lastAccessed: Date.now(),
                version: CACHE_VERSION
            };
            
            this.data.set(key, cacheEntry);
            
            // Enforce size limit
            this.enforceSizeLimit();
            
            // Trigger save if auto-save is enabled
            if (this.autoSave) {
                this.debouncedSave();
            }
            
            return true;
        } catch (error) {
            console.error(`[${this.name}] Error setting cache item:`, error);
            return false;
        }
    }

    /**
     * Get an item from the cache with validation
     * @param {string} key - Cache item key
     * @returns {any|null} The cached value or null if not found/valid
     */
    get(key) {
        try {
            const cacheEntry = this.data.get(key);
            if (!cacheEntry) return null;
            
            // Version check
            if (cacheEntry.version !== CACHE_VERSION) {
                this.data.delete(key);
                return null;
            }
            
            // TTL check
            if (Date.now() - cacheEntry.timestamp > CACHE_TTL) {
                this.data.delete(key);
                return null;
            }
            
            // Update last accessed time for LRU
            cacheEntry.lastAccessed = Date.now();
            this.data.set(key, cacheEntry);
            
            return cacheEntry.data;
        } catch (error) {
            console.error(`[${this.name}] Error getting cache item:`, error);
            return null;
        }
    }

    /**
     * Check if the cache has a valid item
     * @param {string} key - Cache item key
     * @returns {boolean} True if the item exists and is valid
     */
    has(key) {
        try {
            const cacheEntry = this.data.get(key);
            if (!cacheEntry) return false;
            
            // Version check
            if (cacheEntry.version !== CACHE_VERSION) {
                this.data.delete(key);
                return false;
            }
            
            // TTL check
            if (Date.now() - cacheEntry.timestamp > CACHE_TTL) {
                this.data.delete(key);
                return false;
            }
            
            return true;
        } catch (error) {
            console.error(`[${this.name}] Error checking cache item:`, error);
            return false;
        }
    }

    /**
     * Delete an item from the cache
     * @param {string} key - Cache item key
     * @returns {boolean} Success status
     */
    delete(key) {
        try {
            const result = this.data.delete(key);
            
            // Trigger save if auto-save is enabled
            if (result && this.autoSave) {
                this.debouncedSave();
            }
            
            return result;
        } catch (error) {
            console.error(`[${this.name}] Error deleting cache item:`, error);
            return false;
        }
    }

    /**
     * Clear all items from the cache
     * @returns {boolean} Success status
     */
    clear() {
        try {
            this.data.clear();
            
            // Trigger save if auto-save is enabled
            if (this.autoSave) {
                this.save();
            }
            
            return true;
        } catch (error) {
            console.error(`[${this.name}] Error clearing cache:`, error);
            return false;
        }
    }

    /**
     * Get all valid items from the cache
     * @returns {Map} Map of valid cache items
     */
    getAllValid() {
        try {
            const result = new Map();
            const now = Date.now();
            
            for (const [key, entry] of this.data.entries()) {
                // Skip invalid entries
                if (!entry || !entry.data) continue;
                
                // Version check
                if (entry.version !== CACHE_VERSION) {
                    this.data.delete(key);
                    continue;
                }
                
                // TTL check
                if (now - entry.timestamp > CACHE_TTL) {
                    this.data.delete(key);
                    continue;
                }
                
                result.set(key, entry.data);
            }
            
            return result;
        } catch (error) {
            console.error(`[${this.name}] Error getting all valid cache items:`, error);
            return new Map();
        }
    }

    /**
     * Enforce size limit using LRU eviction
     */
    enforceSizeLimit() {
        if (this.data.size <= this.maxSize) return;
        
        try {
            // Convert to array for sorting
            const entries = Array.from(this.data.entries());
            
            // Sort by last accessed (oldest first)
            entries.sort((a, b) => {
                const aAccess = a[1].lastAccessed || a[1].timestamp || 0;
                const bAccess = b[1].lastAccessed || b[1].timestamp || 0;
                return aAccess - bAccess;
            });
            
            // Remove oldest entries until we're at the limit
            const entriesToRemove = entries.slice(0, entries.length - this.maxSize);
            entriesToRemove.forEach(entry => {
                this.data.delete(entry[0]);
            });
            
            logDebug(`[${this.name}] Removed ${entriesToRemove.length} old entries (LRU eviction)`);
        } catch (error) {
            console.error(`[${this.name}] Error enforcing size limit:`, error);
        }
    }

    /**
     * Purge expired items from the cache
     * @returns {number} Number of items removed
     */
    purgeExpired() {
        try {
            const now = Date.now();
            const originalSize = this.data.size;
            
            for (const [key, entry] of this.data.entries()) {
                // Skip invalid entries
                if (!entry || !entry.timestamp) continue;
                
                // Version check
                if (entry.version !== CACHE_VERSION) {
                    this.data.delete(key);
                    continue;
                }
                
                // TTL check
                if (now - entry.timestamp > CACHE_TTL) {
                    this.data.delete(key);
                }
            }
            
            const removedCount = originalSize - this.data.size;
            if (removedCount > 0) {
                logDebug(`[${this.name}] Purged ${removedCount} expired entries`);
                
                // Trigger save if auto-save is enabled and items were removed
                if (this.autoSave) {
                    this.debouncedSave();
                }
            }
            
            return removedCount;
        } catch (error) {
            console.error(`[${this.name}] Error purging expired items:`, error);
            return 0;
        }
    }

    /**
     * Debounced save to prevent too many storage operations
     */
    debouncedSave() {
        if (this.storageSaveTimeoutId !== null) {
            clearTimeout(this.storageSaveTimeoutId);
        }
        
        this.storageSaveTimeoutId = setTimeout(() => {
            this.save();
            this.storageSaveTimeoutId = null;
        }, 500);
    }

    /**
     * Save the cache to persistent storage
     * @returns {Promise<boolean>} Promise resolving to success status
     */
    async save() {
        try {
            // Convert Map to array for storage
            const cacheData = JSON.stringify(Array.from(this.data.entries()));
            
            // Create storage object with consistent version key
            const storageObject = {
                [this.name]: cacheData,
                [CACHE_VERSION_KEY]: CACHE_VERSION
            };
            
            // Save to storage
            await chrome.storage.local.set(storageObject);
            
            logDebug(`[${this.name}] Saved ${this.data.size} entries to storage`);
            return true;
        } catch (error) {
            console.error(`[${this.name}] Error saving cache:`, error);
            return false;
        }
    }

    /**
     * Restore the cache from persistent storage
     * @param {Object} storageData - Storage data object from chrome.storage.local.get()
     * @returns {boolean} Success status
     */
    restore(storageData) {
        try {
            if (!storageData || !storageData[this.name]) return false;
            
            // Check version
            const storedVersion = storageData[CACHE_VERSION_KEY];
            if (storedVersion !== CACHE_VERSION) {
                logDebug(`[${this.name}] Cache version mismatch - stored: ${storedVersion}, current: ${CACHE_VERSION}`);
                // We'll still try to use the data, but log the mismatch
            }
            
            // Parse stored data
            const parsedData = JSON.parse(storageData[this.name]);
            this.data.clear();
            
            let restoredCount = 0;
            let expiredCount = 0;
            
            for (const [key, entry] of parsedData) {
                // Skip invalid entries
                if (!entry || !entry.data) continue;
                
                // Add lastAccessed if missing (for LRU)
                if (!entry.lastAccessed) {
                    entry.lastAccessed = entry.timestamp;
                }
                
                // TTL check
                if (Date.now() - entry.timestamp > CACHE_TTL) {
                    expiredCount++;
                    continue;
                }
                
                // Update version to current
                entry.version = CACHE_VERSION;
                this.data.set(key, entry);
                restoredCount++;
            }
            
            this.enforceSizeLimit();
            
            logDebug(`[${this.name}] Restored ${restoredCount} entries, skipped ${expiredCount} expired entries`);
            return restoredCount > 0;
        } catch (error) {
            console.error(`[${this.name}] Error restoring cache:`, error);
            return false;
        }
    }

    /**
     * Get the size of the cache
     * @returns {number} Number of items in the cache
     */
    get size() {
        return this.data.size;
    }

    /**
     * Get all entries in the cache (for debugging)
     * @returns {Array} Array of entries
     */
    entries() {
        return Array.from(this.data.entries());
    }
}

/**
 * Factory methods for creating different cache types
 */
const CacheFactory = {
    /**
     * Create a new standard cache instance
     * @param {string} name - Name of the cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} A new cache instance
     */
    createCache(name, maxSize) {
        return new Cache(name, maxSize, true);
    },
    
    /**
     * Create a media info cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} MediaInfoCache instance
     */
    createMediaInfoCache(maxSize) {
        return this.createCache('mediaInfoCache', maxSize);
    },
    
    /**
     * Create a poster cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} PosterCache instance
     */
    createPosterCache(maxSize) {
        return this.createCache('posterCache', maxSize);
    },
    
    /**
     * Create a resolution cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} ResolutionCache instance
     */
    createResolutionCache(maxSize) {
        return this.createCache('resolutionCache', maxSize);
    },
    
    /**
     * Create a stream metadata cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} StreamMetadataCache instance
     */
    createStreamMetadataCache(maxSize) {
        return this.createCache('streamMetadataCache', maxSize);
    },
    
    /**
     * Create a master playlist cache
     * @param {number} maxSize - Maximum cache size
     * @returns {Cache} MasterPlaylistCache instance
     */
    createMasterPlaylistCache(maxSize) {
        return this.createCache('masterPlaylistCache', maxSize);
    }
};

// Export factory and constants
export {
    CacheFactory,
    CACHE_TTL,
    CACHE_VERSION,
    CACHE_VERSION_KEY
};