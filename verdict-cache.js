const fs = require('node:fs');
const path = require('node:path');
const { normalizeProcessBase } = require('./window-monitor');

/**
 * Normalizes a window title for consistent cache lookups.
 * Strips Edge zero-width spaces and collapses whitespace.
 * @param {string} [windowTitle]
 * @returns {string}
 */
function normalizeWindowTitle(windowTitle = '') {
  return String(windowTitle || '')
    .replace(/\u200b/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Normalizes an array of daily tasks for simple equality checks.
 * @param {string[]} [tasks]
 * @returns {string[]}
 */
function normalizeTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((t) => String(t).trim())
    .filter(Boolean);
}

/**
 * Returns true if two task lists have identical normalized entries in order.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function areSameTaskLists(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Builds a simple composite cache key combining date, normalized process,
 * normalized window title, and incognito metadata.
 * @param {{ dateString: string, windowTitle: string, processName: string, isIncognito?: boolean }} params
 * @returns {string}
 */
function buildCompositeCacheKey({ dateString, windowTitle, processName, isIncognito }) {
  return JSON.stringify([
    String(dateString || ''),
    normalizeProcessBase(processName),
    normalizeWindowTitle(windowTitle),
    Boolean(isIncognito),
  ]);
}

/**
 * Gate 1: Fast local verdict cache (0 ms, offline) backed by JSON disk persistence.
 * Automatically clears stale entries when the active date or today's task list changes.
 */
class VerdictCache {
  /**
   * @param {string} storageDir Directory where verdict-cache.json is stored
   * @param {() => Date} [nowProvider]
   */
  constructor(storageDir, nowProvider = () => new Date()) {
    this.filePath = path.join(storageDir, 'verdict-cache.json');
    this.nowProvider = nowProvider;
    this.dateString = '';
    this.tasks = [];
    this.entries = new Map();
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      this.dateString = typeof parsed.dateString === 'string' ? parsed.dateString : '';
      this.tasks = normalizeTasks(parsed.tasks);
      if (parsed.entries && typeof parsed.entries === 'object') {
        for (const [key, value] of Object.entries(parsed.entries)) {
          if (value && typeof value === 'object') {
            this.entries.set(key, value);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load verdict cache, starting empty:', err);
      this.entries.clear();
    }
  }

  _saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload = {
        dateString: this.dateString,
        tasks: this.tasks,
        entries: Object.fromEntries(this.entries.entries()),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save verdict cache:', err);
    }
  }

  /**
   * Aligns the cache with the active date and task list, clearing entries if either changed.
   * @param {string} dateString
   * @param {string[]} tasks
   * @returns {boolean} True if cache was reset due to date/task change
   */
  syncActiveTasks(dateString, tasks) {
    const cleanDate = String(dateString || '');
    const cleanTasks = normalizeTasks(tasks);

    if (this.dateString === cleanDate && areSameTaskLists(this.tasks, cleanTasks)) {
      return false;
    }

    this.dateString = cleanDate;
    this.tasks = cleanTasks;
    this.entries.clear();
    this._saveToDisk();
    return true;
  }

  /**
   * Looks up a cached verdict for the active window against today's date and task list.
   * @param {{ dateString: string, tasks: string[], windowTitle: string, processName: string, isIncognito?: boolean }} context
   * @returns {{ hit: boolean, key: string, entry?: object }}
   */
  get(context) {
    const cleanDate = String(context.dateString || '');
    const cleanTasks = normalizeTasks(context.tasks);
    const key = buildCompositeCacheKey(context);

    if (
      cleanDate !== this.dateString ||
      !areSameTaskLists(this.tasks, cleanTasks) ||
      cleanTasks.length === 0
    ) {
      return { hit: false, key };
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return { hit: false, key };
    }

    return { hit: true, key, entry: { ...entry } };
  }

  /**
   * Persists a Gate 2 evaluation verdict in the local cache.
   * @param {{ dateString: string, tasks: string[], windowTitle: string, processName: string, isIncognito?: boolean }} context
   * @param {object} verdict
   */
  set(context, verdict) {
    this.syncActiveTasks(context.dateString, context.tasks);
    const key = buildCompositeCacheKey(context);
    const entry = {
      decision: verdict.decision,
      choice: verdict.choice,
      confidence: verdict.confidence,
      probabilities: verdict.probabilities ? { ...verdict.probabilities } : {},
      windowTitle: String(context.windowTitle || ''),
      processName: String(context.processName || ''),
      isIncognito: Boolean(context.isIncognito),
      cachedAt: this.nowProvider().toISOString(),
    };

    this.entries.set(key, entry);
    this._saveToDisk();
    return entry;
  }

  /**
   * Clears all cached entries immediately.
   */
  clear() {
    this.entries.clear();
    this._saveToDisk();
  }

  /**
   * Returns the number of cached entries currently stored.
   * @returns {number}
   */
  size() {
    return this.entries.size;
  }
}

module.exports = {
  VerdictCache,
  normalizeWindowTitle,
  normalizeTasks,
  areSameTaskLists,
  buildCompositeCacheKey,
};

