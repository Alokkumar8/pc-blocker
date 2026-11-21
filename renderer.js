const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

function getOrdinalWord(indexZeroBased) {
  if (indexZeroBased < ORDINALS.length) {
    return ORDINALS[indexZeroBased];
  }
  const n = indexZeroBased + 1;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n}st`;
  if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
  return `${n}th`;
}

const STATE = {
  ENTERING_TASKS: 'ENTERING_TASKS',
  CONFIRMING: 'CONFIRMING',
  LOCKED: 'LOCKED',
};

window.addEventListener('DOMContentLoaded', async () => {
  const headerDateEl = document.getElementById('header-date');
  const historyEl = document.getElementById('terminal-history');
  const activeLineEl = document.getElementById('active-line');
  const promptLabelEl = document.getElementById('prompt-label');
  const typedInputEl = document.getElementById('typed-input');
  const typedInputAfterEl = document.getElementById('typed-input-after');
  const terminalScreenEl = document.getElementById('terminal-screen');

  let currentState = STATE.ENTERING_TASKS;
  let existingTasks = [];
  let tasks = [];
  let currentBuffer = '';
  let cursorPos = 0;

  function clearBuffer() {
    currentBuffer = '';
    cursorPos = 0;
  }

  function scrollToBottom() {
    terminalScreenEl.scrollTop = terminalScreenEl.scrollHeight;
  }

  function getTaskPromptText(taskIndex) {
    const ordinal = getOrdinalWord(taskIndex);
    if (taskIndex === 0) {
      return `Enter your ${ordinal} important task for today:`;
    }
    return `Enter your ${ordinal} important task for today (or type 'done' / 'exit'):`;
  }

  function updateActivePrompt() {
    if (cursorPos < 0) cursorPos = 0;
    if (cursorPos > currentBuffer.length) cursorPos = currentBuffer.length;

    if (currentState === STATE.ENTERING_TASKS) {
      promptLabelEl.classList.remove('confirm-mode');
      promptLabelEl.textContent = getTaskPromptText(tasks.length);
      if (typedInputAfterEl) {
        typedInputEl.textContent = currentBuffer.slice(0, cursorPos);
        typedInputAfterEl.textContent = currentBuffer.slice(cursorPos);
      } else {
        typedInputEl.textContent = currentBuffer;
      }
      activeLineEl.classList.remove('hidden');
    } else if (currentState === STATE.CONFIRMING) {
      promptLabelEl.classList.add('confirm-mode');
      promptLabelEl.textContent =
        'Confirm and lock your PC for today? Press [ENTER] to commit, or [R] to re-enter tasks.';
      typedInputEl.textContent = '';
      if (typedInputAfterEl) {
        typedInputAfterEl.textContent = '';
      }
      activeLineEl.classList.remove('hidden');
    } else if (currentState === STATE.LOCKED) {
      activeLineEl.classList.add('hidden');
    }
    scrollToBottom();
  }

  function appendHistoryLine(promptText, userText, className = '') {
    const line = document.createElement('div');

    if (userText !== undefined) {
      line.className = `terminal-line history-entry ${className}`.trim();

      const questionRow = document.createElement('div');
      questionRow.className = 'history-question-row';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'history-icon-done';
      iconSpan.textContent = '\u2714 ';

      const promptSpan = document.createElement('span');
      promptSpan.className = 'line-prompt';
      promptSpan.textContent = promptText;

      questionRow.appendChild(iconSpan);
      questionRow.appendChild(promptSpan);

      const answerRow = document.createElement('div');
      answerRow.className = 'history-answer-row';

      const chevronSpan = document.createElement('span');
      chevronSpan.className = 'history-chevron';
      chevronSpan.textContent = '\u203A ';

      const userSpan = document.createElement('span');
      userSpan.className = 'line-user-input';
      userSpan.textContent = userText;

      answerRow.appendChild(chevronSpan);
      answerRow.appendChild(userSpan);

      line.appendChild(questionRow);
      line.appendChild(answerRow);
    } else {
      line.className = `terminal-line ${className}`.trim();
      line.textContent = promptText;
    }

    historyEl.appendChild(line);
    scrollToBottom();
  }

  function transitionToConfirmation() {
    currentState = STATE.CONFIRMING;
    clearBuffer();

    appendHistoryLine(
      `--- DAILY TASK SUMMARY (${tasks.length} ${tasks.length === 1 ? 'TASK' : 'TASKS'}) ---`,
      undefined,
      'line-summary-header'
    );

    tasks.forEach((task, idx) => {
      appendHistoryLine(`  [${idx + 1}] ${task}`, undefined, 'line-summary-item');
    });

    updateActivePrompt();
  }

  async function commitAndLock() {
    if (currentState === STATE.LOCKED) return;
    currentState = STATE.LOCKED;
    updateActivePrompt();

    appendHistoryLine(
      'Confirm and lock your PC for today? Press [ENTER] to commit, or [R] to re-enter tasks.',
      '[ENTER]'
    );
    appendHistoryLine(
      '\u2714 [OK] Daily commitment locked. Closing interface and starting background monitor...',
      undefined,
      'line-ok'
    );

    try {
      await window.pcBlocker.commitTasks(tasks);
    } catch (err) {
      appendHistoryLine(`[ERROR] Failed to commit tasks: ${err.message}`, undefined, 'line-notice');
    }
  }

  function resetTaskEntry() {
    appendHistoryLine(
      'Confirm and lock your PC for today? Press [ENTER] to commit, or [R] to re-enter tasks.',
      '[R]'
    );
    appendHistoryLine(
      existingTasks.length > 0
        ? '[!] Newly added tasks cleared. Re-enter your additional tasks for today:'
        : '[!] Task list cleared. Re-enter your important tasks for today:',
      undefined,
      'line-notice'
    );
    tasks = [...existingTasks];
    clearBuffer();
    currentState = STATE.ENTERING_TASKS;
    updateActivePrompt();
  }

  function handleTaskSubmission() {
    const promptText = getTaskPromptText(tasks.length);
    const trimmed = currentBuffer.trim();

    if (trimmed.length === 0) {
      appendHistoryLine(
        tasks.length === 0
          ? '[!] Please enter at least one important task for today.'
          : "[!] Task cannot be empty. Enter a task, type 'done' if done adding task, or type 'exit' to close the application.",
        undefined,
        'line-notice'
      );
      clearBuffer();
      updateActivePrompt();
      return;
    }

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === '[exit]') {
      appendHistoryLine(promptText, currentBuffer);
      clearBuffer();
      currentState = STATE.LOCKED;
      updateActivePrompt();

      if (tasks.length > existingTasks.length) {
        appendHistoryLine(
          `--- DAILY TASK SUMMARY (${tasks.length} ${tasks.length === 1 ? 'TASK' : 'TASKS'}) ---`,
          undefined,
          'line-summary-header'
        );
        tasks.forEach((task, idx) => {
          appendHistoryLine(`  [${idx + 1}] ${task}`, undefined, 'line-summary-item');
        });
        appendHistoryLine(
          '\u2714 [OK] Tasks saved and locked. Exiting terminal prompt and starting background monitor...',
          undefined,
          'line-ok'
        );
        const savePromise =
          window.pcBlocker && typeof window.pcBlocker.commitTasks === 'function'
            ? window.pcBlocker.commitTasks(tasks)
            : Promise.resolve();
        savePromise
          .then(() => {
            if (window.pcBlocker && typeof window.pcBlocker.exitTerminal === 'function') {
              return window.pcBlocker.exitTerminal(tasks);
            }
          })
          .catch((err) => {
            appendHistoryLine(
              `[ERROR] Failed to save tasks and exit: ${err.message}`,
              undefined,
              'line-notice'
            );
          });
        return;
      }

      appendHistoryLine(
        '\u2714 [OK] Exiting terminal prompt without adding tasks...',
        undefined,
        'line-ok'
      );
      if (window.pcBlocker && typeof window.pcBlocker.exitTerminal === 'function') {
        window.pcBlocker.exitTerminal().catch((err) => {
          appendHistoryLine(`[ERROR] Failed to exit terminal: ${err.message}`, undefined, 'line-notice');
        });
      }
      return;
    }

    if (trimmed.toLowerCase() === 'done') {
      appendHistoryLine(promptText, currentBuffer);
      clearBuffer();

      if (tasks.length === 0) {
        appendHistoryLine(
          '[!] You must enter at least one important task before typing done.',
          undefined,
          'line-notice'
        );
        updateActivePrompt();
        return;
      }

      transitionToConfirmation();
      return;
    }

    // Record the task and advance to the next ordinal prompt
    appendHistoryLine(promptText, currentBuffer);
    tasks.push(trimmed);
    clearBuffer();
    updateActivePrompt();
  }

  let lastPasteTime = 0;

  function normalizePastedTaskText(rawText) {
    return String(rawText ?? '').replace(/[\r\n\t]+/g, ' ');
  }

  function appendPastedText(rawText) {
    if (currentState !== STATE.ENTERING_TASKS) return;
    const normalized = normalizePastedTaskText(rawText);
    if (normalized.length > 0) {
      currentBuffer =
        currentBuffer.slice(0, cursorPos) + normalized + currentBuffer.slice(cursorPos);
      cursorPos += normalized.length;
      updateActivePrompt();
    }
  }

  function writeClipboardSafely(text) {
    if (!text) return;
    if (window.pcBlocker && typeof window.pcBlocker.writeClipboardText === 'function') {
      try {
        Promise.resolve(window.pcBlocker.writeClipboardText(text)).catch(() => {});
      } catch {}
    }
  }

  function getSelectedOrTypedText() {
    if (typeof window.getSelection === 'function') {
      const sel = window.getSelection();
      const selectedText = sel ? String(sel.toString() || '') : '';
      if (selectedText.length > 0) {
        return selectedText;
      }
    }
    return currentBuffer;
  }

  // Block native context menu while keeping mouse cursor and text selection enabled
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // Handle native clipboard paste/copy/cut events
  window.addEventListener('paste', (e) => {
    if (currentState !== STATE.ENTERING_TASKS) return;
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const clipDataText =
      e.clipboardData && typeof e.clipboardData.getData === 'function'
        ? e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || ''
        : '';
    if (clipDataText) {
      if (Date.now() - lastPasteTime < 100) return;
      lastPasteTime = Date.now();
      appendPastedText(clipDataText);
      return;
    }
    if (window.pcBlocker && typeof window.pcBlocker.readClipboardText === 'function') {
      try {
        const res = window.pcBlocker.readClipboardText();
        if (typeof res === 'string') {
          if (Date.now() - lastPasteTime >= 100) {
            lastPasteTime = Date.now();
            appendPastedText(res);
          }
        } else if (res && typeof res.then === 'function') {
          res
            .then((text) => {
              if (text && Date.now() - lastPasteTime >= 100) {
                lastPasteTime = Date.now();
                appendPastedText(text);
              }
            })
            .catch(() => {});
        }
      } catch {}
    }
  });

  window.addEventListener('copy', (e) => {
    const textToCopy = getSelectedOrTypedText();
    if (!textToCopy) return;
    if (e.clipboardData && typeof e.clipboardData.setData === 'function') {
      e.preventDefault();
      e.clipboardData.setData('text/plain', textToCopy);
    }
    writeClipboardSafely(textToCopy);
  });

  window.addEventListener('cut', (e) => {
    if (currentState !== STATE.ENTERING_TASKS || currentBuffer.length === 0) return;
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    if (e.clipboardData && typeof e.clipboardData.setData === 'function') {
      e.clipboardData.setData('text/plain', currentBuffer);
    }
    writeClipboardSafely(currentBuffer);
    clearBuffer();
    updateActivePrompt();
  });

  // Keyboard navigation + copy/paste shortcuts + Ctrl+Shift+W full exit
  window.addEventListener('keydown', (e) => {
    const isCtrlOrMeta = Boolean(e.ctrlKey || e.metaKey);
    const lowerKey = (e.key || '').toLowerCase();

    // Full application exit shortcut (UI + background process): Ctrl+Shift+W
    if (isCtrlOrMeta && e.shiftKey && !e.altKey && lowerKey === 'w') {
      e.preventDefault();
      e.stopPropagation();
      if (window.pcBlocker && typeof window.pcBlocker.quitApp === 'function') {
        try {
          Promise.resolve(window.pcBlocker.quitApp()).catch(() => {});
        } catch {}
      }
      return;
    }

    // Intercept and disable window-closing or system escape shortcuts
    if (
      e.key === 'Escape' ||
      (e.altKey && e.key === 'F4') ||
      (e.ctrlKey && !e.shiftKey && (lowerKey === 'w' || lowerKey === 'q')) ||
      (e.altKey && e.code === 'Space') ||
      e.key === 'F11'
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Copy shortcut: Ctrl+C / Cmd+C / Ctrl+Insert
    if (
      (isCtrlOrMeta && !e.altKey && !e.shiftKey && lowerKey === 'c') ||
      (e.ctrlKey && !e.altKey && e.key === 'Insert')
    ) {
      const textToCopy = getSelectedOrTypedText();
      if (textToCopy) {
        writeClipboardSafely(textToCopy);
      }
      return;
    }

    if (currentState === STATE.LOCKED) {
      e.preventDefault();
      return;
    }

    if (currentState === STATE.CONFIRMING) {
      e.preventDefault();
      if (e.key === 'Enter') {
        commitAndLock();
      } else if (e.key === 'r' || e.key === 'R') {
        resetTaskEntry();
      }
      return;
    }

    if (currentState === STATE.ENTERING_TASKS) {
      // Paste shortcut: Ctrl+V / Cmd+V / Shift+Insert
      if (
        (isCtrlOrMeta && !e.altKey && !e.shiftKey && lowerKey === 'v') ||
        (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Insert')
      ) {
        if (window.pcBlocker && typeof window.pcBlocker.readClipboardText === 'function') {
          try {
            const res = window.pcBlocker.readClipboardText();
            if (typeof res === 'string') {
              e.preventDefault();
              lastPasteTime = Date.now();
              appendPastedText(res);
            } else if (res && typeof res.then === 'function') {
              res
                .then((text) => {
                  if (text && Date.now() - lastPasteTime >= 100) {
                    lastPasteTime = Date.now();
                    appendPastedText(text);
                  }
                })
                .catch(() => {});
            }
          } catch {}
        }
        return;
      }

      // Cut shortcut: Ctrl+X / Cmd+X
      if (isCtrlOrMeta && !e.altKey && !e.shiftKey && lowerKey === 'x') {
        e.preventDefault();
        if (currentBuffer.length > 0) {
          writeClipboardSafely(currentBuffer);
          clearBuffer();
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (cursorPos > 0) {
          if (isCtrlOrMeta) {
            const before = currentBuffer.slice(0, cursorPos);
            const match = before.match(/\S+\s*$/);
            cursorPos = match ? cursorPos - match[0].length : 0;
          } else {
            cursorPos -= 1;
          }
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (cursorPos < currentBuffer.length) {
          if (isCtrlOrMeta) {
            const after = currentBuffer.slice(cursorPos);
            const match = after.match(/^\s*\S+/);
            cursorPos = match ? cursorPos + match[0].length : currentBuffer.length;
          } else {
            cursorPos += 1;
          }
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        if (cursorPos !== 0) {
          cursorPos = 0;
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'End') {
        e.preventDefault();
        if (cursorPos !== currentBuffer.length) {
          cursorPos = currentBuffer.length;
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        handleTaskSubmission();
        return;
      }

      if (e.key === 'Backspace') {
        e.preventDefault();
        if (cursorPos > 0) {
          if (isCtrlOrMeta) {
            const before = currentBuffer.slice(0, cursorPos);
            const after = currentBuffer.slice(cursorPos);
            const newBefore = before.replace(/\s*\S+\s*$/, '');
            currentBuffer = newBefore + after;
            cursorPos = newBefore.length;
          } else {
            currentBuffer =
              currentBuffer.slice(0, cursorPos - 1) + currentBuffer.slice(cursorPos);
            cursorPos -= 1;
          }
          updateActivePrompt();
        }
        return;
      }

      if (e.key === 'Delete') {
        e.preventDefault();
        if (cursorPos < currentBuffer.length) {
          if (isCtrlOrMeta) {
            const before = currentBuffer.slice(0, cursorPos);
            const after = currentBuffer.slice(cursorPos);
            const newAfter = after.replace(/^\s*\S+\s*/, '');
            currentBuffer = before + newAfter;
          } else {
            currentBuffer =
              currentBuffer.slice(0, cursorPos) + currentBuffer.slice(cursorPos + 1);
          }
          updateActivePrompt();
        }
        return;
      }

      // Accept printable characters (no Ctrl/Alt/Meta modifier combinations)
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        currentBuffer =
          currentBuffer.slice(0, cursorPos) + e.key + currentBuffer.slice(cursorPos);
        cursorPos += e.key.length;
        updateActivePrompt();
      }
    }
  });

  updateActivePrompt();

  // Populate current date in header and restore any already-locked tasks for today
  try {
    const state = await window.pcBlocker.getInitialState();
    headerDateEl.textContent = `${state.formattedDate} (${state.dateString})`;

    if (state.committed && Array.isArray(state.tasks) && state.tasks.length > 0) {
      existingTasks = [...state.tasks];
      tasks = [...state.tasks];

      appendHistoryLine(
        `--- CURRENTLY LOCKED TASKS (${existingTasks.length} ${existingTasks.length === 1 ? 'TASK' : 'TASKS'}) ---`,
        undefined,
        'line-summary-header'
      );
      existingTasks.forEach((task, idx) => {
        appendHistoryLine(`  [${idx + 1}] ${task}`, undefined, 'line-summary-item');
      });
    }
  } catch {
    const now = new Date();
    headerDateEl.textContent = now.toDateString();
  }

  updateActivePrompt();
});
