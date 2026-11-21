const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 5000;

const CHOICE_KEYS = Object.freeze({
  DIRECT_WORK: 'direct_work',
  WORK_PLUMBING: 'work_plumbing',
  DISTRACTION: 'distraction',
  CANNOT_DETERMINE: 'cannot_determine',
});

const VALID_CHOICES = new Set(Object.values(CHOICE_KEYS));

const WINDOW_CLASSIFICATION_QUESTION = Object.freeze({
  type: 'choice',
  instructions:
    "Evaluate the Current Active Window in the context of the user's Committed Tasks and Recent Navigation Breadcrumbs. Select the single most appropriate category.",
  criteria: Object.freeze({
    direct_work:
      "The window title directly relates to executing, researching, learning about, or completing one of the user's committed daily tasks, or is a logical continuation of their recent work breadcrumb trail.",
    work_plumbing:
      'A neutral utility, auxiliary tool, or setup step required during computer work—such as account login/OAuth screens (Google Accounts, GitHub login, 2FA), screen recording tools (Loom), cloud docs/sheets/drive, email/calendar, search queries, documentation, file uploads, or productivity utilities.',
    distraction:
      "Unrelated entertainment, gaming, movies, sports, celebrity/drama videos, casual shopping, or passive social media browsing/doomscrolling that is not required by any of today's committed tasks.",
    cannot_determine:
      'The window title is too generic, truncated, cryptic, or ambiguous to tell whether it is work-related or a distraction.',
  }),
});

const WINDOW_OCR_CLASSIFICATION_QUESTION = Object.freeze({
  type: 'choice',
  instructions:
    "Evaluate the Current Active Window and its Full-Screen OCR Text in the context of the user's Committed Tasks and Recent Navigation Breadcrumbs. Determine whether the actual visible on-screen text matches or supports the user's tasks, or if it is unrelated distraction content.",
  criteria: Object.freeze({
    direct_work:
      "The full-screen OCR text and active window directly relate to executing, researching, coding, writing, learning about, or completing one of the user's committed daily tasks.",
    work_plumbing:
      'The full-screen OCR text shows a legitimate neutral utility, login/OAuth prompt, settings/setup screen, cloud drive/workspace index, or search query supporting computer work with no unrelated entertainment/distraction content.',
    distraction:
      "The full-screen OCR text reveals unrelated entertainment, gaming, movies, sports, celebrity/drama videos, casual shopping, or social media feeds/doomscrolling not required by any of today's committed tasks.",
    cannot_determine:
      'Even with both the window title and full-screen OCR text, the visible content is still too sparse, blank, or ambiguous to tell whether it is work-related or a distraction.',
  }),
});

/**
 * Builds the System One request payload for TypeSafe AI jev-latest.
 * Supports both Step 1 (title-only) and Step 2 (title + full-screen OCR text).
 * @param {{ tasks: string[], breadcrumbs: Array<{windowTitle: string, processName: string}>, currentWindow: {windowTitle: string, processName: string, isIncognito?: boolean}, ocrText?: string, initialChoice?: string }} input
 * @returns {object}
 */
function buildSystemOnePayload({
  tasks = [],
  breadcrumbs = [],
  currentWindow,
  ocrText,
  initialChoice,
}) {
  const hasOcr = ocrText !== undefined;
  const activeWindowState = {
    window_title: String(currentWindow?.windowTitle || ''),
    process_name: String(currentWindow?.processName || ''),
    is_incognito: Boolean(currentWindow?.isIncognito),
  };

  if (hasOcr) {
    if (initialChoice) {
      activeWindowState.initial_title_classification = String(initialChoice);
    }
    activeWindowState.full_screen_ocr_text = String(ocrText || '');
  }

  return {
    model: TYPESAFE_MODEL,
    state: {
      todays_committed_tasks: Array.isArray(tasks) ? [...tasks] : [],
      recent_navigation_breadcrumbs: (Array.isArray(breadcrumbs) ? breadcrumbs : []).map((b) => ({
        window_title: String(b.windowTitle || ''),
        process_name: String(b.processName || ''),
      })),
      current_active_window: activeWindowState,
    },
    questions: {
      window_classification: hasOcr
        ? WINDOW_OCR_CLASSIFICATION_QUESTION
        : WINDOW_CLASSIFICATION_QUESTION,
    },
  };
}

/**
 * Normalizes and validates the choice response returned by TypeSafe System One.
 * @param {object} data
 * @returns {{ ok: boolean, choice?: string, confidence?: number, probabilities?: Record<string, number>, error?: string }}
 */
function parseSystemOneResponse(data) {
  const answer = data?.answers?.window_classification;
  if (!answer || typeof answer !== 'object') {
    return { ok: false, error: 'Missing answers.window_classification in TypeSafe response' };
  }

  const choice = String(answer.choice || '');
  if (!VALID_CHOICES.has(choice)) {
    return { ok: false, error: `Invalid choice returned: ${choice || '<empty>'}` };
  }

  const rawProbs =
    answer.probabilities && typeof answer.probabilities === 'object'
      ? answer.probabilities
      : {};
  const probabilities = {};
  for (const key of VALID_CHOICES) {
    const val = Number(rawProbs[key]);
    probabilities[key] = Number.isFinite(val) ? val : 0;
  }

  const rawConfidence = Number(answer.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? rawConfidence
    : probabilities[choice] ?? 0;

  return {
    ok: true,
    choice,
    confidence,
    probabilities,
  };
}

/**
 * Gate 2: Client for TypeSafe AI's jev-latest System One Choice API.
 * Used for both Step 1 (Title Check) and Step 2 (Full-Screen OCR Check).
 */
class TypeSafeClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] Explicit API key; defaults to process.env.TYPESAFE_API_KEY
   * @param {string} [options.endpoint]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.explicitApiKey = options.apiKey;
    this.endpoint = options.endpoint || TYPESAFE_ENDPOINT;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  getApiKey() {
    if (this.explicitApiKey !== undefined) {
      return String(this.explicitApiKey || '').trim();
    }
    return String(process.env.TYPESAFE_API_KEY || '').trim();
  }

  /**
   * Evaluates a foreground window against committed tasks and recent breadcrumbs
   * (with optional full-screen OCR text for Step 2).
   * Never throws; returns `{ ok: false, error }` on missing key, network failure, or timeout.
   * @param {{ tasks: string[], breadcrumbs: Array<{windowTitle: string, processName: string}>, currentWindow: {windowTitle: string, processName: string, isIncognito?: boolean}, ocrText?: string, initialChoice?: string, signal?: AbortSignal }} params
   * @returns {Promise<object>}
   */
  async evaluateWindow({
    tasks,
    breadcrumbs,
    currentWindow,
    ocrText,
    initialChoice,
    signal,
  }) {
    const startMs = Date.now();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      return {
        ok: false,
        aborted: false,
        error: 'TYPESAFE_API_KEY is not configured in .env',
        latencyMs: Date.now() - startMs,
      };
    }

    if (typeof this.fetchImpl !== 'function') {
      return {
        ok: false,
        aborted: false,
        error: 'Global fetch implementation unavailable',
        latencyMs: Date.now() - startMs,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        return {
          ok: false,
          aborted: true,
          error: 'Request aborted before dispatch',
          latencyMs: Date.now() - startMs,
        };
      }
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const payload = buildSystemOnePayload({
        tasks,
        breadcrumbs,
        currentWindow,
        ocrText,
        initialChoice,
      });
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startMs;

      if (!response.ok) {
        return {
          ok: false,
          aborted: false,
          statusCode: response.status,
          error: `TypeSafe API HTTP ${response.status}`,
          latencyMs,
        };
      }

      const data = await response.json();
      const parsed = parseSystemOneResponse(data);
      if (!parsed.ok) {
        return {
          ok: false,
          aborted: false,
          error: parsed.error,
          latencyMs,
        };
      }

      return {
        ok: true,
        choice: parsed.choice,
        confidence: parsed.confidence,
        probabilities: parsed.probabilities,
        latencyMs,
        raw: data,
      };
    } catch (err) {
      const isCallerAbort = Boolean(signal?.aborted) && !timedOut;
      return {
        ok: false,
        aborted: isCallerAbort,
        error: timedOut
          ? `TypeSafe API timeout (${this.timeoutMs}ms)`
          : err?.message || 'TypeSafe API request failed',
        latencyMs: Date.now() - startMs,
      };
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  /**
   * Step 2 helper: Evaluates a foreground window using both window metadata and full-screen OCR text via Jev API.
   * @param {{ tasks: string[], breadcrumbs?: Array<{windowTitle: string, processName: string}>, currentWindow: {windowTitle: string, processName: string, isIncognito?: boolean}, ocrText: string, initialChoice?: string, signal?: AbortSignal }} params
   * @returns {Promise<object>}
   */
  async evaluateWindowWithOcr({
    tasks,
    breadcrumbs = [],
    currentWindow,
    ocrText = '',
    initialChoice = '',
    signal,
  }) {
    return this.evaluateWindow({
      tasks,
      breadcrumbs,
      currentWindow,
      ocrText: String(ocrText ?? ''),
      initialChoice,
      signal,
    });
  }
}

module.exports = {
  TYPESAFE_ENDPOINT,
  TYPESAFE_MODEL,
  DEFAULT_TIMEOUT_MS,
  CHOICE_KEYS,
  VALID_CHOICES,
  WINDOW_CLASSIFICATION_QUESTION,
  WINDOW_OCR_CLASSIFICATION_QUESTION,
  buildSystemOnePayload,
  parseSystemOneResponse,
  TypeSafeClient,
};
