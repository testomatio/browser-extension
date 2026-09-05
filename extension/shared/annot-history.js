// The annotator's undo stack (IIFE global `AnnotHistory`): the fifty steps back a tester gets after
// drawing, moving, deleting, retyping or cropping in shared/annotate-core.js. Nothing here touches a
// canvas, a document or `chrome.*` — it owns two arrays of snapshots and calls back. That is the
// point of the split: what a tester's Undo actually restores is checkable without a toolbar.
//
// Snapshots of {ops, crop} are pushed BEFORE every mutation: ops.pop() would only undo an add, and a
// crop is not in ops at all. A fresh push clears the redo stack.
//
// THE ENV BAG. The stack lives inside the caller's editor, so `makeHistory` is handed the four
// things it cannot own:
//   ops               — the caller's LIVE ops array. A restore SPLICES it in place and never
//                       replaces it: half of annotate-core.js holds a reference to that same array.
//   getCrop()         — the crop in force, {x, y, w, h}, or null before the image has loaded.
//   restoreCrop(crop) — put a snapshot's crop back in force, and drop the selection. The snapshot's
//                       ops are ALREADY in that crop's coords, so this must resize WITHOUT shifting
//                       them — re-shifting is invisible until a crop is undone.
//   onChange()        — after every push, undo and redo, so the caller can repaint its buttons.
//   max               — steps kept before the oldest is dropped; defaults to HISTORY_MAX.
// A caller that forgets the bag gets a TypeError, not a quietly dead Undo button.

const AnnotHistory = (() => {
  'use strict';

  const HISTORY_MAX = 50;

  // Handed out by `ops()` as well as taken by `snapshot()`: nobody outside gets the live objects.
  const copyOps = (ops) => ops.map((o) => (o.pts ? { ...o, pts: o.pts.map((p) => ({ ...p })) } : { ...o }));

  function makeHistory({ ops, getCrop, restoreCrop, onChange, max = HISTORY_MAX }) {
    const history = [];       // undo: {ops, crop} snapshots
    const future = [];        // redo: the mirror stack

    // `{ ...crop }` before the image has loaded (crop still null) yields {} — the quirk is the
    // caller's, and it is carried, not fixed.
    const snapshot = () => ({ ops: copyOps(ops), crop: { ...getCrop() } });
    function restore(snap) {
      ops.splice(0, ops.length, ...snap.ops);
      // The snapshot's ops are already in its crop coords — resize WITHOUT the shift.
      restoreCrop(snap.crop);
    }
    function push(snap) {
      history.push(snap || snapshot());
      if (history.length > max) history.shift();
      future.length = 0;
      onChange();
    }
    function undo() {
      if (!history.length) return;
      future.push(snapshot());
      restore(history.pop());
      onChange();
    }
    function redo() {
      if (!future.length) return;
      history.push(snapshot());
      restore(future.pop());
      onChange();
    }

    return {
      snapshot,
      push,
      undo,
      redo,
      canUndo: () => history.length > 0,
      canRedo: () => future.length > 0,
    };
  }

  // HISTORY_MAX and copyOps ride along: the cap the caller passes back in as `max` and the copy its
  // `ops()` getter hands out are the same two definitions the stack itself runs on, not clones.
  return { makeHistory, copyOps, HISTORY_MAX };
})();
