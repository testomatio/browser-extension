// The "Run in Extension" click: a Testomat page leaves it in session storage, and whichever panel
// wakes up next spends it. Core, not a screen — app.js reads it at boot and again on every live write.

// No `/* global */` list, the way core/storage.js has none: `chrome` is the browser's own, and
// the opener arrives as an ARGUMENT, so this file names no other file's global.

const OPEN_RUN_INTENT_KEY = 'openRunIntent';
const OPEN_RUN_INTENT_MAX_AGE_MS = 60000; // the panel it woke may be slow; a click older than this is not this one

const OpenRunIntent = {
  drop() {
    try { chrome.storage.session?.remove(OPEN_RUN_INTENT_KEY)?.catch(() => {}); } catch { /* no session storage */ }
  },

  // The key is removed BEFORE it is acted on, so boot and the live listener cannot both run it.
  async consume(openRun) {
    let intent;
    try {
      if (!chrome.storage?.session) return false;
      intent = (await chrome.storage.session.get(OPEN_RUN_INTENT_KEY))[OPEN_RUN_INTENT_KEY];
      if (!intent) return false;
      await chrome.storage.session.remove(OPEN_RUN_INTENT_KEY);
    } catch { return false; }
    if (!intent.url || Date.now() - Number(intent.at || 0) > OPEN_RUN_INTENT_MAX_AGE_MS) return false;
    return openRun(intent.url);
  },

  init(openRun) {
    try {
      chrome.storage.session.onChanged.addListener((c) => {
        if (c[OPEN_RUN_INTENT_KEY]?.newValue) OpenRunIntent.consume(openRun);
      });
    } catch { /* older Chrome — no session onChanged */ }
  },
};
