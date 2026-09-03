// Staged screenshots of an unsaved editor draft (IIFE global `ShotStore`). The draft itself lives
// in chrome.storage.session, but a staged shot is a full-page JPEG data URL — half a megabyte and
// up, ten of them allowed — and that budget is ~10 MB shared with everything else the extension
// keeps there, so writing them alongside the draft would lose the draft too. They get a database
// of their own instead: `testomat-shots`, one store of `{ key, shots, at }` keyed by the draft key.
//
// Loaded by the editor page AND by the service worker (which sweeps), so nothing here may touch
// `window` or `document`. Nothing here throws either: a browser that refuses IndexedDB has to
// degrade to the old behaviour — the draft comes back without its pictures — not break the editor.

const ShotStore = (() => {
  const DB_NAME = 'testomat-shots';
  const STORE = 'shots';

  // Opened per call and closed after: a connection held open in one document blocks another's upgrade.
  function openDb() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  // `run` gets the store and a `deliver` for the answer; the COMMIT hands it over, so an aborted
  // write reports the fallback rather than a success it did not have.
  async function inStore(mode, fallback, run) {
    const db = await openDb();
    if (!db) return fallback;
    try {
      return await new Promise((resolve) => {
        let out = fallback;
        try {
          const tx = db.transaction(STORE, mode);
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => resolve(fallback);
          tx.onabort = () => resolve(fallback);
          run(tx.objectStore(STORE), (v) => { out = v; });
        } catch { resolve(fallback); }
      });
    } finally {
      try { db.close(); } catch { /* already gone */ }
    }
  }

  /** Replace the record for `key`; nothing to keep deletes it instead of storing an empty row. */
  function put(key, shots) {
    const list = (Array.isArray(shots) ? shots : []).filter((s) => typeof s === 'string' && s);
    if (!key || !list.length) return del(key);
    return inStore('readwrite', false, (store, deliver) => {
      store.put({ key, shots: list, at: Date.now() });
      deliver(true);
    });
  }

  /** The shots staged under `key` — empty when there are none, or when IndexedDB refused. */
  function get(key) {
    if (!key) return Promise.resolve([]);
    return inStore('readonly', [], (store, deliver) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result;
        deliver(rec && Array.isArray(rec.shots) ? rec.shots : []);
      };
    });
  }

  /** Drop the record for `key`, whether or not it is there. */
  function del(key) {
    if (!key) return Promise.resolve(false);
    return inStore('readwrite', false, (store, deliver) => {
      store.delete(key);
      deliver(true);
    });
  }

  /** Drop every record no key in `liveKeys` claims, and every record older than `maxAgeMs`. */
  function sweep(liveKeys, maxAgeMs) {
    const live = new Set(Array.isArray(liveKeys) ? liveKeys : []);
    const oldest = Date.now() - (maxAgeMs > 0 ? maxAgeMs : 0);
    return inStore('readwrite', 0, (store, deliver) => {
      let dropped = 0;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { deliver(dropped); return; }
        const rec = cur.value;
        // A record with no timestamp is one no build of ours wrote — it goes with the stale ones.
        if (!live.has(cur.key) || !(rec && rec.at > oldest)) { cur.delete(); dropped += 1; }
        cur.continue();
      };
    });
  }

  return { put, get, del, sweep };
})();
