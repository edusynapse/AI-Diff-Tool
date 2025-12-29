# AI Diff Tool — User Guide

This guide is for **end users** who want to download the app from GitHub Releases and use it to apply AI-generated patches to files.

---

## Why this tool exists (the real-world workflow)

When you build software with AI agents, you often ask the agent to make **complex changes across many files**. A common pattern looks like this:

1. You use a **large “thinking” model** to plan and generate changes (often as diffs/patches).
2. The diffs are sometimes **fuzzy**:
   - they *almost* match your current file, but not perfectly
   - they might be missing context lines
   - they may assume an older version of the file
   - they may not apply cleanly with Git or standard patch tools
3. You still want the speed + cost benefits of using a **fast, low-cost model** to do the mechanical work of applying the diff to the file content.

That’s what this app is for.

**AI Diff Tool** lets you:

- Paste a **diff patch** (strict or fuzzy) and the **current file content**
- Use a **fast model** (for example *Grok Fast*) to apply the patch and output the full updated file
- Work in **multiple tabs (workspaces)** at the same time (great when you’re patching many files)
- Verify the result using an **output diff viewer**, so you can catch issues like:
  - the model accidentally truncating the file
  - changes inserted in the wrong section
  - a patch being applied to the wrong file version

It also includes a **System Prompt** mechanism that nudges the model to:

- refuse to apply a patch if the input file doesn’t match what the patch expects
- report an error if it looks like the file is already updated or structurally different

You can keep the default behavior, or create a **stricter** / **looser** prompt and save it under a custom name.

---

## Download and run the app

Releases are published on GitHub:

- https://github.com/edusynapse/AI-Diff-Tool/releases

### What’s available right now

- **Windows:** portable `.exe`
- **Linux:** `.AppImage`
- **macOS:** binaries will be added in a future release

### Windows (portable EXE)

1. Download the `.exe` from the latest release.
2. Double-click to run.

> Windows may show a SmartScreen warning for unsigned apps. If you trust the repo/release, you can choose “More info → Run anyway”.

### Linux (AppImage)

1. Download the `.AppImage` from the latest release.
2. Make it executable:

   ```bash
   chmod +x "AI Diff Tool-*.AppImage"
   ```

3. Run it:

   ```bash
   ./"AI Diff Tool-*.AppImage"
   ```

---

## First launch: API keys and PIN (one-time setup)

The app can use either:

- **xAI (Grok models)**, or
- **OpenAI (GPT models)**

### Step 1: Add an API key

If you’ve never saved any keys before, the app will first ask which provider you want to set up:

- **xAI** or **OpenAI**

You can also do it anytime from the menu:

- **File → xAI API Key…**
- **File → OpenAI API Key…**

### Step 2: Set a 6-digit PIN

Your API key is stored **encrypted locally** using a **6-digit PIN**.

Important notes:

- The **PIN is not stored** on disk.
- You typically enter the PIN **once per app session**, and then keys remain unlocked for that session.
- If you forget the PIN, you cannot decrypt existing saved keys. In that case you can use:
  - **File → Clean and Reset…** (this wipes local app data so you can set keys again)

---

## The basic job this app does

For **each file** you want to patch, you provide two things:

1. A **Diff Patch** (the patch text, usually a unified diff)
2. The **File Content** (the current contents of the file you want to modify)

Then you select a model and click **Apply Patch**.

The app will produce:

- **Output from Model**: the full updated file content
- **Diff with original**: a side-by-side visual diff (so you can review changes safely)

---

## Quick start (patch one file)

1. **Open a workspace tab**
   - Tabs are listed in the left sidebar.
   - Each tab is an independent workspace (its own diff, file content, model, prompt, output).

2. **Pick a model**
   - Grok models use your **xAI key**
   - GPT models use your **OpenAI key**

3. **Paste (or load) the Diff Patch**
   - Paste into **Diff Patch**
   - Or click **Choose file** under the Diff Patch area

4. **Paste (or load) the File Content**
   - Paste into **File Content**
   - Or click **Choose file** under the File Content area

5. **Click “Apply Patch”**
   - The app may show a confirmation dialog (especially useful to avoid accidental runs).

6. **Review**
   - Read the “Output from Model”
   - Scroll down and review “Diff with original”

7. **Save your result**
   - **Copy** the output, or
   - Click **Download Modified File**

---

## Working on multiple files (the “many-file” workflow)

This is where the app shines when you’re applying a batch of AI-generated diffs.

### Recommended workflow

1. Create one tab per file:
   - Click **+** to create a new tab
   - Rename tabs to match filenames (for example: `renderer.js`, `styles.css`, `api/routes.js`)

2. For each tab:
   - Paste the diff for *that file*
   - Paste the current content for *that file*
   - Apply patch
   - Review the output diff
   - Save the patched result

This lets you patch many files **in parallel** without mixing inputs.

---

## Understanding “System Prompt” (important for accuracy)

The System Prompt controls how strict or flexible the model should be while applying patches.

### What it helps with

- Detecting “wrong file” scenarios  
  (example: you pasted the patch for `file A` but the content is actually `file B`)
- Detecting “already applied” scenarios  
  (example: file was already updated, so patch no longer matches)
- Preventing sloppy output like:
  - missing sections
  - truncated end of file
  - changes applied in the wrong area

### How to use it

- Click the **prompt button** near the top (often shows something like “Default”)
- Or open it from the menu:
  - **Edit → System Prompt…**

### Practical tip

If a patch fails because it’s too fuzzy, try a **looser** prompt.
If you’re worried about safety/accuracy, use a **stricter** prompt.

You can save multiple prompts and reuse them per tab.

---

## Reviewing results safely (don’t skip this)

Even fast models can make mistakes. Always verify the output before replacing your real file.

### What to check in “Diff with original”

- Are all expected changes present?
- Did the model accidentally remove a big block of code?
- Did it insert changes in the wrong place?
- Does the file look complete (especially the end of the file)?

### Navigating the diff

- Use **Prev change** / **Next change** (also available on **F7 / F8**)
- This helps when the output diff is long.

---

## Helpful UI tools

### Maximize / minimize text areas

Each of these areas has expand/collapse buttons:

- Diff Patch
- File Content
- Output

Use **maximize** when:

- you want to inspect the full output for truncation
- you want to see a big diff patch clearly

Use **minimize** when:

- you want the page compact again with scrolling inside the text area

### Copy output

- Use **Copy** to paste the patched file into your editor quickly.

### Download modified file

- Use **Download Modified File** if you prefer saving to disk.

---

## History (reopen past runs)

The app can store a history of your past patch runs.

Open it from:

- **View → History…**

From History you can:

- browse older runs
- reopen a past run into a new tab
- clear history if needed

---

## Updates

On startup, the app checks GitHub Releases and may show an **Update available** dialog.

If you see it:

- Click **Download** to go to the release page and grab the newer build
- Or click **Later** to ignore for now

---

## Language and Dark Mode

### Change language

- **View → Language…**
- English (EN) is always the fallback.

### Toggle Dark Mode

- **View → Dark Mode**
- Shortcut: **Cmd/Ctrl + D**

---

## Keyboard shortcuts (quick reference)

- **F1**: Open this usage help (in-app)
- **Cmd/Ctrl + D**: Dark Mode
- **Cmd/Ctrl + T**: New tab
- **Cmd/Ctrl + W**: Close tab
- **Cmd/Ctrl + Tab**: Next tab
- **Cmd/Ctrl + Shift + Tab**: Previous tab
- **F7**: Previous change
- **F8**: Next change
- **ESC**: Close the current dialog

API keys:

- **Cmd/Ctrl + K**: xAI API Key
- **Cmd/Ctrl + Shift + K**: OpenAI API Key

System prompt:

- **Cmd/Ctrl + Shift + P**: System Prompt

---

## Tips for best results (especially with fuzzy diffs)

1. **Always use the latest file content**
   - If your file has already changed since the diff was generated, the patch may fail or apply incorrectly.

2. **One file per tab**
   - Avoid mixing diffs and content across files.

3. **If a patch fails**
   - Check you pasted the right file content
   - Try a different System Prompt (looser/stricter)
   - Try a slightly smarter model if needed

4. **Verify with the diff viewer**
   - Treat the diff viewer as your safety net.

5. **Keep a backup**
   - Before overwriting a file, keep the original around (or rely on git status/undo).

---

## Privacy notes

- Your API keys are stored **locally** and **encrypted** with your PIN.
- Your PIN is **not stored** on disk.
- Inputs/outputs and history are stored locally in the app’s storage.

*** End Patch
