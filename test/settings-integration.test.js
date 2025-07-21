/**
 * Settings Integration Tests
 * Manual tests for settings manager initialization, persistence, and edge cases
 * Run with: node test/settings-integration.test.js
 */

// Simple test framework
let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    testCount++;
    if (condition) {
        console.log(`✓ ${message}`);
        passCount++;
    } else {
        console.error(`✗ ${message}`);
        failCount++;
    }
}

function assertEqual(actual, expected, message) {
    const condition = JSON.stringify(actual) === JSON.stringify(expected);
    assert(condition, `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
}

// Mock chrome.storage.local for testing
const mockStorage = {
    data: {},
    get: function(key) {
        return Promise.resolve(key === 'settings' ? { settings: mockStorage.data.settings } : {});
    },
    set: function(data) {
        Object.assign(mockStorage.data, data);
        return Promise.resolve();
    },
    clear: function() {
        mockStorage.data = {};
        return Promise.resolve();
    }
};

// Mock chrome API
global.chrome = {
    storage: {
        local: mockStorage
    }
};

// Import after mocking
const { SettingsManager } = await import('../extension/background/state/settings-manager.js');

// Test 1: Settings Manager Initialization
async function testInitialization() {
    console.log('\n=== Testing Settings Manager Initialization ===');
    
    // Test 1.1: Initialize with no existing storage
    {
        mockStorage.data = {};
        const settingsManager = new SettingsManager();
        await settingsManager.initialize();
        
        assert(settingsManager.initialized === true, 'Settings manager should be initialized');
        
        const expectedDefaults = {
            maxConcurrentDownloads: 1,
            defaultSavePath: null,
            minFileSizeFilter: 102400, // Updated to 100KB
            autoGeneratePreviews: true,
            maxHistorySize: 50,
            historyAutoRemoveInterval: 30
        };
        
        assertEqual(settingsManager.getAll(), expectedDefaults, 'Should initialize with default settings');
    }
    
    // Test 1.2: Initialize with existing valid storage
    {
        const existingSettings = {
            maxConcurrentDownloads: 3,
            defaultSavePath: '/downloads',
            minFileSizeFilter: 2048,
            autoGeneratePreviews: false,
            maxHistorySize: 100,
            historyAutoRemoveInterval: 60
        };
        mockStorage.data.settings = existingSettings;
        
        const settingsManager = new SettingsManager();
        await settingsManager.initialize();
        
        assertEqual(settingsManager.getAll(), existingSettings, 'Should load existing valid settings');
    }
    
    // Test 1.3: Merge partial settings with defaults
    {
        const partialSettings = {
            maxConcurrentDownloads: 5,
            autoGeneratePreviews: false
        };
        mockStorage.data.settings = partialSettings;
        
        const settingsManager = new SettingsManager();
        await settingsManager.initialize();
        
        const expectedMerged = {
            maxConcurrentDownloads: 5,
            defaultSavePath: null,
            minFileSizeFilter: 102400, // Updated to 100KB
            autoGeneratePreviews: false,
            maxHistorySize: 50,
            historyAutoRemoveInterval: 30
        };
        
        assertEqual(settingsManager.getAll(), expectedMerged, 'Should merge partial settings with defaults');
    }
}
// Test 2: Settings Persistence
async function testPersistence() {
    console.log('\n=== Testing Settings Persistence ===');
    
    const settingsManager = new SettingsManager();
    await settingsManager.initialize();
    
    // Test 2.1: Persist settings updates
    {
        const newSettings = {
            maxConcurrentDownloads: 3,
            defaultSavePath: '/custom/path',
            minFileSizeFilter: 5120,
            autoGeneratePreviews: false,
            maxHistorySize: 75,
            historyAutoRemoveInterval: 45
        };
        
        const success = await settingsManager.updateAll(newSettings);
        
        assert(success === true, 'Settings update should succeed');
        assertEqual(settingsManager.getAll(), newSettings, 'Settings should be updated in memory');
    }
    
    // Test 2.2: Validate settings before persisting
    {
        const invalidSettings = {
            maxConcurrentDownloads: 20, // Above max
            minFileSizeFilter: -500, // Below min
            unknownSetting: 'should be ignored'
        };
        
        const success = await settingsManager.updateAll(invalidSettings);
        
        assert(success === true, 'Settings update should succeed even with invalid values');
        
        const persistedSettings = settingsManager.getAll();
        assert(persistedSettings.maxConcurrentDownloads === 10, 'maxConcurrentDownloads should be clamped to max (10)');
        assert(persistedSettings.minFileSizeFilter === 0, 'minFileSizeFilter should be clamped to min (0)');
        assert(persistedSettings.unknownSetting === undefined, 'Unknown settings should be ignored');
    }
}

// Test 3: Multiple Instance Consistency
async function testMultipleInstances() {
    console.log('\n=== Testing Multiple Instance Consistency ===');
    
    // Test 3.1: Consistent values across instances
    {
        const manager1 = new SettingsManager();
        await manager1.initialize();
        await manager1.updateAll({ maxConcurrentDownloads: 4 });
        
        const manager2 = new SettingsManager();
        await manager2.initialize();
        
        assertEqual(manager1.getAll(), manager2.getAll(), 'Both managers should have same values');
        assert(manager1.get('maxConcurrentDownloads') === 4, 'Manager 1 should have updated value');
        assert(manager2.get('maxConcurrentDownloads') === 4, 'Manager 2 should have same value');
    }
}

// Test 4: Edge Cases
async function testEdgeCases() {
    console.log('\n=== Testing Edge Cases ===');
    
    const settingsManager = new SettingsManager();
    await settingsManager.initialize();
    
    // Test 4.1: Handle null/undefined settings
    {
        const success1 = await settingsManager.updateAll(null);
        const success2 = await settingsManager.updateAll(undefined);
        const success3 = await settingsManager.updateAll({});
        
        assert(success1 === true, 'Should handle null settings');
        assert(success2 === true, 'Should handle undefined settings');
        assert(success3 === true, 'Should handle empty settings');
        
        const expectedDefaults = {
            maxConcurrentDownloads: 1,
            defaultSavePath: null,
            minFileSizeFilter: 102400, // Updated to 100KB
            autoGeneratePreviews: true,
            maxHistorySize: 50,
            historyAutoRemoveInterval: 30
        };
        
        assertEqual(settingsManager.getAll(), expectedDefaults, 'Should maintain defaults for null/undefined/empty');
    }
    
    // Test 4.2: Handle corrupted storage data
    {
        mockStorage.data.settings = "corrupted string instead of object";
        const corruptedManager = new SettingsManager();
        await corruptedManager.initialize();
        
        const expectedDefaults = {
            maxConcurrentDownloads: 1,
            defaultSavePath: null,
            minFileSizeFilter: 102400, // Updated to 100KB
            autoGeneratePreviews: true,
            maxHistorySize: 50,
            historyAutoRemoveInterval: 30
        };
        
        assertEqual(corruptedManager.getAll(), expectedDefaults, 'Should fall back to defaults for corrupted data');
    }
}

// Test 5: Download Queue Integration (Simulated)
async function testDownloadQueueIntegration() {
    console.log('\n=== Testing Download Queue Integration (Simulated) ===');
    
    const settingsManager = new SettingsManager();
    await settingsManager.initialize();
    
    // Mock download manager behavior
    const downloadManager = {
        activeDownloads: new Set(),
        downloadQueue: [],
        settingsManager: settingsManager,
        
        canStartDownload() {
            const maxConcurrent = this.settingsManager.get('maxConcurrentDownloads');
            return this.activeDownloads.size < maxConcurrent;
        },
        
        startDownload(downloadId) {
            if (this.canStartDownload()) {
                this.activeDownloads.add(downloadId);
                return true;
            } else {
                this.downloadQueue.push(downloadId);
                return false;
            }
        },
        
        completeDownload(downloadId) {
            this.activeDownloads.delete(downloadId);
            this.processQueue();
        },
        
        processQueue() {
            while (this.downloadQueue.length > 0 && this.canStartDownload()) {
                const nextDownload = this.downloadQueue.shift();
                this.activeDownloads.add(nextDownload);
            }
        }
    };
    
    // Test 5.1: Respect concurrent download limit
    {
        await settingsManager.updateAll({ maxConcurrentDownloads: 2 });
        
        const results = [
            downloadManager.startDownload('download1'),
            downloadManager.startDownload('download2'),
            downloadManager.startDownload('download3'),
            downloadManager.startDownload('download4')
        ];
        
        assertEqual(results, [true, true, false, false], 'Only first 2 downloads should start immediately');
        assert(downloadManager.activeDownloads.size === 2, 'Should have 2 active downloads');
        assert(downloadManager.downloadQueue.length === 2, 'Should have 2 queued downloads');
    }
    
    // Test 5.2: Process queue when downloads complete
    {
        downloadManager.completeDownload('download1');
        
        assert(downloadManager.activeDownloads.size === 2, 'Should still have 2 active downloads after queue processing');
        assert(downloadManager.downloadQueue.length === 1, 'Should have 1 remaining queued download');
        assert(downloadManager.activeDownloads.has('download2'), 'download2 should still be active');
        assert(downloadManager.activeDownloads.has('download3'), 'download3 should have started from queue');
    }
}
// Run all tests
async function runAllTests() {
    console.log('🧪 Starting Settings Integration Tests...\n');
    
    try {
        await testInitialization();
        await testPersistence();
        await testMultipleInstances();
        await testEdgeCases();
        await testDownloadQueueIntegration();
        
        console.log('\n=== Test Results ===');
        console.log(`✅ Passed: ${passCount}`);
        console.log(`❌ Failed: ${failCount}`);
        console.log(`📊 Total: ${testCount}`);
        
        if (failCount === 0) {
            console.log('\n🎉 All tests passed!');
            process.exit(0);
        } else {
            console.log('\n💥 Some tests failed!');
            process.exit(1);
        }
    } catch (error) {
        console.error('\n💥 Test execution failed:', error);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests();
}