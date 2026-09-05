// A hand-written IndexedDB for node:vm tests — `indexedDB.open`, one database, one object store, a
// transaction and a cursor. Written from the API contract, NOT from a browser run: cursor key types,
// `onblocked` timing and quota-abort behaviour are the three places it is most likely to drift from
// Chrome, so sanity-check those against a real browser before this fake is a module's only cover.
//
// Three shapes here are load-bearing, each because a module under test depends on it:
//   - every handler fires asynchronously (queueMicrotask), never from inside `open()` — callers
//     assign `onupgradeneeded`/`onsuccess`/`onerror`/`onblocked` AFTER `open()` has returned;
//   - `tx.oncomplete` fires only once every request callback the transaction queued has run, so a
//     caller that hands its answer over on COMMIT is really being held to the commit;
//   - the cursor carries `key` next to `value` — a sweep that judges records by `cur.key` would
//     delete the whole store against a fake that omits it, and every one of its rows would pass.
// `calls` logs open/createObjectStore/transaction/put/get/delete/openCursor/close with arguments,
// so a row can assert what was NEVER called.
//
// Deliberately NOT modelled: versions past "the first open creates the store" (no re-upgrade, no
// `versionchange`, no `deleteDatabase`); more than one object store; indexes, key ranges, `getAll`,
// `count`, cursor direction or `advance`; IndexedDB key ordering and key coercion (records come back
// in insertion order and keys are compared with `===`); out-of-line keys (`put(value, key)`);
// per-request failure (`req.onerror`) and DOMException types; DataCloneError on an uncloneable
// value; rollback on abort (an aborted transaction here keeps the writes it made); `tx.abort()`,
// transaction scoping and isolation; `db.onversionchange`, and a closed db refusing to serve.
// Handlers are called with no argument — there are no Event objects.

/**
 * @param {object}  [opts]
 * @param {object[]} [opts.records]  seed rows `{key, shots, at}`; seeding means the store exists
 * @param {boolean} [opts.failOpen]     `indexedDB.open` throws — IndexedDB disabled in the browser
 * @param {boolean} [opts.openError]    the open request fires `onerror`
 * @param {boolean} [opts.openBlocked]  the open request fires `onblocked` — another connection holds it
 * @param {boolean} [opts.txThrows]     `db.transaction()` throws — the store is missing
 * @param {boolean} [opts.txAborts]     the transaction fires `onabort` instead of `oncomplete`
 * @param {string}  [opts.storeName]    the one store's name
 * @returns {{indexedDB: object, calls: object[], records: object[]}}
 */
export function makeIdb({
  records = [], failOpen, openError, openBlocked, txThrows, txAborts, storeName = 'shots',
} = {}) {
  const calls = [];
  const log = (op, ...args) => calls.push({ op, args });

  const rows = records.map((r) => structuredClone(r));
  // Seeded rows can only have got there through an earlier session, so the store already exists.
  const created = new Set(rows.length ? [storeName] : []);
  let version = rows.length ? 1 : 0;
  let keyPath = 'key';

  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
  const indexOf = (key) => rows.findIndex((r) => r[keyPath] === key);
  const drop = (key) => { const at = indexOf(key); if (at >= 0) rows.splice(at, 1); };

  // Requests complete one microtask apart; `done` runs only once the queue has finally emptied,
  // so a callback that queues more work — a cursor walking on — still runs before the commit.
  function pump(queue, done) {
    const step = () => {
      const job = queue.shift();
      if (job) { job(); queueMicrotask(step); return; }
      done();
    };
    queueMicrotask(step);
  }

  function objectStore(queue) {
    const store = {
      put(record) {
        log('put', structuredClone(record));
        const req = request();
        const row = structuredClone(record); // IndexedDB stores a clone, not the caller's object
        queue.push(() => {
          const at = indexOf(row[keyPath]);
          if (at >= 0) rows[at] = row; else rows.push(row);
          req.result = row[keyPath];
          req.onsuccess?.();
        });
        return req;
      },
      get(key) {
        log('get', key);
        const req = request();
        queue.push(() => {
          const hit = rows[indexOf(key)];
          req.result = hit ? structuredClone(hit) : undefined;
          req.onsuccess?.();
        });
        return req;
      },
      delete(key) {
        log('delete', key);
        const req = request();
        queue.push(() => { drop(key); req.onsuccess?.(); });
        return req;
      },
      openCursor() {
        log('openCursor');
        const req = request();
        const snapshot = rows.slice(); // a walk is not disturbed by the rows it deletes behind it
        let i = 0;
        const advance = () => {
          const row = snapshot[i];
          i += 1;
          req.result = row ? cursor(row) : null;
          req.onsuccess?.();
        };
        const cursor = (row) => ({
          key: row[keyPath],
          value: structuredClone(row),
          delete() {
            log('delete', row[keyPath]);
            const req2 = request();
            queue.push(() => { drop(row[keyPath]); req2.onsuccess?.(); });
            return req2;
          },
          continue() { queue.push(advance); },
        });
        queue.push(advance);
        return req;
      },
    };
    return store;
  }

  const db = {
    objectStoreNames: { contains: (name) => created.has(name) },
    createObjectStore(name, opts) {
      log('createObjectStore', name, opts && { ...opts });
      created.add(name);
      if (opts?.keyPath) keyPath = opts.keyPath;
      const queue = [];
      pump(queue, () => {}); // the upgrade transaction commits on its own — nothing waits on it
      return objectStore(queue);
    },
    transaction(name, mode = 'readonly') {
      log('transaction', name, mode);
      if (txThrows) throw new Error('transaction failed');
      if (!created.has(name)) throw new Error(`no object store named ${name}`);
      const queue = [];
      const tx = { objectStore: () => objectStore(queue), oncomplete: null, onerror: null, onabort: null };
      pump(queue, () => { if (txAborts) tx.onabort?.(); else tx.oncomplete?.(); });
      return tx;
    },
    close() { log('close'); },
  };

  const indexedDB = {
    open(name, ver = 1) {
      log('open', name, ver);
      if (failOpen) throw new Error('IndexedDB is disabled');
      const req = { ...request(), onupgradeneeded: null, onblocked: null };
      // Asynchronous on purpose: the caller assigns these four slots after open() has returned.
      queueMicrotask(() => {
        if (openBlocked) { req.onblocked?.(); return; }
        if (openError) { req.error = new Error('open failed'); req.onerror?.(); return; }
        req.result = db;
        if (ver > version) { req.onupgradeneeded?.(); version = ver; }
        req.onsuccess?.();
      });
      return req;
    },
  };

  return { indexedDB, calls, records: rows };
}
