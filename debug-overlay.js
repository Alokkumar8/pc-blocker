const path = require('node:path');

const DEBUG_OVERLAY_WINDOW_TITLE = 'PC Blocker Jev Overlay';
const DEBUG_OVERLAY_ENABLED = true;
const DEFAULT_OVERLAY_WIDTH = 445;
const DEFAULT_OVERLAY_HEIGHT = 282;

function buildOverlayHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${DEBUG_OVERLAY_WINDOW_TITLE}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 100%;
      overflow: hidden;
      background: #09090b;
      color: #f4f4f5;
      font-family: "Cascadia Mono", "Consolas", "Segoe UI", monospace;
      font-size: 11px;
      user-select: none;
      -webkit-app-region: drag;
      cursor: grab;
    }
    .overlay-root {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: auto;
      padding: 10px 12px;
      gap: 7px;
      border: 1px solid #27272a;
      border-radius: 8px;
      background: #09090b;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #27272a;
      padding-bottom: 6px;
      gap: 6px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 10px;
      color: #a1a1aa;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #00ff41;
      box-shadow: 0 0 6px #00ff41;
      flex-shrink: 0;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .copy-btn {
      -webkit-app-region: no-drag;
      cursor: pointer;
      font-family: inherit;
      font-weight: 700;
      font-size: 9.5px;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.02em;
      background: #18181b;
      color: #e4e4e7;
      border: 1px solid #3f3f46;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
      white-space: nowrap;
    }
    .copy-btn:hover:not(:disabled) {
      background: #27272a;
      border-color: #71717a;
      color: #ffffff;
    }
    .copy-btn:active:not(:disabled) {
      background: #3f3f46;
    }
    .copy-btn:disabled {
      opacity: 0.45;
      cursor: wait;
    }
    .copy-btn.copied {
      background: rgba(0, 255, 65, 0.16);
      color: #00ff41;
      border-color: rgba(0, 255, 65, 0.45);
    }
    .jev-ocr-btn {
      background: rgba(251, 191, 36, 0.14);
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.45);
    }
    .jev-ocr-btn:hover:not(:disabled) {
      background: rgba(251, 191, 36, 0.26);
      border-color: #fbbf24;
      color: #fef3c7;
    }
    .jev-ocr-btn.active-view {
      background: rgba(251, 191, 36, 0.3);
      color: #ffffff;
      border-color: #fbbf24;
    }
    .gemini-btn {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.5);
    }
    .gemini-btn:hover:not(:disabled) {
      background: rgba(56, 189, 248, 0.28);
      border-color: #38bdf8;
      color: #e0f2fe;
    }
    .gemini-btn.active-view {
      background: rgba(56, 189, 248, 0.3);
      color: #ffffff;
      border-color: #38bdf8;
    }
    .compare-btn {
      background: rgba(192, 132, 252, 0.14);
      color: #c084fc;
      border-color: rgba(192, 132, 252, 0.45);
    }
    .compare-btn:hover:not(:disabled) {
      background: rgba(192, 132, 252, 0.26);
      border-color: #c084fc;
      color: #f3e8ff;
    }
    .compare-btn.active-view {
      background: rgba(192, 132, 252, 0.28);
      color: #ffffff;
      border-color: #c084fc;
    }
    .hidden {
      display: none !important;
    }
    .decision-badge {
      font-weight: 700;
      font-size: 9.5px;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: #18181b;
      color: #a1a1aa;
      border: 1px solid #3f3f46;
      white-space: nowrap;
    }
    .decision-badge.allow {
      background: rgba(0, 255, 65, 0.14);
      color: #00ff41;
      border-color: rgba(0, 255, 65, 0.4);
    }
    .decision-badge.block {
      background: rgba(239, 68, 68, 0.18);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.5);
    }
    .decision-badge.pending {
      background: rgba(251, 191, 36, 0.16);
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.45);
    }
    .decision-badge.evaluating {
      background: rgba(56, 189, 248, 0.16);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.45);
    }
    .window-box {
      background: #121215;
      border: 1px solid #27272a;
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .win-title {
      color: #ffffff;
      font-weight: 600;
      font-size: 11px;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      min-height: 28px;
    }
    .win-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #a1a1aa;
      font-size: 10px;
      gap: 6px;
    }
    .incognito-pill {
      color: #c084fc;
      font-weight: 700;
    }
    .source-tag {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 700;
      background: #27272a;
      color: #e4e4e7;
    }
    .source-tag.jev-ocr {
      background: rgba(251, 191, 36, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(251, 191, 36, 0.45);
    }
    .source-tag.gemini {
      background: rgba(56, 189, 248, 0.2);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.4);
    }
    .source-tag.compare {
      background: rgba(192, 132, 252, 0.2);
      color: #c084fc;
      border: 1px solid rgba(192, 132, 252, 0.4);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: 1.45fr 1fr 1fr;
      gap: 6px;
    }
    .metric-card {
      background: #121215;
      border: 1px solid #27272a;
      border-radius: 5px;
      padding: 5px 7px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .metric-label {
      color: #71717a;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .metric-value {
      color: #f4f4f5;
      font-weight: 700;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric-value.type-direct_work { color: #00ff41; }
    .metric-value.type-work_plumbing { color: #38bdf8; }
    .metric-value.type-distraction { color: #f87171; }
    .metric-value.type-cannot_determine { color: #fbbf24; }
    .metric-value.danger { color: #f87171; }
    .metric-sub {
      color: #71717a;
      font-size: 9px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric-sub.escalate-hint {
      color: #fbbf24;
    }
    .metric-sub.resolved-hint {
      color: #00ff41;
    }
    .probs-box {
      background: #121215;
      border: 1px solid #27272a;
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .prob-row {
      display: grid;
      grid-template-columns: 110px 1fr 36px;
      align-items: center;
      gap: 6px;
      font-size: 10px;
    }
    .prob-name {
      color: #d4d4d8;
    }
    .prob-bar-bg {
      height: 5px;
      background: #27272a;
      border-radius: 3px;
      overflow: hidden;
    }
    .prob-bar-fill {
      height: 100%;
      width: 0%;
      transition: width 0.15s ease;
    }
    .fill-direct_work { background: #00ff41; }
    .fill-work_plumbing { background: #38bdf8; }
    .fill-distraction { background: #f87171; }
    .fill-cannot_determine { background: #fbbf24; }
    .prob-pct {
      text-align: right;
      color: #a1a1aa;
      font-variant-numeric: tabular-nums;
    }
    .ocr-box {
      -webkit-app-region: no-drag;
      background: #121215;
      border: 1px solid rgba(251, 191, 36, 0.35);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ocr-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 9px;
      color: #fbbf24;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .ocr-text {
      -webkit-app-region: no-drag;
      user-select: text;
      cursor: text;
      color: #d4d4d8;
      font-size: 9.5px;
      line-height: 1.38;
      max-height: 115px;
      overflow-y: auto;
      overflow-x: hidden;
      white-space: pre-wrap;
      word-break: break-word;
      padding-right: 4px;
    }
    .ocr-text::-webkit-scrollbar,
    .reason-text::-webkit-scrollbar {
      width: 6px;
    }
    .ocr-text::-webkit-scrollbar-track,
    .reason-text::-webkit-scrollbar-track {
      background: #18181b;
      border-radius: 3px;
    }
    .ocr-text::-webkit-scrollbar-thumb,
    .reason-text::-webkit-scrollbar-thumb {
      background: #3f3f46;
      border-radius: 3px;
    }
    .ocr-text::-webkit-scrollbar-thumb:hover,
    .reason-text::-webkit-scrollbar-thumb:hover {
      background: #52525b;
    }
    .reason-box {
      -webkit-app-region: no-drag;
      background: #121215;
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .reason-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 9px;
      color: #38bdf8;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .reason-text {
      -webkit-app-region: no-drag;
      user-select: text;
      cursor: text;
      color: #e4e4e7;
      font-size: 10px;
      line-height: 1.35;
      max-height: 95px;
      overflow-y: auto;
      overflow-x: hidden;
      white-space: pre-wrap;
      word-break: break-word;
      padding-right: 4px;
    }
    .compare-box {
      background: #121215;
      border: 1px solid rgba(192, 132, 252, 0.4);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .compare-row {
      display: grid;
      grid-template-columns: 104px 1fr 1fr 1fr;
      align-items: center;
      gap: 5px;
      font-size: 9.5px;
    }
    .compare-row.header {
      color: #a1a1aa;
      font-weight: 700;
      font-size: 8.5px;
      text-transform: uppercase;
      border-bottom: 1px solid #27272a;
      padding-bottom: 3px;
    }
    .compare-cell {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .footer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #71717a;
      font-size: 9.5px;
      padding-top: 2px;
    }
  </style>
</head>
<body>
  <div id="overlay-root" class="overlay-root">
    <div class="header-row">
      <div class="brand">
        <span class="live-dot"></span>
        <span id="brand-label">JEV OVERLAY</span>
      </div>
      <div class="header-actions">
        <button id="jev-ocr-btn" class="copy-btn jev-ocr-btn" type="button" title="Step 2: Run Windows Full-Screen OCR + Jev API (jev-latest)">Jev OCR</button>
        <button id="gemini-btn" class="copy-btn gemini-btn" type="button" title="Step 3: Run Windows Full-Screen OCR + Gemini (gemini-4-hydrogen low)">Gemini</button>
        <button id="compare-btn" class="copy-btn compare-btn hidden" type="button" title="Compare Step 1 (Jev Title) vs Step 2 (Jev OCR) vs Step 3 (Gemini)">Compare</button>
        <button id="copy-btn" class="copy-btn" type="button" title="Copy widget info to clipboard">Copy</button>
        <span id="decision-badge" class="decision-badge">WAITING</span>
      </div>
    </div>

    <div class="window-box">
      <div id="win-title" class="win-title">Waiting for active window...</div>
      <div class="win-meta">
        <span id="win-proc">process: —</span>
        <span id="win-gate">gate: —</span>
      </div>
    </div>

    <div id="standard-view">
      <div class="metrics-grid" style="margin-bottom: 7px;">
        <div class="metric-card">
          <span class="metric-label">Blocking Type</span>
          <span id="val-type" class="metric-value">—</span>
          <span id="sub-status" class="metric-sub">status: idle</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Confidence</span>
          <span id="val-conf" class="metric-value">—</span>
          <span id="sub-conf" class="metric-sub">raw: n/a</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Distract Score</span>
          <span id="val-dist" class="metric-value">—</span>
          <span id="sub-dist" class="metric-sub">block &ge; 80%</span>
        </div>
      </div>

      <div class="probs-box">
        <div class="prob-row">
          <span class="prob-name">direct_work</span>
          <div class="prob-bar-bg"><div id="bar-direct_work" class="prob-bar-fill fill-direct_work"></div></div>
          <span id="pct-direct_work" class="prob-pct">—</span>
        </div>
        <div class="prob-row">
          <span class="prob-name">work_plumbing</span>
          <div class="prob-bar-bg"><div id="bar-work_plumbing" class="prob-bar-fill fill-work_plumbing"></div></div>
          <span id="pct-work_plumbing" class="prob-pct">—</span>
        </div>
        <div class="prob-row">
          <span class="prob-name">distraction</span>
          <div class="prob-bar-bg"><div id="bar-distraction" class="prob-bar-fill fill-distraction"></div></div>
          <span id="pct-distraction" class="prob-pct">—</span>
        </div>
        <div class="prob-row">
          <span class="prob-name">cannot_determine</span>
          <div class="prob-bar-bg"><div id="bar-cannot_determine" class="prob-bar-fill fill-cannot_determine"></div></div>
          <span id="pct-cannot_determine" class="prob-pct">—</span>
        </div>
      </div>
    </div>

    <div id="compare-view" class="compare-box hidden">
      <div class="compare-row header">
        <span>Metric</span>
        <span>1. Jev Title</span>
        <span>2. Jev OCR</span>
        <span>3. Gemini</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">choice</span>
        <span id="cmp-jev-choice" class="compare-cell">—</span>
        <span id="cmp-jevocr-choice" class="compare-cell">—</span>
        <span id="cmp-gem-choice" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">decision</span>
        <span id="cmp-jev-decision" class="compare-cell">—</span>
        <span id="cmp-jevocr-decision" class="compare-cell">—</span>
        <span id="cmp-gem-decision" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">confidence</span>
        <span id="cmp-jev-conf" class="compare-cell">—</span>
        <span id="cmp-jevocr-conf" class="compare-cell">—</span>
        <span id="cmp-gem-conf" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">direct_work</span>
        <span id="cmp-jev-dw" class="compare-cell">—</span>
        <span id="cmp-jevocr-dw" class="compare-cell">—</span>
        <span id="cmp-gem-dw" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">work_plumbing</span>
        <span id="cmp-jev-wp" class="compare-cell">—</span>
        <span id="cmp-jevocr-wp" class="compare-cell">—</span>
        <span id="cmp-gem-wp" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">distraction</span>
        <span id="cmp-jev-dist" class="compare-cell">—</span>
        <span id="cmp-jevocr-dist" class="compare-cell">—</span>
        <span id="cmp-gem-dist" class="compare-cell">—</span>
      </div>
      <div class="compare-row">
        <span class="prob-name">cannot_determine</span>
        <span id="cmp-jev-cd" class="compare-cell">—</span>
        <span id="cmp-jevocr-cd" class="compare-cell">—</span>
        <span id="cmp-gem-cd" class="compare-cell">—</span>
      </div>
    </div>

    <div id="ocr-preview-box" class="ocr-box hidden">
      <div class="ocr-header">
        <span id="ocr-preview-label">STEP 2: JEV (OCR) SCREEN TEXT</span>
        <span id="ocr-preview-meta">jev-latest + Windows OCR</span>
      </div>
      <div id="ocr-preview-text" class="ocr-text">—</div>
    </div>

    <div id="gemini-reason-box" class="reason-box hidden">
      <div class="reason-header">
        <span id="reason-label">STEP 3: GEMINI (OCR) REASON</span>
        <span id="reason-meta">gemini-4-hydrogen (low)</span>
      </div>
      <div id="reason-text" class="reason-text">—</div>
    </div>

    <div class="footer-row">
      <span id="footer-tasks">Tasks committed: 0</span>
      <span id="footer-time">Updated: —</span>
    </div>
  </div>

  <script>
    let latestJevData = null;       // Step 1: Jev Title
    let latestJevOcrData = null;    // Step 2: Jev + Full-Screen OCR
    let latestGeminiData = null;    // Step 3: Gemini + Full-Screen OCR
    let activeViewMode = 'jev';     // 'jev' | 'jev_ocr' | 'gemini' | 'compare'
    let isRunningJevOcr = false;
    let isRunningGemini = false;
    let copyResetTimer = null;

    function fmtPct(v) {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 100) + '%' : 'n/a';
    }
    function fmtRaw(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(3) : 'n/a';
    }

    function syncOverlayHeight() {
      const rootEl = document.getElementById('overlay-root');
      if (!rootEl) return;
      const contentHeight = Math.ceil(rootEl.offsetHeight || rootEl.scrollHeight || 0);
      if (
        contentHeight > 0 &&
        window.pcBlocker &&
        typeof window.pcBlocker.resizeOverlay === 'function'
      ) {
        try {
          Promise.resolve(window.pcBlocker.resizeOverlay(contentHeight)).catch(() => {});
        } catch {}
      }
    }

    function formatVerdictSection(label, data) {
      if (!data) return [];
      const decisionLabel =
        data.decision === 'BLOCKED' || (data.status && data.status.includes('BLOCK'))
          ? 'WOULD BLOCK'
          : (data.decision || 'ALLOWED');
      const blockingType = data.choice || data.category || 'n/a';
      const confNum = Number(data.confidence);
      const distNum = Number(data.distractionProb ?? (data.probabilities && data.probabilities.distraction));
      const probs = data.probabilities || {};
      const latencyStr = Number.isFinite(data.latencyMs) ? data.latencyMs + 'ms' : 'n/a';

      const lines = [
        '--- ' + label + ' ---',
        'Decision: ' + decisionLabel + ' (' + (data.status || 'n/a') + ')',
        'Choice: ' + blockingType,
        'Gate & Latency: ' + (data.gate || 'MONITOR') + ' (' + latencyStr + ')',
        'Confidence: ' + fmtPct(confNum) + ' (raw: ' + fmtRaw(confNum) + ')',
        'Distract Score: ' + fmtPct(distNum) + ' (raw: ' + fmtRaw(distNum) + ')',
        'Probabilities:',
        '  - direct_work: ' + fmtPct(probs.direct_work) + ' (' + fmtRaw(probs.direct_work) + ')',
        '  - work_plumbing: ' + fmtPct(probs.work_plumbing) + ' (' + fmtRaw(probs.work_plumbing) + ')',
        '  - distraction: ' + fmtPct(probs.distraction) + ' (' + fmtRaw(probs.distraction) + ')',
        '  - cannot_determine: ' + fmtPct(probs.cannot_determine) + ' (' + fmtRaw(probs.cannot_determine) + ')',
      ];
      if (data.escalationReason) {
        lines.push(
          'Escalation Check: ' +
            (data.needsNextStep ? 'Move to next step' : 'Resolved') +
            ' (' +
            data.escalationReason +
            ')'
        );
      }
      if (data.ocrTextPreview) {
        lines.push('OCR Preview: ' + data.ocrTextPreview);
      }
      if (data.reason) {
        lines.push('Reason: ' + data.reason);
      }
      if (Number.isFinite(data.ocrChars)) {
        lines.push(
          'OCR Telemetry: ' +
            data.ocrChars +
            ' chars (' +
            (data.ocrLinesCount || 0) +
            ' lines, OCR ' +
            (data.ocrLatencyMs || 0) +
            'ms)'
        );
      }
      return lines;
    }

    function formatOverlayClipboardReport(jevData, jevOcrData, geminiData) {
      const base = jevData || jevOcrData || geminiData;
      if (!base) {
        return 'PC Blocker Jev Overlay — No window data captured yet.';
      }
      const sample = base.sample || {};
      const tasks = Array.isArray(base.tasks) ? base.tasks : [];

      const lines = [
        '=== PC Blocker 3-Step Evaluation Snapshot ===',
        'Window Title: ' + (sample.windowTitle || '<Untitled Window>'),
        'Process: ' + (sample.processName || 'unknown.exe') + (sample.isIncognito ? ' [INCOGNITO]' : ''),
      ];

      if (jevData) {
        lines.push(...formatVerdictSection('Step 1: Jev API (Title Only)', jevData));
      }
      if (jevOcrData) {
        lines.push(...formatVerdictSection('Step 2: Jev API (Full-Screen OCR)', jevOcrData));
      }
      if (geminiData) {
        lines.push(...formatVerdictSection('Step 3: Gemini OCR (gemini-4-hydrogen low)', geminiData));
      }

      if (jevData && (jevOcrData || geminiData)) {
        const c1 = jevData.choice || jevData.category || 'n/a';
        const c2 = jevOcrData ? (jevOcrData.choice || 'n/a') : '(skipped)';
        const c3 = geminiData ? (geminiData.choice || 'n/a') : '(not run)';
        lines.push(
          '--- 3-Step Progression Summary ---',
          'Choice Progression: ' + c1 + ' -> ' + c2 + ' -> ' + c3
        );
      }

      if (tasks.length > 0) {
        lines.push('Committed Tasks (' + tasks.length + '):');
        tasks.forEach((t, i) => {
          lines.push('  [' + (i + 1) + '] ' + t);
        });
      } else {
        lines.push('Committed Tasks: ' + (typeof base.tasksCount === 'number' ? base.tasksCount : 0));
      }

      const timeEl = document.getElementById('footer-time');
      if (timeEl && timeEl.textContent) {
        lines.push(timeEl.textContent);
      }

      return lines.join('\\n');
    }

    function copyTextToClipboard(text) {
      if (window.pcBlocker && typeof window.pcBlocker.writeClipboardText === 'function') {
        try {
          Promise.resolve(window.pcBlocker.writeClipboardText(text)).catch(() => {});
          return;
        } catch {}
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).catch(() => {});
        return;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {}
      document.body.removeChild(ta);
    }

    function applyBadgeState(badgeEl, data) {
      badgeEl.className = 'decision-badge';
      if (isRunningJevOcr) {
        badgeEl.textContent = 'STEP 2 OCR...';
        badgeEl.classList.add('evaluating');
        return;
      }
      if (isRunningGemini) {
        badgeEl.textContent = 'STEP 3 GEMINI...';
        badgeEl.classList.add('evaluating');
        return;
      }
      if (!data) {
        badgeEl.textContent = 'WAITING';
        return;
      }
      if (data.status === 'EVALUATING') {
        badgeEl.textContent = 'EVALUATING...';
        badgeEl.classList.add('evaluating');
      } else if (data.decision === 'BLOCKED' || (data.status && data.status.includes('BLOCK'))) {
        const stepSuffix = data.step ? ' (STEP ' + data.step + ')' : '';
        badgeEl.textContent = 'WOULD BLOCK' + stepSuffix;
        badgeEl.classList.add('block');
      } else if (data.decision === 'PENDING' || data.status === 'AMBIGUOUS_WAITING') {
        badgeEl.textContent = 'PENDING';
        badgeEl.classList.add('pending');
      } else {
        badgeEl.textContent = data.decision || 'ALLOWED';
        badgeEl.classList.add('allow');
      }
    }

    function renderSingleModelView(data, viewMode) {
      const gateEl = document.getElementById('win-gate');
      const typeEl = document.getElementById('val-type');
      const subStatusEl = document.getElementById('sub-status');
      const confEl = document.getElementById('val-conf');
      const subConfEl = document.getElementById('sub-conf');
      const distEl = document.getElementById('val-dist');
      const subDistEl = document.getElementById('sub-dist');

      const latencyStr = Number.isFinite(data.latencyMs) ? ' • ' + data.latencyMs + 'ms' : '';
      if (viewMode === 'jev_ocr') {
        gateEl.innerHTML =
          '<span class="source-tag jev-ocr">STEP 2: JEV OCR</span> ' +
          (Number.isFinite(data.latencyMs) ? data.latencyMs + 'ms' : '');
      } else if (viewMode === 'gemini') {
        gateEl.innerHTML =
          '<span class="source-tag gemini">STEP 3: GEMINI</span> ' +
          (Number.isFinite(data.latencyMs) ? data.latencyMs + 'ms' : '');
      } else {
        gateEl.textContent = 'STEP 1: ' + (data.gate || 'JEV TITLE') + latencyStr;
      }

      const blockingType = data.choice || data.category || '—';
      typeEl.textContent = blockingType;
      typeEl.className = 'metric-value type-' + blockingType;

      subStatusEl.className = 'metric-sub';
      if (viewMode === 'gemini') {
        subStatusEl.textContent =
          (data.model || 'gemini-4-hydrogen') + ' (' + (data.thinkingLevel || 'low') + ')';
      } else if (data.needsNextStep) {
        const nextStepNum = viewMode === 'jev_ocr' ? 3 : 2;
        subStatusEl.textContent = '→ Step ' + nextStepNum + ': ' + (data.escalationReason || 'low conf');
        subStatusEl.classList.add('escalate-hint');
      } else if (data.escalationReason) {
        subStatusEl.textContent = '✓ ' + data.escalationReason;
        subStatusEl.classList.add('resolved-hint');
      } else {
        subStatusEl.textContent = data.status || '—';
      }

      const confNum = Number(data.confidence);
      const distNum = Number(data.distractionProb ?? (data.probabilities && data.probabilities.distraction));

      confEl.textContent = fmtPct(confNum);
      subConfEl.textContent = 'raw: ' + fmtRaw(confNum);

      distEl.textContent = fmtPct(distNum);
      distEl.className = 'metric-value' + (Number.isFinite(distNum) && distNum >= 0.8 ? ' danger' : '');
      subDistEl.textContent = Number.isFinite(distNum) ? 'raw: ' + fmtRaw(distNum) : 'block ≥ 80%';

      const probs = data.probabilities || null;
      ['direct_work', 'work_plumbing', 'distraction', 'cannot_determine'].forEach((k) => {
        const bar = document.getElementById('bar-' + k);
        const pct = document.getElementById('pct-' + k);
        if (probs && Number.isFinite(Number(probs[k]))) {
          const val = Math.max(0, Math.min(1, Number(probs[k])));
          bar.style.width = Math.round(val * 100) + '%';
          pct.textContent = Math.round(val * 100) + '%';
        } else {
          bar.style.width = '0%';
          pct.textContent = '—';
        }
      });
    }

    function renderCompareView(jevData, jevOcrData, geminiData) {
      const gateEl = document.getElementById('win-gate');
      const jevProbs = (jevData && jevData.probabilities) || {};
      const jevOcrProbs = (jevOcrData && jevOcrData.probabilities) || {};
      const gemProbs = (geminiData && geminiData.probabilities) || {};

      gateEl.innerHTML = '<span class="source-tag compare">3-STEP COMPARE</span>';

      const setChoiceCell = (elId, choice) => {
        const el = document.getElementById(elId);
        if (!el) return;
        const c = choice || '—';
        el.textContent = c;
        el.className = 'compare-cell metric-value type-' + c;
        el.style.fontSize = '9.5px';
      };

      setChoiceCell('cmp-jev-choice', jevData && (jevData.choice || jevData.category));
      setChoiceCell('cmp-jevocr-choice', jevOcrData && jevOcrData.choice);
      setChoiceCell('cmp-gem-choice', geminiData && geminiData.choice);

      const setCellText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

      setCellText('cmp-jev-decision', (jevData && jevData.decision) || '—');
      setCellText('cmp-jevocr-decision', (jevOcrData && jevOcrData.decision) || '—');
      setCellText('cmp-gem-decision', (geminiData && geminiData.decision) || '—');

      setCellText(
        'cmp-jev-conf',
        jevData ? fmtPct(jevData.confidence) + ' (' + fmtRaw(jevData.confidence) + ')' : '—'
      );
      setCellText(
        'cmp-jevocr-conf',
        jevOcrData ? fmtPct(jevOcrData.confidence) + ' (' + fmtRaw(jevOcrData.confidence) + ')' : '—'
      );
      setCellText(
        'cmp-gem-conf',
        geminiData ? fmtPct(geminiData.confidence) + ' (' + fmtRaw(geminiData.confidence) + ')' : '—'
      );

      setCellText(
        'cmp-jev-dw',
        jevData ? fmtPct(jevProbs.direct_work) + ' (' + fmtRaw(jevProbs.direct_work) + ')' : '—'
      );
      setCellText(
        'cmp-jevocr-dw',
        jevOcrData ? fmtPct(jevOcrProbs.direct_work) + ' (' + fmtRaw(jevOcrProbs.direct_work) + ')' : '—'
      );
      setCellText(
        'cmp-gem-dw',
        geminiData ? fmtPct(gemProbs.direct_work) + ' (' + fmtRaw(gemProbs.direct_work) + ')' : '—'
      );

      setCellText(
        'cmp-jev-wp',
        jevData ? fmtPct(jevProbs.work_plumbing) + ' (' + fmtRaw(jevProbs.work_plumbing) + ')' : '—'
      );
      setCellText(
        'cmp-jevocr-wp',
        jevOcrData ? fmtPct(jevOcrProbs.work_plumbing) + ' (' + fmtRaw(jevOcrProbs.work_plumbing) + ')' : '—'
      );
      setCellText(
        'cmp-gem-wp',
        geminiData ? fmtPct(gemProbs.work_plumbing) + ' (' + fmtRaw(gemProbs.work_plumbing) + ')' : '—'
      );

      setCellText(
        'cmp-jev-dist',
        jevData ? fmtPct(jevProbs.distraction) + ' (' + fmtRaw(jevProbs.distraction) + ')' : '—'
      );
      setCellText(
        'cmp-jevocr-dist',
        jevOcrData ? fmtPct(jevOcrProbs.distraction) + ' (' + fmtRaw(jevOcrProbs.distraction) + ')' : '—'
      );
      setCellText(
        'cmp-gem-dist',
        geminiData ? fmtPct(gemProbs.distraction) + ' (' + fmtRaw(gemProbs.distraction) + ')' : '—'
      );

      setCellText(
        'cmp-jev-cd',
        jevData ? fmtPct(jevProbs.cannot_determine) + ' (' + fmtRaw(jevProbs.cannot_determine) + ')' : '—'
      );
      setCellText(
        'cmp-jevocr-cd',
        jevOcrData ? fmtPct(jevOcrProbs.cannot_determine) + ' (' + fmtRaw(jevOcrProbs.cannot_determine) + ')' : '—'
      );
      setCellText(
        'cmp-gem-cd',
        geminiData ? fmtPct(gemProbs.cannot_determine) + ' (' + fmtRaw(gemProbs.cannot_determine) + ')' : '—'
      );
    }

    function renderOverlayState() {
      const badgeEl = document.getElementById('decision-badge');
      const titleEl = document.getElementById('win-title');
      const procEl = document.getElementById('win-proc');
      const tasksEl = document.getElementById('footer-tasks');
      const timeEl = document.getElementById('footer-time');
      const jevOcrBtn = document.getElementById('jev-ocr-btn');
      const geminiBtn = document.getElementById('gemini-btn');
      const compareBtn = document.getElementById('compare-btn');
      const standardView = document.getElementById('standard-view');
      const compareView = document.getElementById('compare-view');
      const ocrBox = document.getElementById('ocr-preview-box');
      const ocrPreviewLabel = document.getElementById('ocr-preview-label');
      const ocrPreviewMeta = document.getElementById('ocr-preview-meta');
      const ocrPreviewText = document.getElementById('ocr-preview-text');
      const reasonBox = document.getElementById('gemini-reason-box');
      const reasonLabel = document.getElementById('reason-label');
      const reasonMeta = document.getElementById('reason-meta');
      const reasonText = document.getElementById('reason-text');

      const busy = isRunningJevOcr || isRunningGemini;

      if (jevOcrBtn) {
        jevOcrBtn.disabled = busy;
        jevOcrBtn.textContent = isRunningJevOcr ? 'OCR...' : 'Jev OCR';
        jevOcrBtn.classList.toggle(
          'active-view',
          activeViewMode === 'jev_ocr' && Boolean(latestJevOcrData)
        );
      }

      if (geminiBtn) {
        geminiBtn.disabled = busy;
        geminiBtn.textContent = isRunningGemini ? 'Gemini...' : 'Gemini';
        geminiBtn.classList.toggle(
          'active-view',
          activeViewMode === 'gemini' && Boolean(latestGeminiData)
        );
      }

      const hasExtraStep = Boolean(latestJevOcrData || latestGeminiData);
      if (hasExtraStep) {
        compareBtn.classList.remove('hidden');
        compareBtn.classList.toggle('active-view', activeViewMode === 'compare');
        compareBtn.textContent = activeViewMode === 'compare' ? 'Single View' : 'Compare';
      } else {
        compareBtn.classList.add('hidden');
        compareBtn.classList.remove('active-view');
      }

      const currentStepData =
        activeViewMode === 'gemini' && latestGeminiData
          ? latestGeminiData
          : activeViewMode === 'jev_ocr' && latestJevOcrData
            ? latestJevOcrData
            : (latestJevData || latestJevOcrData || latestGeminiData);

      if (currentStepData) {
        const sample =
          currentStepData.sample ||
          (latestJevData && latestJevData.sample) ||
          {};
        titleEl.textContent = sample.windowTitle || '<Untitled Window>';
        procEl.innerHTML =
          (sample.processName || 'unknown.exe') +
          (sample.isIncognito ? ' <span class="incognito-pill">[INCOGNITO]</span>' : '');

        if (activeViewMode === 'compare' && hasExtraStep) {
          standardView.classList.add('hidden');
          compareView.classList.remove('hidden');
          const latestFinal = latestGeminiData || latestJevOcrData || latestJevData;
          applyBadgeState(badgeEl, latestFinal);
          renderCompareView(latestJevData, latestJevOcrData, latestGeminiData);
        } else {
          compareView.classList.add('hidden');
          standardView.classList.remove('hidden');
          applyBadgeState(badgeEl, currentStepData);
          renderSingleModelView(currentStepData, activeViewMode);
        }

        const tasksCount =
          typeof currentStepData.tasksCount === 'number'
            ? currentStepData.tasksCount
            : (latestJevData && typeof latestJevData.tasksCount === 'number'
                ? latestJevData.tasksCount
                : 0);
        tasksEl.textContent = 'Tasks committed: ' + tasksCount;

        const now = new Date();
        timeEl.textContent = 'Updated: ' + now.toTimeString().slice(0, 8);
      } else {
        applyBadgeState(badgeEl, null);
      }

      // Show Step 2 OCR preview box when in Step 2 view (or when Step 2 had an error)
      if (
        ocrBox &&
        latestJevOcrData &&
        (activeViewMode === 'jev_ocr' || (activeViewMode === 'compare' && !latestGeminiData))
      ) {
        ocrBox.classList.remove('hidden');
        ocrPreviewLabel.textContent = latestJevOcrData.error
          ? 'STEP 2: JEV OCR ERROR'
          : 'STEP 2: JEV (OCR) SCREEN TEXT';
        ocrPreviewMeta.textContent = Number.isFinite(latestJevOcrData.ocrChars)
          ? latestJevOcrData.ocrChars +
            ' OCR chars • ' +
            (latestJevOcrData.latencyMs || 0) +
            'ms'
          : 'jev-latest + Windows OCR';
        ocrPreviewText.textContent =
          latestJevOcrData.ocrText ||
          latestJevOcrData.ocrTextPreview ||
          latestJevOcrData.reason ||
          '—';
      } else if (ocrBox) {
        ocrBox.classList.add('hidden');
      }

      // Show Step 3 Gemini reason box when Gemini has run and we're viewing Gemini or Compare
      if (
        reasonBox &&
        latestGeminiData &&
        latestGeminiData.reason &&
        (activeViewMode === 'gemini' || activeViewMode === 'compare')
      ) {
        reasonBox.classList.remove('hidden');
        reasonLabel.textContent = latestGeminiData.error
          ? 'STEP 3: GEMINI OCR ERROR'
          : 'STEP 3: GEMINI (OCR) REASON';
        reasonMeta.textContent = Number.isFinite(latestGeminiData.ocrChars)
          ? latestGeminiData.ocrChars +
            ' OCR chars • ' +
            (latestGeminiData.latencyMs || 0) +
            'ms'
          : 'gemini-4-hydrogen (low)';
        reasonText.textContent = latestGeminiData.reason;
      } else if (reasonBox) {
        reasonBox.classList.add('hidden');
      }

      syncOverlayHeight();
    }

    const jevOcrBtnEl = document.getElementById('jev-ocr-btn');
    if (jevOcrBtnEl) {
      jevOcrBtnEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isRunningJevOcr || isRunningGemini) return;

        // If Step 2 already ran for this window and we're viewing another tab, switch to Step 2 view first
        if (latestJevOcrData && !latestJevOcrData.error && activeViewMode !== 'jev_ocr') {
          activeViewMode = 'jev_ocr';
          renderOverlayState();
          return;
        }

        if (!window.pcBlocker || typeof window.pcBlocker.runJevOcrCheck !== 'function') {
          return;
        }

        isRunningJevOcr = true;
        renderOverlayState();

        try {
          const res = await window.pcBlocker.runJevOcrCheck();
          isRunningJevOcr = false;
          if (res && res.ok && res.jevOcrVerdict) {
            if (res.jevVerdict) {
              latestJevData = {
                ...latestJevData,
                ...res.jevVerdict,
                tasks: res.tasks || (latestJevData && latestJevData.tasks) || [],
                tasksCount:
                  typeof res.tasksCount === 'number'
                    ? res.tasksCount
                    : (latestJevData && latestJevData.tasksCount) || 0,
              };
            }
            latestJevOcrData = res.jevOcrVerdict;
            activeViewMode = 'jev_ocr';
          } else {
            latestJevOcrData = {
              ...(latestJevData || {}),
              error: true,
              ocrTextPreview: (res && res.error) || 'Step 2 Jev OCR evaluation failed.',
            };
            activeViewMode = 'jev_ocr';
          }
        } catch (err) {
          isRunningJevOcr = false;
          latestJevOcrData = {
            ...(latestJevData || {}),
            error: true,
            ocrTextPreview: (err && err.message) || 'Failed to execute Step 2 Jev OCR check.',
          };
          activeViewMode = 'jev_ocr';
        }

        renderOverlayState();
      });
    }

    document.getElementById('gemini-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isRunningJevOcr || isRunningGemini) return;

      // If Step 3 already ran for this window and we're viewing another tab, switch to Step 3 view first
      if (latestGeminiData && !latestGeminiData.error && activeViewMode !== 'gemini') {
        activeViewMode = 'gemini';
        renderOverlayState();
        return;
      }

      if (!window.pcBlocker || typeof window.pcBlocker.runGeminiOcrCheck !== 'function') {
        return;
      }

      isRunningGemini = true;
      renderOverlayState();

      try {
        const res = await window.pcBlocker.runGeminiOcrCheck();
        isRunningGemini = false;
        if (res && res.ok && res.geminiVerdict) {
          if (res.jevVerdict) {
            latestJevData = {
              ...latestJevData,
              ...res.jevVerdict,
              tasks: res.tasks || (latestJevData && latestJevData.tasks) || [],
              tasksCount:
                typeof res.tasksCount === 'number'
                  ? res.tasksCount
                  : (latestJevData && latestJevData.tasksCount) || 0,
            };
          }
          if (res.jevOcrVerdict) {
            latestJevOcrData = res.jevOcrVerdict;
          }
          latestGeminiData = res.geminiVerdict;
          activeViewMode = 'gemini';
        } else {
          latestGeminiData = {
            ...(latestJevOcrData || latestJevData || {}),
            error: true,
            reason: (res && res.error) || 'Step 3 Gemini OCR evaluation failed.',
          };
          activeViewMode = 'gemini';
        }
      } catch (err) {
        isRunningGemini = false;
        latestGeminiData = {
          ...(latestJevOcrData || latestJevData || {}),
          error: true,
          reason: (err && err.message) || 'Failed to execute Step 3 Gemini OCR check.',
        };
        activeViewMode = 'gemini';
      }

      renderOverlayState();
    });

    document.getElementById('compare-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!latestJevOcrData && !latestGeminiData) return;
      if (activeViewMode === 'compare') {
        activeViewMode = latestGeminiData ? 'gemini' : 'jev_ocr';
      } else {
        activeViewMode = 'compare';
      }
      renderOverlayState();
    });

    document.getElementById('copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const report = formatOverlayClipboardReport(
        latestJevData,
        latestJevOcrData,
        latestGeminiData
      );
      copyTextToClipboard(report);

      const btn = document.getElementById('copy-btn');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      if (copyResetTimer) {
        clearTimeout(copyResetTimer);
      }
      copyResetTimer = setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1200);
    });

    window.__updateJevOverlay = function(data) {
      if (!data) return;

      if (data.status === 'EVALUATING' && data.step === 2) {
        isRunningJevOcr = true;
        isRunningGemini = false;
        if (data.jevVerdict) {
          latestJevData = {
            ...latestJevData,
            ...data.jevVerdict,
            tasks: data.tasks || data.jevVerdict.tasks || [],
            tasksCount:
              typeof data.tasksCount === 'number'
                ? data.tasksCount
                : data.jevVerdict.tasksCount || 0,
          };
        }
        renderOverlayState();
        return;
      }

      if (data.status === 'EVALUATING' && data.step === 3) {
        isRunningJevOcr = false;
        isRunningGemini = true;
        if (data.jevVerdict) {
          latestJevData = {
            ...latestJevData,
            ...data.jevVerdict,
            tasks: data.tasks || data.jevVerdict.tasks || [],
            tasksCount:
              typeof data.tasksCount === 'number'
                ? data.tasksCount
                : data.jevVerdict.tasksCount || 0,
          };
        }
        if (data.jevOcrVerdict) {
          latestJevOcrData = data.jevOcrVerdict;
        }
        renderOverlayState();
        return;
      }

      isRunningJevOcr = false;
      isRunningGemini = false;

      if ((data.jevOcrVerdict || data.geminiVerdict) && data.jevVerdict) {
        latestJevData = {
          ...data.jevVerdict,
          tasks: data.tasks || data.jevVerdict.tasks || [],
          tasksCount:
            typeof data.tasksCount === 'number'
              ? data.tasksCount
              : data.jevVerdict.tasksCount || 0,
        };
        if (data.jevOcrVerdict) {
          latestJevOcrData = data.jevOcrVerdict;
        }
        if (data.geminiVerdict) {
          latestGeminiData = data.geminiVerdict;
        }
        activeViewMode =
          data.viewMode || (data.geminiVerdict ? 'gemini' : 'jev_ocr');
      } else {
        const prevWinTitle =
          latestJevData && latestJevData.sample ? latestJevData.sample.windowTitle : null;
        const nextWinTitle = data.sample ? data.sample.windowTitle : null;
        if (prevWinTitle !== nextWinTitle || data.status === 'EVALUATING') {
          latestJevOcrData = null;
          latestGeminiData = null;
          activeViewMode = 'jev';
        }
        latestJevData = data;
      }

      renderOverlayState();
    };

    syncOverlayHeight();
  </script>
</body>
</html>`;
}

class DebugOverlay {
  /**
   * @param {object} [options]
   * @param {typeof import('electron').BrowserWindow} [options.BrowserWindowClass]
   * @param {import('electron').Screen} [options.screenModule]
   * @param {boolean} [options.enabled]
   * @param {boolean} [options.isSmokeTest]
   */
  constructor(options = {}) {
    this.BrowserWindowClass = options.BrowserWindowClass || null;
    this.screenModule = options.screenModule || null;
    this.isSmokeTest = Boolean(options.isSmokeTest);
    this.enabled =
      options.enabled !== undefined ? Boolean(options.enabled) : DEBUG_OVERLAY_ENABLED;
    this.window = null;
    this.isReady = false;
    this.lastPayload = null;
    this.width = DEFAULT_OVERLAY_WIDTH;
    this.height = DEFAULT_OVERLAY_HEIGHT;
  }

  ensureWindow() {
    if (!this.enabled || this.isSmokeTest || !this.BrowserWindowClass || !this.screenModule) {
      return null;
    }
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const width = this.width;
    const height = this.height;
    let x = 40;
    let y = 40;

    try {
      const primary =
        this.screenModule && typeof this.screenModule.getPrimaryDisplay === 'function'
          ? this.screenModule.getPrimaryDisplay()
          : null;
      const area = (primary && (primary.workArea || primary.bounds)) || null;
      if (area) {
        x = Math.max(area.x + 16, area.x + area.width - width - 20);
        y = area.y + 20;
      }
    } catch {}

    this.isReady = false;
    this.window = new this.BrowserWindowClass({
      x,
      y,
      width,
      height,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#09090b',
      title: DEBUG_OVERLAY_WINDOW_TITLE,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

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
    });

    if (this.window.webContents && typeof this.window.webContents.once === 'function') {
      this.window.webContents.once('did-finish-load', () => {
        this.isReady = true;
        if (this.window && !this.window.isDestroyed()) {
          if (typeof this.window.showInactive === 'function') {
            this.window.showInactive();
          } else {
            this.window.show();
          }
          if (typeof this.window.setAlwaysOnTop === 'function') {
            this.window.setAlwaysOnTop(true, 'screen-saver');
          }
        }
        if (this.lastPayload) {
          this._pushToRenderer(this.lastPayload);
        }
      });
    }

    const htmlDataUrl =
      'data:text/html;charset=utf-8,' + encodeURIComponent(buildOverlayHtml());
    if (typeof this.window.loadURL === 'function') {
      this.window.loadURL(htmlDataUrl).catch(() => {});
    }

    return this.window;
  }

  /**
   * Dynamically adjusts the overlay BrowserWindow height to match its visible content
   * so there is no blank space at the bottom when sections are hidden or expanded.
   * @param {number} targetHeight
   */
  setHeight(targetHeight) {
    const clampedHeight = Math.max(
      250,
      Math.min(680, Math.round(Number(targetHeight) || DEFAULT_OVERLAY_HEIGHT))
    );
    this.height = clampedHeight;

    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    try {
      if (
        typeof this.window.getBounds === 'function' &&
        typeof this.window.setBounds === 'function'
      ) {
        const bounds = this.window.getBounds();
        if (Math.abs((bounds.height || 0) - clampedHeight) > 1) {
          if (typeof this.window.setResizable === 'function') {
            this.window.setResizable(true);
          }
          this.window.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width || this.width,
            height: clampedHeight,
          });
          if (typeof this.window.setResizable === 'function') {
            this.window.setResizable(false);
          }
        }
      } else if (typeof this.window.setSize === 'function') {
        this.window.setSize(this.width, clampedHeight);
      }
    } catch {}
  }

  /**
   * Temporarily makes the overlay transparent while Windows OCR captures the full screen
   * so the underlying window is unobstructed and overlay UI text is not captured.
   */
  hideForOcrCapture() {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      if (typeof this.window.setOpacity === 'function') {
        this.window.setOpacity(0);
      }
    } catch {}
  }

  /**
   * Restores overlay visibility immediately after screen bitmap capture completes.
   */
  restoreAfterOcrCapture() {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      if (typeof this.window.setOpacity === 'function') {
        this.window.setOpacity(1);
      }
    } catch {}
  }

  _pushToRenderer(payload) {
    if (!this.window || this.window.isDestroyed() || !this.isReady) {
      return;
    }
    if (
      this.window.webContents &&
      typeof this.window.webContents.executeJavaScript === 'function'
    ) {
      const serialized = JSON.stringify(payload);
      this.window.webContents
        .executeJavaScript(`window.__updateJevOverlay && window.__updateJevOverlay(${serialized});`)
        .catch(() => {});
    }
  }

  update(payload) {
    if (!this.enabled || this.isSmokeTest) return;
    this.lastPayload = payload;
    this.ensureWindow();
    this._pushToRenderer(payload);
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
    this.isReady = false;
  }
}

module.exports = {
  DEBUG_OVERLAY_WINDOW_TITLE,
  DEBUG_OVERLAY_ENABLED,
  DEFAULT_OVERLAY_WIDTH,
  DEFAULT_OVERLAY_HEIGHT,
  buildOverlayHtml,
  DebugOverlay,
};
