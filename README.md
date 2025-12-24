```markdown
# AI-Diff-Tool

A desktop app built with Electron and Node.js to apply diff patches to files using the xAI Grok 4 API.

## Setup
1. Clone: `git clone https://github.com/yourusername/AI-Diff-Tool.git`
2. `cd AI-Diff-Tool`
3. `npm install`
4. `npm start`

## Building the App
To create a standalone executable (e.g., for distribution or icon-click launch), use electron-builder. This packages the app into a single portable file on Linux (AppImage), or executables on other platforms.

1. Install electron-builder if not already: `npm install --save-dev electron-builder`
2. Run the build command: `npm run build`
   - This generates files in the `dist/` folder.
   - On Linux, it creates a single `AI Diff Tool-1.0.0.AppImage` file (portable, no installation needed).
   - On other platforms, it creates corresponding executables (e.g., .exe on Windows, .dmg on macOS).
3. For custom builds (e.g., Linux only): Modify the "build" script in `package.json` to target specific platforms, e.g., `"build": "electron-builder --linux appimage"`.

The packaged app bundles all dependencies (Node, Electron), so no Node installation is required to run it. It removes dev features like open DevTools for a cleaner experience.

## Usage
- Paste or load the diff patch into the top textarea (or select a file).
- Paste or load the file content into the bottom textarea (or select a file).
- Select the Grok model from the dropdown (saved preference).
- Enter xAI API key (get from https://console.x.ai; saved locally for future sessions).
- Click "Apply Patch with Grok 4 Fast" – preview the modified content in the output area (with copy button and right-click menu), and download the result.

### On Linux (Using the Packaged AppImage)
1. Navigate to `dist/` after building.
2. Make the AppImage executable (if needed): `chmod +x "AI Diff Tool-1.0.0.AppImage"`
3. Double-click the AppImage file to launch, or run `./"AI Diff Tool-1.0.0.AppImage"` from terminal.
4. For desktop icon launch:
   - Create a `.desktop` file in `~/.local/share/applications/` (e.g., `ai-diff-tool.desktop`):
     ```
     [Desktop Entry]
     Name=AI Diff Tool
     Exec=/path/to/dist/AI Diff Tool-1.0.0.AppImage
     Icon=/path/to/icon.png  # Optional: Add your icon
     Type=Application
     Categories=Utility;
     ```
   - Make it executable: `chmod +x ~/.local/share/applications/ai-diff-tool.desktop`
   - Search for "AI Diff Tool" in your app menu or add to desktop.

The AppImage is portable—copy it anywhere (USB, etc.) and run without installation. Settings like API key and model preference persist via local storage (tied to the app on your user account).

## Notes
- Supports any text-based files (JS, HTML, etc.).
- Handles large content with warnings.
- Built/Updated on Dec 24, 2025.
```