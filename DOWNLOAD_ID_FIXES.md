# Download ID Fixes - Streamlined Flow

## Problem Summary
The native host didn't respect downloadId, causing progress mapping failures between videos-tab and downloads-tab. The system had complex fallback logic that was error-prone.

## Solution: Complete downloadId Flow

### Key Principle
**downloadId flows UI → Background → Native Host → Background → UI, never modified**

### Changes Made

#### 1. Hash-Based downloadId Generation
- **Location**: `extension/background/download/download-manager.js`
- **Change**: Use simple hash for privacy and performance
- **Format**: `{urlHash}_{streamHash}_{audioFlag}_{subsFlag}_{timestamp}`
- **Why**: Short IDs, no URL exposure, faster lookups, unique per operation

#### 2. Native Host downloadId Support
- **Location**: `native_host/commands/download.js`
- **Change**: Accept downloadId parameter and pass through all messages
- **Flow**: Store in activeProcesses, include in all progress/completion messages
- **Why**: Enables precise progress mapping from native host back to UI

#### 3. Streamlined Progress Mapping
- **Location**: `extension/popup/video/download-progress-handler.js`
- **Change**: Simple rule-based matching
- **Logic**: 
  - If video-item has downloadId → match only by downloadId
  - If video-item has no downloadId → match by URL (videos-tab fallback)
- **Why**: Natural separation between downloads-tab (precise) and videos-tab (fallback)

#### 4. Simplified Event Handling
- **Location**: `extension/background/download/download-manager.js`
- **Change**: Use downloadId from native host events directly
- **Logic**: Native host provides downloadId, no complex storage lookups needed
- **Why**: Direct flow eliminates lookup complexity and race conditions

#### 5. Clean Storage Operations
- **Location**: All storage operations
- **Change**: downloadId as primary key throughout
- **Logic**: Store by downloadId, lookup by downloadId, clean by downloadId
- **Why**: Consistent key usage enables natural deduplication

## Complete Data Flow

```
1. User clicks download (UI)
2. Background generates unique downloadId (hash-based)
3. downloadId flows to:
   - Active downloads Set (deduplication)
   - Storage (persistence) 
   - Native host command (tracking)
4. Native host stores downloadId and includes in ALL messages
5. Background receives events with downloadId
6. UI maps progress using downloadId (downloads-tab) or URL (videos-tab)
7. Completion cleanup uses downloadId as primary key
```

## Matching Logic

### Downloads Tab (Precise)
- Video items have `data-download-id` attribute
- Match only by downloadId
- Perfect 1:1 mapping for progress updates

### Videos Tab (Fallback)  
- Video items have no downloadId
- Match by `masterUrl || downloadUrl`
- Works for general progress indication

## Benefits

1. **No URL Exposure**: Hash-based IDs protect privacy
2. **Fast Lookups**: Short hash IDs improve performance  
3. **Natural Deduplication**: Same command = same hash = deduplicated
4. **Multi-Operation Support**: Different operations on same URL get unique IDs
5. **Simple Mapping**: Clear rules eliminate edge cases
6. **Complete Flow**: downloadId travels the entire pipeline

## Unique Operations Supported

- Same URL, different stream selections (DASH multi-track)
- Same URL, audio extraction vs video download
- Same URL, subtitle extraction vs video download
- Same URL, re-download after completion
- Same URL, simultaneous operations (3 audio extractions)

## Testing Scenarios

- [x] Multi-track DASH downloads (unique IDs per stream selection)
- [x] Simultaneous audio extractions (unique IDs per operation)
- [x] Re-downloads (unique timestamp ensures new ID)
- [x] Progress mapping (downloads-tab precise, videos-tab fallback)
- [x] Queue management (downloadId-based deduplication)
- [x] Cancellation (downloadId-based cleanup)
- [x] Storage operations (downloadId as primary key)