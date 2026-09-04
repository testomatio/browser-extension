// The editor's unsaved draft (IIFE global `EditorDraft`): the storage.session key it lives under,
// reading one back with its staged screenshots, and the dirty tracker that writes it while typing.

/* global ShotStore */
const EditorDraft = (() => {
  // ---- panel-ctx unsaved-edit persistence (data-loss guard) ----------------
  // Closing a side panel tears the page down with no native unload prompt (beforeunload
  // can't show a dialog there and doesn't fire reliably), so the dirty draft is persisted.
  const editorDraftKey = ({ suite, test }) => (test
    ? `editorDraft:test:${test}`
    : `editorDraft:suite:${suite}`);
  function hasSession() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
  }
  async function readEditorDraft(key) {
    if (!hasSession()) return null;
    try { const o = await chrome.storage.session.get(key); return (o && o[key]) || null; } catch { return null; }
  }
  function removeEditorDraft(key) {
    ShotStore.del(key); // the shots are this draft's, and nothing else would ever come back for them
    if (!hasSession()) return;
    try { chrome.storage.session.remove(key); } catch { /* best effort */ }
  }
  // A restored draft's shots, and how many are gone — its own count is what knows they existed.
  async function readDraftShots(draft, key) {
    const had = Number(draft && draft.shots) || 0;
    if (!had) return { shots: [], lost: 0 };
    const shots = await ShotStore.get(key);
    return { shots, lost: Math.max(0, had - shots.length) };
  }

  // ---- the editor's dirty state, and the draft it writes -------------------
  // Everything below reads renderEditor's own locals (the title field, the OverType instance, the
  // priority control, the grid, the screenshot strip and the recording), so it takes `read`: a bag
  // of getters onto them rather than their values, which change under every keystroke.
  function makeDirtyTracker({ ctx, draftKey, read }) {
    // Dirty tracking is centralized so the tab-ctx `beforeunload` guard mirrors it —
    // registered only while dirty; panel ctx persists to storage.session instead.
    let dirty = false;
    let persistTimer = null;
    let shotsWritten = -1; // the revision the store holds: ten JPEGs per typing pause is too many
    const beforeUnloadHandler = (e) => { e.preventDefault(); e.returnValue = ''; };
    function markDirty() {
      if (dirty) return;
      dirty = true;
      if (ctx === 'tab') window.addEventListener('beforeunload', beforeUnloadHandler);
    }
    function clearDirty() {
      if (!dirty) return;
      dirty = false;
      // Kill the scheduled persist too, or a throttled write still in flight re-creates
      // the draft milliseconds after this removed it.
      clearTimeout(persistTimer);
      if (ctx === 'tab') window.removeEventListener('beforeunload', beforeUnloadHandler);
      if (ctx === 'panel') removeEditorDraft(draftKey);
    }

    function persistDraftNow() {
      if (ctx !== 'panel' || !hasSession()) return;
      const draft = {
        title: read.title(),
        markdown: read.markdown(),
        priority: read.priority(),
        suite: read.suite(), test: read.test(), ts: Date.now(),
        shots: read.shots().length, // a count costs nothing, and outlives a store that lost them
      };
      // Only once the grid knows what the server holds (#5): a draft written before that read lands
      // would restore an empty grid over real parameters.
      const grid = read.params();
      if (grid) draft.params = grid;
      // A create whose test already landed but whose parameters did not: without this the restored
      // draft opens as a create again and a second Save makes a second test.
      const made = read.savedId && read.savedId();
      if (made) draft.savedId = made;
      // #23: the recording itself — its entries (packets included) and where its items are —
      // so a reopened panel can still polish it, or put it back.
      const rec = read.recording();
      if (rec && rec.entries && rec.entries.length) draft.recording = rec;
      try { chrome.storage.session.set({ [draftKey]: draft }); } catch { /* best effort */ }
      // …and the pictures, far too big for the draft itself — only when the strip actually moved.
      const rev = read.shotsRev();
      if (shotsWritten !== rev) { shotsWritten = rev; ShotStore.put(draftKey, read.shots()); }
    }
    function schedulePersist() {
      if (ctx !== 'panel') return;
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistDraftNow, 400);
    }
    function onEdited() { markDirty(); schedulePersist(); read.stripRefresh(); }

    return { markDirty, clearDirty, persistDraftNow, schedulePersist, onEdited, isDirty: () => dirty };
  }

  return { editorDraftKey, hasSession, readEditorDraft, removeEditorDraft, readDraftShots, makeDirtyTracker };
})();
