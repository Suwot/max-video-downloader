/**
 * esbuild Configuration for Chrome Web Store Submission
 * Bundles and minifies extension code while maintaining Chrome extension compatibility
 */

import { build } from 'esbuild';
import { readFileSync } from 'fs';

// Read manifest to get version
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const version = manifest.version;

console.log(`Building MAX Video Downloader v${version} for Chrome Web Store`);



// Shared build options
const sharedOptions = {
  bundle: true,
  minify: true,
  sourcemap: false, // No source maps for production
  target: 'chrome88', // Chrome 88+ for Manifest V3 support
  format: 'esm',
  platform: 'browser',
  treeShaking: true,
  // Keep Chrome extension APIs accessible
  external: ['chrome'],
  // Minification settings for Chrome Web Store compliance
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  // Keep function names that might be important for Chrome extension lifecycle
  keepNames: false,
  legalComments: 'none',
  // Native esbuild console removal - only remove log, debug, info
  // Keep console.warn, console.error, console.group, console.groupEnd
  pure: ['console.log', 'console.debug', 'console.info'],
};

// Build configurations
const builds = [
  // Background service worker bundle
  {
    ...sharedOptions,
    entryPoints: ['extension/background/index.js'],
    outfile: 'chrome-web-store/extension/background.js',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
  
  // Popup bundle
  {
    ...sharedOptions,
    entryPoints: ['extension/popup/index.js'],
    outfile: 'chrome-web-store/extension/popup/popup.js',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
];

// Execute all builds
async function buildAll() {
  try {
    console.log('🔨 Starting esbuild process...');
    
    const buildPromises = builds.map(async (config, index) => {
      const buildName = config.entryPoints[0].includes('background') ? 'Background' : 'Popup';
      console.log(`📦 Building ${buildName}...`);
      
      const result = await build(config);
      
      if (result.errors.length > 0) {
        console.error(`❌ ${buildName} build errors:`, result.errors);
        throw new Error(`${buildName} build failed`);
      }
      
      if (result.warnings.length > 0) {
        console.warn(`⚠️  ${buildName} build warnings:`, result.warnings);
      }
      
      console.log(`✅ ${buildName} built successfully`);
      return result;
    });
    
    await Promise.all(buildPromises);
    
    console.log('🎉 All builds completed successfully!');
    console.log('📁 Output directory: chrome-web-store/extension/');
    
  } catch (error) {
    console.error('💥 Build failed:', error);
    // eslint-disable-next-line no-undef
    process.exit(1);
  }
}

// Run the build
buildAll();