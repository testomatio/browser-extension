// Unsent comment drafts (IIFE global `CommentDrafts`). The comment box is READ only by a status
// write, so everything else that leaves the test used to throw the typing away — the pager, the
// hotkeys, Back, a tab click, the panel closing — and with it the evidence the Attach buttons
// paste into that same box. Kept per RESULT in chrome.storage.session: it outlives navigation and
// a closed panel, and dies with the browser session rather than reaching disk.
//
// One row per result: `{ text, runId }` — the run is what makes the prune below able to tell
// "this run dropped the result" from "the tester is simply in another run".
//
// It is its own file because four surfaces reach it and only one of them is the test view: the
// run open prunes, the project switch drops everything, app init wires the box, and the status
// write spends the draft it sent.

/* global hasChrome, state, $ */

const CommentDrafts = (() => {
  const DRAFTS_KEY = 'commentDrafts';
  const DRAFT_SAVE_MS = 400; // long enough that a burst of typing is one write

  // The panel document is the only writer, so the map is held in memory and MIRRORED to
  // storage (like the offline queue) — seeded once, or a reopened panel would write its
  // fresh map over the drafts already there.
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

  // Tolerant of the shape that came before the run tag: a bare string still restores, and
  // answers NO run — so the prune below never claims it.
  const textOf = (entry) => (typeof entry === 'string' ? entry
    : (entry && typeof entry.text === 'string' ? entry.text : null));
  const runIdOf = (entry) => (entry && typeof entry === 'object' && entry.runId != null
    ? String(entry.runId) : null);

  // '' is a REMOVAL, not a draft: an empty box restores as an empty box either way, and
  // storing it would keep a row for every test the tester merely passed through. Anything
  // else is kept VERBATIM — whitespace included, since only the write trims.
  async function save(recordId, text, runId) {
    if (recordId == null) return;
    const all = await load();
    if (text === '') delete all[String(recordId)];
    else all[String(recordId)] = { text, runId: runId == null ? null : String(runId) };
    await persist();
  }

  // Saving '' IS the removal, so a landed status needs no path of its own.
  const drop = (recordId) => save(recordId, '');

  // Every draft at once: a testrun id from the project being left means nothing in the next.
  async function dropAll() {
    await load(); // settle a read already on the wire, or its rows land back in the cache
    cache = {};
    if (!hasChrome || !chrome.storage?.session) return;
    try { await chrome.storage.session.remove(DRAFTS_KEY); } catch { /* best effort */ }
  }

  // Run open is the one moment the panel knows which results a run still has — so an entry
  // tagged with THIS run whose result is gone goes, and nothing else does: a draft typed in
  // another run is not this run's to judge, and an untagged one belongs to no run at all.
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

  // The open already painted `record.message`; the draft only replaces it on a result
  // that carries none of its own — a written comment is what that test says now.
  async function restore(record) {
    if (!record || record.message) return;
    const all = await load();
    const draft = textOf(all[String(record.id)]);
    if (draft === null) return; // absent answers null, never '' — an absent draft must not blank the box
    if (String(state.currentRecordId) !== String(record.id)) return; // moved on
    $('test-comment').value = draft;
  }

  // Debounced, and the id, the run and the text are ALL captured on the keystroke: a save
  // that lands after the tester paged on still belongs to the test it was typed in.
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
    // A pending save for ANOTHER test is committed, not cancelled, by this keystroke.
    if (pending && String(pending.recordId) !== String(recordId)) flush();
    pending = { recordId, text: $('test-comment').value, runId: state.runId };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DRAFT_SAVE_MS);
  }

  // `load` is public because the prune and the restore are not the only legitimate readers:
  // anything asking "is there unsent typing here" needs the same seeded map, not a second read.
  return { load, save, drop, dropAll, prune, restore, flush, onInput };
})();
