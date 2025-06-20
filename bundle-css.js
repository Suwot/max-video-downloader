/**
 * CSS Bundler for Video Downloader MV3
 * 
 * This script concatenates all CSS files in extension/popup/css/ into extension/popup/popup.css
 * Run this script before building/packaging the extension to ensure all styles are bundled.
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CSS_FOLDER = path.join(__dirname, 'extension/popup/css');
const OUTPUT_FILE = path.join(__dirname, 'extension/popup/popup.css');
const HEADER_COMMENT = '/* Auto-generated bundle from css/*.css files - DO NOT EDIT DIRECTLY */\n\n';

// File order for predictable output
const FILE_ORDER = [
  'variables.css',   // Load variables first
  'base.css',
  'layout.css',
  'header.css',
  'loaders.css',
  'buttons.css', 
  'badges.css',
  'media-groups.css',
  'video-items.css',
  'progress.css',
  'dialogs.css',
  'utilities.css',
  'details-drawer.css',
  // Any other CSS files will be added after these in alphabetical order
];

/**
 * Bundle all CSS files into a single file
 */
function bundleCSS() {
    try {
        console.log('🔍 Looking for CSS files in:', CSS_FOLDER);
        
        // Check if CSS folder exists
        if (!fs.existsSync(CSS_FOLDER)) {
            console.log('⚠️ CSS folder does not exist. Creating it...');
            fs.mkdirSync(CSS_FOLDER, { recursive: true });
            return;
        }

        // Get all CSS files in the folder
        const allCssFiles = fs.readdirSync(CSS_FOLDER)
            .filter(file => file.endsWith('.css'));

        if (allCssFiles.length === 0) {
            console.log('❌ No CSS files found in the folder. Aborting.');
            return;
        }
        
        console.log(`📄 Found ${allCssFiles.length} CSS files`);
        
        // Start with the header comment
        let bundledCSS = HEADER_COMMENT;
        
        // Process files in the specified order first
        const processedFiles = new Set();
        
        for (const fileName of FILE_ORDER) {
            if (allCssFiles.includes(fileName)) {
                const filePath = path.join(CSS_FOLDER, fileName);
                const content = fs.readFileSync(filePath, 'utf8');
                
                bundledCSS += `/* From ${fileName} */\n${content}\n\n`;
                processedFiles.add(fileName);
                console.log(`➕ Added ${fileName}`);
            }
        }
        
        // Process any remaining files that weren't in the specified order
        const remainingFiles = allCssFiles
            .filter(file => !processedFiles.has(file))
            .sort(); // Sort alphabetically for consistency
            
        for (const fileName of remainingFiles) {
            const filePath = path.join(CSS_FOLDER, fileName);
            const content = fs.readFileSync(filePath, 'utf8');
            
            bundledCSS += `/* From ${fileName} */\n${content}\n\n`;
            console.log(`➕ Added ${fileName}`);
        }

        // Write the bundled CSS to the output file
        fs.writeFileSync(OUTPUT_FILE, bundledCSS);
        console.log(`✅ Successfully bundled CSS to: ${OUTPUT_FILE}`);
        
        // Display stats
        const fileSizeKB = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(2);
        console.log(`📊 Generated file size: ${fileSizeKB} KB`);
        console.log(`🔄 Total CSS modules: ${allCssFiles.length}`);
        
    } catch (error) {
        console.error('❌ Error bundling CSS:', error);
        process.exit(1);
    }
}

// Execute the bundling process
bundleCSS();
