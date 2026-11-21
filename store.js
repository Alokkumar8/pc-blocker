const fs = require('node:fs');
const path = require('node:path');

/**
 * Formats a Date object as local YYYY-MM-DD.
 * @param {Date} [date]
 * @returns {string}
 */
function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats a Date object as a human-readable full date string.
 * @param {Date} [date]
 * @returns {string}
 */
function getFormattedDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Returns true if the given Date is at or after 6:00 AM local time.
 * @param {Date} [date]
 * @returns {boolean}
 */
function isAtOrAfterSixAM(date = new Date()) {
  return date.getHours() >= 6;
}

class DailyStore {
  /**
   * @param {string} storageDir Directory where daily-commitment.json is stored
   * @param {() => Date} [nowProvider] Optional clock function for testing date rollover
   */
  constructor(storageDir, nowProvider = () => new Date()) {
    this.filePath = path.join(storageDir, 'daily-commitment.json');
    this.nowProvider = nowProvider;
    this.data = this._loadFromDisk();
    this.checkAndRolloverDate();
  }

  _getDefaultState(dateStr) {
    return {
      currentDate: dateStr,
      committed: false,
      committedAt: null,
      midnightCrossedDate: null,
      tasks: [],
      history: {},
    };
  }

  _loadFromDisk() {
    const today = getLocalDateString(this.nowProvider());
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            currentDate: typeof parsed.currentDate === 'string' ? parsed.currentDate : today,
            committed: Boolean(parsed.committed),
            committedAt: parsed.committedAt || null,
            midnightCrossedDate: parsed.midnightCrossedDate || null,
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
            history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
          };
        }
      }
    } catch (err) {
      console.error('Failed to read daily commitment store, initializing fresh state:', err);
    }
    return this._getDefaultState(today);
  }

  _saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save daily commitment store:', err);
    }
  }

  /**
   * Checks if the system calendar date has crossed midnight (00:00) and whether
   * it has reached 6:00 AM to expire the past day's lock, switch from locked to
   * unlocked, and archive the previous day's tasks.
   * @returns {boolean} True if the daily lock state rolled over and unlocked.
   */
  checkAndRolloverDate() {
    const now = this.nowProvider();
    const today = getLocalDateString(now);

    if (this.data.currentDate !== today) {
      if (this.data.midnightCrossedDate !== today) {
        this.data.midnightCrossedDate = today;
        this._saveToDisk();
      }

      if (isAtOrAfterSixAM(now)) {
        const previousDate = this.data.currentDate;
        if (previousDate && this.data.tasks.length > 0) {
          this.data.history[previousDate] = {
            committed: this.data.committed,
            committedAt: this.data.committedAt,
            tasks: [...this.data.tasks],
          };
        }
        this.data.currentDate = today;
        this.data.committed = false;
        this.data.committedAt = null;
        this.data.midnightCrossedDate = null;
        this.data.tasks = [];
        this._saveToDisk();
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the system clock has crossed midnight (00:00) into a new calendar date.
   * @returns {boolean}
   */
  hasCrossedMidnight() {
    const now = this.nowProvider();
    const today = getLocalDateString(now);
    return this.data.currentDate !== today || this.data.midnightCrossedDate === today;
  }

  /**
   * Returns true if tasks have already been committed for the current active date.
   * @returns {boolean}
   */
  isCommittedForToday() {
    this.checkAndRolloverDate();
    return Boolean(this.data.committed && this.data.tasks.length > 0);
  }

  /**
   * Returns true if it is at or after 6:00 AM and no tasks are locked for the current date.
   * @returns {boolean}
   */
  shouldShowTerminalPrompt() {
    this.checkAndRolloverDate();
    const now = this.nowProvider();
    return isAtOrAfterSixAM(now) && !this.isCommittedForToday();
  }

  /**
   * Commits the user's daily tasks and locks the state for today.
   * @param {string[]} tasks
   */
  commitTasksForToday(tasks) {
    this.checkAndRolloverDate();
    const cleaned = (Array.isArray(tasks) ? tasks : [])
      .map((t) => String(t).trim())
      .filter(Boolean);

    if (cleaned.length === 0) {
      throw new Error('At least one task is required to commit.');
    }

    const now = this.nowProvider();
    const today = getLocalDateString(now);
    if (this.data.currentDate !== today && this.data.tasks.length > 0) {
      this.data.history[this.data.currentDate] = {
        committed: this.data.committed,
        committedAt: this.data.committedAt,
        tasks: [...this.data.tasks],
      };
    }

    this.data.currentDate = today;
    this.data.committed = true;
    this.data.committedAt = now.toISOString();
    this.data.midnightCrossedDate = null;
    this.data.tasks = cleaned;
    this._saveToDisk();
    return this.getState();
  }

  /**
   * Appends additional tasks to today's task list whenever the user wants.
   * @param {string[]} newTasks
   */
  addTasksForToday(newTasks) {
    this.checkAndRolloverDate();
    const cleaned = (Array.isArray(newTasks) ? newTasks : [])
      .map((t) => String(t).trim())
      .filter(Boolean);

    if (cleaned.length === 0) {
      return this.getState();
    }

    const combined = [...this.data.tasks, ...cleaned];
    return this.commitTasksForToday(combined);
  }

  /**
   * Resets today's tasks and commitment status (used for testing or manual reset).
   */
  resetToday() {
    const now = this.nowProvider();
    this.data.currentDate = getLocalDateString(now);
    this.data.committed = false;
    this.data.committedAt = null;
    this.data.midnightCrossedDate = null;
    this.data.tasks = [];
    this._saveToDisk();
    return this.getState();
  }

  /**
   * Returns a snapshot of the current day's state.
   */
  getState() {
    this.checkAndRolloverDate();
    const now = this.nowProvider();
    return {
      dateString: this.data.currentDate,
      formattedDate: getFormattedDate(now),
      committed: this.data.committed,
      committedAt: this.data.committedAt,
      midnightCrossedDate: this.data.midnightCrossedDate,
      tasks: [...this.data.tasks],
      history: { ...this.data.history },
    };
  }
}

module.exports = {
  DailyStore,
  getLocalDateString,
  getFormattedDate,
  isAtOrAfterSixAM,
};

