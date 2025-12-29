# AI-Diff-Tool

A desktop app built with Electron and Node.js to apply diff patches to files using the xAI Grok 4 API.

---

## Setup (All Platforms)

1. Clone:

   ```bash
   git clone https://github.com/yourusername/AI-Diff-Tool.git
   ```
2. Enter repo:

   ```bash
   cd AI-Diff-Tool
   ```
3. Install deps:

   ```bash
   npm install
   ```
4. Run in dev:

   ```bash
   npm start
   ```

---

## Usage

* Paste or load the diff patch into the top textarea (or select a file).
* Paste or load the file content into the bottom textarea (or select a file).
* Select the Grok model from the dropdown (saved preference).
* Enter xAI API key (get from [https://console.x.ai](https://console.x.ai); saved locally for future sessions).
* Click **Apply Patch** – preview the modified content in the output area and download the result.

---

## Building the App

This project uses **electron-builder** and outputs artifacts into `dist/`.

* **Linux:** AppImage (portable)
* **Windows:** Portable `.exe` (single file)
* **macOS:** Zip (x64 + arm64)

> If you are building Windows from Linux, you must use **Docker** (recommended) or install Wine/Mono locally.
> Building macOS artifacts generally requires macOS (Apple tooling), but this repo includes the mac target config for when you build on mac.

---

# Build Instructions — Linux

## A) Build Linux AppImage (native on Linux)

```bash
npm ci
npx electron-builder --linux appimage
```

Output:

* `dist/AI Diff Tool-1.0.1.AppImage`

### Run the AppImage

```bash
chmod +x "dist/AI Diff Tool-1.0.1.AppImage"
./"dist/AI Diff Tool-1.0.1.AppImage"
```

### Optional: Desktop launcher (AppImage)

Create: `~/.local/share/applications/ai-diff-tool.desktop`

```ini
[Desktop Entry]
Name=AI Diff Tool
Exec=/absolute/path/to/dist/AI Diff Tool-1.0.1.AppImage
Icon=/absolute/path/to/icon.png
Type=Application
Categories=Utility;
Terminal=false
```

Then:

```bash
chmod +x ~/.local/share/applications/ai-diff-tool.desktop
```

---

## B) Build Windows portable EXE from Linux (Docker required)

### 1) Install Docker

Install Docker for your distro (Docker Engine is enough; Docker Desktop is optional).

### 2) Prepare host cache dirs (speed-up)

These folders are on your **host machine**, not inside the app folder:

```bash
mkdir -p ~/.cache/electron ~/.cache/electron-builder
```

### 3) Run the Windows build using the builder image (Wine)

Use either the long command or the npm script.

**Long command (your current working command):**

```bash
docker run --rm -t \
  -v "$PWD":/project -w /project \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  bash -lc "npm ci && npx electron-builder --win portable --x64"
```

**Or use the script:**

```bash
npm run dist:win:docker
```

Output:

* `dist/AI Diff Tool 1.0.1.exe` (portable single EXE)

---

# Build Instructions — Windows

## A) Build Windows portable EXE (native on Windows)

### 1) Prereqs

* Node.js (LTS recommended)
* Git (optional but useful)

### 2) Install & build

From repo root:

```powershell
npm ci
npx electron-builder --win portable --x64
```

Output:

* `dist\AI Diff Tool 1.0.1.exe`

> Note: On Windows, builds can trigger Defender/SmartScreen warnings for unsigned executables. That’s expected unless you code-sign.

---

## Notes / Tips

* **Icons**

  * Windows icon must be a real `.ico` (multi-size) at: `build/icons/icon.ico`
  * macOS icon should be `.icns` at: `build/icons/icon.icns`
* **Settings persistence**

  * API keys and preferences persist via Electron’s local storage in your user profile.
* **File support**

  * Works for any text-based files (JS, HTML, etc.). Large inputs show warnings.
* **Last updated**

  * Dec 29, 2025.
