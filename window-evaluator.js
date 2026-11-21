const { CATEGORIES } = require('./window-monitor');
const { CHOICE_KEYS } = require('./typesafe-client');
const { buildCompositeCacheKey } = require('./verdict-cache');

const DISTRACTION_BLOCK_THRESHOLD = 0.8;
const CONFIDENCE_ESCALATION_THRESHOLD = 0.8;
const AMBIGUOUS_ALLOW_MAX_DISTRACTION_PROB = 0.5;
const AMBIGUOUS_WAIT_POLL_CYCLES = 2;
const VERDICT_CACHE_ENABLED = false;

const GEMINI_ELIGIBLE_CHOICES = new Set([
  CHOICE_KEYS.WORK_PLUMBING,
  CHOICE_KEYS.CANNOT_DETERMINE,
]);

/**
 * Truncates OCR text into a clean multi-line preview for the floating overlay widget.
 * @param {string} [text]
 * @param {number} [maxChars]
 * @returns {string}
 */
function buildOcrPreview(text = '', maxChars = 12000) {
  const clean = String(text || '').trim();
  if (!clean) return '(No text detected on screen by Windows OCR)';
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 3)}...`;
}

/**
 * Coordinates:
 * - Gate 0 (Whitelist)
 * - Gate 1 (Local Verdict Cache)
 * - Step 1: Gate 2 Title Check (TypeSafe jev-latest, automatic on window change)
 * - Step 2: Gate 2 Full-Screen OCR Check (Windows OCR + TypeSafe jev-latest, manual trigger in overlay)
 * - Step 3: Gate 3 Full-Screen OCR + Gemini 4 Hydrogen (low) Check (manual trigger in overlay)
 */
class WindowEvaluator {
  /**
   * @param {object} options
   * @param {import('./verdict-cache').VerdictCache} options.verdictCache
   * @param {import('./typesafe-client').TypeSafeClient} options.typeSafeClient
   * @param {import('./screen-ocr').ScreenOcrSensor} [options.screenOcr]
   * @param {import('./gemini-client').GeminiOcrClient} [options.geminiClient]
   * @param {() => { dateString: string, tasks: string[] }} options.getActiveTasks
   * @param {(event: object) => void} [options.onVerdict]
   * @param {boolean} [options.useCache]
   * @param {number} [options.distractionBlockThreshold]
   * @param {number} [options.confidenceEscalationThreshold]
   * @param {number} [options.ambiguousAllowMaxDistractionProb]
   * @param {number} [options.ambiguousWaitCycles]
   */
  constructor(options) {
    this.verdictCache = options.verdictCache;
    this.typeSafeClient = options.typeSafeClient;
    this.screenOcr = options.screenOcr || null;
    this.geminiClient = options.geminiClient || null;
    this.getActiveTasks = options.getActiveTasks;
    this.onVerdict = options.onVerdict || null;
    this.useCache =
      options.useCache !== undefined ? Boolean(options.useCache) : VERDICT_CACHE_ENABLED;
    this.autoEscalate =
      options.autoEscalate !== undefined
        ? Boolean(options.autoEscalate)
        : Boolean(options.screenOcr);

    this.distractionBlockThreshold =
      options.distractionBlockThreshold ?? DISTRACTION_BLOCK_THRESHOLD;
    this.confidenceEscalationThreshold =
      options.confidenceEscalationThreshold ?? CONFIDENCE_ESCALATION_THRESHOLD;
    this.ambiguousAllowMaxDistractionProb =
      options.ambiguousAllowMaxDistractionProb ?? AMBIGUOUS_ALLOW_MAX_DISTRACTION_PROB;
    this.ambiguousWaitCycles =
      options.ambiguousWaitCycles ?? AMBIGUOUS_WAIT_POLL_CYCLES;

    this.generation = 0;
    this.inFlightController = null;
    this.pendingAmbiguous = null;
    this.lastEvaluationContext = null;
  }

  /**
   * Aborts any in-flight Gate 2 request and clears pending 2-cycle ambiguity state.
   */
  cancelPending() {
    this.generation += 1;
    if (this.inFlightController) {
      this.inFlightController.abort();
      this.inFlightController = null;
    }
    this.pendingAmbiguous = null;
  }

  destroy() {
    this.cancelPending();
  }

  _emitVerdict(event) {
    if (typeof this.onVerdict === 'function') {
      this.onVerdict(event);
    }
    return event;
  }

  /**
   * Returns true if a classification choice is work_plumbing or cannot_determine.
   * @param {string} [choice]
   * @returns {boolean}
   */
  isChoiceEligibleForGemini(choice) {
    return GEMINI_ELIGIBLE_CHOICES.has(String(choice || '').trim());
  }

  /**
   * Determines whether a Step 1 or Step 2 verdict should escalate to the next step:
   * - Escalates if choice is `work_plumbing` or `cannot_determine`
   * - Escalates if choice is `direct_work` with low confidence (< 0.65)
   * - Escalates if choice is `distraction` with low confidence (< 0.65 and distractionProb < 0.65)
   * - Resolves (returns false) only when `direct_work` or `distraction` has high confidence (>= 0.65)
   * @param {object} [verdict]
   * @returns {{ needsNextStep: boolean, escalationReason: string }}
   */
  evaluateEscalationNeed(verdict) {
    if (!verdict || verdict.gate === 'GATE_0_WHITELIST') {
      return {
        needsNextStep: false,
        escalationReason: 'whitelisted safe window',
      };
    }

    const choice = String(verdict.choice || '').trim();
    const confidence = Number(verdict.confidence ?? 0);
    const distractionProb = Number(
      verdict.distractionProb ?? verdict.probabilities?.[CHOICE_KEYS.DISTRACTION] ?? 0
    );
    const threshPct = Math.round(this.confidenceEscalationThreshold * 100);

    if (choice === CHOICE_KEYS.WORK_PLUMBING || choice === CHOICE_KEYS.CANNOT_DETERMINE) {
      return {
        needsNextStep: true,
        escalationReason: `state is ${choice}`,
      };
    }

    if (choice === CHOICE_KEYS.DIRECT_WORK) {
      if (confidence < this.confidenceEscalationThreshold) {
        return {
          needsNextStep: true,
          escalationReason: `low direct_work confidence (${Math.round(confidence * 100)}% < ${threshPct}%)`,
        };
      }
      return {
        needsNextStep: false,
        escalationReason: `resolved (${Math.round(confidence * 100)}% direct_work)`,
      };
    }

    if (choice === CHOICE_KEYS.DISTRACTION) {
      const effectiveDist = Math.max(confidence, distractionProb);
      if (effectiveDist < this.confidenceEscalationThreshold) {
        return {
          needsNextStep: true,
          escalationReason: `low distraction confidence (${Math.round(effectiveDist * 100)}% < ${threshPct}%)`,
        };
      }
      return {
        needsNextStep: false,
        escalationReason: `resolved (${Math.round(effectiveDist * 100)}% distraction)`,
      };
    }

    return {
      needsNextStep: true,
      escalationReason: 'unresolved classification',
    };
  }

  /**
   * Returns true if the given verdict should move to the next step (Step 1 -> Step 2, or Step 2 -> Step 3).
   * @param {object} [verdict]
   * @returns {boolean}
   */
  shouldEscalateVerdict(verdict) {
    return this.evaluateEscalationNeed(verdict).needsNextStep;
  }

  /**
   * Handles Gate 0 pre-filtered SAFE windows.
   * OS_ESSENTIAL stays silent to avoid desktop/Alt+Tab notification floods;
   * WORK_APP, PASSWORD_MANAGER, and NEUTRAL_BROWSER_UTILITY emit verification notifications.
   * @param {object} result
   */
  handleSafeWindow(result) {
    this.cancelPending();

    const category = result?.classification?.category;
    const { dateString, tasks } = this.getActiveTasks();

    const safeVerdict = {
      gate: 'GATE_0_WHITELIST',
      step: 0,
      status: 'GATE_0_ALLOW',
      decision: 'ALLOWED',
      category,
      reason: result?.classification?.reason || 'Gate 0 whitelist allow',
      cached: false,
      eligibleForGemini: false,
      needsNextStep: false,
      escalationReason: 'whitelisted safe window',
      latencyMs: 0,
      sample: result?.sample,
    };

    this.lastEvaluationContext = {
      dateString,
      tasks: Array.isArray(tasks) ? [...tasks] : [],
      sample: result?.sample,
      breadcrumbs: result?.priorBreadcrumbs || [],
      jevVerdict: safeVerdict,
      jevOcrVerdict: null,
      geminiVerdict: null,
      lastOcrResult: null,
      eligibleForGemini: false,
    };

    if (category === CATEGORIES.OS_ESSENTIAL) {
      return null;
    }

    return this._emitVerdict(safeVerdict);
  }

  /**
   * Step 1: Evaluates a non-whitelisted window switch sequentially through Gate 1 and Gate 2 (jev-latest title check).
   * Stops after Step 1 so the user can inspect Step 1 and manually trigger Step 2 (Jev OCR) or Step 3 (Gemini) in the floating widget.
   * @param {object} result
   * @returns {Promise<object|null>}
   */
  async handleEvaluationWindow(result) {
    this.cancelPending();
    const myGen = this.generation;

    const sample = result.sample;
    const breadcrumbs = Array.isArray(result.priorBreadcrumbs) ? [...result.priorBreadcrumbs] : [];
    const { dateString, tasks } = this.getActiveTasks();

    if (!Array.isArray(tasks) || tasks.length === 0) {
      const noTaskVerdict = {
        gate: 'FALLBACK',
        step: 1,
        status: 'NO_COMMITTED_TASKS',
        decision: 'ALLOWED',
        cached: false,
        eligibleForGemini: false,
        needsNextStep: false,
        latencyMs: 0,
        error: 'No committed tasks locked for today',
        sample,
      };
      this.lastEvaluationContext = {
        dateString,
        tasks: [],
        sample,
        breadcrumbs,
        jevVerdict: noTaskVerdict,
        jevOcrVerdict: null,
        geminiVerdict: null,
        lastOcrResult: null,
        eligibleForGemini: false,
      };
      return this._emitVerdict(noTaskVerdict);
    }

    const cacheKey = buildCompositeCacheKey({
      dateString,
      windowTitle: sample.windowTitle,
      processName: sample.processName,
      isIncognito: sample.isIncognito,
    });

    // Gate 1: Local Verdict Cache Lookup (0 ms, Offline) — bypassed when useCache is false
    if (this.useCache && this.verdictCache) {
      const cacheLookup = this.verdictCache.get({
        dateString,
        tasks,
        windowTitle: sample.windowTitle,
        processName: sample.processName,
        isIncognito: sample.isIncognito,
      });

      if (cacheLookup.hit) {
        const cached = cacheLookup.entry;
        const cachedVerdict = {
          gate: 'GATE_1_CACHE',
          step: 1,
          status: cached.decision === 'BLOCKED' ? 'CACHE_BLOCK_SIMULATED' : 'CACHE_ALLOW',
          decision: cached.decision,
          choice: cached.choice,
          confidence: cached.confidence,
          probabilities: cached.probabilities,
          distractionProb: Number(cached.probabilities?.distraction ?? 0),
          cached: true,
          latencyMs: 0,
          sample,
        };
        this._saveEvaluationContext(
          { dateString, tasks, sample, breadcrumbs },
          cachedVerdict
        );
        return this._emitVerdict(cachedVerdict);
      }
    }

    // Step 1 (Gate 2): TypeSafe jev-latest Title-Only Choice Evaluation (~100 ms, Online)
    const controller = new AbortController();
    this.inFlightController = controller;

    const apiResult = await this.typeSafeClient.evaluateWindow({
      tasks,
      breadcrumbs,
      currentWindow: sample,
      signal: controller.signal,
    });

    if (this.inFlightController === controller) {
      this.inFlightController = null;
    }

    if (myGen !== this.generation || apiResult.aborted) {
      return null;
    }

    const step1Verdict = this._routeApiResult(
      apiResult,
      {
        dateString,
        tasks,
        sample,
        breadcrumbs,
        cacheKey,
      },
      false
    );

    if (
      !this.autoEscalate ||
      !this.screenOcr ||
      !apiResult.ok ||
      !this.shouldEscalateVerdict(step1Verdict)
    ) {
      return step1Verdict;
    }

    // Automatic Step 2: Windows Full-Screen OCR + Jev API
    this.pendingAmbiguous = null;
    this._emitVerdict({
      gate: 'GATE_2_JEV_OCR',
      step: 2,
      status: 'EVALUATING',
      decision: 'EVALUATING',
      choice: 'step 2: jev ocr...',
      jevVerdict: step1Verdict,
      sample,
    });

    const ocrResult = await this.screenOcr.captureFullScreenText();
    if (myGen !== this.generation) {
      return null;
    }
    if (!ocrResult || !ocrResult.ok) {
      return step1Verdict;
    }

    if (this.lastEvaluationContext) {
      this.lastEvaluationContext.lastOcrResult = ocrResult;
    }

    const step2Controller = new AbortController();
    this.inFlightController = step2Controller;

    const jevOcrRes = await this.typeSafeClient.evaluateWindowWithOcr({
      tasks,
      breadcrumbs,
      currentWindow: sample,
      ocrText: ocrResult.text,
      initialChoice: step1Verdict.choice,
      signal: step2Controller.signal,
    });

    if (this.inFlightController === step2Controller) {
      this.inFlightController = null;
    }

    if (myGen !== this.generation || jevOcrRes.aborted) {
      return null;
    }

    if (!jevOcrRes.ok) {
      return step1Verdict;
    }

    const ctxAfterStep1 = this._ensureActiveEvaluationContext({
      fallbackSample: sample,
      fallbackBreadcrumbs: breadcrumbs,
    });
    const jevOcrVerdict = this._buildJevOcrVerdict(jevOcrRes, ocrResult, ctxAfterStep1);
    ctxAfterStep1.jevOcrVerdict = jevOcrVerdict;

    const emittedStep2 = this._emitVerdict({
      ...jevOcrVerdict,
      jevVerdict: step1Verdict,
      jevOcrVerdict,
      viewMode: 'jev_ocr',
    });

    if (!this.geminiClient || !this.shouldEscalateVerdict(jevOcrVerdict)) {
      return emittedStep2;
    }

    // Automatic Step 3: Windows Full-Screen OCR + Gemini 4 Hydrogen (low)
    this._emitVerdict({
      gate: 'GATE_3_OCR_GEMINI',
      step: 3,
      status: 'EVALUATING',
      decision: 'EVALUATING',
      choice: 'step 3: gemini...',
      jevVerdict: step1Verdict,
      jevOcrVerdict,
      sample,
    });

    const step3Controller = new AbortController();
    this.inFlightController = step3Controller;

    const geminiRes = await this.geminiClient.evaluateWithOcr({
      tasks,
      breadcrumbs,
      currentWindow: sample,
      initialChoice: jevOcrVerdict.choice,
      ocrText: ocrResult.text,
      signal: step3Controller.signal,
    });

    if (this.inFlightController === step3Controller) {
      this.inFlightController = null;
    }

    if (myGen !== this.generation || geminiRes.aborted) {
      return null;
    }

    if (!geminiRes.ok) {
      return emittedStep2;
    }

    const geminiVerdict = this._buildGeminiVerdict(geminiRes, ocrResult, ctxAfterStep1);
    ctxAfterStep1.geminiVerdict = geminiVerdict;

    return this._emitVerdict({
      ...geminiVerdict,
      jevVerdict: step1Verdict,
      jevOcrVerdict,
      geminiVerdict,
      viewMode: 'gemini',
    });
  }

  /**
   * Called on subsequent 2s ticks when the user remains on the exact same window.
   * Drives the 2-polling-cycle re-evaluation for ambiguous/low-confidence titles.
   * @param {{ sample: object, priorBreadcrumbs?: Array<object> }} tickInfo
   * @returns {Promise<object|null>}
   */
  async handleSameWindowTick({ sample, priorBreadcrumbs = [] }) {
    if (
      !this.pendingAmbiguous ||
      this.pendingAmbiguous.resolved ||
      this.pendingAmbiguous.evaluating
    ) {
      return null;
    }

    const { dateString, tasks } = this.getActiveTasks();
    const currentKey = buildCompositeCacheKey({
      dateString,
      windowTitle: sample.windowTitle,
      processName: sample.processName,
      isIncognito: sample.isIncognito,
    });

    if (currentKey !== this.pendingAmbiguous.cacheKey) {
      this.pendingAmbiguous = null;
      return null;
    }

    this.pendingAmbiguous.cyclesWaited += 1;
    if (this.pendingAmbiguous.cyclesWaited < this.ambiguousWaitCycles) {
      return {
        status: 'WAITING',
        cyclesWaited: this.pendingAmbiguous.cyclesWaited,
        targetCycles: this.ambiguousWaitCycles,
      };
    }

    this.pendingAmbiguous.evaluating = true;
    const myGen = this.generation;
    const controller = new AbortController();
    this.inFlightController = controller;

    const apiResult = await this.typeSafeClient.evaluateWindow({
      tasks,
      breadcrumbs: priorBreadcrumbs,
      currentWindow: sample,
      signal: controller.signal,
    });

    if (this.inFlightController === controller) {
      this.inFlightController = null;
    }

    if (myGen !== this.generation || apiResult.aborted) {
      return null;
    }

    if (this.pendingAmbiguous) {
      this.pendingAmbiguous.resolved = true;
    }

    return this._routeApiResult(
      apiResult,
      {
        dateString,
        tasks,
        sample,
        breadcrumbs: priorBreadcrumbs,
        cacheKey: currentKey,
      },
      true
    );
  }

  _saveEvaluationContext(context, jevVerdict) {
    const { needsNextStep, escalationReason } = this.evaluateEscalationNeed(jevVerdict);
    jevVerdict.step = 1;
    jevVerdict.needsNextStep = needsNextStep;
    jevVerdict.escalationReason = escalationReason;
    jevVerdict.eligibleForGemini = needsNextStep;

    const isSameWindow =
      this.lastEvaluationContext &&
      this.lastEvaluationContext.sample &&
      context.sample &&
      this.lastEvaluationContext.sample.windowTitle === context.sample.windowTitle &&
      this.lastEvaluationContext.sample.processName === context.sample.processName;

    this.lastEvaluationContext = {
      dateString: context.dateString,
      tasks: Array.isArray(context.tasks) ? [...context.tasks] : [],
      sample: context.sample,
      breadcrumbs: Array.isArray(context.breadcrumbs) ? [...context.breadcrumbs] : [],
      jevVerdict,
      jevOcrVerdict: isSameWindow ? this.lastEvaluationContext.jevOcrVerdict : null,
      geminiVerdict: isSameWindow ? this.lastEvaluationContext.geminiVerdict : null,
      lastOcrResult: isSameWindow ? this.lastEvaluationContext.lastOcrResult : null,
      eligibleForGemini: needsNextStep,
    };
  }

  _routeApiResult(apiResult, context, isReevaluation) {
    if (!apiResult.ok) {
      this.pendingAmbiguous = null;
      const fallbackVerdict = {
        gate: 'FALLBACK',
        status: 'API_FALLBACK_ALLOW',
        decision: 'ALLOWED',
        cached: false,
        reevaluated: isReevaluation,
        latencyMs: apiResult.latencyMs ?? 0,
        error: apiResult.error || 'TypeSafe API request failed',
        sample: context.sample,
      };
      this._saveEvaluationContext(context, fallbackVerdict);
      return this._emitVerdict(fallbackVerdict);
    }

    const { choice, confidence, probabilities, latencyMs } = apiResult;
    const distractionProb = Number(
      probabilities?.[CHOICE_KEYS.DISTRACTION] ??
        (choice === CHOICE_KEYS.DISTRACTION ? confidence : 0)
    );

    // 1. High-confidence direct_work (>= 0.65) or work_plumbing -> Allowed
    // Note: Low-confidence direct_work (< 0.65) is also allowed at Step 1 if not escalated,
    // while needsNextStep = true marks it for Step 2 (Jev OCR).
    if (choice === CHOICE_KEYS.DIRECT_WORK || choice === CHOICE_KEYS.WORK_PLUMBING) {
      this.pendingAmbiguous = null;
      const isHighConfDirectWork =
        choice === CHOICE_KEYS.DIRECT_WORK &&
        Number(confidence ?? 0) >= this.confidenceEscalationThreshold;
      const shouldCache = Boolean(
        this.useCache &&
          this.verdictCache &&
          (isHighConfDirectWork || choice === CHOICE_KEYS.WORK_PLUMBING)
      );
      if (shouldCache) {
        this.verdictCache.set(
          {
            dateString: context.dateString,
            tasks: context.tasks,
            windowTitle: context.sample.windowTitle,
            processName: context.sample.processName,
            isIncognito: context.sample.isIncognito,
          },
          {
            decision: 'ALLOWED',
            choice,
            confidence,
            probabilities,
          }
        );
      }

      const allowVerdict = {
        gate: 'GATE_2_AI',
        status: 'AI_ALLOW',
        decision: 'ALLOWED',
        choice,
        confidence,
        probabilities,
        distractionProb,
        cached: shouldCache,
        reevaluated: isReevaluation,
        latencyMs,
        sample: context.sample,
      };
      this._saveEvaluationContext(context, allowVerdict);
      return this._emitVerdict(allowVerdict);
    }

    // 2. distraction (High Confidence >= 0.65) -> Marked Blocked (Sim) (& Cached when useCache is enabled)
    if (
      choice === CHOICE_KEYS.DISTRACTION &&
      distractionProb >= this.distractionBlockThreshold
    ) {
      this.pendingAmbiguous = null;
      const shouldCache = Boolean(this.useCache && this.verdictCache);
      if (shouldCache) {
        this.verdictCache.set(
          {
            dateString: context.dateString,
            tasks: context.tasks,
            windowTitle: context.sample.windowTitle,
            processName: context.sample.processName,
            isIncognito: context.sample.isIncognito,
          },
          {
            decision: 'BLOCKED',
            choice,
            confidence,
            probabilities,
          }
        );
      }

      const blockVerdict = {
        gate: 'GATE_2_AI',
        status: 'AI_BLOCK_SIMULATED',
        decision: 'BLOCKED',
        choice,
        confidence,
        probabilities,
        distractionProb,
        cached: shouldCache,
        reevaluated: isReevaluation,
        latencyMs,
        sample: context.sample,
      };
      this._saveEvaluationContext(context, blockVerdict);
      return this._emitVerdict(blockVerdict);
    }

    // 3. cannot_determine OR Low-Confidence distraction (< 0.65)
    if (!isReevaluation) {
      this.pendingAmbiguous = {
        cacheKey: context.cacheKey,
        sample: context.sample,
        cyclesWaited: 0,
        evaluating: false,
        resolved: false,
      };

      const pendingVerdict = {
        gate: 'GATE_2_AI',
        status: 'AMBIGUOUS_WAITING',
        decision: 'PENDING',
        choice,
        confidence,
        probabilities,
        distractionProb,
        cached: false,
        waitCycles: this.ambiguousWaitCycles,
        latencyMs,
        sample: context.sample,
      };
      this._saveEvaluationContext(context, pendingVerdict);
      return this._emitVerdict(pendingVerdict);
    }

    // 4. Re-evaluation after 2 polling cycles still unresolved -> Allow (Uncached)
    this.pendingAmbiguous = null;
    const status =
      choice === CHOICE_KEYS.CANNOT_DETERMINE &&
      distractionProb < this.ambiguousAllowMaxDistractionProb
        ? 'AMBIGUOUS_ALLOW_UNCACHED'
        : 'LOW_CONFIDENCE_ALLOW_UNCACHED';

    const uncachedAllowVerdict = {
      gate: 'GATE_2_AI',
      status,
      decision: 'ALLOWED',
      choice,
      confidence,
      probabilities,
      distractionProb,
      cached: false,
      reevaluated: true,
      latencyMs,
      sample: context.sample,
    };
    this._saveEvaluationContext(context, uncachedAllowVerdict);
    return this._emitVerdict(uncachedAllowVerdict);
  }

  _ensureActiveEvaluationContext(options = {}) {
    const { dateString, tasks: latestTasks } = this.getActiveTasks();
    if (!this.lastEvaluationContext || !this.lastEvaluationContext.jevVerdict) {
      const sample = options.fallbackSample || {
        windowTitle: 'Active Desktop Screen',
        processName: 'explorer.exe',
        isIncognito: false,
      };
      const defaultJevVerdict = {
        gate: 'MONITOR',
        step: 1,
        status: 'MANUAL_CHECK',
        decision: 'ALLOWED',
        choice: CHOICE_KEYS.CANNOT_DETERMINE,
        eligibleForGemini: true,
        needsNextStep: true,
        escalationReason: 'state is cannot_determine',
        latencyMs: 0,
        sample,
      };
      this.lastEvaluationContext = {
        dateString,
        tasks: Array.isArray(latestTasks) ? [...latestTasks] : [],
        sample,
        breadcrumbs: Array.isArray(options.fallbackBreadcrumbs)
          ? [...options.fallbackBreadcrumbs]
          : [],
        jevVerdict: defaultJevVerdict,
        jevOcrVerdict: null,
        geminiVerdict: null,
        lastOcrResult: null,
        eligibleForGemini: true,
      };
    }
    return this.lastEvaluationContext;
  }

  /**
   * Builds a normalized Step 2 verdict object from a Jev + Full-Screen OCR evaluation.
   * @param {object} jevOcrRes
   * @param {object} ocrResult
   * @param {object} context
   * @returns {object}
   */
  _buildJevOcrVerdict(jevOcrRes, ocrResult, context) {
    const choice = jevOcrRes.choice;
    const confidence = jevOcrRes.confidence;
    const probabilities = jevOcrRes.probabilities;
    const distractionProb = Number(
      probabilities?.[CHOICE_KEYS.DISTRACTION] ??
        (choice === CHOICE_KEYS.DISTRACTION ? confidence : 0)
    );

    const ocrLatencyMs = Number(ocrResult?.latencyMs ?? 0);
    const jevOcrLatencyMs = Number(jevOcrRes?.latencyMs ?? 0);
    const totalLatencyMs = ocrLatencyMs + jevOcrLatencyMs;

    let decision = 'ALLOWED';
    let status = 'JEV_OCR_ALLOW';

    if (
      choice === CHOICE_KEYS.DISTRACTION &&
      (distractionProb >= this.distractionBlockThreshold ||
        confidence >= this.distractionBlockThreshold)
    ) {
      decision = 'BLOCKED';
      status = 'JEV_OCR_BLOCK_SIMULATED';
    } else if (choice === CHOICE_KEYS.DISTRACTION) {
      decision = 'PENDING';
      status = 'JEV_OCR_LOW_CONF_DISTRACTION';
    } else if (
      choice === CHOICE_KEYS.DIRECT_WORK &&
      confidence < this.confidenceEscalationThreshold
    ) {
      decision = 'ALLOWED';
      status = 'JEV_OCR_LOW_CONF_WORK';
    } else if (choice === CHOICE_KEYS.CANNOT_DETERMINE) {
      decision = 'PENDING';
      status = 'JEV_OCR_CANNOT_DETERMINE';
    }

    const baseVerdict = {
      gate: 'GATE_2_JEV_OCR',
      step: 2,
      model: 'jev-latest',
      status,
      decision,
      choice,
      confidence,
      probabilities,
      distractionProb,
      initialChoice: context.jevVerdict?.choice || '',
      ocrText: String(ocrResult?.text || '').trim(),
      ocrTextPreview: buildOcrPreview(ocrResult?.text || ''),
      ocrChars: String(ocrResult?.text || '').length,
      ocrLinesCount: Number(ocrResult?.linesCount ?? 0),
      ocrLatencyMs,
      jevOcrLatencyMs,
      latencyMs: totalLatencyMs,
      sample: context.sample,
    };

    const { needsNextStep, escalationReason } = this.evaluateEscalationNeed(baseVerdict);
    baseVerdict.needsNextStep = needsNextStep;
    baseVerdict.escalationReason = escalationReason;
    baseVerdict.eligibleForGemini = needsNextStep;

    return baseVerdict;
  }

  /**
   * Builds a normalized Step 3 verdict object from a Gemini + Full-Screen OCR evaluation.
   * @param {object} geminiRes
   * @param {object} ocrResult
   * @param {object} context
   * @returns {object}
   */
  _buildGeminiVerdict(geminiRes, ocrResult, context) {
    const choice = geminiRes.choice;
    const confidence = geminiRes.confidence;
    const probabilities = geminiRes.probabilities;
    const reason = geminiRes.reason;
    const distractionProb = Number(
      probabilities?.[CHOICE_KEYS.DISTRACTION] ??
        (choice === CHOICE_KEYS.DISTRACTION ? confidence : 0)
    );

    const ocrLatencyMs = Number(ocrResult?.latencyMs ?? 0);
    const geminiLatencyMs = Number(geminiRes?.latencyMs ?? 0);
    const totalLatencyMs = ocrLatencyMs + geminiLatencyMs;

    let decision = 'ALLOWED';
    let status = 'GEMINI_OCR_ALLOW';

    if (
      choice === CHOICE_KEYS.DISTRACTION &&
      (distractionProb >= this.distractionBlockThreshold ||
        confidence >= this.distractionBlockThreshold)
    ) {
      decision = 'BLOCKED';
      status = 'GEMINI_OCR_BLOCK_SIMULATED';
    } else if (choice === CHOICE_KEYS.DISTRACTION) {
      decision = 'ALLOWED';
      status = 'GEMINI_OCR_LOW_CONF_ALLOW';
    } else if (choice === CHOICE_KEYS.CANNOT_DETERMINE) {
      decision = 'ALLOWED';
      status = 'GEMINI_OCR_CANNOT_DETERMINE';
    }

    return {
      gate: 'GATE_3_OCR_GEMINI',
      step: 3,
      model: geminiRes.model || 'gemini-4-hydrogen',
      thinkingLevel: geminiRes.thinkingLevel || 'low',
      status,
      decision,
      choice,
      confidence,
      probabilities,
      distractionProb,
      reason,
      initialChoice:
        context.jevOcrVerdict?.choice || context.jevVerdict?.choice || '',
      ocrText: String(ocrResult?.text || '').trim(),
      ocrTextPreview: buildOcrPreview(ocrResult?.text || ''),
      ocrChars: String(ocrResult?.text || '').length,
      ocrLinesCount: Number(ocrResult?.linesCount ?? 0),
      ocrLatencyMs,
      geminiLatencyMs,
      latencyMs: totalLatencyMs,
      needsNextStep: false,
      escalationReason: 'final step 3 (Gemini)',
      sample: context.sample,
    };
  }

  /**
   * Step 2: Manually triggered from the floating Debug Overlay widget ("Jev OCR" button).
   * Captures full-screen text via Windows built-in OCR and evaluates with Jev API (`jev-latest`).
   * @param {object} [options]
   * @param {boolean} [options.onlyEligible] When true, restricts execution to verdicts where shouldEscalateVerdict is true
   * @param {object} [options.fallbackSample]
   * @param {Array<object>} [options.fallbackBreadcrumbs]
   * @returns {Promise<object>}
   */
  async evaluateCurrentWithJevOcr(options = {}) {
    const ctx = this._ensureActiveEvaluationContext(options);
    const step1Verdict = ctx.jevVerdict;
    const currentChoice = step1Verdict?.choice || step1Verdict?.category || 'cannot_determine';

    if (options.onlyEligible && !this.shouldEscalateVerdict(step1Verdict)) {
      return {
        ok: false,
        error: `Step 2 (Jev + OCR) is only needed for work_plumbing, cannot_determine, or low-confidence (< 65%) direct_work/distraction (current Step 1: ${currentChoice}, conf: ${Math.round(Number(step1Verdict?.confidence || 0) * 100)}%).`,
        jevVerdict: step1Verdict,
      };
    }

    if (!this.screenOcr) {
      return {
        ok: false,
        error: 'ScreenOcrSensor is not configured on WindowEvaluator.',
        jevVerdict: step1Verdict,
      };
    }

    if (!this.typeSafeClient) {
      return {
        ok: false,
        error: 'TypeSafeClient is not configured on WindowEvaluator.',
        jevVerdict: step1Verdict,
      };
    }

    const { tasks: latestTasks } = this.getActiveTasks();
    const activeTasks =
      Array.isArray(latestTasks) && latestTasks.length > 0 ? latestTasks : ctx.tasks;

    const ocrResult = await this.screenOcr.captureFullScreenText();
    if (!ocrResult || !ocrResult.ok) {
      return {
        ok: false,
        error: ocrResult?.error || 'Windows built-in full-screen OCR failed.',
        ocrLatencyMs: ocrResult?.latencyMs ?? 0,
        jevVerdict: step1Verdict,
      };
    }

    ctx.lastOcrResult = ocrResult;

    const jevOcrRes = await this.typeSafeClient.evaluateWindowWithOcr({
      tasks: activeTasks,
      breadcrumbs: ctx.breadcrumbs || [],
      currentWindow: ctx.sample,
      ocrText: ocrResult.text,
      initialChoice: currentChoice,
    });

    if (!jevOcrRes || !jevOcrRes.ok) {
      return {
        ok: false,
        error: jevOcrRes?.error || 'Step 2 Jev OCR API call failed.',
        ocrLatencyMs: ocrResult.latencyMs ?? 0,
        jevOcrLatencyMs: jevOcrRes?.latencyMs ?? 0,
        jevVerdict: step1Verdict,
      };
    }

    const jevOcrVerdict = this._buildJevOcrVerdict(jevOcrRes, ocrResult, ctx);
    ctx.jevOcrVerdict = jevOcrVerdict;

    return {
      ok: true,
      jevVerdict: ctx.jevVerdict,
      jevOcrVerdict,
      geminiVerdict: ctx.geminiVerdict,
      sample: ctx.sample,
      tasks: activeTasks,
      tasksCount: activeTasks.length,
    };
  }

  /**
   * Step 3: Manually triggered from the floating Debug Overlay widget ("Gemini" button).
   * Reuses the full-screen OCR text captured in Step 2 (or captures fresh OCR if Step 2 wasn't run yet)
   * and evaluates with `gemini-4-hydrogen` (`thinking_level: "low"`).
   * @param {object} [options]
   * @param {boolean} [options.onlyEligible] When true, restricts execution to verdicts where shouldEscalateVerdict is true
   * @param {boolean} [options.forceFreshOcr] When true, forces a new OCR screen capture even if Step 2 already captured one
   * @param {object} [options.fallbackSample]
   * @param {Array<object>} [options.fallbackBreadcrumbs]
   * @returns {Promise<object>}
   */
  async evaluateCurrentWithGeminiOcr(options = {}) {
    const ctx = this._ensureActiveEvaluationContext(options);
    const priorVerdict = ctx.jevOcrVerdict || ctx.jevVerdict;
    const currentChoice = priorVerdict?.choice || priorVerdict?.category || 'cannot_determine';

    if (options.onlyEligible && !this.shouldEscalateVerdict(priorVerdict)) {
      return {
        ok: false,
        error: `Step 3 (Gemini + OCR) is only needed when the prior step is work_plumbing, cannot_determine, or low-confidence (< 65%) direct_work/distraction (current choice: ${currentChoice}, conf: ${Math.round(Number(priorVerdict?.confidence || 0) * 100)}%).`,
        jevVerdict: ctx.jevVerdict,
        jevOcrVerdict: ctx.jevOcrVerdict,
      };
    }

    if (!this.screenOcr) {
      return {
        ok: false,
        error: 'ScreenOcrSensor is not configured on WindowEvaluator.',
        jevVerdict: ctx.jevVerdict,
        jevOcrVerdict: ctx.jevOcrVerdict,
      };
    }

    if (!this.geminiClient) {
      return {
        ok: false,
        error: 'GeminiOcrClient is not configured on WindowEvaluator.',
        jevVerdict: ctx.jevVerdict,
        jevOcrVerdict: ctx.jevOcrVerdict,
      };
    }

    const { tasks: latestTasks } = this.getActiveTasks();
    const activeTasks =
      Array.isArray(latestTasks) && latestTasks.length > 0 ? latestTasks : ctx.tasks;

    let ocrResult = !options.forceFreshOcr && ctx.lastOcrResult && ctx.lastOcrResult.ok
      ? ctx.lastOcrResult
      : null;

    if (!ocrResult) {
      ocrResult = await this.screenOcr.captureFullScreenText();
      if (!ocrResult || !ocrResult.ok) {
        return {
          ok: false,
          error: ocrResult?.error || 'Windows built-in full-screen OCR failed.',
          ocrLatencyMs: ocrResult?.latencyMs ?? 0,
          jevVerdict: ctx.jevVerdict,
          jevOcrVerdict: ctx.jevOcrVerdict,
        };
      }
      ctx.lastOcrResult = ocrResult;
    }

    const geminiRes = await this.geminiClient.evaluateWithOcr({
      tasks: activeTasks,
      breadcrumbs: ctx.breadcrumbs || [],
      currentWindow: ctx.sample,
      initialChoice: currentChoice,
      ocrText: ocrResult.text,
    });

    if (!geminiRes || !geminiRes.ok) {
      return {
        ok: false,
        error: geminiRes?.error || 'Gemini API call failed.',
        ocrLatencyMs: ocrResult.latencyMs ?? 0,
        geminiLatencyMs: geminiRes?.latencyMs ?? 0,
        jevVerdict: ctx.jevVerdict,
        jevOcrVerdict: ctx.jevOcrVerdict,
      };
    }

    const geminiVerdict = this._buildGeminiVerdict(geminiRes, ocrResult, ctx);
    ctx.geminiVerdict = geminiVerdict;

    return {
      ok: true,
      jevVerdict: ctx.jevVerdict,
      jevOcrVerdict: ctx.jevOcrVerdict,
      geminiVerdict,
      sample: ctx.sample,
      tasks: activeTasks,
      tasksCount: activeTasks.length,
    };
  }
}

module.exports = {
  DISTRACTION_BLOCK_THRESHOLD,
  CONFIDENCE_ESCALATION_THRESHOLD,
  AMBIGUOUS_ALLOW_MAX_DISTRACTION_PROB,
  AMBIGUOUS_WAIT_POLL_CYCLES,
  VERDICT_CACHE_ENABLED,
  GEMINI_ELIGIBLE_CHOICES,
  buildOcrPreview,
  WindowEvaluator,
};
