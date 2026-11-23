// Snapshots go in before every mutation: ops.pop() would only undo an add, and a crop is not in ops.

const AnnotHistory = (() => {
  'use strict';

  const HISTORY_MAX = 50;

  // Handed out by `ops()` as well as taken by `snapshot()`: nobody outside gets the live objects.
  const copyOps = (ops) => ops.map((o) => (o.pts ? { ...o, pts: o.pts.map((p) => ({ ...p })) } : { ...o }));

  function makeHistory({ ops, getCrop, restoreCrop, onChange, max = HISTORY_MAX }) {
    const history = [];       // undo: {ops, crop} snapshots
    const future = [];        // redo: the mirror stack
    let run;                  // token of the run of pushes in progress; undefined means none

    // A null crop before the image loads yields {}; the caller's quirk is carried, not fixed.
    const snapshot = () => ({ ops: copyOps(ops), crop: { ...getCrop() } });
    function restore(snap) {
      ops.splice(0, ops.length, ...snap.ops);
      // The snapshot's ops are already in its crop coords, so resize without the shift.
      restoreCrop(snap.crop);
    }
    function push(snap, same) {
      // Still inside the run this token named: the step back is already on the stack.
      if (same !== undefined && same === run) return;
      run = same;
      history.push(snap || snapshot());
      if (history.length > max) history.shift();
      future.length = 0;
      onChange();
    }
    function undo() {
      if (!history.length) return;
      run = undefined;
      future.push(snapshot());
      restore(history.pop());
      onChange();
    }
    function redo() {
      if (!future.length) return;
      run = undefined;
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

  // Exported so the caller's `max` and `ops()` copy are the definitions the stack runs on.
  return { makeHistory, copyOps, HISTORY_MAX };
})();
