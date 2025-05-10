# Master-Variant Relationship Simplification

## Overview

We've simplified the HLS video detection system by eliminating the complex bidirectional master-variant relationships. Instead of using separate caches to track these relationships, variant information is now stored directly within the master playlist objects.

## Key Changes

### Removed Relationship Cache

- Eliminated `manifestRelationshipCache` to reduce complexity
- Removed the need for synchronizing two separate data structures
- Simplified the API for querying master-variant relationships

### Direct Variant Storage

- Master playlist objects now directly contain their variant information
- No need for additional lookups when accessing variant data
- Reduced memory usage by eliminating redundant data storage

### Updated Function Implementations

- `isVariantOfMasterPlaylist`: Now scans master playlists to find matching variants
- `getMasterPlaylistForVariant`: Works with the simplified data structure
- `clearCaches`: Updated to remove the unnecessary cache reference

### Performance Benefits

- Reduced memory footprint by eliminating redundant storage
- More direct access to related data without multiple cache lookups
- Simplified maintenance of relationship information

### Improved Code Readability

- Clearer code that directly expresses relationships
- More intuitive data structure that matches the natural parent-child relationship
- Easier to understand and maintain

## Migration Impact

This change is internal to the manifest service and should be transparent to other components. The public API functions remain the same, but with simplified implementations.

## Testing Recommendations

- Verify that master playlists correctly contain their variant information
- Ensure that `isVariantOfMasterPlaylist` and `getMasterPlaylistForVariant` functions work properly
- Check that the UI correctly displays master playlists with their variants
