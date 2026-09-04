#!/usr/bin/env node
// What extension/sidepanel/screens/run-view.js is for the tester (#161): an open run — the list of
// its tests with progress, the status filter, the search, the suite sections, and Finish run. And
// the lock: a run that has finished, been archived or turned out to be automated cannot be written
// to, and the panel has to SAY so rather than let a button be pressed into an error.
// Three things here are easy to get quietly wrong, so most of this file is about them. The lock has
// three reasons and they are ranked — the tester must be told the ACTUAL one, and the paint is
// memoised on a signature that includes the automated ROWS, so a reporter result landing mid-poll
// still repaints. The counters split two ways: `done` is passed+failed+skipped while the chips also
// count `all`, and a running row belongs to neither. And every write is gated twice — once when the
// row is drawn, once after the archived answer lands — because the flag arrives a round-trip late.
// Rows 1-65 are the ticket's; 66-131 are this file's own, where the ticket was silent about live
// code — the lock painting, the run-state pill, the substatus counters, the three best-effort
// re-reads, the probe and the chip bar. A lettered suffix is the companion case that drives the same
// path the other way, so a row asserting "nothing happened" cannot pass against a broken fixture.
// Run: node --test tests/run-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

// formatTimeIn falls back to the MACHINE zone when the profile zone is junk (row 18). Pinned to a
// zone that is neither UTC nor the repo's own, so the fallback is distinguishable from a honoured
// timeZone argument rather than accidentally equal to it.
process.env.TZ = 'Asia/Tokyo';

const BASE = 'https://app.testomat.io';
const ARCHIVED = 'Run is archived — results are read-only';
const FINISHED = 'Run is finished — results are read-only';
const AUTOMATED = 'Automated result — read-only in the panel';

// A promise this file resolves by hand: the probe races a sleep, and which of the two lands first
// is the whole subject of several rows.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const rec = (id, over = {}) => ({ id, test_id: id, test_title: `Test ${id}`, status: 'pending', ...over });

// index.html's shape (:521-557 and the confirm dialog at :806), cut to the nodes this screen touches.
const NODES = [
  ['p', 'run-meta-note', true], ['span', 'run-kind', true], ['span', 'run-state', true],
  ['button', 'btn-finish-run', true], ['div', 'run-progress', false], ['p', 'run-lock-note', true],
  ['div', 'run-info', true], ['button', 'run-info-head', false], ['dl', 'run-info-body', false],
  ['input', 'run-search', false], ['button', 'run-search-clear', true], ['div', 'run-filter', false],
  ['ul', 'run-tests', false], ['div', 'test-progress', false],
  ['dialog', 'confirm-dialog', false], ['p', 'confirm-message', false],
  ['button', 'confirm-ok', false], ['button', 'confirm-cancel', false],
];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// The panel globals run-view.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the screens beside this one land in parallel.
function load(opts = {}) {
  const o = {
    runId: 'r1',
    runTitle: '',
    runStatus: null,
    runKind: null,
    runInfo: {},
    records: [],
    runExamples: {},
    runFilter: 'all',
    runSearch: '',
    expandedSuites: {},
    substatusCounts: {},
    currentRecordId: null,
    testrunDetail: null,
    suiteEmoji: null,
    tcSuites: null,
    settings: { baseUrl: BASE, projectId: 'proj' },
    saving: false,
    view: 'run',
    jwt: true,          // capabilities.jwt — what the panel already believes
    jwtAvailable: true, // TestomatAPI.jwtAvailable(): true | false | 'unknown'
    gate: false,        // readonlyGate() — the project-wide read-only lockout
    without: [],        // ids to leave out of the page
    noTestActions: false, // a panel where test-view.js was never loaded
    holdSleep: false,   // sleep() parks instead of resolving — the probe race needs both modes
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    if (o.without.includes(id)) continue;
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    if (id === 'run-search') n.value = o.runSearch;
    if (id === 'run-info-head') n.setAttribute('aria-expanded', 'true');
    node[key(id)] = n;
    doc.body.append(n);
  }
  // The three members mini-dom does not have and this screen reaches for. Layout is STATED here
  // (a browser measures it): zero-by-zero means the description fits, which is the branch that
  // leaves the "Show more" button off — case 96 states an overflow and gets the button instead.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollHeight = 0;
    made.clientHeight = 0;
    made.after = (...nodes) => {
      const parent = made.parentElement;
      if (!parent) return;
      const at = parent.childNodes.indexOf(made);
      for (const [i, n] of nodes.entries()) parent.insertBefore(n, parent.childNodes[at + 1 + i] ?? null);
    };
    return made;
  };
  // spinnerEl() builds its two circles in the SVG namespace; mini-dom has one namespace only.
  doc.createElementNS = (ns, tag) => {
    const made = doc.createElement(tag);
    made.dataset.ns = ns;
    return made;
  };

  const calls = {
    order: [],        // one ordered trace, for the rows that assert "before", not merely "both"
    shows: [],
    toasts: [],
    lines: [],        // { id, text, tone }
    apiErrors: [],    // { message, id, opts }
    fitChips: 0,
    skeleton: [],
    sleeps: [],       // { ms, resolve } in order — settlePendingWrites' give-up is counted here
    durations: [],    // every ms handed to humanDuration
    writes: [],       // { id, status, comment }
    reads: { run: [], testruns: [], info: [], examples: [], suiteTree: 0, finish: [] },
    contextBars: 0,
    liveSyncs: 0,
    replays: 0,
    decorated: [],
    projectInfo: 0,
    projectUsers: 0,
    capabilities: 0,
    testActions: 0,
    persists: 0,
    prunes: [],
    opened: [],       // openTestView(recordId)
    progressToasts: [],
  };

  // <dialog>'s own three members; mini-dom has no dialog element, and confirmDialog drives all of
  // them — showModal to open it, `open` to decide whether close() is still needed.
  if (node.confirmDialog) {
    node.confirmDialog.open = false;
    node.confirmDialog.showModal = () => { node.confirmDialog.open = true; calls.order.push('showModal'); };
    node.confirmDialog.close = () => { node.confirmDialog.open = false; calls.order.push('closeModal'); };
  }

  // Held promises, so a row can decide which of two answers lands first.
  const held = [];
  const sleep = (ms) => {
    if (!o.holdSleep) { calls.sleeps.push({ ms }); return Promise.resolve(); }
    const d = deferred();
    calls.sleeps.push({ ms, resolve: d.resolve });
    held.push(d);
    return d.promise;
  };

  // Reassignable after load(), so a test can answer the second read differently from the first, or
  // change the world from inside a call the screen is awaiting.
  const on = {
    getRun: async () => o.detail ?? { id: o.runId, title: 'Checkout run', status: 'running' },
    listTestruns: async () => o.serverRecords ?? [],
    getRunInfo: async () => o.serverInfo ?? {},
    listTestrunExamples: async () => o.serverExamples ?? {},
    getSuiteTree: async () => o.serverTree ?? [],
    finishRun: async () => o.finished ?? { id: o.runId, status: 'finished' },
    runInfoOf: (payload) => ({ status: payload?.status ?? null }),
    write: async () => ({}),
    projectInfo: async () => {},
    projectUsers: async () => {},
  };

  const state = {
    runId: o.runId,
    runTitle: o.runTitle,
    runStatus: o.runStatus,
    runKind: o.runKind,
    runInfo: o.runInfo,
    records: o.records,
    runExamples: o.runExamples,
    runFilter: o.runFilter,
    runSearch: o.runSearch,
    expandedSuites: o.expandedSuites,
    substatusCounts: o.substatusCounts,
    currentRecordId: o.currentRecordId,
    testrunDetail: o.testrunDetail,
    suiteEmoji: o.suiteEmoji,
    tcSuites: o.tcSuites,
    settings: o.settings,
    saving: o.saving,
    inlineWrites: 0,
    view: o.view,
  };

  // shared/user-cell.js's own normalize, verbatim in behaviour: a string with an @ is an address, a
  // record is name+email+avatar, anything naming nobody is null. Rows 14, 16 and 28 are ABOUT it.
  const normalize = (user) => {
    if (!user) return null;
    if (typeof user === 'string') {
      const s = user.trim();
      if (!s) return null;
      return s.includes('@') ? { name: '', email: s } : { name: s, email: '' };
    }
    if (typeof user !== 'object') return null;
    const name = String(user.name || user.username || user.title || '').trim();
    const email = String(user.email || '').trim();
    if (!name && !email) return null;
    return { name, email, avatar: String(user.avatar || user['avatar-url'] || user.avatarUrl || '').trim() };
  };

  // shared/icons.js's own rule: an empty value or an unresolved `:shortcode:` draws nothing, so the
  // caller falls back to the glyph.
  const emojiSpan = (value, cls = '') => {
    const s = String(value || '').trim();
    if (!s || /^:[a-z0-9_+-]+:$/i.test(s)) return null;
    const span = doc.createElement('span');
    span.className = `${cls} emoji`.trim();
    span.textContent = s;
    return span;
  };

  // shared/empty-state.js's shape, cut to what this screen asks of it: `live` is the role=status a
  // filtered-empty list needs, and the actions are appended in the order the caller listed them.
  const buildEmpty = ({ icon, title, text, actions, tag = 'div', live = false } = {}) => {
    const box = doc.createElement(tag);
    box.className = 'empty';
    box.dataset.icon = icon || '';
    if (live) box.setAttribute('role', 'status');
    const body = doc.createElement('div');
    body.className = 'empty-body';
    const head = doc.createElement('p');
    head.className = 'empty-title';
    head.textContent = title || '';
    const para = doc.createElement('p');
    para.className = 'empty-text';
    for (const part of [].concat(text ?? [])) {
      if (part == null || part === '') continue;
      para.append(typeof part === 'string' ? doc.createTextNode(part) : part);
    }
    body.append(head, para);
    box.append(body);
    const list = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
    if (list.length) {
      const bar = doc.createElement('div');
      bar.className = 'empty-actions';
      bar.append(...list);
      box.append(bar);
    }
    return box;
  };

  const globals = {
    state,
    capabilities: { jwt: o.jwt },
    stepWriteChain: Promise.resolve(),
    ResizeObserver: class { observe() {} disconnect() {} },
    sleep,
    $: (id) => doc.getElementById(id),
    show: (view) => { calls.shows.push(view); calls.order.push(`show:${view}`); },
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); calls.order.push('toast'); },
    progressToast: (msg) => { calls.progressToasts.push(msg); calls.order.push('progressToast'); },
    setStatusLine: (id, text, tone) => { calls.lines.push({ id, text, tone }); },
    handleApiError: (e, id, eOpts) => {
      calls.apiErrors.push({ message: e?.message ?? String(e), id, opts: plain(eOpts) });
      calls.order.push('apiError');
    },
    isAuthError: (e) => e?.kind === 'auth',
    persistSession: () => { calls.persists += 1; },
    refreshContextBar: () => { calls.contextBars += 1; },
    // core/views.js's own rule: repainting the same figure is silent.
    paintCounter: (n, value) => {
      if (!n || n.textContent === String(value)) return;
      n.textContent = String(value);
    },
    fitFilterChips: (bar) => { calls.fitChips += 1; calls.order.push('chips'); if (bar) bar.dataset.fitted = '1'; },
    baseUrlHost: () => 'app.testomat.io',
    readonlyGate: async () => { calls.order.push('gate'); return o.gate; },
    // core/state.js:79's own, stringified on both sides; every lock read goes through it.
    recordFor: (recordId) => {
      calls.order.push('lock-read');
      return state.records.find((r) => String(r.id) === String(recordId));
    },
    viewerTimezone: () => o.timezone ?? null,
    assigneeUser: (email) => (o.members || {})[String(email).toLowerCase()] || null,
    assigneeName: (email) => {
      const resolved = ((o.members || {})[String(email).toLowerCase()] || {}).name;
      if (resolved) return resolved;
      const at = String(email).indexOf('@');
      return at > 0 ? String(email).slice(0, at) : String(email);
    },
    // screens/test-view.js:508's ladder, cut to the branches these rows read. The ARGUMENT is the
    // point: run-view passes seconds and has to multiply, so an unconverted 90 prints '0.09s'.
    humanDuration: (ms) => {
      calls.durations.push(ms);
      const secs = Number(ms) / 1000;
      if (!(secs > 0)) return '';
      const mins = Math.floor(secs / 60);
      if (!mins) return `${String(secs.toFixed(1)).replace(/\.0$/, '')}s`;
      const rest = Math.round(secs - mins * 60);
      return rest ? `${mins}m ${rest}s` : `${mins}m`;
    },
    // screens/test-view.js:1584's own optimistic assign — without it a rollback row would pass
    // against a stub that never changed the record in the first place.
    writeStatus: async (record, status, comment) => {
      calls.writes.push({ id: record?.id, status, comment });
      calls.order.push('write');
      if (record) Object.assign(record, { status, message: comment });
      return on.write(record, status);
    },
    loadProjectInfo: async () => { calls.projectInfo += 1; calls.order.push('projectInfo'); return on.projectInfo(); },
    loadProjectUsers: async () => { calls.projectUsers += 1; calls.order.push('projectUsers'); return on.projectUsers(); },
    applyCapabilities: () => { calls.capabilities += 1; },
    startLiveSync: () => { calls.liveSyncs += 1; calls.order.push('liveSync'); },
    openTestView: (id) => { calls.opened.push(id); },
    pruneCommentDrafts: (runId) => { calls.prunes.push(runId); },
    updateTestActionsState: o.noTestActions ? undefined : () => { calls.testActions += 1; },
    OfflineQueue: {
      replay: () => { calls.replays += 1; calls.order.push('replay'); },
      decorateRow: (li, id) => { calls.decorated.push(String(id)); },
    },
    Icons: {
      // The real one hands `cls` to classList.add, which throws on a token with a space — the arity
      // is part of the contract, so the stub keeps it rather than joining the arguments.
      el: (name, size = 16, ...cls) => {
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        n.classList.add(...cls.filter(Boolean));
        return n;
      },
      emoji: emojiSpan,
    },
    // The real one writes data-tip on the node it is given; a recorder alone could not tell a tip
    // that landed on the right element from one that went nowhere. (shared/tooltip.js:257)
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    Skeleton: {
      show: (view) => { calls.skeleton.push(['show', view]); calls.order.push('skeleton'); return { view }; },
      hide: (handle) => { calls.skeleton.push(['hide', handle ? handle.view : handle]); },
    },
    EmptyState: { build: buildEmpty },
    TestType: {
      mark: (kind, mOpts) => el('span', { className: 'type-mark', dataset: { kind, text: String(!!(mOpts && mOpts.text)) } }),
      forRecord: (r) => (r.automated ? el('span', { className: 'type-mark', dataset: { kind: 'automated' } }) : null),
    },
    PriorityIcons: { mark: (p) => el('span', { className: 'prio', dataset: { prio: String(p ?? 'normal') } }) },
    UserCell: {
      normalize,
      cell: (user) => {
        const u = normalize(user);
        if (!u) return null;
        const box = el('span', { className: 'user-cell' });
        const name = el('span', { className: 'user-name' });
        const at = u.email.indexOf('@');
        name.textContent = u.name || (at > 0 ? u.email.slice(0, at) : u.email);
        box.append(name);
        box.dataset.email = u.email;
        return box;
      },
    },
    TestomatAPI: {
      jwtAvailable: () => o.jwtAvailable,
      getRun: async (id) => { calls.reads.run.push(id); calls.order.push('getRun'); return on.getRun(id); },
      listTestruns: async (id) => { calls.reads.testruns.push(id); calls.order.push('listTestruns'); return on.listTestruns(id); },
      getRunInfo: async (id) => { calls.reads.info.push(id); calls.order.push('getRunInfo'); return on.getRunInfo(id); },
      listTestrunExamples: async (id) => { calls.reads.examples.push(id); calls.order.push('listExamples'); return on.listTestrunExamples(id); },
      getSuiteTree: async () => { calls.reads.suiteTree += 1; calls.order.push('suiteTree'); return on.getSuiteTree(); },
      finishRun: async (id) => { calls.reads.finish.push(id); calls.order.push('finishPut'); return on.finishRun(id); },
      runInfoOf: (payload) => on.runInfoOf(payload),
    },
  };

  // A repaint of the progress band is one act the ordering rows anchor on; wrapping the node is the
  // only seam, since paintRunProgress is a module function no stub stands in front of.
  if (node.runProgress) {
    const orig = node.runProgress.replaceChildren.bind(node.runProgress);
    node.runProgress.replaceChildren = (...args) => { calls.order.push('progress'); return orig(...args); };
  }
  if (node.runTests) {
    const orig = node.runTests.replaceChildren.bind(node.runTests);
    node.runTests.replaceChildren = (...args) => { calls.order.push('sections'); return orig(...args); };
  }

  const clock = fakeClock();
  const h = loadScreen('run-view', {
    globals,
    document: doc,
    clock,
    // Every name below is a lexical `const` — invisible as a sandbox property, reachable only off
    // the completion value, exactly as tests/md-sections.test.mjs takes `MdSections`.
    exported: `({ normStatus, statusLabel, treeSlot, runStatusTerminal, runArchived, runAutomated,
      matchesRunFilter, exampleOf, rowVisible, suiteKeyOf, suiteEmojiOf, orderedRecords,
      visibleRecords, rowTitle, awaitRunState, RUN_STATUS_FILTERS, RUN_FILTER_KEYS, RUN_FILTER_TINT,
      STATUS_ICON, NEUTRAL_ICON, FILE_ICON, FOLDER_ICON, CHEVRON_ICON, NO_SUITE, PROBE_WAIT_MS,
      RUN_STATE_TINT, ROW_BTN_LABEL, RUN_LOCK_REASON, ARCHIVED_LOCK_REASON, AUTOMATED_LOCK_REASON })`,
  });

  return {
    ...h,
    lex: h.screen,
    state, calls, on, node, doc, clock,
    // The held sleeps, so a row can let the 2000 ms probe timeout win the race on purpose.
    releaseSleeps: () => { for (const d of held.splice(0)) d.resolve(); },
    // What the tester actually sees in the checklist.
    sectionKeys: () => node.runTests.querySelectorAll('.suite-section').map((s) => s.dataset.suite),
    sectionTitles: () => node.runTests.querySelectorAll('.suite-head .title').map((t) => t.textContent),
    rowIds: () => node.runTests.querySelectorAll('li.test-row').map((r) => r.dataset.recordId),
    emptyTitle: () => node.runTests.querySelector('.empty-title')?.textContent ?? null,
    emptyActions: () => node.runTests.querySelectorAll('.empty-actions > *').map((a) => a.textContent),
    fraction: () => node.runProgress.querySelector('.counts-done')?.textContent ?? null,
    parts: () => node.runProgress.querySelectorAll('.counts-part').map((p) => p.textContent),
    widths: () => node.runProgress.querySelectorAll('.progress > div').map((d) => d.style.width),
    chipLabels: () => node.runFilter.querySelectorAll('.filter-chip').map((c) => c.dataset.filter),
    chipCounts: () => node.runFilter.querySelectorAll('.filter-chip .counter').map((c) => c.textContent),
    // The Run info card as a plain [label, text] list — the order is half of what these rows assert.
    infoRows: () => {
      const out = [];
      const kids = node.runInfoBody.children;
      for (let i = 0; i < kids.length; i += 2) out.push([kids[i].textContent, kids[i + 1].textContent]);
      return out;
    },
    infoLabels: () => node.runInfoBody.querySelectorAll('dt').map((dt) => dt.textContent),
    infoValue: (label) => {
      const kids = node.runInfoBody.children;
      for (let i = 0; i < kids.length; i += 2) if (kids[i].textContent === label) return kids[i + 1];
      return null;
    },
  };
}

// The offline queue's «queued» marker, which is the ONLY `.badge` a run row ever carries
// (screens/offline-queue.js:215) and so the only thing flashRowSaved can find. `offsetWidth` is its
// reflow read, and the one seam that says WHEN the flash ran relative to the repaint.
function addBadge(h, li) {
  const badge = el('span', { className: 'badge' });
  Object.defineProperty(badge, 'offsetWidth', { get: () => { h.calls.order.push('flash'); return 1; } });
  li.append(badge);
  return badge;
}

// ---------- the write gate: three reasons, ranked (rows 7-13, 66-71) ----------

test('7: an archived run that also finished and is automated says ARCHIVED — the actual reason', () => {
  const h = load({ runInfo: { isArchived: true }, runStatus: 'finished', runKind: 'automated' });
  assert.equal(h.fn.runWriteLock(), ARCHIVED);
});

test('8: take the archive away and the same run says FINISHED', () => {
  const h = load({ runInfo: {}, runStatus: 'finished', runKind: 'automated' });
  assert.equal(h.fn.runWriteLock(), FINISHED);
});

test('9: an automated run bars every row but leaves Finish run alive', () => {
  const h = load({ runStatus: 'running', runKind: 'automated' });
  assert.equal(h.fn.runWriteLock(), AUTOMATED);
  assert.equal(h.fn.finishBlockedReason(), '');
  // …and the two reasons Finish DOES answer to, driven the same way.
  h.state.runInfo = { isArchived: true };
  assert.equal(h.fn.finishBlockedReason(), ARCHIVED);
  h.state.runInfo = {};
  h.state.runStatus = 'passed';
  assert.equal(h.fn.finishBlockedReason(), FINISHED);
});

test('10: no run open at all is not a lock — the screen is simply empty', () => {
  const h = load({ runId: null, runInfo: { isArchived: true }, runStatus: 'finished' });
  assert.equal(h.fn.runWriteLock(), '');
  // The identical state WITH a run id locks, so the guard is what answered and not the flags.
  h.state.runId = 'r1';
  assert.equal(h.fn.runWriteLock(), ARCHIVED);
});

test('11: a run still reported running is finished once it carries a finishedAt', () => {
  const h = load({ runStatus: 'running', runInfo: { finishedAt: '2026-01-01T00:00:00Z' } });
  assert.equal(h.fn.runFinished(), true);
  assert.equal(h.fn.runWriteLock(), FINISHED);
  h.state.runInfo = { finishedAt: null };
  assert.equal(h.fn.runFinished(), false);
});

test('12: the open row consults the JSON:API detail, and the id is compared as text', () => {
  const h = load({ currentRecordId: 7, testrunDetail: { data: { attributes: { automated: true } } } });
  assert.equal(h.fn.recordAutomated({ id: '7' }), true);
  // A different row on the same screen is not the one the detail describes.
  assert.equal(h.fn.recordAutomated({ id: '8' }), false);
  assert.equal(h.fn.recordAutomated(null), false);
});

test('13: the lock signature carries the automated rows, so a mid-poll flip repaints', () => {
  const h = load({ records: [{ id: 1, automated: true }, { id: 2 }] });
  assert.equal(h.fn.lockSignature(''), ' | 1');
  // The second row flipping is a DIFFERENT signature — which is the whole point of listing them.
  h.state.records[1].automated = true;
  assert.equal(h.fn.lockSignature(''), ' | 1,2');
  assert.equal(h.fn.lockSignature(FINISHED), `${FINISHED} | 1,2`);
});

test('66: a run-level reason is the row\'s reason too, and outranks its own flag', () => {
  const h = load({ runStatus: 'finished' });
  assert.equal(h.fn.recordWriteLock({ id: 1, automated: true }), FINISHED);
  h.state.runStatus = 'running';
  assert.equal(h.fn.recordWriteLock({ id: 1, automated: true }), AUTOMATED);
  assert.equal(h.fn.recordWriteLock({ id: 2 }), '');
});

test('67: only the four terminal words are terminal, whatever their case', () => {
  const h = load();
  for (const s of ['passed', 'FAILED', 'Terminated', 'finished']) {
    assert.equal(h.lex.runStatusTerminal(s), true, s);
  }
  for (const s of ['running', 'launching', 'scheduled', '', null, undefined]) {
    assert.equal(h.lex.runStatusTerminal(s), false, String(s));
  }
});

test('68: the run detail is a second source of "finished" — the status the card shows counts', () => {
  const h = load({ runStatus: 'running', runInfo: { status: 'passed' } });
  assert.equal(h.fn.runFinished(), true);
  assert.equal(h.fn.runWriteLock(), FINISHED);
});

test('69: archived is one signal only — a run info that never said so is not archived', () => {
  const h = load({ runInfo: {} });
  assert.equal(h.lex.runArchived(), false);
  h.state.runInfo = { isArchived: false };
  assert.equal(h.lex.runArchived(), false);
  h.state.runInfo = { isArchived: 'true' }; // a string is not the flag: basic mode stays blind
  assert.equal(h.lex.runArchived(), false);
  h.state.runInfo = { isArchived: true };
  assert.equal(h.lex.runArchived(), true);
});

test('70: only the word `automated` locks the run — a rungroup kind draws nothing here', () => {
  const h = load({ runKind: 'AUTOMATED' });
  assert.equal(h.lex.runAutomated(), true);
  for (const k of ['manual', 'mixed', 'multienv', null]) {
    h.state.runKind = k;
    assert.equal(h.lex.runAutomated(), false, String(k));
  }
});

test('71: a row flagged automated by the server locks without the run being automated at all', () => {
  const h = load({ runStatus: 'running', runKind: 'mixed' });
  assert.equal(h.fn.runWriteLock(), '');
  assert.equal(h.fn.recordAutomated({ id: 9, automated: true }), true);
  assert.equal(h.fn.recordWriteLock({ id: 9, automated: true }), AUTOMATED);
});

// ---------- painting the lock: the memoised signature (rows 72-75) ----------

test('72: the note carries the reason and the rows go dead with it', () => {
  const h = load({ runStatus: 'finished', records: [rec(1), rec(2)] });
  h.fn.renderRunSections();
  assert.deepEqual(h.rowIds(), ['1', '2']);
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.textContent, FINISHED);
  assert.equal(h.node.runLockNote.hidden, false);
  const buttons = h.node.runTests.querySelectorAll('.row-actions .row-st');
  assert.equal(buttons.length, 6);
  assert.ok(buttons.every((b) => b.disabled === true));
  assert.deepEqual([...new Set(buttons.map((b) => b.dataset.tip))], [FINISHED]);
});

test('72a: an unlocked run paints an empty note and live buttons, driven the same way', () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.fn.renderRunSections();
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.textContent, '');
  assert.equal(h.node.runLockNote.hidden, true);
  const buttons = h.node.runTests.querySelectorAll('.row-actions .row-st');
  assert.ok(buttons.every((b) => b.disabled === false));
  assert.deepEqual(buttons.map((b) => b.dataset.tip), ['Mark passed', 'Mark failed', 'Mark skipped']);
});

test('73: the paint is memoised — a second call with the same reason leaves a rebuilt DOM bare', () => {
  const h = load({ runStatus: 'finished', records: [rec(1)] });
  h.fn.renderRunSections();
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.textContent, FINISHED);
  // The section rebuilds under it (a poll tick), taking the note and the disabled buttons with it.
  h.node.runLockNote.textContent = '';
  h.fn.renderRunSections();
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.textContent, '', 'the same signature is a no-op');
  // …and `force` is what a rebuilt DOM needs.
  h.fn.applyRunLock({ force: true });
  assert.equal(h.node.runLockNote.textContent, FINISHED);
});

test('74: a reason that CHANGED repaints without force — the signature is what is compared', () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.fn.renderRunSections();
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.hidden, true);
  h.state.runInfo = { isArchived: true };
  h.fn.applyRunLock();
  assert.equal(h.node.runLockNote.textContent, ARCHIVED);
  assert.equal(h.node.runLockNote.hidden, false);
});

test('75: one row turning automated mid-poll repaints, though the run-level reason never moved', () => {
  const h = load({ runStatus: 'running', runKind: 'mixed', records: [rec(1), rec(2)] });
  h.fn.renderRunSections();
  h.fn.applyRunLock();
  const tipOf = (id) => h.node.runTests
    .querySelector(`li[data-record-id="${id}"] .row-actions .row-st`).dataset.tip;
  assert.equal(tipOf(2), 'Mark passed');
  h.state.records[1].automated = true;   // a reporter result lands on row 2
  h.fn.applyRunLock();                   // no force: the ROW list is what changed
  assert.equal(tipOf(2), AUTOMATED);
  assert.equal(tipOf(1), 'Mark passed', 'the manual row beside it stays writable');
  assert.equal(h.node.runLockNote.hidden, true, 'and the run-level note stays silent');
});

test('76: applyRunLock re-asks the Finish button and the test view, when there is one', () => {
  const h = load({ runStatus: 'running', jwtAvailable: true });
  h.fn.applyRunLock();
  assert.equal(h.calls.testActions, 1);
  assert.equal(h.node.btnFinishRun.hidden, false);
  // A panel that never loaded test-view.js has no updateTestActionsState at all, and survives it.
  const bare = load({ runStatus: 'running', noTestActions: true });
  bare.fn.applyRunLock();
  assert.equal(bare.calls.testActions, 0);
  assert.equal(bare.node.btnFinishRun.hidden, false);
});

// ---------- the Finish run button (rows 48, 77) ----------

test('48: an unproven session hides Finish run; a lost one shows it disabled, with the reason', () => {
  const unknown = load({ runStatus: 'running', jwtAvailable: 'unknown' });
  unknown.fn.updateRunActions();
  assert.equal(unknown.node.btnFinishRun.hidden, true);

  const lost = load({ runStatus: 'running', jwtAvailable: false });
  lost.fn.updateRunActions();
  assert.equal(lost.node.btnFinishRun.hidden, false);
  assert.equal(lost.node.btnFinishRun.disabled, true);
  assert.equal(lost.node.btnFinishRun.dataset.tip,
    'Finish run needs an active app.testomat.io web login — sign in there, then Refresh');

  const ok = load({ runStatus: 'running', jwtAvailable: true });
  ok.fn.updateRunActions();
  assert.equal(ok.node.btnFinishRun.hidden, false);
  assert.equal(ok.node.btnFinishRun.disabled, false);
  assert.equal(ok.node.btnFinishRun.dataset.tip, undefined);
});

test('77: a re-run archived run is "running" again — Finish stays hidden anyway', () => {
  const h = load({ runStatus: 'running', jwtAvailable: true, runInfo: { isArchived: true } });
  h.fn.updateRunActions();
  assert.equal(h.node.btnFinishRun.hidden, true);
  h.state.runInfo = { finishedAt: '2026-01-01T00:00:00Z' };
  h.fn.updateRunActions();
  assert.equal(h.node.btnFinishRun.hidden, true);
  // A page without the button is not an error — the test view shares this file.
  const bare = load({ runStatus: 'running', without: ['btn-finish-run'] });
  assert.doesNotThrow(() => bare.fn.updateRunActions());
});

// ---------- finishing a run (rows 49-51, 78-81) ----------

// The dialog is answered from outside, the way a tester answers it: start the call, let it reach
// showModal, then click. `settle()` is the turn in between — never await the finishRun promise here,
// which cannot resolve until the click that has not happened yet.
async function openConfirm(h) {
  await settle();
  assert.equal(h.node.confirmDialog.open, true, 'the dialog should be open by now');
}

test('49: the archive landing while the confirm sits open is caught by the second gate', async () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  const done = h.fn.finishRun();
  await openConfirm(h);
  h.state.runInfo = { isArchived: true }; // a colleague archives it while the tester reads
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.reads.finish, [], 'no PUT');
  assert.deepEqual(h.calls.toasts, [{ msg: ARCHIVED }]);
  assert.equal(h.node.runLockNote.textContent, ARCHIVED, 'and the lock is force-painted');
  assert.equal(h.state.runStatus, 'running');
});

test('50: dismissing the dialog is a no-op — no PUT, no state change', async () => {
  const h = load({ runStatus: 'running' });
  const done = h.fn.finishRun();
  await openConfirm(h);
  fire(h.node.confirmCancel, 'click');
  await done;
  assert.deepEqual(h.calls.reads.finish, []);
  assert.equal(h.state.runStatus, 'running');
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.progressToasts, []);
  assert.equal(h.node.confirmDialog.open, false);
});

test('51: confirming finishes the run, re-reads the checklist and says so on the status line', async () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.on.finishRun = async () => ({ id: 'r1', status: 'finished' });
  h.on.runInfoOf = (payload) => ({ status: payload.status, finishedAt: '2026-01-02T00:00:00Z' });
  h.on.listTestruns = async () => [rec(2, { status: 'skipped' }), rec(1, { status: 'passed' })];
  const done = h.fn.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.reads.finish, ['r1']);
  assert.equal(h.state.runStatus, 'finished');
  assert.equal(h.state.runInfo.status, 'finished');
  assert.equal(h.state.runInfo.finishedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(h.state.records.map((r) => r.id), [1, 2], 're-read AND re-sorted by id');
  assert.deepEqual(h.calls.lines.at(-1), { id: 'run-status', text: 'Run finished ✓', tone: 'ok' });
  assert.deepEqual(h.rowIds(), ['1', '2'], 'and the checklist repainted');
  assert.equal(h.node.runLockNote.textContent, FINISHED);
});

test('78: the FIRST gate bites before the dialog is ever shown', async () => {
  const h = load({ runStatus: 'finished' });
  await h.fn.finishRun();
  assert.equal(h.node.confirmDialog.open, false);
  assert.ok(!h.calls.order.includes('showModal'));
  assert.deepEqual(h.calls.toasts, [{ msg: FINISHED }]);
  assert.deepEqual(h.calls.reads.finish, []);
  assert.equal(h.node.runLockNote.textContent, FINISHED);
});

test('79: with no run open Finish does nothing at all — not even the state probe', async () => {
  const h = load({ runId: null, runStatus: 'running' });
  await h.fn.finishRun();
  assert.deepEqual(h.calls.order, []);
  // The same call WITH a run id gets as far as the dialog, so the guard is what stopped it.
  const open = load({ runStatus: 'running' });
  const done = open.fn.finishRun();
  await settle();
  assert.equal(open.node.confirmDialog.open, true);
  fire(open.node.confirmCancel, 'click');
  await done;
});

test('80: a failed PUT is reported inline, the button comes back, and the run is untouched', async () => {
  const h = load({ runStatus: 'running' });
  h.on.finishRun = async () => { throw Object.assign(new Error('boom'), { kind: 'http' }); };
  const done = h.fn.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.apiErrors, [{ message: 'boom', id: 'run-status', opts: { inlineAuth: true } }]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Finish failed: boom', error: true }]);
  assert.equal(h.state.runStatus, 'running');
  assert.equal(h.node.btnFinishRun.disabled, false, 'released in the finally');
});

test('80a: an expired session is handled inline WITHOUT a second toast on top of it', async () => {
  const h = load({ runStatus: 'running' });
  h.on.finishRun = async () => { throw Object.assign(new Error('nope'), { kind: 'auth' }); };
  const done = h.fn.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.equal(h.calls.apiErrors.length, 1);
  assert.deepEqual(h.calls.toasts, []);
});

test('81: the dialog wears the message and the label, and lets go of both buttons on the way out', async () => {
  const h = load({ runStatus: 'running' });
  const done = h.fn.finishRun();
  await settle();
  assert.equal(h.node.confirmMessage.textContent, 'Finish run? Pending tests will be marked skipped.');
  assert.equal(h.node.confirmOk.textContent, 'Finish run');
  assert.equal(h.node.confirmOk.listeners.get('click').length, 1);
  assert.equal(h.node.confirmCancel.listeners.get('click').length, 1);
  assert.equal(h.node.confirmDialog.listeners.get('cancel').length, 1);
  fire(h.node.confirmCancel, 'click');
  await done;
  assert.equal(h.node.confirmOk.listeners.get('click').length, 0, 'torn down');
  assert.equal(h.node.confirmCancel.listeners.get('click').length, 0);
  assert.equal(h.node.confirmDialog.listeners.get('cancel').length, 0);
  assert.equal(h.node.confirmDialog.open, false, 'and closed');
});

test('81a: Esc on the dialog reads as a cancel, not as a confirmation', async () => {
  const h = load({ runStatus: 'running' });
  const done = h.fn.finishRun();
  await settle();
  fire(h.node.confirmDialog, 'cancel');
  await done;
  assert.deepEqual(h.calls.reads.finish, []);
  assert.equal(h.state.runStatus, 'running');
});

// ---------- the status vocabulary and the counters (rows 1-3, 5-6, 82-88) ----------

test('1: a launching run reads as running, and nothing at all reads as unknown', () => {
  const h = load();
  assert.equal(h.lex.normStatus('launching'), 'running');
  assert.equal(h.lex.normStatus(''), 'unknown');
  assert.equal(h.lex.normStatus(undefined), 'unknown');
  assert.equal(h.lex.normStatus('passed'), 'passed');
});

test('2: pending, blank and no record at all are one word to this screen — untested', () => {
  const h = load();
  assert.equal(h.fn.displayStatus({ status: 'pending' }), 'untested');
  assert.equal(h.fn.displayStatus(null), 'untested');
  assert.equal(h.fn.displayStatus({ status: '' }), 'untested');
  assert.equal(h.fn.displayStatus({ status: 'passed' }), 'passed');
});

test('3: `untested` is this file\'s key; the word the tester reads is `pending`', () => {
  const h = load();
  assert.equal(h.lex.statusLabel('untested'), 'pending');
  assert.equal(h.lex.statusLabel('passed'), 'passed');
  assert.equal(h.lex.statusLabel('skipped'), 'skipped');
});

test('5: a running test is legitimately not done — 2/4, and no skipped part is drawn', () => {
  const h = load({
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'failed' }),
      rec(3, { status: 'pending' }), rec(4, { status: 'running' })],
  });
  h.fn.paintRunProgress();
  assert.equal(h.fraction(), '2/4');
  assert.deepEqual(h.parts(), ['1 passed', '1 failed']);
  assert.deepEqual(h.widths(), ['25%', '25%', '0%']);
});

test('5a: a skipped test is done too — it counts into the fraction and draws its own segment', () => {
  const h = load({
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'skipped' }),
      rec(3, { status: 'skipped' }), rec(4, { status: 'pending' })],
  });
  h.fn.paintRunProgress();
  assert.equal(h.fraction(), '3/4');
  assert.deepEqual(h.parts(), ['1 passed', '2 skipped']);
  assert.deepEqual(h.widths(), ['25%', '0%', '50%']);
});

test('6: an empty run divides by nothing — 0/0, no parts, and every segment at zero', () => {
  const h = load({ records: [] });
  h.fn.paintRunProgress();
  assert.equal(h.fraction(), '0/0');
  assert.deepEqual(h.parts(), []);
  assert.deepEqual(h.widths(), ['0', '0', '0']);
});

test('82: the run header extends the counts line with custom statuses, biggest first', () => {
  const h = load({ substatusCounts: { flaky: 2, blocked: 5, aborted: 2 } });
  h.fn.paintRunProgress();
  const group = h.node.runProgress.querySelector('.substatus-counts');
  assert.equal(group.dataset.tip, 'Custom statuses set in this run');
  // count DESC, then name ASC — `aborted` before `flaky` on the tie.
  assert.deepEqual(group.querySelectorAll('.substatus-count').map((s) => s.textContent),
    ['blocked: 5', 'aborted: 2', 'flaky: 2']);
  assert.deepEqual(group.querySelectorAll('.substatus-count').map((s) => s.dataset.substatus),
    ['blocked', 'aborted', 'flaky']);
});

test('83: a token-only panel gets no custom counters at all, and neither does an empty map', () => {
  const basic = load({ jwt: false, substatusCounts: { flaky: 2 } });
  basic.fn.paintRunProgress();
  assert.equal(basic.node.runProgress.querySelector('.substatus-counts'), null);
  const empty = load({ jwt: true, substatusCounts: {} });
  empty.fn.paintRunProgress();
  assert.equal(empty.node.runProgress.querySelector('.substatus-counts'), null);
  // The same map WITH a session draws them, so the two rows above are a gate and not a stub.
  const on = load({ jwt: true, substatusCounts: { flaky: 2 } });
  on.fn.paintRunProgress();
  // A NBSP after the middot, so a wrap takes the separator down with its counter.
  assert.equal(on.node.runProgress.querySelector('.substatus-counts').textContent, ' · flaky: 2');
});

test('84: the run status pill takes the card\'s own status first, and the v2 one only after', () => {
  const h = load({ runStatus: 'running', runInfo: { status: 'passed' } });
  h.fn.paintRunState();
  assert.equal(h.node.runState.hidden, false);
  assert.equal(h.node.runState.className, 'status-label passed');
  assert.equal(h.node.runState.dataset.tip, 'Run status: passed');
  assert.equal(h.node.runState.textContent, 'passed');
  // Only the v2 status left: it is the fallback, and a status with no tint is neutral.
  h.state.runInfo = {};
  h.fn.paintRunState();
  assert.equal(h.node.runState.className, 'status-label neutral');
  assert.equal(h.node.runState.textContent, 'running');
});

test('84a: neither source answered — the pill hides rather than printing an empty row', () => {
  const h = load({ runStatus: null, runInfo: {} });
  h.fn.paintRunState();
  assert.equal(h.node.runState.hidden, true);
  assert.equal(h.node.runState.textContent, '');
});

test('85: a running test draws the two-circle ring, not a glyph — and both measure the same slot', () => {
  const h = load();
  const spinner = h.fn.statusIcon('launching');
  assert.equal(spinner.className, 'spinner');
  assert.equal(spinner.dataset.status, 'running', 'launching folds into running here too');
  assert.equal(spinner.dataset.tip, 'running');
  assert.deepEqual(spinner.children.map((c) => c.className), ['spinner-track', 'spinner-head']);
  assert.equal(spinner.children[1].getAttribute('stroke-dasharray'), '25 75');
  assert.equal(spinner.children[0].getAttribute('stroke-dasharray'), null);
  // Every other status IS a glyph, so the branch above is a decision and not the only path.
  const glyph = h.fn.statusIcon('passed');
  assert.equal(glyph.dataset.icon, 'status_passed');
  assert.ok(glyph.classList.contains('status-icon'));
  assert.equal(glyph.dataset.status, 'passed');
});

test('86: three kinds are a run kind; a rungroup\'s own kind draws no badge', () => {
  const h = load();
  for (const k of ['manual', 'AUTOMATED', 'Mixed']) assert.equal(h.fn.runKind(k), k.toLowerCase());
  for (const k of ['multienv', '', null, undefined, 5]) assert.equal(h.fn.runKind(k), null, String(k));
  const badge = h.fn.kindBadge('mixed');
  assert.equal(badge.dataset.kind, 'mixed');
  assert.equal(badge.dataset.text, 'true', 'the header badge carries its word');
  assert.equal(badge.dataset.tip, 'mixed run');
  assert.equal(h.fn.kindBadge('multienv'), null);
});

test('86a: the kind pill hides itself when the run has no kind to show', () => {
  const h = load({ runKind: 'manual' });
  h.fn.paintRunKind();
  assert.equal(h.node.runKind.hidden, false);
  assert.equal(h.node.runKind.children[0].dataset.kind, 'manual');
  h.state.runKind = null;
  h.fn.paintRunKind();
  assert.equal(h.node.runKind.hidden, true);
  assert.deepEqual(h.node.runKind.children, []);
});

test('87: a project emoji replaces the suite glyph and says so through data-emoji', () => {
  const h = load();
  const plainIcon = h.fn.treeIcon('tree_suite', 'file-icon', null);
  assert.equal(plainIcon.className, 'tree-icon file-icon');
  assert.equal(plainIcon.dataset.emoji, undefined);
  assert.equal(plainIcon.children[0].dataset.icon, 'tree_suite');
  const marked = h.fn.treeIcon('tree_suite', 'file-icon', '🔥');
  assert.equal(marked.dataset.emoji, '🔥');
  assert.equal(marked.textContent, '🔥');
  // An unresolved shortcode is not a mark — it falls back to the glyph, carrying no data-emoji.
  const shortcode = h.fn.treeIcon('tree_suite', 'file-icon', ':fire:');
  assert.equal(shortcode.dataset.emoji, undefined);
  assert.equal(shortcode.children[0].dataset.icon, 'tree_suite');
});

test('88: an unfoldable row keeps the empty slot, so its title lines up with a foldable sibling', () => {
  const h = load();
  const slot = h.lex.treeSlot();
  assert.equal(slot.className, 'tree-icon');
  assert.deepEqual(slot.childNodes, []);
});

test('88a: the test view reuses the same counts line, into its own band', () => {
  const h = load({ records: [rec(1, { status: 'passed' }), rec(2)] });
  h.fn.renderTestProgress();
  assert.equal(h.node.testProgress.querySelector('.counts-done').textContent, '1/2');
  assert.deepEqual(h.node.testProgress.querySelectorAll('.counts-part').map((p) => p.textContent), ['1 passed']);
});

