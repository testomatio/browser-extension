// Unsent comment drafts per result, in session storage: they survive navigation but never reach disk.

/* global hasChrome, state, $ */

const CommentDrafts = (() => {
  const DRAFTS_KEY = 'commentDrafts';
  const DRAFT_SAVE_MS = 400; // long enough that a burst of typing is one write

  // Held in memory and mirrored to storage; seeded first, or a reopened panel would overwrite drafts.
  let cache = null;
  let loading = null;

  async function load() {
    if (cache) return cache;
    if (loading) return loading;
    if (!hasChrome || !chrome.storage?.session) { cache = {}; return cache; }
    loading = (async () => {
      try {
        const all = (await chrome.storage.session.get(DRAFTS_KEY))[DRAFTS_KEY];
        cache = all && typeof all === 'object' ? all : {};
      } catch { cache = {}; } // best effort — a draft never fails an open
      return cache;
    })();
    return loading;
  }

  async function persist() {
    if (!hasChrome || !chrome.storage?.session) return;
    try { await chrome.storage.session.set({ [DRAFTS_KEY]: cache }); } catch { /* best effort */ }
  }

  // A bare string (an untagged legacy draft) still restores and answers no run, so prune skips it.
  const textOf = (entry) => (typeof entry === 'string' ? entry
    : (entry && typeof entry.text === 'string' ? entry.text : null));
  const runIdOf = (entry) => (entry && typeof entry === 'object' && entry.runId != null
    ? String(entry.runId) : null);

  // '' removes the row: storing it would keep one for every test passed through. Text stays verbatim.
  async function save(recordId, text, runId) {
    if (recordId == null) return;
    const all = await load();
    if (text === '') delete all[String(recordId)];
    else all[String(recordId)] = { text, runId: runId == null ? null : String(runId) };
    await persist();
  }

  const drop = (recordId) => save(recordId, '');

  // Every draft at once: a testrun id from the project being left means nothing in the next.
  async function dropAll() {
    await load(); // settle a read already on the wire, or its rows land back in the cache
    cache = {};
    if (!hasChrome || !chrome.storage?.session) return;
    try { await chrome.storage.session.remove(DRAFTS_KEY); } catch { /* best effort */ }
  }

  // Drops only entries tagged with the given run whose result is gone; other runs' and untagged stay.
  async function prune(runId) {
    const all = await load();
    const keys = Object.keys(all);
    if (!keys.length) return;
    const run = String(runId);
    const live = new Set(state.records.map((r) => String(r.id)));
    const stale = keys.filter((key) => runIdOf(all[key]) === run && !live.has(key));
    if (!stale.length) return;
    for (const key of stale) delete all[key];
    await persist();
  }

  // The draft never replaces a written comment: that is what the test says now.
  async function restore(record) {
    if (!record || record.message) return;
    const all = await load();
    const draft = textOf(all[String(record.id)]);
    if (draft === null) return; // absent answers null, never '' — an absent draft must not blank the box
    if (String(state.currentRecordId) !== String(record.id)) return; // moved on
    $('test-comment').value = draft;
  }

  // Id, run and text are captured on the keystroke: a late save still belongs to its own test.
  let pending = null;
  let saveTimer = null;

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!pending) return;
    const { recordId, text, runId } = pending;
    pending = null;
    save(recordId, text, runId);
  }

  // Also the evidence Attach path: it dispatches `input` on the box after pasting a snippet.
  function onInput() {
    const recordId = state.currentRecordId;
    // A pending save for another test is committed, not cancelled, by a keystroke here.
    if (pending && String(pending.recordId) !== String(recordId)) flush();
    pending = { recordId, text: $('test-comment').value, runId: state.runId };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DRAFT_SAVE_MS);
  }

  // `load` is public: anything asking "is there unsent typing here" needs the same seeded map.
  return { load, save, drop, dropAll, prune, restore, flush, onInput };
})();
