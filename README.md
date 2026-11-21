# PC Blocker

**PC Blocker** is a lightweight Windows desktop utility that forces you to commit to your core daily tasks when you first open your PC, then runs silently in the Windows System Tray for the rest of the day with zero UI memory footprint.

## Features

- **Fullscreen CLI Takeover**: Opens as a frameless, kiosk-mode, always-on-top (`screen-saver` z-order) terminal window with no title bar, window borders, or taskbar visibility.
- **Exit Shortcut Blocking**: Intercepts and disables `Alt+F4`, `Escape`, `Ctrl+W`, `Alt+Space`, `Ctrl+Q`, and `F11` until daily tasks are committed.
- **Zero-Mouse Terminal Flow**: Pure pitch-black (`#000000`) interface with high-contrast terminal green (`#00FF41`) and bright white (`#FFFFFF`) monospace text, driven strictly by `Enter`, `Backspace`, and character keys.
- **Complete UI Memory Cleanup**: After confirming your daily tasks (`[ENTER]`), the terminal displays `[OK] Daily commitment locked. Closing interface and starting background monitor...` for 1.5 seconds, updates the System Tray menu, and calls `mainWindow.destroy()` to free 100% of Chromium renderer memory.
- **Daily Persistence, Midnight Detection & 6:00 AM Unlock**: Stores committed tasks per calendar date (`YYYY-MM-DD`). Periodically monitors the system clock across midnight (`00:00`) and automatically expires the previous day's lock at **6:00 AM**, archiving past tasks and unlocking the status. Waking or restarting on the same day after locking skips the UI and resumes silent background monitoring.
- **Add New Tasks Anytime**: Users can reopen the Fullscreen Terminal Prompt whenever they want to append additional tasks to their locked daily commitment.
- **2-Second Foreground Window Monitor & Breadcrumb Trail**: Captures the active foreground window (`windowTitle`, `processName`, `timestamp`) every 2 seconds, automatically pauses when the screen is locked or asleep, skips consecutive duplicate checks, and maintains a rolling list of the last 5 distinct visited windows (oldest to newest).
- **Fast Local Pre-Filter Engine**: Automatically approves OS essentials (`explorer.exe`, Windows Search, Start Menu, System Settings, Alt+Tab, PC Blocker), password managers & credential prompts, dedicated work applications (code editors, terminals, local database tools, design software), and neutral browser utilities (blank new tabs, downloads/settings, standard login redirects).
- **Windows System Tray Daemon**: Shows current lock status, date header, today's committed tasks, Windows Startup auto-launch toggle, and `Add New Tasks / Re-open Terminal UI`.

## Project Structure

- `main.js` — Electron main process: Windows login auto-registration, fullscreen lockdown, shortcut blocker, IPC handlers, System Tray daemon, 6:00 AM rollover monitor, and power/lock session hooks.
- `store.js` — Local daily JSON persistence (`daily-commitment.json`), midnight crossing detection, 6:00 AM unlock archiving, and anytime task additions.
- `window-monitor.js` — 2-second Win32 foreground window poller, consecutive duplicate skipper, 5-slot rolling breadcrumb tracker, and 4-category pre-filter allowlist engine.
- `tray-icon.js` — Programmatic 16×16 BGRA bitmap icon generator for the Windows System Tray.
- `preload.js` — Context-isolated IPC bridge exposing `window.pcBlocker`.
- `index.html`, `styles.css`, `renderer.js` — Fullscreen terminal wizard and keyboard-only state machine.

## Run Locally on Windows

```powershell
npm start
```

## Run Automated Smoke Test

```powershell
npm test
```
