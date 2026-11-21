const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DailyStore } = require('./store');
const {
  WindowMonitor,
  classifyWindow,
  detectIncognitoFromTitle,
  CATEGORIES,
  POLL_INTERVAL_MS,
  MAX_BREADCRUMBS,
} = require('./window-monitor');
const {
  VerdictCache,
  normalizeWindowTitle,
  buildCompositeCacheKey,
} = require('./verdict-cache');
const {
  TYPESAFE_ENDPOINT,
  TYPESAFE_MODEL,
  CHOICE_KEYS,
  buildSystemOnePayload,
  TypeSafeClient,
} = require('./typesafe-client');
const {
  DISTRACTION_BLOCK_THRESHOLD,
  AMBIGUOUS_ALLOW_MAX_DISTRACTION_PROB,
  AMBIGUOUS_WAIT_POLL_CYCLES,
  WindowEvaluator,
} = require('./window-evaluator');
const {
  DetectionNotifier,
  formatDetectionNotification,
  buildUrgentToastXml,
} = require('./notifier');
const {
  ScreenOcrSensor,
  cleanOcrText,
} = require('./screen-ocr');
const {
  GEMINI_MODEL,
  GEMINI_THINKING_LEVEL,
  GEMINI_OCR_RESPONSE_SCHEMA,
  buildGeminiInteractionRequest,
  parseGeminiInteractionOutput,
  GeminiOcrClient,
} = require('./gemini-client');
const {
  buildOverlayHtml,
} = require('./debug-overlay');
const {
  shouldShowDistractionBorder,
  formatDistractionStepLabel,
  buildDistractionBorderHtml,
  DistractionBorderOverlay,
} = require('./distraction-border');

async function runVerificationSuite() {
  console.log('=== PC Blocker Automated Verification Suite ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-blocker-verify-'));

  try {
    // -------------------------------------------------------------------------
    // 1. Verify DailyStore Persistence, Same-Day Check & Midnight Date Rollover
    // -------------------------------------------------------------------------
    let clock = new Date('2026-11-10T08:30:00');
    const storeDir = path.join(tempDir, 'userData');
    const store = new DailyStore(storeDir, () => clock);

    assert.equal(store.isCommittedForToday(), false, 'Fresh store should not be committed');
    assert.equal(store.getState().dateString, '2026-11-10');

    // Commit tasks for 2026-11-10
    store.commitTasksForToday(['Finish core backend architecture', 'Write documentation']);
    assert.equal(store.isCommittedForToday(), true, 'Store should be committed after commitTasksForToday');
    assert.deepEqual(store.getState().tasks, [
      'Finish core backend architecture',
      'Write documentation',
    ]);

    // Simulate restarting the app later on the same calendar day (2026-11-10)
    clock = new Date('2026-11-10T16:45:00');
    const restartedStoreSameDay = new DailyStore(storeDir, () => clock);
    assert.equal(
      restartedStoreSameDay.isCommittedForToday(),
      true,
      'Restarting on the same calendar date must preserve committed state and skip UI'
    );
    assert.equal(restartedStoreSameDay.getState().tasks.length, 2);

    // Simulate system date rolling over to the next morning (2026-11-11)
    clock = new Date('2026-11-11T09:00:00');
    const rolledOver = restartedStoreSameDay.checkAndRolloverDate();
    assert.equal(rolledOver, true, 'checkAndRolloverDate should return true on new day');
    assert.equal(
      restartedStoreSameDay.isCommittedForToday(),
      false,
      'New day rollover must reset commitment lock state'
    );

    const stateAfterRollover = restartedStoreSameDay.getState();
    assert.equal(stateAfterRollover.dateString, '2026-11-11');
    assert.equal(stateAfterRollover.tasks.length, 0);
    assert.ok(
      stateAfterRollover.history['2026-11-10'],
      'Previous day tasks must be archived in history'
    );
    assert.deepEqual(stateAfterRollover.history['2026-11-10'].tasks, [
      'Finish core backend architecture',
      'Write documentation',
    ]);
    console.log('[PASS] 1. DailyStore persistence, same-day check, and midnight date rollover');

    // -------------------------------------------------------------------------
    // 2. Verify Programmatic System Tray Icon Generation (tray-icon.js)
    // -------------------------------------------------------------------------
    let capturedBitmap = null;
    let capturedDimensions = null;
    const trayIconSandbox = {
      require: (mod) => {
        if (mod === 'electron') {
          return {
            nativeImage: {
              createFromBitmap: (buf, dims) => {
                capturedBitmap = buf;
                capturedDimensions = dims;
                return { isEmpty: () => false, getSize: () => dims };
              },
            },
          };
        }
        return require(mod);
      },
      Buffer,
      module: { exports: {} },
      exports: {},
    };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, 'tray-icon.js'), 'utf8'),
      trayIconSandbox
    );
    const { createTrayIcon } = trayIconSandbox.module.exports;
    const icon = createTrayIcon(true);
    assert.equal(icon.isEmpty(), false);
    assert.equal(capturedDimensions.width, 16);
    assert.equal(capturedDimensions.height, 16);
    assert.equal(capturedBitmap.length, 16 * 16 * 4, 'Tray icon bitmap must be 16x16 BGRA');
    // Check top-left corner pixel is pure black (#000000 -> BGRA 0,0,0,255)
    assert.deepEqual([...capturedBitmap.slice(0, 4)], [0x00, 0x00, 0x00, 0xff]);
    // Check border pixel (1,1) is terminal green (#00FF41 -> BGRA 0x41, 0xFF, 0x00, 0xFF)
    const pixel11Offset = (1 * 16 + 1) * 4;
    assert.deepEqual(
      [...capturedBitmap.slice(pixel11Offset, pixel11Offset + 4)],
      [0x41, 0xff, 0x00, 0xff]
    );
    console.log('[PASS] 2. Programmatic Windows System Tray icon generation (16x16 BGRA)');

    // -------------------------------------------------------------------------
    // 3. Verify HTML & CSS Terminal Aesthetics Specification
    // -------------------------------------------------------------------------
    const htmlContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const cssContent = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    const mainContent = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

    assert.ok(cssContent.includes('#000000'), 'CSS must use pitch-black #000000 background');
    assert.ok(
      cssContent.toLowerCase().includes('#00ff41'),
      'CSS must use high-contrast terminal green #00FF41'
    );
    assert.ok(cssContent.includes('font-size: 14px'), 'CSS must use compact 14px terminal font');
    assert.ok(cssContent.includes('cursor: default'), 'CSS must enable mouse cursor in UI');
    assert.ok(cssContent.includes('user-select: text'), 'CSS must allow text selection in UI');
    assert.ok(
      htmlContent.includes('Enter your first important task for today:'),
      'HTML must display initial task prompt'
    );
    assert.ok(
      htmlContent.includes('prompt-question-row') && htmlContent.includes('prompt-input-row'),
      'HTML must structure active prompt in two rows (question row + indented input row)'
    );
    assert.ok(
      mainContent.includes("setAlwaysOnTop(true, 'screen-saver')"),
      'main.js must lock window Always-On-Top with screen-saver level'
    );
    assert.ok(
      mainContent.includes('skipTaskbar: true') && mainContent.includes('frame: false'),
      'main.js must hide title bar, borders, and taskbar icon'
    );
    assert.ok(
      mainContent.includes('mainWindow.destroy()'),
      'main.js must completely destroy the BrowserWindow to free memory'
    );
    console.log('[PASS] 3. Fullscreen lockdown, pitch-black #000000 + #00FF41 CSS, and destroy() configuration');

    // -------------------------------------------------------------------------
    // 4. Verify Conversational CLI Flow & Keyboard State Machine (renderer.js)
    // -------------------------------------------------------------------------
    const elements = {
      'header-date': { textContent: '', classList: createClassList() },
      'terminal-history': {
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
        get innerText() {
          return this.children.map((c) => c.textContent).join('\n');
        },
      },
      'active-line': { textContent: '', classList: createClassList() },
      'prompt-label': { textContent: '', classList: createClassList() },
      'typed-input': { textContent: '', classList: createClassList() },
      'typed-input-after': { textContent: '', classList: createClassList() },
      'terminal-screen': { scrollTop: 0, scrollHeight: 500 },
    };

    function createClassList() {
      const set = new Set();
      return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
      };
    }

    const windowListeners = {};
    let committedTasksPayload = null;
    let exitTerminalCalled = false;
    let quitAppCalled = false;
    let simulatedClipboardText = '';

    const rendererSandbox = {
      window: {
        addEventListener: (evt, handler) => {
          windowListeners[evt] = windowListeners[evt] || [];
          windowListeners[evt].push(handler);
        },
        pcBlocker: {
          getInitialState: async () => restartedStoreSameDay.getState(),
          commitTasks: async (tasks) => {
            committedTasksPayload = [...tasks];
            return restartedStoreSameDay.commitTasksForToday(tasks);
          },
          exitTerminal: async () => {
            exitTerminalCalled = true;
            return { exited: true };
          },
          quitApp: async () => {
            quitAppCalled = true;
            return { quitting: true };
          },
          readClipboardText: () => simulatedClipboardText,
          writeClipboardText: (text) => {
            simulatedClipboardText = String(text ?? '');
            return true;
          },
        },
      },
      document: {
        getElementById: (id) => elements[id],
        createElement: (tag) => ({
          tagName: tag.toUpperCase(),
          className: '',
          children: [],
          _text: '',
          appendChild(child) {
            this.children.push(child);
          },
          set textContent(val) {
            this._text = val;
          },
          get textContent() {
            if (this.children.length > 0) {
              return this.children.map((c) => c.textContent).join('');
            }
            return this._text;
          },
        }),
      },
      console,
    };

    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8'),
      rendererSandbox
    );

    // Trigger DOMContentLoaded
    for (const handler of windowListeners['DOMContentLoaded'] || []) {
      await handler();
    }

    function sendKey(key, extra = {}) {
      let defaultPrevented = false;
      const event = {
        key,
        code: extra.code || key,
        altKey: Boolean(extra.altKey),
        ctrlKey: Boolean(extra.ctrlKey),
        shiftKey: Boolean(extra.shiftKey),
        metaKey: Boolean(extra.metaKey),
        preventDefault: () => {
          defaultPrevented = true;
        },
        stopPropagation: () => {},
      };
      for (const handler of windowListeners['keydown'] || []) {
        handler(event);
      }
      return defaultPrevented;
    }

    function typeText(text) {
      for (const ch of text) {
        sendKey(ch);
      }
    }

    // Verify greeting date populated
    assert.ok(
      elements['header-date'].textContent.includes('2026-11-11'),
      'Header must display current date'
    );

    // Verify initial prompt
    assert.equal(
      elements['prompt-label'].textContent,
      'Enter your first important task for today:'
    );

    // Verify exit shortcuts are intercepted and prevented
    assert.equal(sendKey('Escape'), true, 'Escape must be intercepted');
    assert.equal(sendKey('F4', { altKey: true }), true, 'Alt+F4 must be intercepted');
    assert.equal(sendKey('w', { ctrlKey: true }), true, 'Ctrl+W must be intercepted');
    assert.equal(sendKey(' ', { altKey: true, code: 'Space' }), true, 'Alt+Space must be intercepted');

    // Verify Ctrl+Shift+W triggers full application exit (quitApp)
    assert.equal(sendKey('W', { ctrlKey: true, shiftKey: true }), true, 'Ctrl+Shift+W must be handled');
    assert.equal(quitAppCalled, true, 'Ctrl+Shift+W must invoke pcBlocker.quitApp()');

    // Verify typing 'done' before any task is rejected
    typeText('done');
    sendKey('Enter');
    assert.equal(
      elements['prompt-label'].textContent,
      'Enter your first important task for today:',
      'Typing done with 0 tasks must stay on first task prompt'
    );

    // Enter 1st task
    typeText('Ship PC Blocker UI');
    sendKey('Enter');
    assert.equal(
      elements['prompt-label'].textContent,
      "Enter your second important task for today (or type 'done' / 'exit'):"
    );

    // Enter 2nd task using Backspace to fix a typo and ArrowLeft/ArrowRight to edit mid-string
    typeText('Test TrayX');
    sendKey('Backspace');
    assert.equal(elements['typed-input'].textContent, 'Test Tray');
    // Move cursor 4 characters left (before 'Tray'), insert 'System ', then move right to end
    for (let i = 0; i < 4; i++) {
      sendKey('ArrowLeft');
    }
    assert.equal(elements['typed-input'].textContent, 'Test ');
    assert.equal(elements['typed-input-after'].textContent, 'Tray');
    typeText('System ');
    for (let i = 0; i < 4; i++) {
      sendKey('ArrowRight');
    }
    assert.equal(elements['typed-input'].textContent, 'Test System Tray');
    assert.equal(elements['typed-input-after'].textContent, '');

    // Verify Ctrl+C copies current typed input to clipboard
    sendKey('c', { ctrlKey: true });
    assert.equal(simulatedClipboardText, 'Test System Tray', 'Ctrl+C must copy typed task to clipboard');

    sendKey('Enter');
    assert.equal(
      elements['prompt-label'].textContent,
      "Enter your third important task for today (or type 'done' / 'exit'):"
    );

    // Verify Ctrl+V pastes a long multi-line task into the active prompt
    simulatedClipboardText =
      'Complete comprehensive system architecture documentation\r\nand verify end-to-end TypeSafe AI classification pipeline';
    sendKey('v', { ctrlKey: true });
    assert.equal(
      elements['typed-input'].textContent,
      'Complete comprehensive system architecture documentation and verify end-to-end TypeSafe AI classification pipeline',
      'Ctrl+V must paste and normalize long tasks into the active prompt'
    );
    sendKey('Enter');
    assert.equal(
      elements['prompt-label'].textContent,
      "Enter your fourth important task for today (or type 'done' / 'exit'):"
    );

    // Type 'done' to move to confirmation step
    typeText('done');
    sendKey('Enter');
    assert.equal(
      elements['prompt-label'].textContent,
      'Confirm and lock your PC for today? Press [ENTER] to commit, or [R] to re-enter tasks.'
    );

    // Press 'R' to re-enter tasks
    sendKey('r');
    assert.equal(
      elements['prompt-label'].textContent,
      'Enter your first important task for today:',
      'Pressing [R] must clear tasks and restart at first task prompt'
    );

    // Enter final tasks and confirm with [ENTER]
    typeText('Complete Deep Work Session');
    sendKey('Enter');
    typeText('Review Daily Architecture');
    sendKey('Enter');
    typeText('done');
    sendKey('Enter');

    // Press [ENTER] to commit and lock
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      elements['terminal-history'].innerText.includes(
        '[OK] Daily commitment locked. Closing interface and starting background monitor...'
      ),
      'Terminal must print the exact [OK] confirmation line'
    );
    assert.equal(
      elements['active-line'].classList.contains('hidden'),
      true,
      'Active prompt line must be hidden after locking'
    );
    assert.deepEqual(committedTasksPayload, [
      'Complete Deep Work Session',
      'Review Daily Architecture',
    ]);
    assert.equal(restartedStoreSameDay.isCommittedForToday(), true);
    console.log('[PASS] 4. Conversational CLI flow, ordinal prompts, [R] reset, and [ENTER] lock commitment');

    // -------------------------------------------------------------------------
    // 5. Verify Main Process Lifecycle, 1.5s Delay, Window Destroy & Tray Menu
    // -------------------------------------------------------------------------
    const mainTestDir = path.join(tempDir, 'main-lifecycle');
    fs.mkdirSync(mainTestDir, { recursive: true });

    function runMainProcessSimulation(simOptions = {}) {
      let readyCallback = null;
      const appEvents = {};
      const ipcHandlers = {};
      const createdWindows = [];
      let lastTrayMenuTemplate = null;
      let lastTrayTooltip = '';
      let quitCalled = false;
      const scheduledTimeouts = [];
      const scheduledIntervals = [];
      const simStorageDir = simOptions.storageDir || mainTestDir;
      const storeModule = require('./store');

      class MockBrowserWindow {
        constructor(opts) {
          this.options = opts;
          this.destroyed = false;
          this.alwaysOnTopLevel = null;
          this.events = {};
          this.webContentsEvents = {};
          this.webContents = {
            setWindowOpenHandler: () => {},
            on: (evt, fn) => {
              this.webContentsEvents[evt] = fn;
            },
            once: () => {},
          };
          createdWindows.push(this);
        }
        setAlwaysOnTop(flag, level) {
          this.alwaysOnTopLevel = { flag, level };
        }
        setMenuBarVisibility() {}
        on(evt, fn) {
          this.events[evt] = fn;
        }
        once(evt, fn) {
          this.events[evt] = fn;
        }
        loadFile() {}
        show() {}
        moveTop() {}
        focus() {}
        isDestroyed() {
          return this.destroyed;
        }
        destroy() {
          this.destroyed = true;
          if (this.events['closed']) this.events['closed']();
        }
      }

      let loginItemRegistered = null;
      const powerMonitorEvents = {};

      const mockElectron = {
        app: {
          isPackaged: false,
          setAppUserModelId: () => {},
          requestSingleInstanceLock: () => true,
          on: (evt, fn) => {
            appEvents[evt] = fn;
          },
          whenReady: () => ({
            then: (fn) => {
              readyCallback = fn;
            },
          }),
          getPath: () => simStorageDir,
          getLoginItemSettings: () => ({ openAtLogin: false }),
          setLoginItemSettings: (settings) => {
            loginItemRegistered = settings;
          },
          quit: () => {
            quitCalled = true;
          },
        },
        BrowserWindow: MockBrowserWindow,
        clipboard: {
          _text: '',
          readText() {
            return this._text;
          },
          writeText(val) {
            this._text = String(val ?? '');
          },
        },
        ipcMain: {
          handle: (channel, fn) => {
            ipcHandlers[channel] = fn;
          },
          on: (channel, fn) => {
            ipcHandlers[`on:${channel}`] = fn;
          },
        },
        Tray: class {
          setImage() {}
          setToolTip(t) {
            lastTrayTooltip = t;
          }
          setContextMenu(m) {
            lastTrayMenuTemplate = m;
          }
          displayBalloon() {}
        },
        Menu: {
          buildFromTemplate: (tpl) => tpl,
        },
        Notification: class {
          static isSupported() {
            return true;
          }
          once() {}
          show() {}
        },
        powerMonitor: {
          on: (evt, fn) => {
            powerMonitorEvents[evt] = fn;
          },
        },
        nativeImage: {
          createFromBitmap: () => ({}),
        },
      };

      const mainSandbox = {
        require: (mod) => {
          if (mod === 'electron') return mockElectron;
          if (mod === './store') {
            if (simOptions.nowProvider) {
              return {
                ...storeModule,
                DailyStore: class extends storeModule.DailyStore {
                  constructor(dir) {
                    super(dir, simOptions.nowProvider);
                  }
                },
              };
            }
            return storeModule;
          }
          if (mod === './tray-icon') return { createTrayIcon: () => ({}) };
          if (mod === './notifier') {
            return {
              APP_USER_MODEL_ID: 'com.pcblocker.app',
              DetectionNotifier: class {
                notify() {}
              },
              ensureWindowsNotificationShortcut: async () => false,
            };
          }
          if (mod === './window-monitor') {
            return {
              WindowMonitor: class {
                constructor() {
                  this.isScreenLocked = false;
                  this.isDisplayAsleep = false;
                }
                start() {}
                stop() {}
                destroy() {}
                handleScreenLock() {
                  this.isScreenLocked = true;
                }
                handleScreenUnlock() {
                  this.isScreenLocked = false;
                }
                handleSuspend() {
                  this.isDisplayAsleep = true;
                }
                handleResume() {
                  this.isDisplayAsleep = false;
                }
              },
            };
          }
          return require(mod);
        },
        process: {
          platform: 'win32',
          argv: ['electron', '.'],
          execPath: 'electron.exe',
          env: {},
        },
        __dirname,
        setTimeout: (fn, ms) => {
          const entry = { fn, ms, cleared: false };
          scheduledTimeouts.push(entry);
          return entry;
        },
        clearTimeout: (entry) => {
          if (entry && typeof entry === 'object') {
            entry.cleared = true;
          }
        },
        setInterval: (fn, ms) => {
          const entry = { fn, ms };
          scheduledIntervals.push(entry);
          return entry;
        },
        clearInterval: () => {},
        console,
      };

      const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
      vm.runInNewContext(`(function() {\n${mainSource}\n})()`, mainSandbox);
      readyCallback();

      return {
        appEvents,
        ipcHandlers,
        createdWindows,
        getTrayMenu: () => lastTrayMenuTemplate,
        getTrayTooltip: () => lastTrayTooltip,
        isQuitCalled: () => quitCalled,
        getLoginItemRegistered: () => loginItemRegistered,
        powerMonitorEvents,
        scheduledTimeouts,
        scheduledIntervals,
      };
    }

    // Boot 1: Fresh day (uncommitted) -> UI window must open & auto-launch registered
    const boot1 = runMainProcessSimulation();
    assert.ok(
      boot1.getLoginItemRegistered() && boot1.getLoginItemRegistered().openAtLogin === true,
      'App must register itself with Windows to launch automatically at login'
    );
    assert.equal(boot1.createdWindows.length, 1, 'First boot of day must open Fullscreen Terminal UI');
    const win = boot1.createdWindows[0];
    assert.equal(win.options.fullscreen, true);
    assert.equal(win.options.kiosk, true);
    assert.equal(win.options.frame, false);
    assert.equal(win.options.skipTaskbar, true);
    assert.equal(win.alwaysOnTopLevel.level, 'screen-saver');

    // Verify before-input-event blocks Alt+F4, Escape, Ctrl+W, Alt+Space
    for (const shortcut of [
      { key: 'F4', alt: true },
      { key: 'Escape' },
      { key: 'w', control: true },
      { key: ' ', alt: true, code: 'Space' },
    ]) {
      let prevented = false;
      win.webContentsEvents['before-input-event'](
        { preventDefault: () => { prevented = true; } },
        shortcut
      );
      assert.equal(prevented, true, `Main process must block shortcut ${JSON.stringify(shortcut)}`);
    }

    // Commit tasks via IPC
    await boot1.ipcHandlers['tasks:commit'](null, ['Task Alpha', 'Task Beta']);
    assert.equal(
      win.isDestroyed(),
      false,
      'Window must remain visible during the 1.5s confirmation pause'
    );
    assert.equal(boot1.scheduledTimeouts.length, 1);
    assert.equal(boot1.scheduledTimeouts[0].ms, 1500, 'Pause before window destruction must be 1500ms');

    // Verify System Tray updated with LOCKED status and tasks
    const trayMenuLabels = boot1.getTrayMenu().map((item) => item.label).filter(Boolean);
    assert.ok(trayMenuLabels.some((l) => l.includes('LOCKED')));
    assert.ok(trayMenuLabels.includes('[1] Task Alpha'));
    assert.ok(trayMenuLabels.includes('[2] Task Beta'));

    // Execute the 1.5s timer -> window must be completely destroyed
    boot1.scheduledTimeouts[0].fn();
    assert.equal(win.isDestroyed(), true, 'Window must be completely destroyed after 1.5s timer');

    // Trigger window-all-closed -> background daemon must stay alive
    boot1.appEvents['window-all-closed']();
    assert.equal(boot1.isQuitCalled(), false, 'Closing UI window must NOT quit the background process');

    // Boot 2: Same calendar day (already committed) -> UI window must NOT open
    const boot2 = runMainProcessSimulation();
    assert.equal(
      boot2.createdWindows.length,
      0,
      'Starting app again on the same day after commitment must skip opening the UI window'
    );

    // Boot 3: Uncommitted day -> user enters 'exit' -> window closes and MUST NOT reopen on rollover ticks or unlock
    const exitTestDir = path.join(tempDir, 'exit-no-reopen');
    fs.mkdirSync(exitTestDir, { recursive: true });
    let exitSimClock = new Date('2026-11-13T11:16:00');
    const bootExit = runMainProcessSimulation({
      storageDir: exitTestDir,
      nowProvider: () => exitSimClock,
    });
    assert.equal(
      bootExit.createdWindows.length,
      1,
      'Fresh uncommitted day after 6am must open terminal prompt once'
    );
    await bootExit.ipcHandlers['terminal:exit']();
    const exitTimeout = bootExit.scheduledTimeouts[bootExit.scheduledTimeouts.length - 1];
    assert.equal(exitTimeout.ms, 300);
    exitTimeout.fn();
    assert.equal(
      bootExit.createdWindows[0].isDestroyed(),
      true,
      'Prompt window must be destroyed after terminal:exit'
    );
    // Simulate multiple 15-second background rollover ticks & screen unlock/resume
    for (let i = 0; i < 4; i++) {
      bootExit.scheduledIntervals.forEach((interval) => interval.fn());
    }
    bootExit.powerMonitorEvents['unlock-screen']();
    bootExit.powerMonitorEvents['resume']();
    assert.equal(
      bootExit.createdWindows.length,
      1,
      'Exiting prompt without adding tasks must NOT reopen the terminal window 10-15s later or on unlock'
    );

    // Boot 4: Pressing Ctrl+Shift+W in UI window immediately destroys window and quits entire app
    const quitShortcutDir = path.join(tempDir, 'quit-shortcut');
    fs.mkdirSync(quitShortcutDir, { recursive: true });
    const bootQuitShortcut = runMainProcessSimulation({
      storageDir: quitShortcutDir,
      nowProvider: () => new Date('2026-11-14T10:00:00'),
    });
    assert.equal(bootQuitShortcut.createdWindows.length, 1);
    let ctrlShiftWPrevented = false;
    bootQuitShortcut.createdWindows[0].webContentsEvents['before-input-event'](
      { preventDefault: () => { ctrlShiftWPrevented = true; } },
      { key: 'W', control: true, shift: true, alt: false }
    );
    assert.equal(ctrlShiftWPrevented, true, 'Ctrl+Shift+W must be intercepted by main process');
    assert.equal(
      bootQuitShortcut.createdWindows[0].isDestroyed(),
      true,
      'Ctrl+Shift+W must immediately destroy the terminal UI window'
    );
    assert.equal(
      bootQuitShortcut.isQuitCalled(),
      true,
      'Ctrl+Shift+W must quit the background process completely'
    );
    console.log('[PASS] 5. Main process lifecycle, Windows login auto-launch, 1.5s pause, BrowserWindow.destroy(), System Tray, same-day daemon mode, and terminal:exit no-reopen');

    // -------------------------------------------------------------------------
    // 6. Verify Welcome Message & Adding New Tasks Anytime in Terminal UI (f)
    // -------------------------------------------------------------------------
    assert.ok(
      htmlContent.includes('You can add new tasks whenever you want'),
      'Welcome message in index.html must state that users can add new tasks whenever they want alongside other details'
    );
    assert.equal(
      htmlContent.includes('[Backspace] to edit'),
      false,
      'index.html must not contain "[Backspace] to edit" notice'
    );

    // Simulate re-opening the terminal when 2 tasks are already committed for today
    elements['terminal-history'].children = [];
    for (const handler of windowListeners['DOMContentLoaded'] || []) {
      await handler();
    }
    assert.ok(
      elements['terminal-history'].innerText.includes('CURRENTLY LOCKED TASKS (2 TASKS)'),
      'Reopening terminal when tasks are locked must show currently locked tasks'
    );
    assert.equal(
      elements['prompt-label'].textContent,
      "Enter your third important task for today (or type 'done' / 'exit'):",
      'Prompt must advance to next ordinal after existing tasks'
    );
    typeText('Write unit tests for window monitor');
    sendKey('Enter');
    typeText('done');
    sendKey('Enter');
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(restartedStoreSameDay.getState().tasks, [
      'Complete Deep Work Session',
      'Review Daily Architecture',
      'Write unit tests for window monitor',
    ]);

    // Simulate reopening terminal and typing 'exit' without adding anything
    elements['terminal-history'].children = [];
    for (const handler of windowListeners['DOMContentLoaded'] || []) {
      await handler();
    }
    typeText('exit');
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(exitTerminalCalled, true, 'Typing exit must invoke exitTerminal IPC to close prompt window');
    assert.deepEqual(restartedStoreSameDay.getState().tasks, [
      'Complete Deep Work Session',
      'Review Daily Architecture',
      'Write unit tests for window monitor',
    ]);

    // Simulate adding a task and then typing 'EXIT' on the next task field -> must save the added task and exit
    exitTerminalCalled = false;
    elements['terminal-history'].children = [];
    for (const handler of windowListeners['DOMContentLoaded'] || []) {
      await handler();
    }
    typeText('Task saved via EXIT command');
    sendKey('Enter');
    typeText('EXIT');
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      exitTerminalCalled,
      true,
      'Typing EXIT after adding a task must save the task and exit the terminal UI'
    );
    assert.deepEqual(restartedStoreSameDay.getState().tasks, [
      'Complete Deep Work Session',
      'Review Daily Architecture',
      'Write unit tests for window monitor',
      'Task saved via EXIT command',
    ]);
    console.log('[PASS] 6. Welcome message details, adding new tasks anytime, and [exit] command in Fullscreen Terminal Prompt');

    // -------------------------------------------------------------------------
    // 7. Verify 2s Window Poller, Duplicate Skip, Lock/Sleep Pause & 5 Breadcrumbs (g, h, i, j)
    // -------------------------------------------------------------------------
    assert.equal(POLL_INTERVAL_MS, 2000, 'Poll interval must be 2000ms (2 seconds)');
    assert.equal(MAX_BREADCRUMBS, 5, 'Max breadcrumbs must be 5');

    let simulatedWindow = {
      windowTitle: 'pc-blocker - Visual Studio Code',
      processName: 'Code.exe',
      timestamp: '2026-11-11T10:00:00.000Z',
    };
    const evaluationsTriggered = [];

    const monitor = new WindowMonitor({
      windowProvider: async () => simulatedWindow,
      onEvaluationReady: (res) => evaluationsTriggered.push(res),
    });

    monitor.start();
    assert.equal(monitor.isActivelyPolling(), true);

    // Poll 1: Initial window (VS Code -> WORK_APP)
    const poll1 = await monitor.pollOnce();
    assert.equal(poll1.status, 'SAFE');
    assert.equal(poll1.classification.category, CATEGORIES.WORK_APP);
    assert.equal(monitor.getBreadcrumbs().length, 1);

    // Poll 2: Identical window 2s later -> must skip further processing (h)
    const poll2 = await monitor.pollOnce();
    assert.equal(poll2.status, 'SKIPPED_DUPLICATE');
    assert.equal(monitor.getBreadcrumbs().length, 1, 'Duplicate consecutive poll must not add breadcrumb');

    // Pause on Windows screen lock & display sleep, resume on unlock (g)
    monitor.handleScreenLock();
    assert.equal(monitor.isActivelyPolling(), false);
    const lockedPoll = await monitor.pollOnce();
    assert.equal(lockedPoll.status, 'PAUSED');

    monitor.handleScreenUnlock();
    assert.equal(monitor.isActivelyPolling(), true);

    monitor.handleSuspend();
    assert.equal(monitor.isActivelyPolling(), false);
    monitor.handleResume();
    assert.equal(monitor.isActivelyPolling(), true);

    // Visit 5 more distinct window titles to verify rolling 5-item breadcrumb list (i, j)
    const visitedSequence = [
      { windowTitle: 'Pull Requests · GitHub - Google Chrome', processName: 'chrome.exe', timestamp: '2026-11-11T10:00:02.000Z' },
      { windowTitle: 'Architecture Spec - Notion', processName: 'Notion.exe', timestamp: '2026-11-11T10:00:04.000Z' },
      { windowTitle: 'Stack Overflow - Google Chrome', processName: 'chrome.exe', timestamp: '2026-11-11T10:00:06.000Z' },
      { windowTitle: 'Localhost:3000 - Google Chrome', processName: 'chrome.exe', timestamp: '2026-11-11T10:00:08.000Z' },
      { windowTitle: 'Funny Cat Videos - YouTube - Google Chrome', processName: 'chrome.exe', timestamp: '2026-11-11T10:00:10.000Z' },
    ];

    for (const winSample of visitedSequence) {
      simulatedWindow = winSample;
      await monitor.pollOnce();
    }

    const crumbs = monitor.getBreadcrumbs();
    assert.equal(crumbs.length, 5, 'Breadcrumbs must cap at 5 distinct entries');
    assert.deepEqual(
      crumbs.map((c) => c.windowTitle),
      visitedSequence.map((v) => v.windowTitle),
      'Breadcrumbs must be ordered from oldest to newest with the oldest evicted'
    );
    assert.ok(
      evaluationsTriggered.length >= 1,
      'Non-allowlisted browser tabs must trigger evaluation callback with breadcrumbs'
    );
    monitor.destroy();
    console.log('[PASS] 7. 2-second foreground poller, duplicate skip, lock/sleep pause, and 5-slot rolling breadcrumbs');

    // -------------------------------------------------------------------------
    // 8. Verify Fast Pre-Filter Allowlist Categories (k)
    // -------------------------------------------------------------------------
    // OS Essentials
    assert.equal(classifyWindow('File Explorer', 'explorer.exe').category, CATEGORIES.OS_ESSENTIAL);
    assert.equal(classifyWindow('Windows Search', 'SearchHost.exe').category, CATEGORIES.OS_ESSENTIAL);
    assert.equal(classifyWindow('Start', 'StartMenuExperienceHost.exe').category, CATEGORIES.OS_ESSENTIAL);
    assert.equal(classifyWindow('Settings', 'SystemSettings.exe').category, CATEGORIES.OS_ESSENTIAL);
    assert.equal(classifyWindow('Task Switching', 'explorer.exe').category, CATEGORIES.OS_ESSENTIAL);
    assert.equal(classifyWindow('PC Blocker', 'electron.exe').category, CATEGORIES.OS_ESSENTIAL);

    // Password Managers & System Credential Prompts
    assert.equal(classifyWindow('1Password', '1Password.exe').category, CATEGORIES.PASSWORD_MANAGER);
    assert.equal(classifyWindow('Bitwarden', 'Bitwarden.exe').category, CATEGORIES.PASSWORD_MANAGER);
    assert.equal(classifyWindow('KeePassXC', 'KeePassXC.exe').category, CATEGORIES.PASSWORD_MANAGER);
    assert.equal(classifyWindow('Windows Security', 'CredentialUIBroker.exe').category, CATEGORIES.PASSWORD_MANAGER);
    assert.equal(classifyWindow('User Account Control', 'consent.exe').category, CATEGORIES.PASSWORD_MANAGER);

    // Dedicated Work Applications (Editors, Terminals, DB Tools, Design Software)
    assert.equal(classifyWindow('main.js - Visual Studio Code', 'Code.exe').category, CATEGORIES.WORK_APP);
    assert.equal(classifyWindow('Windows PowerShell', 'WindowsTerminal.exe').category, CATEGORIES.WORK_APP);
    assert.equal(classifyWindow('DBeaver 24.1', 'dbeaver.exe').category, CATEGORIES.WORK_APP);
    assert.equal(classifyWindow('Design System - Figma', 'Figma.exe').category, CATEGORIES.WORK_APP);

    // Neutral Browser Utilities (Blank New Tabs, Downloads/Settings, Internal DevTools)
    assert.equal(classifyWindow('New Tab - Google Chrome', 'chrome.exe').category, CATEGORIES.NEUTRAL_BROWSER_UTILITY);
    assert.equal(classifyWindow('Downloads - Microsoft Edge', 'msedge.exe').category, CATEGORIES.NEUTRAL_BROWSER_UTILITY);
    assert.equal(classifyWindow('Settings - Brave', 'brave.exe').category, CATEGORIES.NEUTRAL_BROWSER_UTILITY);
    assert.equal(classifyWindow('chrome://settings - Google Chrome', 'chrome.exe').category, CATEGORIES.NEUTRAL_BROWSER_UTILITY);

    // OAuth / Login redirects and non-exempt pages route to Gate 1 -> Gate 2 TypeSafe AI (work_plumbing / evaluation)
    const oauthCheck = classifyWindow('Sign in - Google Accounts - Google Chrome', 'chrome.exe');
    assert.equal(oauthCheck.safe, false);
    assert.equal(oauthCheck.category, CATEGORIES.REQUIRES_EVALUATION);

    const githubLoginCheck = classifyWindow('Sign in to GitHub · GitHub - Google Chrome', 'chrome.exe');
    assert.equal(githubLoginCheck.safe, false);
    assert.equal(githubLoginCheck.category, CATEGORIES.REQUIRES_EVALUATION);

    const evalCheck = classifyWindow('Trending - YouTube - Google Chrome', 'chrome.exe');
    assert.equal(evalCheck.safe, false);
    assert.equal(evalCheck.category, CATEGORIES.REQUIRES_EVALUATION);
    console.log('[PASS] 8. Gate 0 pre-filter allowlist (OS, password managers, work apps, internal browser tabs; OAuth routed to AI)');

    // -------------------------------------------------------------------------
    // 9. Verify Local Verdict Cache (Gate 1) & .env Loading
    // -------------------------------------------------------------------------
    const cacheDir = path.join(tempDir, 'cache-test');
    const cache = new VerdictCache(cacheDir, () => new Date('2026-11-13T10:00:00Z'));
    const tasksA = ['Build PC Blocker AI evaluator', 'Write TypeSafe API tests', 'Apply to VC program'];
    cache.syncActiveTasks('2026-11-13', tasksA);

    cache.set(
      {
        dateString: '2026-11-13',
        tasks: tasksA,
        windowTitle: 'Electron Builder NSIS - YouTube\u200b - Google Chrome',
        processName: 'chrome.exe',
        isIncognito: false,
      },
      {
        decision: 'ALLOWED',
        choice: CHOICE_KEYS.DIRECT_WORK,
        confidence: 0.94,
        probabilities: { direct_work: 0.94, work_plumbing: 0.04, distraction: 0.01, cannot_determine: 0.01 },
      }
    );

    // Lookup ignores extra whitespace, casing, and Edge zero-width spaces
    const cacheHit = cache.get({
      dateString: '2026-11-13',
      tasks: tasksA,
      windowTitle: '  electron builder   nsis - youtube - google chrome ',
      processName: 'CHROME.EXE',
      isIncognito: false,
    });
    assert.equal(cacheHit.hit, true);
    assert.equal(cacheHit.entry.decision, 'ALLOWED');
    assert.equal(cacheHit.entry.choice, CHOICE_KEYS.DIRECT_WORK);

    // Incognito flag produces separate cache key
    const incognitoMiss = cache.get({
      dateString: '2026-11-13',
      tasks: tasksA,
      windowTitle: 'Electron Builder NSIS - YouTube - Google Chrome',
      processName: 'chrome.exe',
      isIncognito: true,
    });
    assert.equal(incognitoMiss.hit, false, 'Incognito window must not share cache key with normal window');

    // Disk persistence across restarts
    const reloadedCache = new VerdictCache(cacheDir);
    const reloadedHit = reloadedCache.get({
      dateString: '2026-11-13',
      tasks: tasksA,
      windowTitle: 'Electron Builder NSIS - YouTube - Google Chrome',
      processName: 'chrome.exe',
      isIncognito: false,
    });
    assert.equal(reloadedHit.hit, true, 'Persisted verdict cache must reload from disk');

    // Adding a task mid-day invalidates old cache entries cleanly
    const tasksB = [...tasksA, 'Watch gaming stream review'];
    const cacheReset = reloadedCache.syncActiveTasks('2026-11-13', tasksB);
    assert.equal(cacheReset, true);
    assert.equal(reloadedCache.size(), 0, 'Changing active tasks must invalidate previous cache entries');

    // Verify normalizeWindowTitle and composite key equality without hashing
    assert.equal(normalizeWindowTitle('  Test\u200b   Title  '), 'test title');
    assert.notEqual(
      buildCompositeCacheKey({ dateString: '2026-11-13', windowTitle: 'A', processName: 'chrome.exe', isIncognito: false }),
      buildCompositeCacheKey({ dateString: '2026-11-14', windowTitle: 'A', processName: 'chrome.exe', isIncognito: false })
    );

    // Verify direct .env loading in main.js respects pre-existing process.env values
    const envTestDir = path.join(tempDir, 'env-test');
    fs.mkdirSync(envTestDir, { recursive: true });
    fs.writeFileSync(
      path.join(envTestDir, '.env'),
      '# comment\nTYPESAFE_API_KEY="from_dotenv_file"\nOTHER_VAR=hello_world\n',
      'utf8'
    );
    const envSandbox = {
      fs,
      process: { env: { TYPESAFE_API_KEY: 'already_set_in_shell' } },
      console,
    };
    const mainSrcForEnv = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const loadEnvFnMatch = mainSrcForEnv.match(/function loadDotEnv[\s\S]*?\n\}\n/);
    assert.ok(loadEnvFnMatch, 'main.js must define loadDotEnv');
    vm.runInNewContext(`${loadEnvFnMatch[0]}; loadDotEnv(${JSON.stringify(path.join(envTestDir, '.env'))});`, envSandbox);
    assert.equal(envSandbox.process.env.TYPESAFE_API_KEY, 'already_set_in_shell', 'Existing env var must not be overwritten');
    assert.equal(envSandbox.process.env.OTHER_VAR, 'hello_world', '.env value must be loaded when unset');
    console.log('[PASS] 9. Gate 1 Local Verdict Cache (0ms lookup, incognito separation, task/date invalidation, disk reload) & .env loader');

    // -------------------------------------------------------------------------
    // 10. Verify TypeSafe AI jev-latest Client (Gate 2) & Fallbacks
    // -------------------------------------------------------------------------
    const samplePayload = buildSystemOnePayload({
      tasks: tasksA,
      breadcrumbs: [
        { windowTitle: 'Apply to YC - Google Chrome', processName: 'chrome.exe' },
        { windowTitle: 'Loom — Record Video - Google Chrome', processName: 'chrome.exe' },
      ],
      currentWindow: {
        windowTitle: 'Sign in - Google Accounts - Google Chrome',
        processName: 'chrome.exe',
        isIncognito: false,
      },
    });
    assert.equal(samplePayload.model, TYPESAFE_MODEL);
    assert.equal(samplePayload.model, 'jev-latest');
    assert.deepEqual(samplePayload.state.todays_committed_tasks, tasksA);
    assert.equal(samplePayload.state.recent_navigation_breadcrumbs.length, 2);
    assert.equal(samplePayload.state.current_active_window.is_incognito, false);
    assert.equal(samplePayload.questions.window_classification.type, 'choice');
    assert.deepEqual(
      Object.keys(samplePayload.questions.window_classification.criteria).sort(),
      ['cannot_determine', 'direct_work', 'distraction', 'work_plumbing']
    );

    let capturedFetchArgs = null;
    const mockOkClient = new TypeSafeClient({
      apiKey: 'test_api_key_123',
      fetchImpl: async (url, init) => {
        capturedFetchArgs = { url, init };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'jev-latest',
            answers: {
              window_classification: {
                type: 'choice',
                choice: 'work_plumbing',
                confidence: 0.91,
                probabilities: {
                  direct_work: 0.06,
                  work_plumbing: 0.91,
                  distraction: 0.02,
                  cannot_determine: 0.01,
                },
              },
            },
          }),
        };
      },
    });

    const clientRes = await mockOkClient.evaluateWindow({
      tasks: tasksA,
      breadcrumbs: [{ windowTitle: 'Apply to YC', processName: 'chrome.exe' }],
      currentWindow: { windowTitle: 'Sign in - Google Accounts', processName: 'chrome.exe', isIncognito: false },
    });
    assert.equal(capturedFetchArgs.url, TYPESAFE_ENDPOINT);
    assert.equal(capturedFetchArgs.init.method, 'POST');
    assert.equal(capturedFetchArgs.init.headers.Authorization, 'Bearer test_api_key_123');
    assert.equal(capturedFetchArgs.init.headers['Content-Type'], 'application/json');
    assert.equal(clientRes.ok, true);
    assert.equal(clientRes.choice, CHOICE_KEYS.WORK_PLUMBING);
    assert.equal(clientRes.confidence, 0.91);

    // Missing API key returns clean error without throwing or hitting fetch
    let fetchCalledWithoutKey = false;
    const missingKeyClient = new TypeSafeClient({
      apiKey: '',
      fetchImpl: async () => {
        fetchCalledWithoutKey = true;
        return { ok: true };
      },
    });
    const missingKeyRes = await missingKeyClient.evaluateWindow({
      tasks: tasksA,
      breadcrumbs: [],
      currentWindow: { windowTitle: 'Test', processName: 'chrome.exe' },
    });
    assert.equal(fetchCalledWithoutKey, false);
    assert.equal(missingKeyRes.ok, false);

    // HTTP 500 & network error gracefully return ok: false
    const errorClient = new TypeSafeClient({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    const httpErrRes = await errorClient.evaluateWindow({
      tasks: tasksA,
      breadcrumbs: [],
      currentWindow: { windowTitle: 'Test', processName: 'chrome.exe' },
    });
    assert.equal(httpErrRes.ok, false);
    assert.equal(httpErrRes.statusCode, 503);
    console.log('[PASS] 10. TypeSafe AI jev-latest payload schema, Bearer auth, and error handling');

    // -------------------------------------------------------------------------
    // 11. Verify WindowEvaluator Routing, 2-Cycle Ambiguity & Notifications
    // -------------------------------------------------------------------------
    assert.equal(DISTRACTION_BLOCK_THRESHOLD, 0.8);
    assert.equal(AMBIGUOUS_ALLOW_MAX_DISTRACTION_PROB, 0.5);
    assert.equal(AMBIGUOUS_WAIT_POLL_CYCLES, 2);

    const evalCacheDir = path.join(tempDir, 'eval-cache');
    const evalCache = new VerdictCache(evalCacheDir);
    evalCache.syncActiveTasks('2026-11-13', tasksA);

    const apiQueue = [];
    let apiCallCount = 0;
    const apiCapturedRequests = [];
    const mockEvalClient = new TypeSafeClient({
      apiKey: 'test_key',
      fetchImpl: async (_url, init) => {
        apiCallCount += 1;
        apiCapturedRequests.push(JSON.parse(init.body));
        const next = apiQueue.shift();
        if (next instanceof Error) {
          throw next;
        }
        return {
          ok: true,
          status: 200,
          json: async () => next,
        };
      },
    });

    const shownNotifications = [];
    const shownBalloons = [];
    class MockNotification {
      constructor(opts) {
        this.opts = opts;
        this.handlers = {};
      }
      static isSupported() {
        return true;
      }
      once(evt, fn) {
        this.handlers[evt] = fn;
      }
      show() {
        shownNotifications.push(this);
      }
    }

    const mockTrayForNotif = {
      displayBalloon: (balloon) => shownBalloons.push(balloon),
    };

    // Verify system notifications are disabled by default via SYSTEM_NOTIFICATIONS_ENABLED = false
    const defaultDisabledNotifier = new DetectionNotifier({
      NotificationClass: MockNotification,
      getTray: () => mockTrayForNotif,
      isSmokeTest: false,
      logger: { log: () => {} },
    });
    assert.equal(
      defaultDisabledNotifier.notificationsEnabled,
      false,
      'System notifications must be disabled by default via boolean flag'
    );
    defaultDisabledNotifier.notify({
      gate: 'GATE_0_WHITELIST',
      status: 'GATE_0_ALLOW',
      sample: { windowTitle: 'Test', processName: 'Code.exe' },
    });
    assert.equal(shownNotifications.length, 0, 'Disabled notifier must not trigger pop-up notifications');

    const testNotifier = new DetectionNotifier({
      NotificationClass: MockNotification,
      getTray: () => mockTrayForNotif,
      isSmokeTest: false,
      notificationsEnabled: true,
      logger: { log: () => {} },
    });

    const emittedVerdicts = [];

    // Verify default WindowEvaluator has useCache disabled so every window title change calls Jev API
    const defaultUncachedEvaluator = new WindowEvaluator({
      verdictCache: evalCache,
      typeSafeClient: mockEvalClient,
      getActiveTasks: () => ({ dateString: '2026-11-13', tasks: tasksA }),
    });
    assert.equal(
      defaultUncachedEvaluator.useCache,
      false,
      'WindowEvaluator must disable verdict cache by default so each window change calls Jev API'
    );
    apiQueue.push(
      {
        answers: {
          window_classification: {
            choice: 'direct_work',
            confidence: 0.91,
            probabilities: { direct_work: 0.91, work_plumbing: 0.05, distraction: 0.02, cannot_determine: 0.02 },
          },
        },
      },
      {
        answers: {
          window_classification: {
            choice: 'direct_work',
            confidence: 0.96,
            probabilities: { direct_work: 0.96, work_plumbing: 0.02, distraction: 0.01, cannot_determine: 0.01 },
          },
        },
      }
    );
    const firstUncachedEval = await defaultUncachedEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Repeat Window Test - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    const secondUncachedEval = await defaultUncachedEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Repeat Window Test - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(apiCallCount, 2, 'Uncached evaluator must call Jev API on every evaluation even for the same window title');
    assert.equal(firstUncachedEval.confidence, 0.91);
    assert.equal(secondUncachedEval.confidence, 0.96);
    assert.equal(secondUncachedEval.cached, false);
    apiCallCount = 0;

    const evaluator = new WindowEvaluator({
      verdictCache: evalCache,
      typeSafeClient: mockEvalClient,
      useCache: true,
      getActiveTasks: () => ({ dateString: '2026-11-13', tasks: tasksA }),
      onVerdict: (evt) => {
        emittedVerdicts.push(evt);
        testNotifier.notify(evt);
      },
    });

    let currentSimWin = { windowTitle: 'File Explorer', processName: 'explorer.exe' };
    const wiredMonitor = new WindowMonitor({
      windowProvider: async () => currentSimWin,
      onSafeWindowDetected: (res) => evaluator.handleSafeWindow(res),
      onEvaluationReady: (res) => evaluator.handleEvaluationWindow(res),
      onSameWindowPoll: (tick) => evaluator.handleSameWindowTick(tick),
    });
    wiredMonitor.start();

    // (a) OS_ESSENTIAL -> allowed & silent
    await wiredMonitor.pollOnce();
    assert.equal(emittedVerdicts.length, 0, 'OS_ESSENTIAL must remain silent');

    // (b) WORK_APP -> Gate 0 notification emitted
    currentSimWin = { windowTitle: 'main.js - Visual Studio Code', processName: 'Code.exe' };
    await wiredMonitor.pollOnce();
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'GATE_0_ALLOW');
    assert.equal(shownNotifications.length, 1);
    assert.ok(shownNotifications[0].opts.toastXml.includes('scenario="urgent"'));

    // (c) direct_work -> Allowed, cached, and 0ms hit on revisit
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'direct_work',
          confidence: 0.95,
          probabilities: { direct_work: 0.95, work_plumbing: 0.03, distraction: 0.01, cannot_determine: 0.01 },
        },
      },
    });
    currentSimWin = { windowTitle: 'How to configure Electron Builder NSIS - YouTube - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(apiCallCount, 1);
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AI_ALLOW');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].choice, 'direct_work');

    // Switch away to New Tab (Gate 0 NEUTRAL_BROWSER_UTILITY -> notifies)
    currentSimWin = { windowTitle: 'New Tab - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'GATE_0_ALLOW');

    // Revisit same YouTube tutorial -> Gate 1 0ms cache hit (no extra API call)
    currentSimWin = { windowTitle: 'How to configure Electron Builder NSIS - YouTube - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(apiCallCount, 1, 'Revisit must hit Gate 1 cache without calling TypeSafe');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'CACHE_ALLOW');

    // (d) OAuth Sign-in tab routes to TypeSafe work_plumbing with prior breadcrumbs
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'work_plumbing',
          confidence: 0.92,
          probabilities: { direct_work: 0.05, work_plumbing: 0.92, distraction: 0.02, cannot_determine: 0.01 },
        },
      },
    });
    currentSimWin = { windowTitle: 'Sign in - Google Accounts - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(apiCallCount, 2);
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].choice, 'work_plumbing');

    // (e) High-confidence distraction (>= 0.65) -> WOULD BLOCK & cached
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.89,
          probabilities: { direct_work: 0.04, work_plumbing: 0.03, distraction: 0.89, cannot_determine: 0.04 },
        },
      },
    });
    currentSimWin = { windowTitle: 'Best Gaming Moments 2026 - YouTube - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AI_BLOCK_SIMULATED');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].decision, 'BLOCKED');

    // Switch and return -> Gate 1 Cached WOULD BLOCK (0ms)
    currentSimWin = { windowTitle: 'New Tab - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    currentSimWin = { windowTitle: 'Best Gaming Moments 2026 - YouTube - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(apiCallCount, 3, 'Cached distraction must not trigger a new API call');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'CACHE_BLOCK_SIMULATED');

    // (f) cannot_determine -> waits 2 polling cycles -> still cannot_determine & pDistract < 0.50 -> Allow (Uncached)
    const cacheCountBeforeAmbiguous = evalCache.size();
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'cannot_determine',
          confidence: 0.6,
          probabilities: { direct_work: 0.2, work_plumbing: 0.1, distraction: 0.1, cannot_determine: 0.6 },
        },
      },
    });
    currentSimWin = { windowTitle: 'Loading... - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AMBIGUOUS_WAITING');
    assert.equal(evalCache.size(), cacheCountBeforeAmbiguous, 'cannot_determine must NOT cache immediately');

    // Cycle 1 on same window -> still waiting
    await wiredMonitor.pollOnce();
    assert.equal(apiCallCount, 4, 'Cycle 1 must wait without re-calling API');

    // Cycle 2 on same window -> re-evaluates and resolves to Allow (Uncached)
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'cannot_determine',
          confidence: 0.58,
          probabilities: { direct_work: 0.22, work_plumbing: 0.1, distraction: 0.1, cannot_determine: 0.58 },
        },
      },
    });
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(apiCallCount, 5, 'Cycle 2 must trigger re-evaluation');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AMBIGUOUS_ALLOW_UNCACHED');
    assert.equal(evalCache.size(), cacheCountBeforeAmbiguous, 'Persistent cannot_determine must stay uncached');

    // (g) Low-confidence distraction (< 0.65) -> waits 2 cycles -> Cycle 2 resolves to distraction >= 0.65 -> Blocked & Cached
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.55,
          probabilities: { direct_work: 0.2, work_plumbing: 0.1, distraction: 0.55, cannot_determine: 0.15 },
        },
      },
    });
    currentSimWin = { windowTitle: 'Mystery Stream - Twitch - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AMBIGUOUS_WAITING');

    await wiredMonitor.pollOnce(); // Cycle 1
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.85,
          probabilities: { direct_work: 0.05, work_plumbing: 0.05, distraction: 0.85, cannot_determine: 0.05 },
        },
      },
    });
    await wiredMonitor.pollOnce(); // Cycle 2
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'AI_BLOCK_SIMULATED');
    assert.equal(evalCache.size(), cacheCountBeforeAmbiguous + 1);

    // (h) Switching away mid-wait cancels pending 2-cycle re-evaluation
    apiQueue.push({
      answers: {
        window_classification: {
          choice: 'cannot_determine',
          confidence: 0.7,
          probabilities: { direct_work: 0.1, work_plumbing: 0.1, distraction: 0.1, cannot_determine: 0.7 },
        },
      },
    });
    currentSimWin = { windowTitle: 'Transient Redirect - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    const callsBeforeSwitch = apiCallCount;
    await wiredMonitor.pollOnce(); // Cycle 1
    currentSimWin = { windowTitle: 'main.js - Visual Studio Code', processName: 'Code.exe' };
    await wiredMonitor.pollOnce(); // Switched to VS Code
    await wiredMonitor.pollOnce(); // Stay on VS Code
    assert.equal(apiCallCount, callsBeforeSwitch, 'Switching away must cancel pending 2-cycle wait');

    // (i) Network / API failure fallback -> Allow everything (Uncached)
    apiQueue.push(new Error('Network offline'));
    currentSimWin = { windowTitle: 'Unvisited Page - Google Chrome', processName: 'chrome.exe' };
    await wiredMonitor.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].status, 'API_FALLBACK_ALLOW');
    assert.equal(emittedVerdicts[emittedVerdicts.length - 1].decision, 'ALLOWED');

    // (j) Verify failed native Toast triggers Tray balloon fallback & XML escaping works
    const lastNotif = shownNotifications[shownNotifications.length - 1];
    lastNotif.handlers['failed']();
    assert.equal(shownBalloons.length, 1, 'Failed toast must fall back to Tray balloon');
    const escapedXml = buildUrgentToastXml({ title: 'A & B <Tag>', body: '"Quoted"' });
    assert.ok(escapedXml.includes('A &amp; B &lt;Tag&gt;') && escapedXml.includes('&quot;Quoted&quot;'));
    assert.ok(formatDetectionNotification({ status: 'AI_BLOCK_SIMULATED', choice: 'distraction', confidence: 0.9, distractionProb: 0.9, sample: { windowTitle: 'Test' } }).title.includes('WOULD BLOCK'));

    wiredMonitor.destroy();
    evaluator.destroy();
    console.log('[PASS] 11. WindowEvaluator routing, 2-cycle ambiguity state machine, API fallback, and high-priority notifications');

    // -------------------------------------------------------------------------
    // 12. Verify Incognito Detection & Prior-5 Breadcrumbs Ordering
    // -------------------------------------------------------------------------
    assert.equal(detectIncognitoFromTitle('YouTube - InPrivate - Microsoft\u200b Edge', 'msedge.exe'), true);
    assert.equal(detectIncognitoFromTitle('Reddit — Mozilla Firefox Private Browsing', 'firefox.exe'), true);
    assert.equal(detectIncognitoFromTitle('New Incognito Tab - Google Chrome', 'chrome.exe'), true);
    assert.equal(detectIncognitoFromTitle('What is Incognito mode? - Google Chrome', 'chrome.exe'), false);

    let bcWin = { windowTitle: 'Win 1', processName: 'chrome.exe', isIncognito: false };
    let capturedPriorBreadcrumbs = null;
    const bcMonitor = new WindowMonitor({
      windowProvider: async () => bcWin,
      onEvaluationReady: (res) => {
        capturedPriorBreadcrumbs = res.priorBreadcrumbs;
      },
    });
    bcMonitor.start();
    for (let i = 1; i <= 6; i++) {
      bcWin = { windowTitle: `Page ${i} - Google Chrome`, processName: 'chrome.exe', isIncognito: i === 6 };
      await bcMonitor.pollOnce();
    }
    assert.equal(capturedPriorBreadcrumbs.length, 5, 'priorBreadcrumbs must keep 5 distinct windows visited right before current window');
    assert.deepEqual(
      capturedPriorBreadcrumbs.map((b) => b.windowTitle),
      [
        'Page 1 - Google Chrome',
        'Page 2 - Google Chrome',
        'Page 3 - Google Chrome',
        'Page 4 - Google Chrome',
        'Page 5 - Google Chrome',
      ],
      'priorBreadcrumbs must be ordered oldest to newest excluding current window'
    );
    assert.equal(bcMonitor.lastEvaluation.sample.isIncognito, true);
    bcMonitor.destroy();
    console.log('[PASS] 12. Incognito/Private detection and prior-5 breadcrumb ordering');

    // -------------------------------------------------------------------------
    // 13. Verify Windows Built-in Full-Screen OCR (ScreenOcrSensor) & .env GEMINI_API_KEY
    // -------------------------------------------------------------------------
    const envFileText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    assert.ok(
      envFileText.includes('GEMINI_API_KEY=AIzaSyBDei21HEWDnEEYmTSd6cXjopUCCaC4_Tg'),
      '.env must configure GEMINI_API_KEY'
    );

    const cleanedOcrSample = cleanOcrText(
      'JEV LIVE OVERLAY (DRAG)\n  Pull Request #42: Fix Auth Flow  \r\n\n  OCR + Gemini  \nReviewing TypeScript changes'
    );
    assert.equal(
      cleanedOcrSample,
      'Pull Request #42: Fix Auth Flow\nReviewing TypeScript changes',
      'cleanOcrText must strip overlay UI labels and normalize whitespace'
    );

    if (process.platform === 'win32') {
      const liveOcrSensor = new ScreenOcrSensor();
      const ocrSelfTest = await liveOcrSensor.runSelfTest();
      assert.equal(ocrSelfTest.ok, true, 'Windows built-in OcrEngine self-test must succeed on win32');
      assert.ok(
        ocrSelfTest.text.toLowerCase().includes('complete system architecture task'),
        `Windows built-in OCR must recognize rendered text (got: "${ocrSelfTest.text}")`
      );
      assert.ok(
        ocrSelfTest.text.toLowerCase().includes('windows built-in ocr engine active'),
        `Windows built-in OCR must recognize second line of rendered text (got: "${ocrSelfTest.text}")`
      );
    }
    console.log('[PASS] 13. Windows built-in OCR engine (Windows.Media.Ocr.OcrEngine) & .env GEMINI_API_KEY');

    // -------------------------------------------------------------------------
    // 14. Verify Gemini 4 Hydrogen (Low) Client & On-Demand WindowEvaluator OCR Flow
    // -------------------------------------------------------------------------
    assert.equal(GEMINI_MODEL, 'gemini-4-hydrogen');
    assert.equal(GEMINI_THINKING_LEVEL, 'low');
    assert.deepEqual(GEMINI_OCR_RESPONSE_SCHEMA.required, [
      'choice',
      'confidence',
      'probabilities',
      'reason',
    ]);

    const interactionReq = buildGeminiInteractionRequest({
      tasks: ['Complete backend API migration', 'Write integration tests'],
      breadcrumbs: [{ windowTitle: 'GitHub PRs - Google Chrome', processName: 'chrome.exe' }],
      currentWindow: {
        windowTitle: 'Untitled Document - Google Docs - Google Chrome',
        processName: 'chrome.exe',
        isIncognito: false,
      },
      initialChoice: 'work_plumbing',
      ocrText: 'Top 10 Movie Trailers 2026 - Watch Now',
    });
    assert.equal(interactionReq.model, 'gemini-4-hydrogen');
    assert.equal(interactionReq.store, false);
    assert.equal(interactionReq.background, false);
    assert.deepEqual(interactionReq.generation_config, { thinking_level: 'low' });
    assert.equal(interactionReq.response_format.type, 'text');
    assert.equal(interactionReq.response_format.mime_type, 'application/json');
    assert.ok(interactionReq.input.includes('Complete backend API migration'));
    assert.ok(interactionReq.input.includes('Top 10 Movie Trailers 2026 - Watch Now'));

    let capturedInteractionCreatePayload = null;
    const mockGeminiClient = new GeminiOcrClient({
      genAiClient: {
        interactions: {
          create: async (payload) => {
            capturedInteractionCreatePayload = payload;
            return {
              output_text: JSON.stringify({
                choice: 'distraction',
                confidence: 0.93,
                probabilities: {
                  direct_work: 0.02,
                  work_plumbing: 0.03,
                  distraction: 0.93,
                  cannot_determine: 0.02,
                },
                reason:
                  'Full-screen OCR text shows unrelated movie trailers instead of backend API migration work.',
              }),
            };
          },
        },
      },
    });

    let ocrCaptureCount = 0;
    const mockScreenOcr = new ScreenOcrSensor({
      ocrProvider: async () => {
        ocrCaptureCount += 1;
        return {
          ok: true,
          text: 'Top 10 Movie Trailers 2026 - Watch Now\nSubscribe for celebrity gossip',
          linesCount: 2,
        };
      },
    });

    const jevQueueForGeminiTest = [];
    let jevCallCountForGeminiTest = 0;
    const capturedJevRequestsForStep2 = [];
    const mockJevClientForGeminiTest = new TypeSafeClient({
      apiKey: 'test_jev_key',
      fetchImpl: async (_url, init) => {
        jevCallCountForGeminiTest += 1;
        capturedJevRequestsForStep2.push(JSON.parse(init.body));
        const next = jevQueueForGeminiTest.shift();
        return {
          ok: true,
          status: 200,
          json: async () => next,
        };
      },
    });

    const onDemandEvaluator = new WindowEvaluator({
      verdictCache: evalCache,
      typeSafeClient: mockJevClientForGeminiTest,
      screenOcr: mockScreenOcr,
      geminiClient: mockGeminiClient,
      autoEscalate: false,
      useCache: false,
      getActiveTasks: () => ({
        dateString: '2026-11-15',
        tasks: ['Complete backend API migration', 'Write integration tests'],
      }),
    });

    // (a) High-confidence direct_work (>= 0.65) -> resolved at Step 1 (needsNextStep = false)
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'direct_work',
          confidence: 0.96,
          probabilities: { direct_work: 0.96, work_plumbing: 0.02, distraction: 0.01, cannot_determine: 0.01 },
        },
      },
    });
    const dwEval = await onDemandEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Backend Migration PR - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(dwEval.choice, 'direct_work');
    assert.equal(dwEval.needsNextStep, false, 'High-confidence direct_work must not need escalation');
    assert.equal(ocrCaptureCount, 0, 'OCR must never run automatically');
    assert.equal(capturedInteractionCreatePayload, null, 'Gemini must never run automatically');

    const rejectedHighConfDirectWork = await onDemandEvaluator.evaluateCurrentWithJevOcr({
      onlyEligible: true,
    });
    assert.equal(rejectedHighConfDirectWork.ok, false);

    // (b) Low-confidence direct_work (< 0.65) -> needsNextStep = true (recommended for Step 2: Jev OCR)
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'direct_work',
          confidence: 0.52,
          probabilities: { direct_work: 0.52, work_plumbing: 0.25, distraction: 0.13, cannot_determine: 0.1 },
        },
      },
    });
    const lowConfDwEval = await onDemandEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Ambiguous Tech Blog - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(lowConfDwEval.choice, 'direct_work');
    assert.equal(
      lowConfDwEval.needsNextStep,
      true,
      'Low-confidence (< 0.65) direct_work must be flagged to move to Step 2'
    );
    assert.ok(lowConfDwEval.escalationReason.includes('low direct_work confidence'));
    assert.equal(ocrCaptureCount, 0, 'Must still wait for manual button click before running Step 2');

    // (c) High-confidence distraction (>= 0.65) -> resolved at Step 1 (needsNextStep = false)
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.91,
          probabilities: { direct_work: 0.03, work_plumbing: 0.03, distraction: 0.91, cannot_determine: 0.03 },
        },
      },
    });
    const distEval = await onDemandEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Gaming Stream - Twitch', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(distEval.choice, 'distraction');
    assert.equal(distEval.needsNextStep, false, 'High-confidence distraction must not need escalation');

    // (d) Low-confidence distraction (< 0.65) -> needsNextStep = true
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.48,
          probabilities: { direct_work: 0.22, work_plumbing: 0.15, distraction: 0.48, cannot_determine: 0.15 },
        },
      },
    });
    const lowConfDistEval = await onDemandEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Mixed Video Title - YouTube', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(
      lowConfDistEval.needsNextStep,
      true,
      'Low-confidence (< 0.65) distraction must be flagged to move to Step 2'
    );
    assert.ok(lowConfDistEval.escalationReason.includes('low distraction confidence'));

    // (e) Full 3-Step Manual Flow: Step 1 (work_plumbing) -> Step 2 (Jev OCR: low-conf distraction) -> Step 3 (Gemini: high-conf distraction)
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'work_plumbing',
          confidence: 0.84,
          probabilities: { direct_work: 0.08, work_plumbing: 0.84, distraction: 0.05, cannot_determine: 0.03 },
        },
      },
    });
    const wpEval = await onDemandEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Google Search - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [{ windowTitle: 'VS Code', processName: 'Code.exe' }],
    });
    assert.equal(wpEval.step, 1);
    assert.equal(wpEval.choice, 'work_plumbing');
    assert.equal(wpEval.needsNextStep, true);
    assert.equal(ocrCaptureCount, 0, 'Step 1 must not automatically trigger OCR');

    // User clicks "Jev OCR" button (Step 2) -> runs full-screen OCR + Jev API
    jevQueueForGeminiTest.push({
      answers: {
        window_classification: {
          choice: 'distraction',
          confidence: 0.54,
          probabilities: { direct_work: 0.16, work_plumbing: 0.2, distraction: 0.54, cannot_determine: 0.1 },
        },
      },
    });
    const step2Res = await onDemandEvaluator.evaluateCurrentWithJevOcr({ onlyEligible: true });
    assert.equal(step2Res.ok, true);
    assert.equal(ocrCaptureCount, 1, 'Step 2 (Jev OCR) must capture full-screen OCR');
    assert.equal(capturedInteractionCreatePayload, null, 'Step 2 must NOT call Gemini API');
    const lastJevReq = capturedJevRequestsForStep2[capturedJevRequestsForStep2.length - 1];
    assert.ok(
      lastJevReq.state.current_active_window.full_screen_ocr_text.includes('Top 10 Movie Trailers 2026'),
      'Step 2 must send full_screen_ocr_text to Jev API'
    );
    assert.equal(step2Res.jevOcrVerdict.step, 2);
    assert.equal(step2Res.jevOcrVerdict.choice, 'distraction');
    assert.equal(step2Res.jevOcrVerdict.confidence, 0.54);
    assert.equal(
      step2Res.jevOcrVerdict.needsNextStep,
      true,
      'Step 2 with low-confidence distraction (0.54 < 0.65) must recommend moving to Step 3 (Gemini)'
    );

    // User clicks "Gemini" button (Step 3) -> reuses Step 2 OCR text and calls Gemini 4 Hydrogen (low)
    const step3Res = await onDemandEvaluator.evaluateCurrentWithGeminiOcr({ onlyEligible: true });
    assert.equal(step3Res.ok, true);
    assert.equal(
      ocrCaptureCount,
      1,
      'Step 3 must reuse the OCR text already captured in Step 2 for the same window'
    );
    assert.ok(capturedInteractionCreatePayload, 'Step 3 must call Gemini API');
    assert.equal(capturedInteractionCreatePayload.model, 'gemini-4-hydrogen');
    assert.deepEqual(capturedInteractionCreatePayload.generation_config, { thinking_level: 'low' });
    assert.equal(step3Res.jevVerdict.choice, 'work_plumbing');
    assert.equal(step3Res.jevOcrVerdict.choice, 'distraction');
    assert.equal(step3Res.geminiVerdict.step, 3);
    assert.equal(step3Res.geminiVerdict.choice, 'distraction');
    assert.equal(step3Res.geminiVerdict.decision, 'BLOCKED');
    assert.equal(step3Res.geminiVerdict.confidence, 0.93);
    assert.ok(step3Res.geminiVerdict.reason.includes('movie trailers'));

    onDemandEvaluator.destroy();

    // (f) Verify Automated Step 1 -> Step 2 -> Step 3 Escalation (autoEscalate: true by default)
    const autoEmittedEvents = [];
    const autoEvaluator = new WindowEvaluator({
      verdictCache: evalCache,
      typeSafeClient: mockJevClientForGeminiTest,
      screenOcr: mockScreenOcr,
      geminiClient: mockGeminiClient,
      useCache: false,
      getActiveTasks: () => ({
        dateString: '2026-11-15',
        tasks: ['Complete backend API migration', 'Write integration tests'],
      }),
      onVerdict: (evt) => autoEmittedEvents.push(evt),
    });
    assert.equal(autoEvaluator.autoEscalate, true, 'autoEscalate must default to true when screenOcr is provided');

    // Case 1: Step 1 (work_plumbing) -> automatically runs Step 2 (Jev OCR -> high-conf distraction 0.88) -> stops at Step 2 without calling Gemini
    capturedInteractionCreatePayload = null;
    const ocrCountBeforeAutoCase1 = ocrCaptureCount;
    jevQueueForGeminiTest.push(
      // Step 1 Jev Title response
      {
        answers: {
          window_classification: {
            choice: 'work_plumbing',
            confidence: 0.78,
            probabilities: { direct_work: 0.1, work_plumbing: 0.78, distraction: 0.08, cannot_determine: 0.04 },
          },
        },
      },
      // Step 2 Jev OCR response (resolved with high confidence distraction >= 0.65)
      {
        answers: {
          window_classification: {
            choice: 'distraction',
            confidence: 0.88,
            probabilities: { direct_work: 0.04, work_plumbing: 0.05, distraction: 0.88, cannot_determine: 0.03 },
          },
        },
      }
    );
    const autoCase1Final = await autoEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Google Docs - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(
      ocrCaptureCount,
      ocrCountBeforeAutoCase1 + 1,
      'Auto escalation must automatically run Windows OCR for Step 2'
    );
    assert.equal(
      capturedInteractionCreatePayload,
      null,
      'Auto escalation must stop at Step 2 when Step 2 resolves to high-confidence distraction'
    );
    assert.equal(autoCase1Final.step, 2);
    assert.equal(autoCase1Final.choice, 'distraction');
    assert.equal(autoCase1Final.decision, 'BLOCKED');

    // Case 2: Step 1 (low-conf direct_work 0.51) -> automatically runs Step 2 (Jev OCR -> cannot_determine 0.60) -> automatically runs Step 3 (Gemini -> distraction 0.93)
    const ocrCountBeforeAutoCase2 = ocrCaptureCount;
    jevQueueForGeminiTest.push(
      // Step 1 Jev Title response (low confidence direct_work < 0.65)
      {
        answers: {
          window_classification: {
            choice: 'direct_work',
            confidence: 0.51,
            probabilities: { direct_work: 0.51, work_plumbing: 0.25, distraction: 0.14, cannot_determine: 0.1 },
          },
        },
      },
      // Step 2 Jev OCR response (still cannot_determine)
      {
        answers: {
          window_classification: {
            choice: 'cannot_determine',
            confidence: 0.6,
            probabilities: { direct_work: 0.15, work_plumbing: 0.15, distraction: 0.1, cannot_determine: 0.6 },
          },
        },
      }
    );
    const autoCase2Final = await autoEvaluator.handleEvaluationWindow({
      sample: { windowTitle: 'Vague Page - Google Chrome', processName: 'chrome.exe', isIncognito: false },
      priorBreadcrumbs: [],
    });
    assert.equal(
      ocrCaptureCount,
      ocrCountBeforeAutoCase2 + 1,
      'Auto Step 2 and Step 3 must share a single full-screen OCR capture'
    );
    assert.ok(capturedInteractionCreatePayload, 'Auto escalation must proceed to Step 3 Gemini when Step 2 is unresolved');
    assert.equal(autoCase2Final.step, 3);
    assert.equal(autoCase2Final.choice, 'distraction');
    assert.equal(autoCase2Final.decision, 'BLOCKED');
    autoEvaluator.destroy();

    console.log('[PASS] 14. 3-Step automatic & manual pipeline (Step 1 Jev Title -> Step 2 Jev OCR -> Step 3 Gemini) & low-confidence (< 65%) escalation rules');

    // -------------------------------------------------------------------------
    // 15. Verify Debug Overlay 3-Step Buttons (Jev OCR, Gemini, Compare, Copy) & Display
    // -------------------------------------------------------------------------
    const overlayHtml = buildOverlayHtml();

    // Verify button order in header-actions: jev-ocr-btn -> gemini-btn -> compare-btn -> copy-btn
    const jevOcrBtnIdx = overlayHtml.indexOf('id="jev-ocr-btn"');
    const geminiBtnIdx = overlayHtml.indexOf('id="gemini-btn"');
    const compareBtnIdx = overlayHtml.indexOf('id="compare-btn"');
    const copyBtnIdx = overlayHtml.indexOf('id="copy-btn"');
    assert.ok(
      jevOcrBtnIdx > 0 && geminiBtnIdx > jevOcrBtnIdx && compareBtnIdx > geminiBtnIdx && copyBtnIdx > compareBtnIdx,
      'Overlay header buttons must be ordered: Jev OCR -> Gemini -> Compare -> Copy'
    );

    // Execute the overlay script in a DOM sandbox to verify interactive behavior
    const overlayScriptMatch = overlayHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(overlayScriptMatch, 'Overlay HTML must contain inline controller script');

    const overlayElements = {};
    const overlayElementIds = [
      'overlay-root',
      'brand-label',
      'jev-ocr-btn',
      'gemini-btn',
      'compare-btn',
      'copy-btn',
      'decision-badge',
      'win-title',
      'win-proc',
      'win-gate',
      'standard-view',
      'compare-view',
      'val-type',
      'sub-status',
      'val-conf',
      'sub-conf',
      'val-dist',
      'sub-dist',
      'bar-direct_work',
      'pct-direct_work',
      'bar-work_plumbing',
      'pct-work_plumbing',
      'bar-distraction',
      'pct-distraction',
      'bar-cannot_determine',
      'pct-cannot_determine',
      'cmp-jev-choice',
      'cmp-jevocr-choice',
      'cmp-gem-choice',
      'cmp-jev-decision',
      'cmp-jevocr-decision',
      'cmp-gem-decision',
      'cmp-jev-conf',
      'cmp-jevocr-conf',
      'cmp-gem-conf',
      'cmp-jev-dw',
      'cmp-jevocr-dw',
      'cmp-gem-dw',
      'cmp-jev-wp',
      'cmp-jevocr-wp',
      'cmp-gem-wp',
      'cmp-jev-dist',
      'cmp-jevocr-dist',
      'cmp-gem-dist',
      'cmp-jev-cd',
      'cmp-jevocr-cd',
      'cmp-gem-cd',
      'ocr-preview-box',
      'ocr-preview-label',
      'ocr-preview-meta',
      'ocr-preview-text',
      'gemini-reason-box',
      'reason-label',
      'reason-meta',
      'reason-text',
      'footer-tasks',
      'footer-time',
    ];

    function createOverlayEl(id) {
      const classes = new Set(
        id === 'compare-btn' ||
        id === 'compare-view' ||
        id === 'ocr-preview-box' ||
        id === 'gemini-reason-box'
          ? ['hidden']
          : []
      );
      const listeners = {};
      return {
        id,
        textContent: '',
        innerHTML: '',
        disabled: false,
        title: '',
        className: '',
        get offsetHeight() {
          if (id === 'overlay-root') {
            const hasOcrBox =
              overlayElements['ocr-preview-box'] &&
              !overlayElements['ocr-preview-box'].classList.contains('hidden');
            const hasReason =
              overlayElements['gemini-reason-box'] &&
              !overlayElements['gemini-reason-box'].classList.contains('hidden');
            const hasCompare =
              overlayElements['compare-view'] &&
              !overlayElements['compare-view'].classList.contains('hidden');
            return 282 + (hasOcrBox ? 56 : 0) + (hasReason ? 64 : 0) + (hasCompare ? 18 : 0);
          }
          return 0;
        },
        style: { width: '0%', fontSize: '' },
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
          toggle: (c, force) => {
            const shouldHave = force !== undefined ? Boolean(force) : !classes.has(c);
            if (shouldHave) classes.add(c);
            else classes.delete(c);
          },
        },
        addEventListener: (evt, fn) => {
          listeners[evt] = fn;
        },
        click: async () => {
          if (listeners['click']) {
            await listeners['click']({ stopPropagation: () => {} });
          }
        },
      };
    }

    for (const id of overlayElementIds) {
      overlayElements[id] = createOverlayEl(id);
    }

    let overlayClipboardCopied = '';
    let overlayJevOcrRunCalls = 0;
    let overlayGeminiRunCalls = 0;
    const overlayResizeHeights = [];

    const mockStep1Verdict = {
      gate: 'GATE_2_AI',
      step: 1,
      status: 'AI_ALLOW',
      decision: 'ALLOWED',
      choice: 'work_plumbing',
      confidence: 0.82,
      probabilities: {
        direct_work: 0.08,
        work_plumbing: 0.82,
        distraction: 0.06,
        cannot_determine: 0.04,
      },
      distractionProb: 0.06,
      needsNextStep: true,
      escalationReason: 'state is work_plumbing',
      latencyMs: 112,
      sample: {
        windowTitle: 'Search Results - Google Chrome',
        processName: 'chrome.exe',
        isIncognito: false,
      },
    };

    const mockStep2Verdict = {
      gate: 'GATE_2_JEV_OCR',
      step: 2,
      model: 'jev-latest',
      status: 'JEV_OCR_LOW_CONF_WORK',
      decision: 'ALLOWED',
      choice: 'direct_work',
      confidence: 0.58,
      probabilities: {
        direct_work: 0.58,
        work_plumbing: 0.28,
        distraction: 0.08,
        cannot_determine: 0.06,
      },
      distractionProb: 0.08,
      needsNextStep: true,
      escalationReason: 'low direct_work confidence (58% < 65%)',
      ocrTextPreview: 'Windows.Media.Ocr.OcrEngine TryCreateFromUserProfileLanguages documentation',
      ocrChars: 1420,
      ocrLinesCount: 34,
      ocrLatencyMs: 95,
      jevOcrLatencyMs: 115,
      latencyMs: 210,
      sample: mockStep1Verdict.sample,
    };

    const mockStep3Verdict = {
      gate: 'GATE_3_OCR_GEMINI',
      step: 3,
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'low',
      status: 'GEMINI_OCR_ALLOW',
      decision: 'ALLOWED',
      choice: 'direct_work',
      confidence: 0.95,
      probabilities: {
        direct_work: 0.95,
        work_plumbing: 0.03,
        distraction: 0.01,
        cannot_determine: 0.01,
      },
      distractionProb: 0.01,
      reason: "Full-screen OCR shows Windows Media OcrEngine documentation matching today's task.",
      ocrTextPreview: mockStep2Verdict.ocrTextPreview,
      ocrChars: 1420,
      ocrLinesCount: 34,
      ocrLatencyMs: 95,
      geminiLatencyMs: 410,
      latencyMs: 505,
      sample: mockStep1Verdict.sample,
    };

    const overlaySandbox = {
      window: {
        pcBlocker: {
          writeClipboardText: (txt) => {
            overlayClipboardCopied = String(txt || '');
            return Promise.resolve(true);
          },
          resizeOverlay: (h) => {
            overlayResizeHeights.push(h);
            return Promise.resolve(true);
          },
          runJevOcrCheck: async () => {
            overlayJevOcrRunCalls += 1;
            return {
              ok: true,
              jevVerdict: mockStep1Verdict,
              jevOcrVerdict: mockStep2Verdict,
              tasks: ['Implement Windows OCR and Gemini accuracy check'],
              tasksCount: 1,
            };
          },
          runGeminiOcrCheck: async () => {
            overlayGeminiRunCalls += 1;
            return {
              ok: true,
              jevVerdict: mockStep1Verdict,
              jevOcrVerdict: mockStep2Verdict,
              geminiVerdict: mockStep3Verdict,
              tasks: ['Implement Windows OCR and Gemini accuracy check'],
              tasksCount: 1,
            };
          },
        },
      },
      document: {
        getElementById: (id) => overlayElements[id],
        createElement: () => ({
          style: {},
          select: () => {},
        }),
        body: {
          appendChild: () => {},
          removeChild: () => {},
        },
        execCommand: () => {},
      },
      navigator: {},
      Number,
      Math,
      Date,
      Promise,
      setTimeout: () => 1,
      clearTimeout: () => {},
      console,
    };

    vm.runInNewContext(overlayScriptMatch[1], overlaySandbox);

    // Step 1: Push Step 1 (Jev Title) result -> shows Step 1 values and escalation hint, compact 282px height
    overlaySandbox.window.__updateJevOverlay({
      ...mockStep1Verdict,
      tasks: ['Implement Windows OCR and Gemini accuracy check'],
      tasksCount: 1,
    });
    assert.equal(overlayElements['jev-ocr-btn'].disabled, false);
    assert.equal(overlayElements['gemini-btn'].disabled, false);
    assert.equal(overlayElements['val-type'].textContent, 'work_plumbing');
    assert.equal(overlayElements['val-conf'].textContent, '82%');
    assert.ok(overlayElements['sub-status'].textContent.includes('→ Step 2'));
    const compactHeight = overlayResizeHeights[overlayResizeHeights.length - 1];
    assert.equal(compactHeight, 282, 'Step 1 view must have compact 282px height with zero blank space');

    // Step 2: Manually click "Jev OCR" button -> executes Step 2 and shows Jev OCR result + OCR preview box
    await overlayElements['jev-ocr-btn'].click();
    assert.equal(overlayJevOcrRunCalls, 1, 'Clicking #jev-ocr-btn must invoke runJevOcrCheck()');
    assert.equal(overlayGeminiRunCalls, 0, 'Clicking #jev-ocr-btn must NOT invoke Gemini');
    assert.equal(overlayElements['val-type'].textContent, 'direct_work');
    assert.equal(overlayElements['val-conf'].textContent, '58%');
    assert.ok(overlayElements['sub-status'].textContent.includes('→ Step 3'));
    assert.equal(
      overlayElements['ocr-preview-box'].classList.contains('hidden'),
      false,
      'Step 2 view must display the OCR screen text preview box'
    );
    assert.ok(overlayElements['ocr-preview-text'].textContent.includes('Windows.Media.Ocr.OcrEngine'));
    assert.ok(overlayResizeHeights[overlayResizeHeights.length - 1] > compactHeight);

    // Step 3: Manually click "Gemini" button -> executes Step 3 and shows Gemini result + reason box
    await overlayElements['gemini-btn'].click();
    assert.equal(overlayGeminiRunCalls, 1, 'Clicking #gemini-btn must invoke runGeminiOcrCheck()');
    assert.equal(overlayElements['val-type'].textContent, 'direct_work');
    assert.equal(overlayElements['val-conf'].textContent, '95%');
    assert.equal(overlayElements['pct-direct_work'].textContent, '95%');
    assert.equal(
      overlayElements['gemini-reason-box'].classList.contains('hidden'),
      false,
      'Step 3 view must display the Gemini reason box'
    );
    assert.ok(overlayElements['reason-text'].textContent.includes('Windows Media OcrEngine documentation'));

    // Step 4: Manually click "Compare" button -> shows 3-column comparison table (Step 1 vs Step 2 vs Step 3)
    await overlayElements['compare-btn'].click();
    assert.equal(overlayElements['compare-view'].classList.contains('hidden'), false);
    assert.equal(overlayElements['cmp-jev-choice'].textContent, 'work_plumbing');
    assert.equal(overlayElements['cmp-jevocr-choice'].textContent, 'direct_work');
    assert.equal(overlayElements['cmp-gem-choice'].textContent, 'direct_work');
    assert.equal(overlayElements['cmp-jev-conf'].textContent, '82% (0.820)');
    assert.equal(overlayElements['cmp-jevocr-conf'].textContent, '58% (0.580)');
    assert.equal(overlayElements['cmp-gem-conf'].textContent, '95% (0.950)');

    // Step 5: Click Copy button -> copies all 3 steps + 3-Step Progression Summary
    await overlayElements['copy-btn'].click();
    assert.ok(overlayClipboardCopied.includes('--- Step 1: Jev API (Title Only) ---'));
    assert.ok(overlayClipboardCopied.includes('--- Step 2: Jev API (Full-Screen OCR) ---'));
    assert.ok(overlayClipboardCopied.includes('--- Step 3: Gemini OCR (gemini-4-hydrogen low) ---'));
    assert.ok(overlayClipboardCopied.includes('Choice Progression: work_plumbing -> direct_work -> direct_work'));
    console.log('[PASS] 15. DebugOverlay 3-step manual buttons (Jev OCR, Gemini, Compare), OCR preview, Gemini reason, and 3-column Compare view');

    // -------------------------------------------------------------------------
    // 16. Verify Full-Screen Blinking Red Distraction Border & Step 1/2/3 Indicator
    // -------------------------------------------------------------------------
    const borderHtml = buildDistractionBorderHtml();
    assert.equal(borderHtml.includes('@keyframes blinkRedBorder'), false, 'Distraction border must be steady (non-blinking)');
    assert.ok(borderHtml.includes('bottom: 18px') && borderHtml.includes('left: 50%'), 'Distraction banner text must be positioned at center-bottom');
    assert.ok(borderHtml.includes('id="bottom-banner-wrap" class="bottom-banner-wrap hidden"'), 'Center-bottom banner text must be hidden by default');
    assert.ok(borderHtml.includes('DISTRACTION DETECTED'), 'Distraction border HTML must include banner title');
    const mainSrcForShortcut = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    assert.ok(
      mainSrcForShortcut.includes("globalShortcut.register('CommandOrControl+Shift+S'") &&
        mainSrcForShortcut.includes('distractionBorder.toggleBannerText()'),
      'main.js must register Ctrl+Shift+S global shortcut to toggle distraction border text box'
    );

    // Verify shouldShowDistractionBorder enforces ALL blocking criteria (choice === distraction, decision === BLOCKED, score >= 0.65)
    assert.equal(
      shouldShowDistractionBorder({
        step: 1,
        decision: 'ALLOWED',
        choice: 'direct_work',
        confidence: 0.95,
      }),
      false,
      'Red border must NOT show for direct_work'
    );
    assert.equal(
      shouldShowDistractionBorder({
        step: 1,
        decision: 'PENDING',
        choice: 'distraction',
        confidence: 0.55,
        distractionProb: 0.55,
      }),
      false,
      'Red border must NOT show for low-confidence (< 0.65) distraction'
    );
    assert.equal(
      shouldShowDistractionBorder({
        step: 3,
        decision: 'ALLOWED',
        choice: 'distraction',
        confidence: 0.45,
        distractionProb: 0.45,
      }),
      false,
      'Red border must NOT show when confidence is below 0.65 threshold'
    );

    // Verify Step 1, Step 2, and Step 3 high-confidence distractions all trigger red border with accurate step text
    const step1DistVerdict = {
      step: 1,
      gate: 'GATE_2_AI',
      decision: 'BLOCKED',
      choice: 'distraction',
      confidence: 0.91,
      distractionProb: 0.91,
      sample: { windowTitle: 'Funny Cat Videos - YouTube' },
    };
    assert.equal(shouldShowDistractionBorder(step1DistVerdict), true);
    const step1Label = formatDistractionStepLabel(step1DistVerdict);
    assert.equal(step1Label.stepNumber, 1);
    assert.ok(step1Label.bannerTitle.includes('STEP 1'), 'Step 1 distraction border must display STEP 1');

    const step2DistVerdict = {
      step: 2,
      gate: 'GATE_2_JEV_OCR',
      decision: 'BLOCKED',
      choice: 'distraction',
      confidence: 0.86,
      distractionProb: 0.86,
      sample: { windowTitle: 'Untitled Tab - Google Chrome' },
    };
    assert.equal(shouldShowDistractionBorder(step2DistVerdict), true);
    const step2Label = formatDistractionStepLabel(step2DistVerdict);
    assert.equal(step2Label.stepNumber, 2);
    assert.ok(step2Label.bannerTitle.includes('STEP 2'), 'Step 2 distraction border must display STEP 2');

    const step3DistVerdict = {
      step: 3,
      gate: 'GATE_3_OCR_GEMINI',
      decision: 'BLOCKED',
      choice: 'distraction',
      confidence: 0.94,
      distractionProb: 0.94,
      sample: { windowTitle: 'Research Doc - Google Docs' },
    };
    assert.equal(shouldShowDistractionBorder(step3DistVerdict), true);
    const step3Label = formatDistractionStepLabel(step3DistVerdict);
    assert.equal(step3Label.stepNumber, 3);
    assert.ok(step3Label.bannerTitle.includes('STEP 3'), 'Step 3 distraction border must display STEP 3');

    // Verify DistractionBorderOverlay window lifecycle (click-through, show on BLOCKED, hide on ALLOWED)
    let borderIgnoredMouse = false;
    let borderShown = false;
    let borderLastJs = '';
    class MockBorderWindow {
      constructor(opts) {
        this.opts = opts;
        this.destroyed = false;
        this.webContents = {
          once: (evt, fn) => {
            if (evt === 'did-finish-load') this._onLoad = fn;
          },
          executeJavaScript: async (code) => {
            borderLastJs = code;
          },
        };
      }
      setIgnoreMouseEvents(flag) {
        borderIgnoredMouse = Boolean(flag);
      }
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      setBounds() {}
      on() {}
      loadURL() {
        if (this._onLoad) this._onLoad();
        return Promise.resolve();
      }
      showInactive() {
        borderShown = true;
      }
      hide() {
        borderShown = false;
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
    }

    const borderOverlay = new DistractionBorderOverlay({
      BrowserWindowClass: MockBorderWindow,
      screenModule: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      isSmokeTest: false,
    });

    assert.equal(borderOverlay.updateForVerdict(step2DistVerdict), true);
    assert.equal(borderIgnoredMouse, true, 'Full-screen distraction border must be click-through');
    assert.equal(borderShown, true, 'Full-screen distraction border must show when distraction blocking criteria are met');
    assert.equal(borderOverlay.isBannerTextVisible, false, 'Center-bottom text box must stay hidden by default when red border appears');
    assert.ok(borderLastJs.includes('"showText":false'), 'Initial red border render must hide text box');
    assert.ok(borderLastJs.includes('STEP 2'), 'Border renderer must receive STEP 2 banner text');

    // Ctrl+Shift+S toggle while red border is shown -> shows text box
    assert.equal(borderOverlay.toggleBannerText(), true, 'toggleBannerText must succeed while red border is visible');
    assert.equal(borderOverlay.isBannerTextVisible, true, 'First Ctrl+Shift+S press must show text box');
    assert.ok(borderLastJs.includes('"showText":true'), 'First toggle must pass showText:true to renderer');

    // Ctrl+Shift+S pressed again -> hides text box while keeping red border visible
    assert.equal(borderOverlay.toggleBannerText(), true, 'Second toggleBannerText must succeed while red border is visible');
    assert.equal(borderOverlay.isBannerTextVisible, false, 'Second Ctrl+Shift+S press must hide text box');
    assert.equal(borderShown, true, 'Red border must remain visible when text box is toggled off');
    assert.ok(borderLastJs.includes('"showText":false'), 'Second toggle must pass showText:false to renderer');

    assert.equal(
      borderOverlay.updateForVerdict({
        step: 1,
        decision: 'ALLOWED',
        choice: 'direct_work',
        confidence: 0.95,
      }),
      false
    );
    assert.equal(borderShown, false, 'Full-screen distraction border must hide immediately when window is allowed');
    assert.equal(borderOverlay.toggleBannerText(), false, 'Ctrl+Shift+S must do nothing when red border is not shown');
    assert.equal(borderOverlay.isBannerTextVisible, false);
    borderOverlay.destroy();
    console.log('[PASS] 16. Full-screen red distraction border (border-only by default) & Ctrl+Shift+S center-bottom info toggle');

    console.log('\nALL TESTS PASSED SUCCESSFULLY.');
  } finally {
    // Leave os.tmpdir() cleanup to OS so sandboxed environments do not block rmSync in tmpdir
  }
}

runVerificationSuite()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Verification suite failed:', err);
    process.exit(1);
  });