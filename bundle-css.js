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
        }

        // Read all CSS files in the folder
        const cssFiles = fs.readdirSync(CSS_FOLDER)
            .filter(file => file.endsWith('.css'))
            .map(file => path.join(CSS_FOLDER, file));

        console.log(`📄 Found ${cssFiles.length} CSS files`);

        // Read the current popup.css (if exists)
        let baseCSS = '';
        if (fs.existsSync(OUTPUT_FILE)) {
            baseCSS = fs.readFileSync(OUTPUT_FILE, 'utf8');
            
            // Remove any previous auto-generated comment and find where user CSS starts
            const autogenIndex = baseCSS.indexOf('/* Auto-generated bundle');
            if (autogenIndex !== -1) {
                // Find the next CSS block after header
                const nextCSSStart = baseCSS.indexOf('/*', autogenIndex + 1);
                if (nextCSSStart !== -1) {
                    baseCSS = baseCSS.substring(nextCSSStart);
                } else {
                    baseCSS = '/* Base styles */\n';
                }
            }
            
            console.log('📝 Loaded base CSS from popup.css');
        } else {
            baseCSS = '/* Base styles */\n';
            console.log('🆕 No existing popup.css found, creating new file');
        }

        // Combine all CSS content
        let bundledCSS = HEADER_COMMENT + baseCSS + '\n\n';
        
        // Add module CSS files
        for (const file of cssFiles) {
            const fileName = path.basename(file);
            const content = fs.readFileSync(file, 'utf8');
            
            bundledCSS += `/* From ${fileName} */\n${content}\n\n`;
            console.log(`➕ Added ${fileName}`);
        }

        // Write the bundled CSS to the output file
        fs.writeFileSync(OUTPUT_FILE, bundledCSS);
        console.log(`✅ Successfully bundled CSS to: ${OUTPUT_FILE}`);
        
    } catch (error) {
        console.error('❌ Error bundling CSS:', error);
    }
}

// Execute the bundling process
bundleCSS();
