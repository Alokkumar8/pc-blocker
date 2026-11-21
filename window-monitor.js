const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_INTERVAL_MS = 2000;
const MAX_BREADCRUMBS = 5;

const CATEGORIES = {
  OS_ESSENTIAL: 'OS_ESSENTIAL',
  PASSWORD_MANAGER: 'PASSWORD_MANAGER',
  WORK_APP: 'WORK_APP',
  NEUTRAL_BROWSER_UTILITY: 'NEUTRAL_BROWSER_UTILITY',
  REQUIRES_EVALUATION: 'REQUIRES_EVALUATION',
};

/**
 * Normalize process name to lowercase with .exe stripped for consistent comparison.
 * @param {string} processName
 * @returns {string}
 */
function normalizeProcessBase(processName = '') {
  const base = String(processName)
    .trim()
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/**
 * Formats process name with .exe suffix when appropriate.
 * @param {string} processName
 * @returns {string}
 */
function formatProcessName(processName = '') {
  const trimmed = String(processName).trim().split(/[\\/]/).pop();
  if (!trimmed) return 'unknown.exe';
  return trimmed.toLowerCase().endsWith('.exe') ? trimmed : `${trimmed}.exe`;
}

// 1. Operating System Essentials (processes)
const OS_ESSENTIAL_PROCESSES = new Set([
  'explorer',
  'searchhost',
  'searchapp',
  'searchui',
  'startmenuexperiencehost',
  'shellexperiencehost',
  'systemsettings',
  'control',
  'taskmgr',
  'mmc',
  'dwm',
  'sihost',
  'taskhostw',
  'ctfmon',
  'textinputhost',
  'lockapp',
  'logonui',
  'rundll32',
  'snippingtool',
  'screenclippinghost',
  'calc',
  'calculatorapp',
  'pc-blocker',
]);

// Operating System Essentials (window titles, lowercase exact or substring rules)
const OS_ESSENTIAL_EXACT_TITLES = new Set([
  '',
  'program manager',
  'task switching',
  'alt+tab',
  'task view',
  'windows shell experience host',
  'start',
  'search',
  'windows search',
  'settings',
  'system settings',
  'control panel',
  'file explorer',
  'windows default lock screen',
  'pc blocker',
]);

// 2. Password Managers & System Credential Prompts
const PASSWORD_MANAGER_PROCESSES = new Set([
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'dashlane',
  'nordpass',
  'protonpass',
  'enpass',
  'roboform',
  'keeper',
  'consent',
  'credentialuibroker',
  'vaultcmd',
  'wlrmdr',
  'pinenrollmentbroker',
  'useraccountcontrolsettings',
]);

const PASSWORD_MANAGER_TITLE_PATTERNS = [
  /\b1password\b/i,
  /\bbitwarden\b/i,
  /\bkeepass(xc)?\b/i,
  /\blastpass\b/i,
  /\bdashlane\b/i,
  /\bnordpass\b/i,
  /\bproton\s*pass\b/i,
  /\benpass\b/i,
  /\broboform\b/i,
  /\bkeeper\s*password\b/i,
  /^windows security$/i,
  /^user account control$/i,
  /\bunlock\s+vault\b/i,
  /\bmaster\s+password\b/i,
];

// 3. Dedicated Work Applications (Code Editors, Terminals, Local DB Tools, Design Software)
const WORK_APP_PROCESSES = new Set([
  // Code Editors & IDEs
  'code',
  'code - insiders',
  'cursor',
  'windsurf',
  'antigravity',
  'devenv',
  'idea64',
  'idea',
  'webstorm64',
  'webstorm',
  'pycharm64',
  'pycharm',
  'goland64',
  'goland',
  'clion64',
  'clion',
  'rider64',
  'rider',
  'phpstorm64',
  'phpstorm',
  'rubymine64',
  'datagrip64',
  'datagrip',
  'studio64',
  'sublime_text',
  'notepad++',
  'nvim',
  'vim',
  'gvim',
  'zed',
  'eclipse',
  'fleet',
  'atom',

  // Terminals & Shells
  'windowsterminal',
  'wt',
  'powershell',
  'pwsh',
  'cmd',
  'mintty',
  'bash',
  'wsl',
  'wezterm-gui',
  'wezterm',
  'alacritty',
  'hyper',
  'tabby',
  'warp',
  'conhost',
  'git-bash',

  // Local Database & API Tools
  'dbeaver',
  'pgadmin4',
  'ssms',
  'azuredatastudio',
  'mongodbcompass',
  'mongodb-compass',
  'tableplus',
  'heidisql',
  'mysqlworkbench',
  'postman',
  'insomnia',
  'bruno',
  'sqlitebrowser',
  'redisinsight',
  'redis-insight',
  'docker desktop',

  // Design Software
  'figma',
  'photoshop',
  'illustrator',
  'indesign',
  'afterfx',
  'premiere pro',
  'xd',
  'blender',
  'affinitydesigner',
  'affinityphoto',
  'affinitypublisher',
  'canva',
  'sketch',
  'gimp-2.10',
  'gimp',
  'inkscape',
]);

// 4. Web Browsers & Neutral Browser Utility Patterns
const BROWSER_PROCESSES = new Set([
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  'arc',
  'waterfox',
  'zen',
  'chromium',
  'thorium',
  'floorp',
  'librewolf',
]);

const BROWSER_SUFFIX_REGEX =
  /\s*[-—–]\s*(?:personal\s*[-—–]\s*|work\s*[-—–]\s*)?(?:google\s+chrome|microsoft\u200b?\s+edge|mozilla\s+firefox|brave|opera|vivaldi|arc|chromium|waterfox|zen\s+browser)$/i;

const NEUTRAL_BROWSER_EXACT_TITLES = new Set([
  '',
  'new tab',
  'new incognito tab',
  'new private tab',
  'inprivate',
  'about:blank',
  'about:newtab',
  'about:home',
  'start page',
  'speed dial',
  'untitled',
  'google chrome',
  'microsoft edge',
  'mozilla firefox',
  'brave',
  'opera',
  'vivaldi',
  'downloads',
  'settings',
  'history',
  'extensions',
  'bookmarks',
  'bookmark manager',
  'password manager',
  'passwords',
  'clear browsing data',
  'developer tools',
  'devtools',
  'inspect',
  'library',
  'about:preferences',
  'about:addons',
  'about:config',
  'about:downloads',
]);

const NEUTRAL_BROWSER_TITLE_PATTERNS = [
  /^(?:chrome|edge|brave|opera|vivaldi|about):\/\//i,
  /^devtools\s*[-—–]/i,
  /^developer\s+tools\s*[-—–]/i,
];

/**
 * Detects private/incognito browsing indicators directly from a browser window title.
 * Edge and Firefox expose InPrivate / Private Browsing in the window title, whereas
 * Chrome relies on the C# UIAutomation toolbar check in Win32ForegroundSensor.
 * @param {string} [windowTitle]
 * @param {string} [processName]
 * @returns {boolean}
 */
function detectIncognitoFromTitle(windowTitle = '', processName = '') {
  const rawTitle = String(windowTitle || '').replace(/\u200b/g, '').trim();
  if (!rawTitle) return false;

  const procBase = normalizeProcessBase(processName);
  const isBrowser =
    BROWSER_PROCESSES.has(procBase) || BROWSER_SUFFIX_REGEX.test(rawTitle);
  if (!isBrowser) return false;

  return (
    /\binprivate\b/i.test(rawTitle) ||
    /private\s+browsing/i.test(rawTitle) ||
    /[-—–]\s*private$/i.test(rawTitle) ||
    /\((?:incognito|private)\)\s*$/i.test(rawTitle) ||
    /\bnew\s+(?:incognito|inprivate|private)\s+tab\b/i.test(rawTitle) ||
    /\bincognito\b(?:\s*[-—–]\s*|$)/i.test(rawTitle)
  );
}

/**
 * Classifies a foreground window into a safe allowlist category or marks it as requiring AI evaluation.
 * @param {string} windowTitle
 * @param {string} processName
 * @returns {{ safe: boolean, category: string, reason: string }}
 */
function classifyWindow(windowTitle = '', processName = '') {
  const rawTitle = String(windowTitle || '').trim();
  const lowerTitle = rawTitle.toLowerCase();
  const procBase = normalizeProcessBase(processName);

  // 1. Operating System Essentials
  if (
    OS_ESSENTIAL_PROCESSES.has(procBase) ||
    OS_ESSENTIAL_EXACT_TITLES.has(lowerTitle) ||
    (procBase === 'electron' && lowerTitle === 'pc blocker') ||
    (procBase === 'applicationframehost' &&
      (lowerTitle === 'settings' ||
        lowerTitle === 'windows security' ||
        lowerTitle === 'calculator' ||
        lowerTitle === ''))
  ) {
    return {
      safe: true,
      category: CATEGORIES.OS_ESSENTIAL,
      reason: 'Operating System essential interface or PC Blocker process',
    };
  }

  // 2. Dedicated Password Managers & System Credential Prompts
  if (
    PASSWORD_MANAGER_PROCESSES.has(procBase) ||
    PASSWORD_MANAGER_TITLE_PATTERNS.some((re) => re.test(rawTitle))
  ) {
    return {
      safe: true,
      category: CATEGORIES.PASSWORD_MANAGER,
      reason: 'Password manager or system credential prompt',
    };
  }

  // 3. Dedicated Work Applications
  if (WORK_APP_PROCESSES.has(procBase)) {
    return {
      safe: true,
      category: CATEGORIES.WORK_APP,
      reason: 'Dedicated work application (editor, terminal, DB tool, or design app)',
    };
  }

  // 4. Neutral Browser Utilities (New Tab, Downloads/Settings, Standard Login Redirects)
  const strippedBrowserTitle = rawTitle.replace(BROWSER_SUFFIX_REGEX, '').trim();
  const lowerStrippedTitle = strippedBrowserTitle.toLowerCase();
  const isBrowser =
    BROWSER_PROCESSES.has(procBase) || BROWSER_SUFFIX_REGEX.test(rawTitle);

  if (
    NEUTRAL_BROWSER_TITLE_PATTERNS.some(
      (re) => re.test(rawTitle) || re.test(strippedBrowserTitle)
    ) ||
    (isBrowser && NEUTRAL_BROWSER_EXACT_TITLES.has(lowerStrippedTitle)) ||
    NEUTRAL_BROWSER_EXACT_TITLES.has(lowerTitle)
  ) {
    return {
      safe: true,
      category: CATEGORIES.NEUTRAL_BROWSER_UTILITY,
      reason: 'Neutral browser utility (blank tab, settings/downloads, or login redirect)',
    };
  }

  return {
    safe: false,
    category: CATEGORIES.REQUIRES_EVALUATION,
    reason: 'Active window requires AI context evaluation',
  };
}

const CSHARP_SENSOR_SOURCE = `
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
#if HAS_UIA
using System.Windows.Automation;
#endif

public class PcBlockerSensor {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  static string EscapeJson(string s) {
    if (s == null) return "";
    StringBuilder sb = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '\\\\') sb.Append("\\\\\\\\");
      else if (c == '"') sb.Append("\\\\\\"");
      else if (c == '\\n') sb.Append("\\\\n");
      else if (c == '\\r') sb.Append("\\\\r");
      else if (c == '\\t') sb.Append("\\\\t");
      else if (c >= 32) sb.Append(c);
    }
    return sb.ToString();
  }

  static bool IsBrowserProc(string procLower) {
    return procLower == "chrome" || procLower == "msedge" || procLower == "brave" ||
           procLower == "opera" || procLower == "vivaldi" || procLower == "arc" ||
           procLower == "chromium" || procLower == "thorium" || procLower == "firefox" ||
           procLower == "waterfox" || procLower == "librewolf" || procLower == "floorp" ||
           procLower == "zen";
  }

#if HAS_UIA
  struct UiaNode {
    public AutomationElement Element;
    public int Depth;
  }

  static bool DetectBrowserIncognitoUia(IntPtr hwnd) {
    try {
      AutomationElement root = AutomationElement.FromHandle(hwnd);
      if (root == null) return false;

      TreeWalker walker = TreeWalker.ControlViewWalker;
      Queue<UiaNode> queue = new Queue<UiaNode>();
      queue.Enqueue(new UiaNode { Element = root, Depth = 0 });
      int visited = 0;

      while (queue.Count > 0 && visited < 120) {
        UiaNode current = queue.Dequeue();
        visited++;

        AutomationElement el = current.Element;
        string className = "";
        ControlType ctrlType = null;
        string name = "";
        string autoId = "";

        try {
          className = el.Current.ClassName ?? "";
          ctrlType = el.Current.ControlType;
          name = (el.Current.Name ?? "").Trim();
          autoId = (el.Current.AutomationId ?? "").Trim();
        } catch {
          continue;
        }

        // Skip web document DOM and tab items so page/tab titles never trigger false positives.
        if (className == "Chrome_RenderWidgetHostHWND" ||
            ctrlType == ControlType.Document ||
            ctrlType == ControlType.Tab ||
            ctrlType == ControlType.TabItem) {
          continue;
        }

        if (ctrlType == ControlType.Button || ctrlType == ControlType.MenuItem) {
          string lowerName = name.ToLowerInvariant();
          string lowerAutoId = autoId.ToLowerInvariant();
          if (lowerName == "incognito" ||
              lowerName == "inprivate" ||
              lowerName == "private" ||
              lowerName == "you're incognito" ||
              lowerName == "you are in incognito mode" ||
              lowerName.StartsWith("incognito (") ||
              lowerName.StartsWith("browse as incognito") ||
              lowerName.StartsWith("inprivate") ||
              lowerAutoId.Contains("incognito") ||
              lowerAutoId.Contains("inprivate")) {
            return true;
          }
        }

        if (current.Depth >= 7) continue;

        try {
          AutomationElement child = walker.GetFirstChild(el);
          while (child != null) {
            queue.Enqueue(new UiaNode { Element = child, Depth = current.Depth + 1 });
            child = walker.GetNextSibling(child);
          }
        } catch {}
      }
    } catch {}
    return false;
  }
#endif

  public static void Main() {
    string json = "{\\"windowTitle\\":\\"\\",\\"processName\\":\\"unknown.exe\\",\\"isIncognito\\":false}\\n";
    try {
      IntPtr hwnd = GetForegroundWindow();
      if (hwnd == IntPtr.Zero) {
        json = "{\\"windowTitle\\":\\"\\",\\"processName\\":\\"explorer.exe\\",\\"isIncognito\\":false}\\n";
      } else {
        StringBuilder sb = new StringBuilder(2048);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        uint pidOut = 0;
        GetWindowThreadProcessId(hwnd, out pidOut);
        string procBase = "unknown";
        string procName = "unknown.exe";
        if (pidOut > 0) {
          try {
            Process proc = Process.GetProcessById((int)pidOut);
            if (proc != null && !string.IsNullOrEmpty(proc.ProcessName)) {
              procBase = proc.ProcessName.ToLowerInvariant();
              procName = proc.ProcessName + ".exe";
            }
          } catch {}
        }

        bool isIncognito = false;
#if HAS_UIA
        if (IsBrowserProc(procBase)) {
          isIncognito = DetectBrowserIncognitoUia(hwnd);
        }
#endif

        json = "{\\"windowTitle\\":\\"" + EscapeJson(sb.ToString()) +
               "\\",\\"processName\\":\\"" + EscapeJson(procName) +
               "\\",\\"isIncognito\\":" + (isIncognito ? "true" : "false") + "}\\n";
      }
    } catch {}
    try {
      byte[] bytes = Encoding.UTF8.GetBytes(json);
      using (var stdout = Console.OpenStandardOutput()) {
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
      }
    } catch {}
  }
}
`;

/**
 * Lightweight Win32 foreground window sensor using a tiny compiled C# P/Invoke + UIA helper.
 * Uses execFile with no stdin writes so Error: write EPIPE can never occur.
 */
class Win32ForegroundSensor {
  constructor() {
    this.exePath = path.join(os.tmpdir(), 'pc-blocker-fg-sensor-v4.exe');
    this.csPath = path.join(os.tmpdir(), 'pc-blocker-fg-sensor-v4.cs');
    this.compiled = false;
    this.compileAttempted = false;
  }

  _ensureCompiled() {
    if (this.compiled) return true;
    if (fs.existsSync(this.exePath)) {
      this.compiled = true;
      return true;
    }
    if (this.compileAttempted) return false;
    this.compileAttempted = true;

    const cscCandidates = [
      path.join(
        process.env.WINDIR || 'C:\\Windows',
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe'
      ),
      path.join(
        process.env.WINDIR || 'C:\\Windows',
        'Microsoft.NET',
        'Framework',
        'v4.0.30319',
        'csc.exe'
      ),
    ];

    const cscPath = cscCandidates.find((p) => fs.existsSync(p));
    if (!cscPath) return false;

    const wpfDir = path.join(path.dirname(cscPath), 'WPF');
    const uiaClientDll = path.join(wpfDir, 'UIAutomationClient.dll');
    const uiaTypesDll = path.join(wpfDir, 'UIAutomationTypes.dll');
    const hasUia = fs.existsSync(uiaClientDll) && fs.existsSync(uiaTypesDll);

    const args = ['/nologo', '/optimize+'];
    if (hasUia) {
      args.push('/define:HAS_UIA', `/r:${uiaClientDll}`, `/r:${uiaTypesDll}`);
    }
    args.push(`/out:${this.exePath}`, this.csPath);

    try {
      fs.writeFileSync(this.csPath, CSHARP_SENSOR_SOURCE, 'utf8');
      execFileSync(cscPath, args, {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15000,
      });
      this.compiled = fs.existsSync(this.exePath);
      return this.compiled;
    } catch {
      return false;
    }
  }

  async getActiveWindow() {
    if (process.platform !== 'win32') {
      return null;
    }
    if (!this._ensureCompiled()) {
      return null;
    }

    return new Promise((resolve) => {
      execFile(
        this.exePath,
        [],
        {
          windowsHide: true,
          timeout: 1500,
          encoding: 'utf8',
        },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          try {
            const line = String(stdout).trim();
            resolve(line ? JSON.parse(line) : null);
          } catch {
            resolve(null);
          }
        }
      );
    });
  }

  destroy() {
    // No persistent child process or stdin stream to clean up
  }
}

/**
 * Background Active Window Monitor
 * - Polls every 2 seconds
 * - Automatically pauses when Windows screen is locked or display is asleep, resuming on unlock
 * - Skips redundant evaluation if active windowTitle, processName & incognito match previous check 2s ago
 *   while notifying onSameWindowPoll so pending ambiguous checks can count polling cycles
 * - Tracks rolling list of last 5 distinct visited window titles & process names ordered oldest to newest
 * - Pre-filters OS essentials, password managers, work apps, and internal browser utilities (Gate 0)
 */
class WindowMonitor {
  /**
   * @param {object} [options]
   * @param {() => Promise<{windowTitle: string, processName: string, isIncognito?: boolean, timestamp?: string}|null>} [options.windowProvider]
   * @param {() => Date} [options.nowProvider]
   * @param {(payload: object) => void} [options.onEvaluationReady]
   * @param {(payload: object) => void} [options.onSafeWindowDetected]
   * @param {(payload: object) => void} [options.onSameWindowPoll]
   * @param {number} [options.pollIntervalMs]
   */
  constructor(options = {}) {
    this.nowProvider = options.nowProvider || (() => new Date());
    this.sensor = options.windowProvider ? null : new Win32ForegroundSensor();
    this.windowProvider =
      options.windowProvider ||
      (async () => {
        const raw = await this.sensor.getActiveWindow();
        if (!raw) return null;
        return {
          windowTitle: String(raw.windowTitle || ''),
          processName: formatProcessName(raw.processName),
          isIncognito: Boolean(raw.isIncognito),
          timestamp: this.nowProvider().toISOString(),
        };
      });
    this.onEvaluationReady = options.onEvaluationReady || null;
    this.onSafeWindowDetected = options.onSafeWindowDetected || null;
    this.onSameWindowPoll = options.onSameWindowPoll || null;
    this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;

    this.timer = null;
    this.isPollingTick = false;
    this.isRunning = false;
    this.isScreenLocked = false;
    this.isDisplayAsleep = false;

    this.lastSample = null;
    this.lastPriorBreadcrumbs = [];
    this.breadcrumbs = [];
    this.lastEvaluation = null;
  }

  /**
   * Returns true if polling is currently active and not paused by screen lock or sleep.
   * @returns {boolean}
   */
  isActivelyPolling() {
    return Boolean(this.isRunning && !this.isScreenLocked && !this.isDisplayAsleep);
  }

  /**
   * Starts the 2-second background polling loop.
   */
  start() {
    this.isRunning = true;
    this._syncTimer();
  }

  /**
   * Stops the background polling loop completely.
   */
  stop() {
    this.isRunning = false;
    this._clearTimer();
  }

  /**
   * Destroys any child sensor resources.
   */
  destroy() {
    this.stop();
    if (this.sensor) {
      this.sensor.destroy();
    }
  }

  /**
   * Pauses polling when Windows screen is locked.
   */
  handleScreenLock() {
    this.isScreenLocked = true;
    this._clearTimer();
  }

  /**
   * Resumes polling when the user unlocks the Windows session.
   */
  handleScreenUnlock() {
    this.isScreenLocked = false;
    this.isDisplayAsleep = false;
    this._syncTimer();
  }

  /**
   * Pauses polling when the display or system goes to sleep.
   */
  handleSuspend() {
    this.isDisplayAsleep = true;
    this._clearTimer();
  }

  /**
   * Handles system wake/resume. Resumes polling if the session is unlocked.
   */
  handleResume() {
    this.isDisplayAsleep = false;
    if (!this.isScreenLocked) {
      this._syncTimer();
    }
  }

  _clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _syncTimer() {
    this._clearTimer();
    if (this.isActivelyPolling()) {
      this.timer = setInterval(() => {
        if (this.isPollingTick) return;
        this.isPollingTick = true;
        this.pollOnce()
          .catch(() => {})
          .finally(() => {
            this.isPollingTick = false;
          });
      }, this.pollIntervalMs);
    }
  }

  /**
   * Returns a shallow copy of the rolling 5-item breadcrumb history (ordered oldest to newest).
   * @returns {Array<{windowTitle: string, processName: string, timestamp: string}>}
   */
  getBreadcrumbs() {
    return this.breadcrumbs.map((entry) => ({ ...entry }));
  }

  /**
   * Updates the rolling 5-slot breadcrumb list if the user switched to a different window title.
   * @param {{windowTitle: string, processName: string, timestamp: string}} sample
   * @returns {boolean} True if added to breadcrumbs
   */
  _updateBreadcrumbs(sample) {
    const title = sample.windowTitle;
    if (!title) {
      return false;
    }

    const newest =
      this.breadcrumbs.length > 0
        ? this.breadcrumbs[this.breadcrumbs.length - 1]
        : null;

    // Only add when switching to a different window title
    if (newest && newest.windowTitle === title) {
      return false;
    }

    // Keep the 5-slot rolling list distinct by windowTitle, ordered oldest to newest
    const existingIdx = this.breadcrumbs.findIndex((b) => b.windowTitle === title);
    if (existingIdx !== -1) {
      this.breadcrumbs.splice(existingIdx, 1);
    }

    this.breadcrumbs.push({
      windowTitle: sample.windowTitle,
      processName: sample.processName,
      timestamp: sample.timestamp,
    });

    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs.shift();
    }

    return true;
  }

  /**
   * Executes a single foreground window check.
   * @returns {Promise<object>}
   */
  async pollOnce() {
    if (!this.isActivelyPolling()) {
      return {
        status: 'PAUSED',
        isScreenLocked: this.isScreenLocked,
        isDisplayAsleep: this.isDisplayAsleep,
      };
    }

    const raw = await this.windowProvider();
    if (!raw) {
      return { status: 'NO_WINDOW' };
    }

    const windowTitle = String(raw.windowTitle ?? '').trim();
    const processName = formatProcessName(raw.processName);
    const isIncognito = Boolean(
      raw.isIncognito || detectIncognitoFromTitle(windowTitle, processName)
    );

    const sample = {
      windowTitle,
      processName,
      isIncognito,
      timestamp: raw.timestamp || this.nowProvider().toISOString(),
    };

    // If LockApp.exe or LogonUI.exe is foreground, treat as locked screen
    const procBase = normalizeProcessBase(sample.processName);
    if (procBase === 'lockapp' || procBase === 'logonui') {
      return {
        status: 'PAUSED',
        reason: 'Windows lock screen process detected',
        sample,
      };
    }

    // Ignore the floating Jev Debug Overlay and Distraction Border windows
    if (
      sample.windowTitle === 'PC Blocker Jev Overlay' ||
      sample.windowTitle === 'PC Blocker Distraction Border'
    ) {
      return {
        status: 'SKIPPED_OVERLAY',
        sample,
      };
    }

    // Skip further processing if window title, process name & incognito match previous check 2s ago
    if (
      this.lastSample &&
      this.lastSample.windowTitle === sample.windowTitle &&
      normalizeProcessBase(this.lastSample.processName) === procBase &&
      Boolean(this.lastSample.isIncognito) === sample.isIncognito
    ) {
      const sameWindowPayload = {
        status: 'SKIPPED_DUPLICATE',
        sample,
        breadcrumbs: this.getBreadcrumbs(),
        priorBreadcrumbs: this.lastPriorBreadcrumbs.map((entry) => ({ ...entry })),
      };
      if (typeof this.onSameWindowPoll === 'function') {
        this.onSameWindowPoll(sameWindowPayload);
      }
      return sameWindowPayload;
    }

    this.lastSample = sample;

    // Capture the last 5 distinct windows visited right before the current window (oldest -> newest)
    const priorBreadcrumbs = this.getBreadcrumbs();
    this.lastPriorBreadcrumbs = priorBreadcrumbs.map((entry) => ({ ...entry }));

    // Update rolling list of last 5 distinct visited window titles (oldest -> newest)
    const breadcrumbAdded = this._updateBreadcrumbs(sample);

    // Gate 0: Fast pre-filter for OS essentials, password managers, work apps, and internal browser tabs
    const classification = classifyWindow(sample.windowTitle, sample.processName);
    const result = {
      status: classification.safe ? 'SAFE' : 'NEEDS_EVALUATION',
      sample,
      classification,
      breadcrumbAdded,
      breadcrumbs: this.getBreadcrumbs(),
      priorBreadcrumbs,
    };

    this.lastEvaluation = result;

    if (classification.safe) {
      if (typeof this.onSafeWindowDetected === 'function') {
        this.onSafeWindowDetected(result);
      }
    } else if (typeof this.onEvaluationReady === 'function') {
      this.onEvaluationReady(result);
    }

    return result;
  }
}

module.exports = {
  POLL_INTERVAL_MS,
  MAX_BREADCRUMBS,
  CATEGORIES,
  WindowMonitor,
  Win32ForegroundSensor,
  classifyWindow,
  detectIncognitoFromTitle,
  normalizeProcessBase,
  formatProcessName,
};

