const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_USER_MODEL_ID = 'com.pcblocker.app';
const SHORTCUT_NAME = 'PC Blocker.lnk';
const SYSTEM_NOTIFICATIONS_ENABLED = false;

/**
 * Escapes XML special characters so arbitrary window titles never break Windows Toast XML.
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateText(text = '', maxLen = 96) {
  const clean = String(text || '').trim() || '<Empty Title>';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

function formatPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  return `${Math.round(num * 100)}%`;
}

/**
 * Builds Windows Toast XML so notifications pop up immediately as expanded banners
 * without a 'Dismiss' action button.
 * @param {{ title: string, body: string }} payload
 * @returns {string}
 */
function buildUrgentToastXml({ title, body }) {
  return `<toast scenario="urgent" displayTimestamp="${new Date().toISOString()}">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(title)}</text>
      <text>${escapeXml(body)}</text>
    </binding>
  </visual>
</toast>`;
}

/**
 * Formats a WindowEvaluator verdict event into high-priority notification text.
 * @param {object} event
 * @returns {{ title: string, body: string, iconType: 'info'|'warning'|'error' }}
 */
function formatDetectionNotification(event) {
  const sample = event?.sample || {};
  const winLabel = truncateText(sample.windowTitle, 80);
  const procName = sample.processName || 'unknown.exe';
  const incognitoTag = sample.isIncognito ? ' | [Incognito]' : '';
  const conf = formatPct(event?.confidence);
  const pDist = formatPct(event?.distractionProb ?? event?.probabilities?.distraction);
  const latency = Number.isFinite(event?.latencyMs) ? `${event.latencyMs}ms` : '';

  switch (event?.status) {
    case 'GATE_0_ALLOW':
      return {
        title: `[ALLOW • Gate 0: ${event.category}]`,
        body: `${winLabel} (${procName})${incognitoTag}`,
        iconType: 'info',
      };

    case 'CACHE_ALLOW':
      return {
        title: `[ALLOW • Cached 0ms (${event.choice})]`,
        body: `${winLabel} | Conf: ${conf} | Distract: ${pDist}${incognitoTag}`,
        iconType: 'info',
      };

    case 'CACHE_BLOCK_SIMULATED':
      return {
        title: '[WOULD BLOCK • Cached 0ms]',
        body: `${winLabel} | Choice: ${event.choice} | Distract: ${pDist}${incognitoTag}`,
        iconType: 'error',
      };

    case 'AI_ALLOW':
      return {
        title: `[ALLOW • ${event.choice}]${latency ? ` (${latency})` : ''}`,
        body: `${winLabel} | Conf: ${conf} | Distract: ${pDist}${incognitoTag}`,
        iconType: 'info',
      };

    case 'AI_BLOCK_SIMULATED':
      return {
        title: `[WOULD BLOCK • distraction]${latency ? ` (${latency})` : ''}`,
        body: `${winLabel} | Distract: ${pDist} | Conf: ${conf}${incognitoTag}`,
        iconType: 'error',
      };

    case 'AMBIGUOUS_WAITING':
      return {
        title: `[PENDING (Wait ${event.waitCycles || 2} cycles) • ${event.choice}]`,
        body: `${winLabel} | Conf: ${conf} | Distract: ${pDist}${incognitoTag}`,
        iconType: 'warning',
      };

    case 'AMBIGUOUS_ALLOW_UNCACHED':
    case 'LOW_CONFIDENCE_ALLOW_UNCACHED':
      return {
        title: `[ALLOW UNCACHED • ${event.choice}]${latency ? ` (${latency})` : ''}`,
        body: `${winLabel} | Conf: ${conf} | Distract: ${pDist}${incognitoTag}`,
        iconType: 'warning',
      };

    case 'API_FALLBACK_ALLOW':
    case 'NO_COMMITTED_TASKS':
    default:
      return {
        title: '[ALLOW • API Fallback]',
        body: `${winLabel} | ${event?.error || 'Offline/API fallback'}${incognitoTag}`,
        iconType: 'warning',
      };
  }
}

/**
 * On Windows 10/11, unpackaged Electron Notification toasts require a Start Menu shortcut
 * carrying the app's AppUserModelID. Creates/updates the shortcut asynchronously once if missing.
 * @param {object} [options]
 * @param {string} [options.appUserModelId]
 * @param {string} [options.exePath]
 * @param {string} [options.appArgs]
 * @param {string} [options.displayName]
 * @returns {Promise<boolean>}
 */
function ensureWindowsNotificationShortcut(options = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve(false);
  }

  const appUserModelId = options.appUserModelId || APP_USER_MODEL_ID;
  const exePath = options.exePath || process.execPath;
  const appArgs = options.appArgs || '';
  const displayName = options.displayName || 'PC Blocker';
  const appData = process.env.APPDATA;
  if (!appData) {
    return Promise.resolve(false);
  }

  const shortcutPath = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    SHORTCUT_NAME
  );

  const escapePs = (val) => String(val).replace(/'/g, "''");

  const psScript = `
$ErrorActionPreference = 'Stop'
$shortcutPath = '${escapePs(shortcutPath)}'
$targetPath = '${escapePs(exePath)}'
$argsText = '${escapePs(appArgs)}'
$aumid = '${escapePs(appUserModelId)}'
$displayName = '${escapePs(displayName)}'

$regPath = "HKCU:\\Software\\Classes\\AppUserModelId\\$aumid"
if (-not (Test-Path $regPath)) {
  New-Item -Path $regPath -Force | Out-Null
}
New-ItemProperty -Path $regPath -Name 'DisplayName' -Value $displayName -PropertyType String -Force | Out-Null

$dir = Split-Path -Parent $shortcutPath
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$code = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class PcBlockerShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
  }

  public static void Create(string shortcutPath, string targetPath, string arguments, string aumid) {
    IShellLinkW link = (IShellLinkW)new ShellLink();
    link.SetPath(targetPath);
    if (!string.IsNullOrEmpty(arguments)) {
      link.SetArguments(arguments);
    }
    IPropertyStore store = (IPropertyStore)link;
    PROPERTYKEY key = new PROPERTYKEY {
      fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      pid = 5
    };
    PROPVARIANT pv = new PROPVARIANT {
      vt = 31, // VT_LPWSTR
      pwszVal = Marshal.StringToCoTaskMemUni(aumid)
    };
    try {
      store.SetValue(ref key, ref pv);
      store.Commit();
    } finally {
      Marshal.FreeCoTaskMem(pv.pwszVal);
    }
    ((IPersistFile)link).Save(shortcutPath, true);
  }
}
"@
Add-Type -TypeDefinition $code
[PcBlockerShortcut]::Create($shortcutPath, $targetPath, $argsText, $aumid)
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000 },
      (err) => {
        if (err) {
          console.warn('Could not register Start Menu AUMID shortcut:', err.message);
          resolve(false);
          return;
        }
        resolve(fs.existsSync(shortcutPath));
      }
    );
  });
}

/**
 * Dispatches high-priority Windows system pop-up notifications for detection verification
 * (with automatic Tray balloon fallback and terminal log telemetry).
 */
class DetectionNotifier {
  /**
   * @param {object} [options]
   * @param {typeof import('electron').Notification} [options.NotificationClass]
   * @param {() => import('electron').Tray|null} [options.getTray]
   * @param {boolean} [options.isSmokeTest]
   * @param {Console} [options.logger]
   */
  constructor(options = {}) {
    this.NotificationClass = options.NotificationClass || null;
    this.getTray = options.getTray || (() => null);
    this.isSmokeTest = Boolean(options.isSmokeTest);
    this.notificationsEnabled =
      options.notificationsEnabled !== undefined
        ? Boolean(options.notificationsEnabled)
        : SYSTEM_NOTIFICATIONS_ENABLED;
    this.logger = options.logger || console;
  }

  _showTrayFallback(payload) {
    const tray = typeof this.getTray === 'function' ? this.getTray() : null;
    if (!tray || typeof tray.displayBalloon !== 'function') {
      return false;
    }
    try {
      tray.displayBalloon({
        iconType: payload.iconType || 'info',
        title: payload.title,
        content: payload.body,
        largeIcon: true,
        respectQuietTime: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Logs and shows a high-priority pop-up notification for a WindowEvaluator verdict event.
   * @param {object} event
   */
  notify(event) {
    if (!event) return;

    const payload = formatDetectionNotification(event);
    const sample = event.sample || {};
    const conf = formatPct(event?.confidence);
    const pDist = formatPct(event?.distractionProb ?? event?.probabilities?.distraction);
    this.logger.log(
      `[PC-Blocker][${event.gate}][${event.status}] ${payload.title} | conf: ${conf} | distract: ${pDist} :: ${sample.processName || ''} :: "${sample.windowTitle || ''}" (incognito=${Boolean(sample.isIncognito)})`
    );

    if (this.isSmokeTest || !this.notificationsEnabled) {
      return;
    }

    const Notif = this.NotificationClass;
    const supported = Notif && (typeof Notif.isSupported !== 'function' || Notif.isSupported());

    if (supported) {
      try {
        const opts = {
          title: payload.title,
          body: payload.body,
          urgency: 'critical',
        };
        if (process.platform === 'win32') {
          opts.toastXml = buildUrgentToastXml(payload);
        }

        const notif = new Notif(opts);
        if (typeof notif.once === 'function') {
          notif.once('failed', () => {
            this._showTrayFallback(payload);
          });
        }
        notif.show();
        return;
      } catch {
        // Fall through to tray balloon
      }
    }

    this._showTrayFallback(payload);
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  SHORTCUT_NAME,
  escapeXml,
  buildUrgentToastXml,
  formatDetectionNotification,
  ensureWindowsNotificationShortcut,
  DetectionNotifier,
};

