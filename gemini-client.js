const { GoogleGenAI } = require('@google/genai');
const { CHOICE_KEYS, VALID_CHOICES } = require('./typesafe-client');

const GEMINI_MODEL = 'gemini-4-hydrogen';
const GEMINI_THINKING_LEVEL = 'low';
const DEFAULT_GEMINI_TIMEOUT_MS = 15000;

const GEMINI_OCR_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    choice: {
      type: 'string',
      enum: [
        CHOICE_KEYS.DIRECT_WORK,
        CHOICE_KEYS.WORK_PLUMBING,
        CHOICE_KEYS.DISTRACTION,
        CHOICE_KEYS.CANNOT_DETERMINE,
      ],
    },
    confidence: { type: 'number' },
    probabilities: {
      type: 'object',
      properties: {
        direct_work: { type: 'number' },
        work_plumbing: { type: 'number' },
        distraction: { type: 'number' },
        cannot_determine: { type: 'number' },
      },
      required: ['direct_work', 'work_plumbing', 'distraction', 'cannot_determine'],
    },
    reason: { type: 'string' },
  },
  required: ['choice', 'confidence', 'probabilities', 'reason'],
});

/**
 * Builds the input prompt sent to `gemini-4-hydrogen` with the user's committed task list,
 * window context, initial Jev classification, and full-screen Windows OCR text.
 * @param {{ tasks: string[], breadcrumbs?: Array<{windowTitle: string, processName: string}>, currentWindow: {windowTitle: string, processName: string, isIncognito?: boolean}, initialChoice?: string, ocrText: string }} params
 * @returns {string}
 */
function buildGeminiOcrInput({
  tasks = [],
  breadcrumbs = [],
  currentWindow = {},
  initialChoice = '',
  ocrText = '',
}) {
  const formattedTasks =
    Array.isArray(tasks) && tasks.length > 0
      ? tasks.map((t, idx) => `  [${idx + 1}] ${String(t).trim()}`).join('\n')
      : '  (No tasks listed)';

  const formattedBreadcrumbs =
    Array.isArray(breadcrumbs) && breadcrumbs.length > 0
      ? breadcrumbs
          .map(
            (b, idx) =>
              `  ${idx + 1}. "${String(b.windowTitle || '')}" (${String(b.processName || '')})`
          )
          .join('\n')
      : '  (None)';

  const cleanOcr = String(ocrText || '').trim() || '(No visible text detected on screen by OCR)';

  return [
    'You are an accurate focus & productivity verifier for a desktop distraction blocker.',
    'An initial fast window-title classifier returned an uncertain or auxiliary state (' +
      (initialChoice || 'work_plumbing / cannot_determine') +
      ').',
    "Your job is to inspect the FULL-SCREEN OCR TEXT captured from the user's screen and compare it against Today's Committed Tasks to determine the accurate final classification.",
    '',
    '=== CLASSIFICATION CATEGORIES ===',
    '- "direct_work": The on-screen OCR text and active window directly relate to executing, researching, coding, writing, or completing one of Today\'s Committed Tasks.',
    '- "work_plumbing": A legitimate neutral utility, login/OAuth step, documentation lookup, search results page, cloud workspace, or setup step supporting the user\'s work, with no unrelated entertainment/distraction content.',
    '- "distraction": The on-screen OCR text reveals unrelated entertainment, gaming, movies, sports, drama/celebrity content, social media feeds/doomscrolling, or casual shopping not required by Today\'s Committed Tasks (even if disguised behind a generic window title, search page, or document).',
    '- "cannot_determine": Even with the full-screen OCR text and window metadata, there is genuinely not enough information to tell whether the screen is work-related or a distraction.',
    '',
    "=== TODAY'S COMMITTED TASKS ===",
    formattedTasks,
    '',
    '=== RECENT NAVIGATION BREADCRUMBS (OLDEST TO NEWEST) ===',
    formattedBreadcrumbs,
    '',
    '=== CURRENT ACTIVE WINDOW ===',
    `Window Title: "${String(currentWindow?.windowTitle || '')}"`,
    `Process Name: "${String(currentWindow?.processName || '')}"`,
    `Incognito/Private: ${Boolean(currentWindow?.isIncognito)}`,
    `Initial Title-Only Classifier State: "${String(initialChoice || 'cannot_determine')}"`,
    '',
    '=== FULL-SCREEN WINDOWS OCR TEXT ===',
    cleanOcr,
    '',
    'Return a JSON object with:',
    '- "choice": one of ["direct_work", "work_plumbing", "distraction", "cannot_determine"]',
    '- "confidence": number between 0 and 1 for the chosen category',
    '- "probabilities": object with numbers between 0 and 1 for "direct_work", "work_plumbing", "distraction", and "cannot_determine" (summing to ~1.0)',
    '- "reason": concise 1-2 sentence explanation referencing what on-screen OCR content matched or conflicted with the committed tasks.',
  ].join('\n');
}

/**
 * Builds the `client.interactions.create(...)` request payload for `gemini-4-hydrogen`.
 * @param {object} params
 * @returns {object}
 */
function buildGeminiInteractionRequest(params) {
  return {
    model: GEMINI_MODEL,
    input: buildGeminiOcrInput(params),
    store: false,
    background: false,
    generation_config: {
      thinking_level: GEMINI_THINKING_LEVEL,
    },
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: GEMINI_OCR_RESPONSE_SCHEMA,
    },
  };
}

/**
 * Parses and validates the JSON string from `interaction.output_text`.
 * @param {string} outputText
 * @returns {{ ok: boolean, choice?: string, confidence?: number, probabilities?: Record<string, number>, reason?: string, error?: string }}
 */
function parseGeminiInteractionOutput(outputText) {
  if (typeof outputText !== 'string' || !outputText.trim()) {
    return {
      ok: false,
      error: 'Empty output_text in Gemini interaction response',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse Gemini JSON output_text: ${err?.message || 'Invalid JSON'}`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      error: 'Gemini output_text did not parse to a JSON object',
    };
  }

  const choice = String(parsed.choice || '').trim();
  if (!VALID_CHOICES.has(choice)) {
    return {
      ok: false,
      error: `Invalid choice in Gemini response: ${choice || '<empty>'}`,
    };
  }

  const rawProbs =
    parsed.probabilities && typeof parsed.probabilities === 'object' ? parsed.probabilities : {};
  const probabilities = {};
  for (const key of VALID_CHOICES) {
    const val = Number(rawProbs[key]);
    probabilities[key] = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
  }

  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : probabilities[choice] ?? 0;

  // Ensure the selected choice's probability reflects at least confidence if probabilities were all 0
  const probSum = Object.values(probabilities).reduce((acc, v) => acc + v, 0);
  if (probSum === 0 && confidence > 0) {
    probabilities[choice] = confidence;
  }

  const reason = String(parsed.reason || '').trim() || `Classified as ${choice} via OCR + Gemini.`;

  return {
    ok: true,
    choice,
    confidence,
    probabilities,
    reason,
  };
}

/**
 * Client for evaluating full-screen OCR text against daily tasks using
 * Google's `@google/genai` Interactions API (`gemini-4-hydrogen`, `thinking_level: "low"`).
 */
class GeminiOcrClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] Explicit API key; defaults to process.env.GEMINI_API_KEY
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {object} [options.genAiClient] Optional injected GoogleGenAI client instance for testing
   */
  constructor(options = {}) {
    this.explicitApiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs || DEFAULT_GEMINI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.injectedClient = options.genAiClient || null;
  }

  getApiKey() {
    if (this.explicitApiKey !== undefined) {
      return String(this.explicitApiKey || '').trim();
    }
    return String(process.env.GEMINI_API_KEY || '').trim();
  }

  _getClient(apiKey) {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    return new GoogleGenAI({
      apiKey,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * Sends the committed task list, window metadata, and full-screen OCR text
   * to Gemini (`gemini-4-hydrogen`, `thinking_level: "low"`).
   * @param {{ tasks: string[], breadcrumbs?: Array<{windowTitle: string, processName: string}>, currentWindow: {windowTitle: string, processName: string, isIncognito?: boolean}, initialChoice?: string, ocrText: string, signal?: AbortSignal }} params
   * @returns {Promise<object>}
   */
  async evaluateWithOcr({
    tasks = [],
    breadcrumbs = [],
    currentWindow = {},
    initialChoice = '',
    ocrText = '',
    signal,
  }) {
    const startMs = Date.now();
    const apiKey = this.getApiKey();

    if (!apiKey && !this.injectedClient) {
      return {
        ok: false,
        aborted: false,
        error: 'GEMINI_API_KEY is not configured in .env',
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
          error: 'Gemini request aborted before dispatch',
          latencyMs: Date.now() - startMs,
        };
      }
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const client = this._getClient(apiKey);
      const requestPayload = buildGeminiInteractionRequest({
        tasks,
        breadcrumbs,
        currentWindow,
        initialChoice,
        ocrText,
      });

      const interaction = await client.interactions.create(requestPayload, {
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startMs;
      const parsed = parseGeminiInteractionOutput(interaction?.output_text);

      if (!parsed.ok) {
        return {
          ok: false,
          aborted: false,
          error: parsed.error,
          latencyMs,
          raw: interaction,
        };
      }

      return {
        ok: true,
        model: GEMINI_MODEL,
        thinkingLevel: GEMINI_THINKING_LEVEL,
        choice: parsed.choice,
        confidence: parsed.confidence,
        probabilities: parsed.probabilities,
        reason: parsed.reason,
        latencyMs,
        raw: interaction,
      };
    } catch (err) {
      const isCallerAbort = Boolean(signal?.aborted) && !timedOut;
      return {
        ok: false,
        aborted: isCallerAbort,
        error: timedOut
          ? `Gemini API timeout (${this.timeoutMs}ms)`
          : err?.message || 'Gemini API interaction failed',
        latencyMs: Date.now() - startMs,
      };
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }
}

module.exports = {
  GEMINI_MODEL,
  GEMINI_THINKING_LEVEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_OCR_RESPONSE_SCHEMA,
  buildGeminiOcrInput,
  buildGeminiInteractionRequest,
  parseGeminiInteractionOutput,
  GeminiOcrClient,
};

