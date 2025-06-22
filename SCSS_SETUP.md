# SCSS Setup Guide for Video Downloader MV3

## What I've Done

✅ **Created `popup.scss`** - A complete SCSS refactor of your bundled CSS with:
- **Proper nesting** structure for better organization
- **CSS variables** maintained at the root for theming
- **Logical grouping** of related styles
- **Responsive design** patterns
- **Clean hierarchy** that follows your component structure

✅ **Live Sass Compiler Configuration** - Updated `.vscode/settings.json` with:
- Auto-compilation on save
- Output directly to `popup.css` (same location)
- Excluded CSS folder from compilation
- Optimized for your project structure

## How to Use

### 1. Start the Live Sass Compiler (Primary Method)
1. Open VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "Live Sass: Watch Sass" and select it
4. You'll see "Watching..." in the status bar

### 2. Alternative: Terminal Commands (If you prefer)
```bash
# Install Sass globally (one-time setup)
npm install -g sass

# Watch for changes (auto-compile)
npm run watch-css

# Or build once
npm run build-css
```

### 3. Edit SCSS File
- **Source file**: `extension/popup/popup.scss` 
- **Output file**: `extension/popup/popup.css` (auto-generated)
- Edit only the `.scss` file - the `.css` file will be automatically updated

### 3. SCSS Features You Can Use

#### **Variables** (already set up)
```scss
// Color scheme is defined in :root for CSS custom properties
// You can also create SCSS variables:
$primary-spacing: 8px;
$border-radius: 4px;
```

#### **Nesting** (extensively used)
```scss
.video-item {
    padding: 8px;
    
    .preview-container {
        width: 80px;
        
        .preview-image {
            opacity: 0;
            
            &.loaded {
                opacity: 1;
            }
        }
    }
    
    .theme-dark & {
        background-color: var(--bg-primary-dark);
    }
}
```

#### **Mixins** (you can add these)
```scss
@mixin button-style($bg-color) {
    padding: 8px 16px;
    background-color: $bg-color;
    border-radius: 4px;
    cursor: pointer;
}

.download-btn {
    @include button-style(var(--color-primary));
}
```

## Current Structure

```
popup.scss
├── Variables (:root CSS custom properties)
├── Base Styles (*, body, themes)
├── Layout (container, app-title, messages)
├── Header (refresh-container, buttons)
├── Buttons (theme-toggle, clear-cache, dismiss)
├── Video List (#videos, scrollbars)
├── Media Groups (type headers, toggles)
├── Video Items (cards, preview, info)
├── Download Components (buttons, wrappers)
├── Custom Dropdown (options, DASH multi-column)
├── Badges (source, status)
├── Progress (bars, animations)
├── Loaders & Animations (spin, pulse)
├── Hover Effects (preview hover)
├── Tooltips & Dialogs
└── Responsive Design (@media queries)
```

## Benefits of This Setup

### **Development**
- **Faster workflow**: Edit SCSS → Auto-compile → Instant preview
- **Better organization**: Logical nesting instead of flat CSS
- **Easier maintenance**: Related styles grouped together
- **IntelliSense**: VS Code provides SCSS autocomplete

### **Code Quality**
- **Reduced duplication**: Nested selectors eliminate repetition
- **Consistent structure**: Clear hierarchy matches HTML structure
- **Better readability**: Indentation shows relationships
- **Maintainable**: Easy to find and modify specific components

## Migration Notes

### **CSS Folder**
- ✅ **Kept in place** for reference
- ❌ **No longer used** for compilation
- 🔄 **Can be removed** once you're confident with SCSS setup

### **Bundle Script**
- 📁 `bundle-css.js` is now obsolete
- 🚫 No need to run it anymore
- 🗑️ Can be deleted if desired

### **Workflow Change**
- **Before**: Edit CSS partials → Run bundle script → Result in popup.css
- **After**: Edit popup.scss → Auto-compile → Result in popup.css

## Troubleshooting

### **Compilation Not Working?**
1. Check if Live Sass Compiler extension is installed
2. Verify "Watching..." appears in VS Code status bar
3. Check VS Code Output panel (View → Output → Live Sass Compiler)

### **Output Location Wrong?**
- The SCSS file will compile to the same directory (popup.css)
- If it goes elsewhere, adjust `savePath` in `.vscode/settings.json`

### **Syntax Errors?**
- SCSS is mostly compatible with CSS
- Main differences: nesting and `&` parent selector
- Check VS Code Problems panel for syntax issues

## What You Need to Do

### ✅ **Ready to Use Immediately**
1. Open `extension/popup/popup.scss` in VS Code
2. Start Live Sass Compiler: `Cmd+Shift+P` → "Live Sass: Watch Sass"
3. Edit the SCSS file - `popup.css` will auto-update!

### 📋 **Optional Setup Steps**

#### **Install Terminal Alternative** (if you want npm scripts)
```bash
npm install
# This installs sass for terminal commands
```

#### **Verify Live Sass Compiler Extension**
- Should already be installed in VS Code
- If not: Extensions → Search "Live Sass Compiler" → Install

### 🗑️ **Cleanup** (when you're confident)
- Delete `bundle-css.js` (no longer needed)
- Delete `extension/popup/css/` folder (optional - kept for reference)
- Delete `popup.css.backup` (created as backup)

### **Advanced SCSS Features You Can Add:**

1. **Mixins for common patterns**:
```scss
@mixin theme-colors($dark-bg, $light-bg) {
    .theme-dark & { background-color: $dark-bg; }
    .theme-light & { background-color: $light-bg; }
}
```

2. **Functions for calculations**:
```scss
@function rem($px) {
    @return #{$px / 16}rem;
}
```

3. **Partials and imports** (if code grows):
```scss
@import 'variables';
@import 'base';
@import 'components';
```

Your SCSS setup is now ready! Just open `popup.scss` and start editing. The CSS will auto-compile on save! 🎨
