const { CHOICE_KEYS } = require('./typesafe-client');
const { DISTRACTION_BLOCK_THRESHOLD } = require('./window-evaluator');

const DISTRACTION_BORDER_WINDOW_TITLE = 'PC Blocker Distraction Border';
const DISTRACTION_BORDER_ENABLED = true;

/**
 * Determines whether the full-screen blinking red distraction border should be shown.
 * Requires ALL blocking criteria to be met:
 * - choice === 'distraction'
 * - decision === 'BLOCKED'
 * - confidence or distractionProb >= minimum threshold (0.65)
 * @param {object} [verdict]
 * @param {number} [minThreshold]
 * @returns {boolean}
 */
function shouldShowDistractionBorder(verdict, minThreshold = DISTRACTION_BLOCK_THRESHOLD) {
  if (!verdict || typeof verdict !== 'object') {
    return false;
  }
  const activeVerdict = verdict.geminiVerdict || verdict.jevOcrVerdict || verdict;
  if (activeVerdict.decision !== 'BLOCKED') {
    return false;
  }
  if (activeVerdict.choice !== CHOICE_KEYS.DISTRACTION) {
    return false;
  }
  const confidence = Number(activeVerdict.confidence ?? 0);
  const distractionProb = Number(
    activeVerdict.distractionProb ??
      activeVerdict.probabilities?.[CHOICE_KEYS.DISTRACTION] ??
      0
  );
  const effectiveScore = Math.max(confidence, distractionProb);
  return Number.isFinite(effectiveScore) && effectiveScore >= minThreshold;
}

/**
 * Formats the step label (Step 1, Step 2, or Step 3) and telemetry text shown on the red border banner.
 * @param {object} [verdict]
 * @returns {{ stepNumber: number, stepLabel: string, bannerTitle: string, bannerDetail: string }}
 */
function formatDistractionStepLabel(verdict = {}) {
  const activeVerdict = verdict.geminiVerdict || verdict.jevOcrVerdict || verdict;
  let stepNumber = Number(activeVerdict.step) || 1;
  if (!activeVerdict.step) {
    if (activeVerdict.gate === 'GATE_3_OCR_GEMINI') stepNumber = 3;
    else if (activeVerdict.gate === 'GATE_2_JEV_OCR') stepNumber = 2;
    else stepNumber = 1;
  }

  let stepLabel = 'STEP 1 • JEV (TITLE)';
  if (stepNumber === 2) {
    stepLabel = 'STEP 2 • JEV (FULL-SCREEN OCR)';
  } else if (stepNumber === 3) {
    stepLabel = 'STEP 3 • GEMINI (FULL-SCREEN OCR)';
  }

  const confPct = Math.round(Number(activeVerdict.confidence ?? 0) * 100);
  const distPct = Math.round(
    Number(
      activeVerdict.distractionProb ??
        activeVerdict.probabilities?.[CHOICE_KEYS.DISTRACTION] ??
        activeVerdict.confidence ??
        0
    ) * 100
  );
  const winTitle = String(activeVerdict.sample?.windowTitle || '').trim();
  const shortTitle =
    winTitle.length > 56 ? `${winTitle.slice(0, 53)}...` : winTitle || 'Active Window';

  return {
    stepNumber,
    stepLabel,
    bannerTitle: `DISTRACTION DETECTED — ${stepLabel}`,
    bannerDetail: `Distract: ${distPct}% • Conf: ${confPct}% • ${shortTitle}`,
  };
}

function buildDistractionBorderHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${DISTRACTION_BORDER_WINDOW_TITLE}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: transparent;
      pointer-events: none;
      user-select: none;
      font-family: "Cascadia Mono", "Consolas", "Segoe UI", monospace;
    }
    .border-frame {
      position: fixed;
      inset: 0;
      border: 8px solid #ff1e1e;
      box-shadow:
        inset 0 0 22px rgba(255, 20, 20, 0.75),
        inset 0 0 6px rgba(255, 20, 20, 0.9);
      pointer-events: none;
    }
    .bottom-banner-wrap {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      z-index: 10;
    }
    .bottom-banner {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 6px 18px;
      border-radius: 7px;
      border: 2px solid #ff4d4d;
      background: rgba(185, 28, 28, 0.96);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.65);
      color: #ffffff;
      text-align: center;
    }
    .banner-title {
      font-size: 12.5px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #ffffff;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    }
    .banner-detail {
      font-size: 10.5px;
      font-weight: 600;
      color: #fee2e2;
    }
    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <div id="root-container" class="hidden">
    <div class="border-frame"></div>
    <div id="bottom-banner-wrap" class="bottom-banner-wrap hidden">
      <div class="bottom-banner">
        <div id="banner-title" class="banner-title">DISTRACTION DETECTED — STEP 1 • JEV (TITLE)</div>
        <div id="banner-detail" class="banner-detail">Distract: — • Conf: —</div>
      </div>
    </div>
  </div>
  <script>
    window.__updateDistractionBorder = function(payload) {
      const root = document.getElementById('root-container');
      const bannerWrap = document.getElementById('bottom-banner-wrap');
      const titleEl = document.getElementById('banner-title');
      const detailEl = document.getElementById('banner-detail');
      if (!root) return;

      if (!payload || !payload.visible) {
        root.classList.add('hidden');
        if (bannerWrap) bannerWrap.classList.add('hidden');
        return;
      }

      titleEl.textContent = payload.bannerTitle || 'DISTRACTION DETECTED';
      detailEl.textContent = payload.bannerDetail || '';
      if (bannerWrap) {
        if (payload.showText) {
          bannerWrap.classList.remove('hidden');
        } else {
          bannerWrap.classList.add('hidden');
        }
      }
      root.classList.remove('hidden');
    };
  </script>
</body>
</html>`;
}

/**
 * Manages the full-screen click-through blinking red border overlay that alerts
 * the user when a distraction is detected and shows which step (Step 1, 2, or 3) caught it.
 */
class DistractionBorderOverlay {
  /**
   * @param {object} [options]
   * @param {typeof import('electron').BrowserWindow} [options.BrowserWindowClass]
   * @param {import('electron').Screen} [options.screenModule]
   * @param {boolean} [options.enabled]
   * @param {boolean} [options.isSmokeTest]
   * @param {number} [options.minThreshold]
   */
  constructor(options = {}) {
    this.BrowserWindowClass = options.BrowserWindowClass || null;
    this.screenModule = options.screenModule || null;
    this.isSmokeTest = Boolean(options.isSmokeTest);
    this.enabled =
      options.enabled !== undefined ? Boolean(options.enabled) : DISTRACTION_BORDER_ENABLED;
    this.minThreshold = options.minThreshold ?? DISTRACTION_BLOCK_THRESHOLD;

    this.window = null;
    this.isReady = false;
    this.isVisible = false;
    this.isBannerTextVisible = false;
    this.lastBannerPayload = null;
  }

  ensureWindow() {
    if (!this.enabled || this.isSmokeTest || !this.BrowserWindowClass || !this.screenModule) {
      return null;
    }
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    let bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    try {
      const primary =
        typeof this.screenModule.getPrimaryDisplay === 'function'
          ? this.screenModule.getPrimaryDisplay()
          : null;
      if (primary && primary.bounds) {
        bounds = primary.bounds;
      }
    } catch {}

    this.isReady = false;
    this.window = new this.BrowserWindowClass({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      hasShadow: false,
      title: DISTRACTION_BORDER_WINDOW_TITLE,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (typeof this.window.setIgnoreMouseEvents === 'function') {
      try {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      } catch {}
    }
    if (typeof this.window.setAlwaysOnTop === 'function') {
      this.window.setAlwaysOnTop(true, 'screen-saver');
    }
    if (typeof this.window.setVisibleOnAllWorkspaces === 'function') {
      try {
        this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {}
    }

    this.window.on('closed', () => {
      this.window = null;
      this.isReady = false;
      this.isVisible = false;
    });

    if (this.window.webContents && typeof this.window.webContents.once === 'function') {
      this.window.webContents.once('did-finish-load', () => {
        this.isReady = true;
        if (this.lastBannerPayload) {
          this._applyBannerPayload(this.lastBannerPayload);
        }
      });
    }

    const htmlDataUrl =
      'data:text/html;charset=utf-8,' + encodeURIComponent(buildDistractionBorderHtml());
    if (typeof this.window.loadURL === 'function') {
      this.window.loadURL(htmlDataUrl).catch(() => {});
    }

    return this.window;
  }

  _applyBannerPayload(payload) {
    if (!this.window || this.window.isDestroyed() || !this.isReady) {
      return;
    }

    if (
      this.window.webContents &&
      typeof this.window.webContents.executeJavaScript === 'function'
    ) {
      const serialized = JSON.stringify(payload);
      this.window.webContents
        .executeJavaScript(
          `window.__updateDistractionBorder && window.__updateDistractionBorder(${serialized});`
        )
        .catch(() => {});
    }

    if (payload && payload.visible) {
      try {
        if (this.screenModule && typeof this.screenModule.getPrimaryDisplay === 'function') {
          const primary = this.screenModule.getPrimaryDisplay();
          if (primary && primary.bounds && typeof this.window.setBounds === 'function') {
            this.window.setBounds(primary.bounds);
          }
        }
        if (typeof this.window.setIgnoreMouseEvents === 'function') {
          this.window.setIgnoreMouseEvents(true, { forward: true });
        }
        if (typeof this.window.showInactive === 'function') {
          this.window.showInactive();
        } else if (typeof this.window.show === 'function') {
          this.window.show();
        }
        if (typeof this.window.setAlwaysOnTop === 'function') {
          this.window.setAlwaysOnTop(true, 'screen-saver');
        }
        this.isVisible = true;
      } catch {}
    } else {
      try {
        if (typeof this.window.hide === 'function') {
          this.window.hide();
        }
        this.isVisible = false;
      } catch {}
    }
  }

  /**
   * Evaluates a verdict event and shows or hides the blinking red border accordingly.
   * @param {object} [verdict]
   * @returns {boolean} True if border is shown, false if hidden
   */
  updateForVerdict(verdict) {
    if (!this.enabled || this.isSmokeTest) {
      return false;
    }

    const shouldShow = shouldShowDistractionBorder(verdict, this.minThreshold);
    if (!shouldShow) {
      this.hide();
      return false;
    }

    const formatted = formatDistractionStepLabel(verdict);
    const payload = {
      visible: true,
      showText: this.isBannerTextVisible,
      ...formatted,
    };
    this.lastBannerPayload = payload;
    this.ensureWindow();
    this._applyBannerPayload(payload);
    return true;
  }

  /**
   * Toggles the center-bottom info text box when the red distraction border is currently shown.
   * Triggered globally via Ctrl+Shift+S.
   * @returns {boolean} True if toggled, false if the red border is not currently visible
   */
  toggleBannerText() {
    if (!this.isVisible || !this.lastBannerPayload || !this.lastBannerPayload.visible) {
      return false;
    }

    this.isBannerTextVisible = !this.isBannerTextVisible;
    this.lastBannerPayload = {
      ...this.lastBannerPayload,
      showText: this.isBannerTextVisible,
    };
    this._applyBannerPayload(this.lastBannerPayload);
    return true;
  }

  /**
   * Hides the red border and resets the info text box visibility immediately.
   */
  hide() {
    this.isBannerTextVisible = false;
    this.lastBannerPayload = { visible: false, showText: false };
    if (!this.window || this.window.isDestroyed()) {
      this.isVisible = false;
      return;
    }
    this._applyBannerPayload(this.lastBannerPayload);
  }

  hideForOcrCapture() {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      if (typeof this.window.setOpacity === 'function') {
        this.window.setOpacity(0);
      }
    } catch {}
  }

  restoreAfterOcrCapture() {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      if (typeof this.window.setOpacity === 'function') {
        this.window.setOpacity(1);
      }
    } catch {}
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
    this.isReady = false;
    this.isVisible = false;
  }
}

module.exports = {
  DISTRACTION_BORDER_WINDOW_TITLE,
  DISTRACTION_BORDER_ENABLED,
  shouldShowDistractionBorder,
  formatDistractionStepLabel,
  buildDistractionBorderHtml,
  DistractionBorderOverlay,
};

