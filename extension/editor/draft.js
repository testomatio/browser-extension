/* global ShotStore */
const EditorDraft = (() => {
  // Persisted: a side panel closing can't show a beforeunload dialog, and a reload tears tabs down.
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
  // A restored draft's shots and how many are gone: only its own count knows they existed.
  async function readDraftShots(draft, key) {
    const had = Number(draft && draft.shots) || 0;
    if (!had) return { shots: [], lost: 0 };
    const shots = await ShotStore.get(key);
    return { shots, lost: Math.max(0, had - shots.length) };
  }

  // `read` is a bag of getters onto renderEditor's locals: their values change under every keystroke.
  function makeDirtyTracker({ ctx, draftKey, read }) {
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
      // Kill the scheduled persist too, or a write in flight re-creates the draft after this removed it.
      clearTimeout(persistTimer);
      if (ctx === 'tab') window.removeEventListener('beforeunload', beforeUnloadHandler);
      // In every context: a draft a tab left behind would restore over fresh server data.
      removeEditorDraft(draftKey);
    }

    function persistDraftNow() {
      if (!hasSession()) return;
      const draft = {
        title: read.title(),
        markdown: read.markdown(),
        priority: read.priority(),
        suite: read.suite(), test: read.test(), ts: Date.now(),
        shots: read.shots().length, // a count costs nothing, and outlives a store that lost them
      };
      // Only once the grid knows what the server holds: an earlier draft would restore an empty grid.
      const grid = read.params();
      if (grid) draft.params = grid;
      // A create whose test landed but parameters did not: else the restored draft makes a second test.
      const made = read.savedId && read.savedId();
      if (made) draft.savedId = made;
      // The recording too, so a reopened panel can still polish it, or put it back.
      const rec = read.recording();
      if (rec && rec.entries && rec.entries.length) draft.recording = rec;
      try { chrome.storage.session.set({ [draftKey]: draft }); } catch { /* best effort */ }
      // Pictures are too big for the draft itself; written only when the strip actually moved.
      const rev = read.shotsRev();
      if (shotsWritten !== rev) { shotsWritten = rev; ShotStore.put(draftKey, read.shots()); }
    }
    function schedulePersist() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistDraftNow, 400);
    }
    function onEdited() { markDirty(); schedulePersist(); read.stripRefresh(); }

    return { markDirty, clearDirty, persistDraftNow, schedulePersist, onEdited, isDirty: () => dirty };
  }

  return { editorDraftKey, hasSession, readEditorDraft, removeEditorDraft, readDraftShots, makeDirtyTracker };
})();
