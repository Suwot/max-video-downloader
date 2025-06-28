# SCSS Architecture Documentation

## Overview
The popup styles have been refactored from a single 1,945-line file into a modular architecture with 8 focused partials.

## Structure

```
extension/popup/
├── popup.scss                 # Main import file
└── styles/                    # Modular partials
    ├── _variables.scss         # CSS custom properties & design tokens
    ├── _base.scss             # Reset, body, typography system  
    ├── _layout.scss           # Header, containers, tab structure
    ├── _navigation.scss       # Tab navigation, buttons
    ├── _components.scss       # Dropdowns, badges, tooltips
    ├── _video-items.scss      # Video list, media groups, video items
    ├── _downloads.scss        # Download sections, history items
    └── _animations.scss       # Loaders, hover effects, transitions
```

## Import Order
The partials are imported in dependency order:
1. **Variables** - Must be first (CSS custom properties)
2. **Base** - Foundation styles
3. **Layout** - High-level structure
4. **Navigation** - Interactive elements
5. **Components** - Reusable UI components
6. **Content Areas** - Video items and downloads
7. **Animations** - Visual enhancements

## Benefits
- **Maintainability**: Easier to locate and modify specific components
- **Collaboration**: Multiple developers can work on different areas
- **Organization**: Clear separation of concerns
- **Debugging**: Styles are logically grouped
- **Scalability**: New components can be added as separate partials

## Development Guidelines
- Variables are defined once in `_variables.scss`
- Each partial has a single responsibility
- Use semantic naming conventions
- Import order must be maintained
- All styles compile to the same `popup.css` output

## Compilation
The Live Sass Compile extension automatically handles the `@import` statements. No changes to build process needed.

## Backup
Original file backed up as `popup-backup-YYYYMMDD_HHMMSS.scss`
