const electron = require('electron');

// If launched from an Electron-based IDE terminal that sets ELECTRON_RUN_AS_NODE=1,
// re-spawn with ELECTRON_RUN_AS_NODE removed so Electron initializes its GUI/main process.
// If running --smoke-test in a headless/sandboxed shell where Win32 GUI window stations
// are restricted, fall back to the automated Node verification suite (test-runner.js).
if (typeof electron === 'string') {
  if (process.argv.includes('--smoke-test')) {
    require('./test-runner');
    return;
  }
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, process.argv.slice(1), {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  return;
}

const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  Notification,
  powerMonitor,
  screen,
} = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DailyStore, isAtOrAfterSixAM } = require('./store');
const { createTrayIcon } = require('./tray-icon');
const { WindowMonitor } = require('./window-monitor');
const { VerdictCache } = require('./verdict-cache');
const { TypeSafeClient } = require('./typesafe-client');
const { ScreenOcrSensor } = require('./screen-ocr');
const { GeminiOcrClient } = require('./gemini-client');
const { WindowEvaluator } = require('./window-evaluator');
const {
  APP_USER_MODEL_ID,
  DetectionNotifier,
  ensureWindowsNotificationShortcut,
} = require('./notifier');
const { DebugOverlay } = require('./debug-overlay');
const { DistractionBorderOverlay } = require('./distraction-border');

const isSmokeTest = process.argv.includes('--smoke-test');
const isBackgroundLaunch = process.argv.includes('--background');

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Prevent Chromium disk_cache / gpu_disk_cache "Access is denied (0x5)" errors on Windows
if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
}
if (!isSmokeTest && app && typeof app.setPath === 'function') {
  try {
    app.setPath('sessionData', path.join(os.tmpdir(), `pc-blocker-session-${process.pid}`));
  } catch {}
}

/**
 * Loads KEY=VALUE pairs from a local .env file directly into process.env
 * without overriding variables already set in the parent process environment.
 * @param {string} envFilePath
 */
function loadDotEnv(envFilePath) {
  try {
    if (!fs.existsSync(envFilePath)) return;
    if (!process.env) process.env = {};
    const lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (err) {
    console.error('Failed to load .env file:', err);
  }
}

let mainWindow = null;
let debugOverlay = null;
let distractionBorder = null;
let tray = null;
let store = null;
let verdictCache = null;
let windowEvaluator = null;
let notifier = null;
let windowMonitor = null;
let rolloverInterval = null;
let pendingDestroyTimeout = null;
let allowWindowDestroy = false;
let isQuitting = false;
let promptDismissedDate = null;
let lastCheckAtOrAfterSixAM = null;

// Prevent multiple instances when running normally.
// If launched interactively (e.g. `npm start`) while an older background tray instance is running,
// terminate the stale instance first so the new code starts cleanly without cache/lock conflicts.
if (!isSmokeTest) {
  let gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock && !isBackgroundLaunch && process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(
        'taskkill.exe',
        ['/F', '/FI', `PID ne ${process.pid}`, '/IM', path.basename(process.execPath)],
        { windowsHide: true, stdio: 'ignore', timeout: 4000 }
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    } catch {}
    gotTheLock = app.requestSingleInstanceLock();
  }

  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      } else if (store && !store.isCommittedForToday()) {
        promptDismissedDate = null;
        createTerminalWindow();
      } else if (debugOverlay && store && store.isCommittedForToday()) {
        debugOverlay.ensureWindow();
      }
    });
  }
}

/**
 * Configures auto-launch on Windows startup when user logs into their Windows account.
 */
function getAutoLaunchEnabled() {
  try {
    const args = app.isPackaged ? ['--background'] : [path.resolve(__dirname), '--background'];
    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args,
    });
    return Boolean(settings.openAtLogin);
  } catch {
    return false;
  }
}

function setAutoLaunchEnabled(enabled) {
  try {
    const args = app.isPackaged ? ['--background'] : [path.resolve(__dirname), '--background'];
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args,
    });
  } catch (err) {
    console.error('Failed to update login item settings:', err);
  }
}

/**
 * Builds and updates the Windows System Tray icon, tooltip, and context menu.
 */
function updateTrayMenu() {
  if (!tray || !store) return;

  const state = store.getState();
  const isLocked = state.committed && state.tasks.length > 0;

  tray.setImage(createTrayIcon(isLocked));
  tray.setToolTip(
    isLocked
      ? `PC Blocker — Locked (${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} committed for ${state.dateString})`
      : `PC Blocker — Awaiting Daily Task Commitment (${state.dateString})`
  );

  const taskMenuItems = isLocked
    ? state.tasks.map((task, idx) => ({
        label: `[${idx + 1}] ${task}`,
        enabled: false,
      }))
    : [
        {
          label: 'No tasks committed for today',
          enabled: false,
        },
      ];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `PC BLOCKER — ${isLocked ? 'LOCKED' : 'UNLOCKED'} (${state.dateString})`,
      enabled: false,
    },
    {
      label: isLocked
        ? `Status: Background Monitor Active • ${state.tasks.length} Task(s)`
        : 'Status: Awaiting Daily Commitment (Unlocks Daily at 6:00 AM)',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: "Today's Committed Tasks:",
      enabled: false,
    },
    ...taskMenuItems,
    { type: 'separator' },
    {
      label: 'Launch at Windows Startup',
      type: 'checkbox',
      checked: getAutoLaunchEnabled(),
      click: (menuItem) => {
        setAutoLaunchEnabled(menuItem.checked);
        updateTrayMenu();
      },
    },
    {
      label: 'Add New Tasks / Re-open Terminal UI',
      click: () => {
        createTerminalWindow();
      },
    },
    {
      label: "Reset Today's Tasks (Dev/Test)",
      click: () => {
        promptDismissedDate = null;
        store.resetToday();
        syncEvaluatorWithStore();
        if (windowMonitor) {
          windowMonitor.stop();
        }
        updateTrayMenu();
        createTerminalWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit PC Blocker (Ctrl+Shift+W)',
      accelerator: 'CommandOrControl+Shift+W',
      click: () => {
        quitApplication();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function clearPendingWindowDestroy() {
  if (pendingDestroyTimeout) {
    clearTimeout(pendingDestroyTimeout);
    pendingDestroyTimeout = null;
  }
}

/**
 * Destroys the fullscreen terminal window completely to free 100% of Chromium UI memory.
 */
function destroyTerminalWindow() {
  clearPendingWindowDestroy();
  if (!mainWindow) return;
  allowWindowDestroy = true;
  if (!mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  mainWindow = null;
  allowWindowDestroy = false;
}

/**
 * Fully exits the application, destroying the UI window and stopping all background monitors/timers.
 */
function quitApplication() {
  isQuitting = true;
  allowWindowDestroy = true;
  clearPendingWindowDestroy();
  if (rolloverInterval) {
    clearInterval(rolloverInterval);
    rolloverInterval = null;
  }
  if (windowEvaluator) {
    windowEvaluator.destroy();
  }
  if (windowMonitor) {
    windowMonitor.destroy();
  }
  if (globalShortcut && typeof globalShortcut.unregisterAll === 'function') {
    try {
      globalShortcut.unregisterAll();
    } catch {}
  }
  destroyTerminalWindow();
  if (debugOverlay) {
    debugOverlay.destroy();
    debugOverlay = null;
  }
  if (distractionBorder) {
    distractionBorder.destroy();
    distractionBorder = null;
  }
  if (tray && typeof tray.destroy === 'function') {
    try {
      tray.destroy();
    } catch {}
    tray = null;
  }
  app.quit();
}

function focusTerminalWindow(win) {
  if (!win || win.isDestroyed() || isSmokeTest) return;
  if (typeof win.moveTop === 'function') {
    win.moveTop();
  }
  if (typeof win.focus === 'function') {
    win.focus();
  }
  if (win.webContents && typeof win.webContents.focus === 'function') {
    win.webContents.focus();
  }
}

/**
 * Forces the BrowserWindow to cover 100% of the primary display in fullscreen kiosk mode.
 * Avoids resizable:false / maximizable:false locks that prevent Win32 from expanding
 * a hidden window across scaled DPI displays.
 */
function applyTrueFullscreen(win) {
  if (!win || win.isDestroyed() || isSmokeTest) return;

  const primaryDisplay =
    screen && typeof screen.getPrimaryDisplay === 'function'
      ? screen.getPrimaryDisplay()
      : null;

  if (typeof win.setFullScreenable === 'function') {
    win.setFullScreenable(true);
  }
  if (typeof win.setResizable === 'function') {
    win.setResizable(true);
  }
  if (primaryDisplay && primaryDisplay.bounds && typeof win.setBounds === 'function') {
    win.setBounds({
      x: primaryDisplay.bounds.x,
      y: primaryDisplay.bounds.y,
      width: primaryDisplay.bounds.width,
      height: primaryDisplay.bounds.height,
    });
  }
  if (typeof win.setFullScreen === 'function') {
    win.setFullScreen(true);
  }
  if (typeof win.setKiosk === 'function') {
    win.setKiosk(true);
  }
  win.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * Creates the Fullscreen Takeover CLI BrowserWindow.
 */
function createTerminalWindow() {
  clearPendingWindowDestroy();

  if (mainWindow && !mainWindow.isDestroyed()) {
    applyTrueFullscreen(mainWindow);
    mainWindow.show();
    applyTrueFullscreen(mainWindow);
    focusTerminalWindow(mainWindow);
    return mainWindow;
  }

  allowWindowDestroy = false;

  const primaryDisplay =
    screen && typeof screen.getPrimaryDisplay === 'function'
      ? screen.getPrimaryDisplay()
      : null;
  const bounds =
    primaryDisplay && primaryDisplay.bounds
      ? primaryDisplay.bounds
      : { x: 0, y: 0, width: 1920, height: 1080 };

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreen: !isSmokeTest,
    fullscreenable: true,
    kiosk: !isSmokeTest,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    movable: false,
    minimizable: false,
    closable: false,
    enableLargerThanScreen: true,
    show: false,
    backgroundColor: '#000000',
    title: 'PC Blocker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Highest Always-On-Top z-order level on Windows so it stays above the taskbar
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Intercept and block standard window-closing & escape shortcuts at the main-process level,
  // allow Ctrl+Shift+W to fully quit the application (UI + background daemon),
  // and allow standard clipboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Shift+Insert, Ctrl+Insert)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const isCtrlShiftW = (input.control || input.meta) && input.shift && !input.alt && key === 'w';
    if (isCtrlShiftW) {
      event.preventDefault();
      quitApplication();
      return;
    }

    const isAltF4 = input.alt && key === 'f4';
    const isEscape = key === 'escape';
    const isCtrlW = input.control && !input.shift && key === 'w';
    const isCtrlQ = input.control && key === 'q';
    const isAltSpace = input.alt && (key === ' ' || input.code === 'Space');
    const isF11 = key === 'f11';
    const isDevTools = input.control && input.shift && key === 'i';
    const isReload = (input.control && key === 'r') || key === 'f5';

    if (
      isAltF4 ||
      isEscape ||
      isCtrlW ||
      isCtrlQ ||
      isAltSpace ||
      isF11 ||
      isDevTools ||
      isReload
    ) {
      event.preventDefault();
    }
  });

  // Block OS-level close attempts unless explicitly destroyed after task commitment
  mainWindow.on('close', (event) => {
    if (!allowWindowDestroy && !isQuitting) {
      event.preventDefault();
    }
  });

  // Keep keyboard focus locked to the terminal window while active
  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !allowWindowDestroy && !isSmokeTest) {
      focusTerminalWindow(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (!isSmokeTest) {
    mainWindow.once('ready-to-show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyTrueFullscreen(mainWindow);
        mainWindow.show();
        applyTrueFullscreen(mainWindow);
        focusTerminalWindow(mainWindow);
      }
    });
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        focusTerminalWindow(mainWindow);
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
}

/**
 * Tracks transitions across 6:00 AM and clears any prior prompt dismissal when crossing 6:00 AM.
 */
function syncSixAMBoundary() {
  const now =
    store && typeof store.nowProvider === 'function' ? store.nowProvider() : new Date();
  const nowAtOrAfterSixAM = isAtOrAfterSixAM(now);
  const crossedSixAM = lastCheckAtOrAfterSixAM === false && nowAtOrAfterSixAM === true;
  lastCheckAtOrAfterSixAM = nowAtOrAfterSixAM;
  if (crossedSixAM) {
    promptDismissedDate = null;
  }
  return crossedSixAM;
}

function syncEvaluatorWithStore() {
  if (windowEvaluator) {
    windowEvaluator.cancelPending();
  }
  if (distractionBorder) {
    distractionBorder.hide();
  }
  if (verdictCache && store) {
    const state = store.getState();
    verdictCache.syncActiveTasks(state.dateString, state.tasks);
  }
}

/**
 * Periodically checks whether the system clock crossed midnight (00:00)
 * and whether it reached 6:00 AM to expire the past day's lock, archive tasks,
 * and trigger the Fullscreen Terminal Prompt.
 */
function checkMidnightRollover() {
  if (!store) return;

  syncSixAMBoundary();
  const rolledOver = store.checkAndRolloverDate();
  if (rolledOver) {
    promptDismissedDate = null;
    syncEvaluatorWithStore();
    if (windowMonitor) {
      windowMonitor.stop();
    }
    updateTrayMenu();
  }

  const state = store.getState();
  if (
    store.shouldShowTerminalPrompt() &&
    promptDismissedDate !== state.dateString &&
    (!mainWindow || mainWindow.isDestroyed())
  ) {
    const isSessionLockedOrAsleep =
      windowMonitor && (windowMonitor.isScreenLocked || windowMonitor.isDisplayAsleep);
    if (!isSessionLockedOrAsleep) {
      createTerminalWindow();
    }
  }
}

/**
 * Handles waking or unlocking the PC:
 * - If at/after 6:00 AM and no tasks are locked for today (and not dismissed via exit),
 *   opens Fullscreen Terminal Prompt immediately.
 * - If tasks are already locked for today, skips the terminal screen and resumes silent background monitoring.
 */
function handleSessionWakeOrUnlock(eventType) {
  if (!store) return;

  if (windowMonitor) {
    if (eventType === 'unlock-screen') {
      windowMonitor.handleScreenUnlock();
    } else if (eventType === 'resume') {
      windowMonitor.handleResume();
    }
  }

  syncSixAMBoundary();
  const rolledOver = store.checkAndRolloverDate();
  if (rolledOver) {
    promptDismissedDate = null;
    syncEvaluatorWithStore();
    updateTrayMenu();
  }

  const state = store.getState();
  if (store.isCommittedForToday()) {
    if (windowMonitor && !windowMonitor.isScreenLocked) {
      windowMonitor.start();
    }
  } else if (
    store.shouldShowTerminalPrompt() &&
    promptDismissedDate !== state.dateString
  ) {
    if (windowMonitor) {
      windowMonitor.stop();
    }
    if (!windowMonitor || !windowMonitor.isScreenLocked) {
      createTerminalWindow();
    }
  }
}

/**
 * Runs the automated end-to-end verification suite when launched with --smoke-test.
 */
async function runSmokeTest(tempDir) {
  try {
    // 1. Verify store rollover logic in isolation
    let fakeDate = new Date('2026-11-09T10:00:00');
    const rolloverStore = new DailyStore(
      path.join(tempDir, 'rollover-test'),
      () => fakeDate
    );
    rolloverStore.commitTasksForToday(['Yesterday Task 1']);
    if (!rolloverStore.isCommittedForToday()) {
      throw new Error('Rollover test store should be committed for 2026-11-09');
    }

    // Advance clock to next day
    fakeDate = new Date('2026-11-10T08:00:00');
    const didRollover = rolloverStore.checkAndRolloverDate();
    const afterRolloverState = rolloverStore.getState();
    if (
      !didRollover ||
      rolloverStore.isCommittedForToday() ||
      afterRolloverState.tasks.length !== 0 ||
      !afterRolloverState.history['2026-11-09'] ||
      afterRolloverState.history['2026-11-09'].tasks[0] !== 'Yesterday Task 1'
    ) {
      throw new Error(
        `Date rollover failed: ${JSON.stringify(afterRolloverState)}`
      );
    }

    // 2. Verify fresh boot opens the Terminal UI window
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Terminal window should be created when uncommitted');
    }

    await new Promise((resolve, reject) => {
      mainWindow.webContents.once('did-finish-load', resolve);
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`Failed to load UI (${code}): ${desc}`))
      );
    });

    // Wait briefly for DOMContentLoaded async state initialization
    await new Promise((r) => setTimeout(r, 100));

    // 3. Drive the conversational CLI flow via synthetic keyboard events
    const uiFlowResult = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const dispatchKey = (key, opts = {}) => {
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key,
            code: opts.code || key,
            altKey: Boolean(opts.altKey),
            ctrlKey: Boolean(opts.ctrlKey),
            bubbles: true,
            cancelable: true,
          }));
        };

        const typeString = (str) => {
          for (const ch of str) {
            dispatchKey(ch);
          }
        };

        const initialPrompt = document.getElementById('prompt-label').textContent;

        // Test exit shortcuts do nothing
        dispatchKey('Escape');
        dispatchKey('F4', { altKey: true });
        dispatchKey('w', { ctrlKey: true });

        // Test typing 'done' before any tasks are added (should warn and stay on first task)
        typeString('done');
        dispatchKey('Enter');
        const promptAfterPrematureDone = document.getElementById('prompt-label').textContent;

        // Enter first task
        typeString('Complete system architecture');
        dispatchKey('Enter');
        const secondPrompt = document.getElementById('prompt-label').textContent;

        // Enter second task with Backspace correction
        typeString('Ship background daemonX');
        dispatchKey('Backspace');
        dispatchKey('Enter');
        const thirdPrompt = document.getElementById('prompt-label').textContent;

        // Type 'done' to enter confirmation mode
        typeString('done');
        dispatchKey('Enter');
        const confirmPrompt = document.getElementById('prompt-label').textContent;

        // Press 'R' to re-enter tasks
        dispatchKey('r');
        const promptAfterReset = document.getElementById('prompt-label').textContent;

        // Re-enter two tasks and confirm with Enter
        typeString('Build Fullscreen Terminal UI');
        dispatchKey('Enter');
        typeString('Verify System Tray Daemon');
        dispatchKey('Enter');
        typeString('done');
        dispatchKey('Enter');

        // Confirm commitment with Enter
        dispatchKey('Enter');

        const historyText = document.getElementById('terminal-history').innerText;
        return {
          initialPrompt,
          promptAfterPrematureDone,
          secondPrompt,
          thirdPrompt,
          confirmPrompt,
          promptAfterReset,
          historyText,
        };
      })()
    `);

    if (
      !uiFlowResult.initialPrompt.includes('Enter your first important task for today:') ||
      !uiFlowResult.promptAfterPrematureDone.includes('Enter your first important task for today:') ||
      !uiFlowResult.secondPrompt.includes('Enter your second important task for today') ||
      !uiFlowResult.thirdPrompt.includes('Enter your third important task for today') ||
      !uiFlowResult.confirmPrompt.includes('Confirm and lock your PC for today? Press [ENTER] to commit, or [R] to re-enter tasks.') ||
      !uiFlowResult.promptAfterReset.includes('Enter your first important task for today:') ||
      !uiFlowResult.historyText.includes('[OK] Daily commitment locked. Closing interface and starting background monitor...')
    ) {
      throw new Error(`Unexpected CLI flow state: ${JSON.stringify(uiFlowResult, null, 2)}`);
    }

    // 4. Wait for the 1.5s confirmation pause + window destruction
    await new Promise((r) => setTimeout(r, 1750));

    const openWindowsCount = BrowserWindow.getAllWindows().length;
    const committedToday = store.isCommittedForToday();
    const currentState = store.getState();

    if (
      openWindowsCount !== 0 ||
      !committedToday ||
      currentState.tasks.length !== 2 ||
      currentState.tasks[0] !== 'Build Fullscreen Terminal UI' ||
      currentState.tasks[1] !== 'Verify System Tray Daemon'
    ) {
      throw new Error(
        `Window destruction or task persistence failed: openWindows=${openWindowsCount}, state=${JSON.stringify(currentState)}`
      );
    }

    console.log(
      'Smoke test passed:',
      JSON.stringify(
        {
          openWindowsAfterCommit: openWindowsCount,
          committedToday,
          tasks: currentState.tasks,
          rolloverVerified: true,
        },
        null,
        2
      )
    );

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    isQuitting = true;
    app.exit(0);
  } catch (error) {
    console.error('Smoke test failed:', error);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    app.exit(1);
  }
}

app.whenReady().then(() => {
  loadDotEnv(path.join(__dirname, '.env'));

  const storageDir = isSmokeTest
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'pc-blocker-test-'))
    : app.getPath('userData');

  store = new DailyStore(storageDir);
  verdictCache = new VerdictCache(storageDir, store.nowProvider);
  const initialState = store.getState();
  verdictCache.syncActiveTasks(initialState.dateString, initialState.tasks);

  notifier = new DetectionNotifier({
    NotificationClass: Notification,
    getTray: () => tray,
    isSmokeTest,
  });

  debugOverlay = new DebugOverlay({
    BrowserWindowClass: BrowserWindow,
    screenModule: screen,
    isSmokeTest,
  });

  distractionBorder = new DistractionBorderOverlay({
    BrowserWindowClass: BrowserWindow,
    screenModule: screen,
    isSmokeTest,
  });

  const getActiveTasksList = () => {
    try {
      return store ? [...store.getState().tasks] : [];
    } catch {
      return [];
    }
  };

  const typeSafeClient = new TypeSafeClient();
  const screenOcr = new ScreenOcrSensor({
    beforeCapture: async () => {
      if (debugOverlay) {
        debugOverlay.hideForOcrCapture();
      }
      if (distractionBorder) {
        distractionBorder.hideForOcrCapture();
      }
      if (debugOverlay || distractionBorder) {
        await new Promise((r) => setTimeout(r, 45));
      }
    },
    afterCapture: () => {
      if (debugOverlay) {
        debugOverlay.restoreAfterOcrCapture();
      }
      if (distractionBorder) {
        distractionBorder.restoreAfterOcrCapture();
      }
    },
  });
  const geminiClient = new GeminiOcrClient();

  windowEvaluator = new WindowEvaluator({
    verdictCache,
    typeSafeClient,
    screenOcr,
    geminiClient,
    autoEscalate: true,
    useCache: false,
    getActiveTasks: () => {
      const s = store.getState();
      return { dateString: s.dateString, tasks: s.tasks };
    },
    onVerdict: (event) => {
      if (notifier && event?.status !== 'EVALUATING') {
        notifier.notify(event);
      }
      if (debugOverlay) {
        const activeTasks = getActiveTasksList();
        debugOverlay.update({
          ...event,
          tasks: activeTasks,
          tasksCount: activeTasks.length,
        });
      }
      if (distractionBorder) {
        distractionBorder.updateForVerdict(event);
      }
    },
  });

  windowMonitor = new WindowMonitor({
    onSafeWindowDetected: (result) => {
      if (distractionBorder) {
        distractionBorder.hide();
      }
      if (windowEvaluator) {
        const emitted = windowEvaluator.handleSafeWindow(result);
        // Also update the live overlay for OS_ESSENTIAL windows where notifications are silent
        if (!emitted && debugOverlay && result && result.sample) {
          const activeTasks = getActiveTasksList();
          debugOverlay.update({
            gate: 'GATE_0_WHITELIST',
            status: 'GATE_0_ALLOW',
            decision: 'ALLOWED',
            category: result?.classification?.category || 'OS_ESSENTIAL',
            latencyMs: 0,
            sample: result.sample,
            tasks: activeTasks,
            tasksCount: activeTasks.length,
          });
        }
      }
    },
    onEvaluationReady: (result) => {
      if (distractionBorder) {
        distractionBorder.hide();
      }
      if (debugOverlay && result && result.sample) {
        const activeTasks = getActiveTasksList();
        debugOverlay.update({
          gate: 'GATE_2_TYPESAFE_AI',
          status: 'EVALUATING',
          decision: 'EVALUATING',
          choice: 'evaluating...',
          sample: result.sample,
          tasks: activeTasks,
          tasksCount: activeTasks.length,
        });
      }
      if (windowEvaluator) {
        windowEvaluator.handleEvaluationWindow(result).catch((err) => {
          console.error('Window evaluation error:', err);
        });
      }
    },
    onSameWindowPoll: (tickInfo) => {
      if (windowEvaluator) {
        windowEvaluator.handleSameWindowTick(tickInfo).catch((err) => {
          console.error('Ambiguous re-evaluation error:', err);
        });
      }
    },
  });

  lastCheckAtOrAfterSixAM = isAtOrAfterSixAM(
    typeof store.nowProvider === 'function' ? store.nowProvider() : new Date()
  );

  // (a) Register application with Windows to launch automatically in the background on login
  if (!isSmokeTest && !getAutoLaunchEnabled()) {
    setAutoLaunchEnabled(true);
  }

  // Register Windows Start Menu AUMID shortcut in background so dev Toast pop-ups display reliably
  if (!isSmokeTest) {
    ensureWindowsNotificationShortcut({
      appUserModelId: APP_USER_MODEL_ID,
      exePath: process.execPath,
      appArgs: app.isPackaged ? '' : path.resolve(__dirname),
    }).catch(() => {});
  }

  // Initialize Windows System Tray icon and menu
  tray = new Tray(createTrayIcon(store.isCommittedForToday()));
  updateTrayMenu();

  // IPC Handlers
  ipcMain.handle('tasks:get-state', () => store.getState());

  const readClipboard = () =>
    clipboard && typeof clipboard.readText === 'function' ? clipboard.readText() : '';
  const writeClipboard = (text) => {
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(String(text ?? ''));
    }
    return true;
  };

  ipcMain.handle('clipboard:read-text', () => readClipboard());
  ipcMain.handle('clipboard:write-text', (_event, text) => writeClipboard(text));

  ipcMain.handle('overlay:run-jev-ocr', async () => {
    if (!windowEvaluator) {
      return { ok: false, error: 'WindowEvaluator is not initialized.' };
    }
    const result = await windowEvaluator.evaluateCurrentWithJevOcr({
      fallbackSample: windowMonitor ? windowMonitor.lastSample : null,
      fallbackBreadcrumbs: windowMonitor ? windowMonitor.getBreadcrumbs() : [],
    });
    if (result && result.ok && debugOverlay) {
      debugOverlay.update({
        ...result,
        viewMode: 'jev_ocr',
      });
    }
    if (result && result.ok && distractionBorder) {
      distractionBorder.updateForVerdict(result.jevOcrVerdict);
    }
    return result;
  });

  ipcMain.handle('overlay:run-gemini-ocr', async () => {
    if (!windowEvaluator) {
      return { ok: false, error: 'WindowEvaluator is not initialized.' };
    }
    const result = await windowEvaluator.evaluateCurrentWithGeminiOcr({
      fallbackSample: windowMonitor ? windowMonitor.lastSample : null,
      fallbackBreadcrumbs: windowMonitor ? windowMonitor.getBreadcrumbs() : [],
    });
    if (result && result.ok && debugOverlay) {
      debugOverlay.update({
        ...result,
        viewMode: 'gemini',
      });
    }
    if (result && result.ok && distractionBorder) {
      distractionBorder.updateForVerdict(result.geminiVerdict);
    }
    return result;
  });

  ipcMain.handle('overlay:resize', (_event, height) => {
    if (debugOverlay) {
      debugOverlay.setHeight(height);
    }
    return true;
  });

  if (typeof ipcMain.on === 'function') {
    ipcMain.on('clipboard:read-text', (event) => {
      event.returnValue = readClipboard();
    });
    ipcMain.on('clipboard:write-text', (event, text) => {
      event.returnValue = writeClipboard(text);
    });
  }

  ipcMain.handle('tasks:commit', async (_event, tasks) => {
    promptDismissedDate = null;
    const updatedState = store.commitTasksForToday(tasks);
    syncEvaluatorWithStore();
    updateTrayMenu();
    if (windowMonitor) {
      windowMonitor.start();
    }

    // Pause for 1.5 seconds so the user can read the [OK] confirmation line,
    // then completely destroy the BrowserWindow to free all renderer memory.
    clearPendingWindowDestroy();
    pendingDestroyTimeout = setTimeout(() => {
      pendingDestroyTimeout = null;
      destroyTerminalWindow();
      if (debugOverlay) {
        debugOverlay.ensureWindow();
      }
    }, 1500);

    return updatedState;
  });

  ipcMain.handle('tasks:add', async (_event, newTasks) => {
    promptDismissedDate = null;
    const updatedState = store.addTasksForToday(newTasks);
    syncEvaluatorWithStore();
    updateTrayMenu();
    if (windowMonitor && store.isCommittedForToday()) {
      windowMonitor.start();
    }
    return updatedState;
  });

  ipcMain.handle('terminal:exit', async (_event, pendingTasks) => {
    if (store && Array.isArray(pendingTasks) && pendingTasks.length > 0) {
      promptDismissedDate = null;
      store.commitTasksForToday(pendingTasks);
      syncEvaluatorWithStore();
      updateTrayMenu();
    } else if (store) {
      promptDismissedDate = store.getState().dateString;
    }
    if (windowMonitor && store && store.isCommittedForToday()) {
      windowMonitor.start();
    }
    clearPendingWindowDestroy();
    pendingDestroyTimeout = setTimeout(() => {
      pendingDestroyTimeout = null;
      destroyTerminalWindow();
      if (debugOverlay && store && store.isCommittedForToday()) {
        debugOverlay.ensureWindow();
      }
    }, 300);
    return { exited: true };
  });

  ipcMain.handle('app:quit', async () => {
    quitApplication();
    return { quitting: true };
  });

  if (!isSmokeTest && globalShortcut && typeof globalShortcut.register === 'function') {
    try {
      globalShortcut.register('CommandOrControl+Shift+W', () => {
        quitApplication();
      });
    } catch (err) {
      console.error('Failed to register global quit shortcut:', err);
    }
    try {
      globalShortcut.register('CommandOrControl+Shift+S', () => {
        if (distractionBorder) {
          distractionBorder.toggleBannerText();
        }
      });
    } catch (err) {
      console.error('Failed to register distraction info toggle shortcut:', err);
    }
  }

  // (b) & (c) Check if tasks are already locked for today's date:
  // - If locked, skip terminal screen and resume silent background monitoring immediately.
  // - If unlocked and at or after 6:00 AM, open Fullscreen Terminal Prompt immediately.
  if (store.isCommittedForToday()) {
    if (debugOverlay) {
      debugOverlay.ensureWindow();
    }
    windowMonitor.start();
  } else if (store.shouldShowTerminalPrompt()) {
    createTerminalWindow();
  }

  // (d) & (e) Continuous background clock check for midnight (00:00) crossing & 6:00 AM unlock
  rolloverInterval = setInterval(checkMidnightRollover, 15 * 1000);

  // (g) Pause polling when Windows screen is locked or display is asleep; resume on unlock/wake
  powerMonitor.on('lock-screen', () => {
    if (windowEvaluator) {
      windowEvaluator.cancelPending();
    }
    if (distractionBorder) {
      distractionBorder.hide();
    }
    if (windowMonitor) {
      windowMonitor.handleScreenLock();
    }
  });

  powerMonitor.on('suspend', () => {
    if (windowEvaluator) {
      windowEvaluator.cancelPending();
    }
    if (distractionBorder) {
      distractionBorder.hide();
    }
    if (windowMonitor) {
      windowMonitor.handleSuspend();
    }
  });

  powerMonitor.on('unlock-screen', () => {
    handleSessionWakeOrUnlock('unlock-screen');
  });

  powerMonitor.on('resume', () => {
    handleSessionWakeOrUnlock('resume');
  });

  if (isSmokeTest) {
    runSmokeTest(storageDir);
  }
});

// Keep the background daemon alive when the UI window is destroyed
app.on('window-all-closed', () => {
  // Intentionally empty: closing/destroying the UI window must NOT quit the app.
  // The core background process remains active in the Windows System Tray.
});