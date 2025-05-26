# Video Downloader MV3

A Chrome MV3 extension designed to download HLS, DASH, and direct video/audio, communicating with a Node.js-powered native host bundled with ffmpeg and ffprobe for efficient media processing.

## Development

### CSS Architecture

This project uses a modular CSS approach for development but bundles all CSS files into a single file for production.

#### CSS Structure

- **Main CSS file**: `/extension/popup/popup.css` - This is the bundled file that contains all styles
- **CSS modules**: `/extension/popup/css/*.css` - Individual CSS files for specific components

#### How CSS Bundling Works

1. During development, you can create and modify CSS files in the `/extension/popup/css/` folder
2. The bundling script (`bundle-css.js`) combines all these files into a single `popup.css` file
3. Only the bundled file is loaded by the popup HTML, keeping network requests minimal

#### Running the CSS Bundler

```bash
# Bundle CSS once
npm run bundle-css

# Auto-bundle CSS as you make changes (development mode)
npm run dev
```

#### Adding New CSS Files

1. Create a new CSS file in `/extension/popup/css/` (e.g., `my-component.css`)
2. Add your styles to this file
3. Run the bundler - the styles will be added to the main popup.css file
4. The HTML already loads the bundled file, so no changes needed to HTML

Note: The `/extension/popup/css/` folder is excluded from Git. All your CSS changes should be committed through the bundled `popup.css` file.

## Building for Production

Before building the extension for production:

```bash
npm run build
```

This will bundle all CSS files and prepare the extension for packaging.

## License

MIT
