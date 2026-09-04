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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

// The REAL formatter, not a stub: the Run info rows assert the duration a tester reads, and a
// fake would let them pass against a wording the panel never prints (tests/format.test.mjs).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const Fmt = runInNewContext(`${readFileSync(join(CORE_SRC, 'format.js'), 'utf8')}\nFmt;`, {});

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
    // The real core/format.js, recorded on the way through. The ARGUMENT is the point of these
    // rows: run-view holds SECONDS and has to multiply, so an unconverted 90 prints '0.09s'.
    Fmt: { humanDuration: (ms) => { calls.durations.push(ms); return Fmt.humanDuration(ms); } },
    // core/write-status.js's own optimistic assign — without it a rollback row would pass
    // against a stub that never changed the record in the first place.
    WriteCore: {
      writeStatus: async (record, status, comment) => {
        calls.writes.push({ id: record?.id, status, comment });
        calls.order.push('write');
        if (record) Object.assign(record, { status, message: comment });
        return on.write(record, status);
      },
    },
    loadProjectInfo: async () => { calls.projectInfo += 1; calls.order.push('projectInfo'); return on.projectInfo(); },
    loadProjectUsers: async () => { calls.projectUsers += 1; calls.order.push('projectUsers'); return on.projectUsers(); },
    applyCapabilities: () => { calls.capabilities += 1; },
    startLiveSync: () => { calls.liveSyncs += 1; calls.order.push('liveSync'); },
    openTestView: (id) => { calls.opened.push(id); },
    CommentDrafts: { prune: (runId) => { calls.prunes.push(runId); } },
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

// The row's own status mark is what the flash lands on (#274) — every row has one, so the
// confirmation is no longer conditional on a marker that may not be there. repaintRow REPLACES that
// mark, so the seam wraps the row's own lookup rather than one node, and `offsetWidth` — the flash's
// reflow read — says WHEN it ran relative to the repaint.
function flashTarget(h, li) {
  const find = li.querySelector.bind(li);
  li.querySelector = (sel) => {
    const node = find(sel);
    if (sel === '.row-status' && node && !node.flashSeam) {
      node.flashSeam = true;
      Object.defineProperty(node, 'offsetWidth', { get: () => { h.calls.order.push('flash'); return 1; } });
    }
    return node;
  };
  return () => li.querySelector('.row-status');
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


// ---------- the Run info model (rows 14-21, 89-90) ----------

test('14: the v2 detail is kept verbatim — the authoritative count, and only plans that NAME one', () => {
  const h = load();
  const info = plain(h.fn.runInfoFromDetail({
    total_tests: 12, tests_count: 9, env: 'chrome, firefox',
    plans: [{ title: 'P' }, 77], description: '  hi  ',
  }));
  assert.deepEqual(info, {
    status: null, testsCount: 12, createdAt: null, description: 'hi',
    envs: ['chrome', 'firefox'], plans: ['P'],
  });
});

test('14a: a payload that says nothing about people leaves those keys OFF, never null', () => {
  const h = load();
  const bare = plain(h.fn.runInfoFromDetail({ tests_count: 3, status: 'running', created_at: 'x' }));
  assert.deepEqual(Object.keys(bare).sort(), ['createdAt', 'description', 'status', 'testsCount']);
  // Named, and the three land — so the absence above is a decision, not an empty payload path.
  const full = plain(h.fn.runInfoFromDetail({
    tests_count: 3, executed_by: 'ann@x.io', author: 'Bo', assigned_to: 'cy@x.io',
  }));
  assert.deepEqual(full.executedBy, { name: '', email: 'ann@x.io' });
  assert.deepEqual(full.createdBy, { name: 'Bo', email: '' });
  assert.deepEqual(full.assignees, [{ name: '', email: 'cy@x.io' }]);
});

test('15: env arrives as a list on one route and a comma string on another — both come back a list', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.envList(['x', null, '  '])), ['x']);
  assert.deepEqual(plain(h.fn.envList('a, b ,')), ['a', 'b']);
  assert.deepEqual(plain(h.fn.envList(null)), []);
  assert.deepEqual(plain(h.fn.envList('')), []);
});

test('15a: a plan is whatever names it; a bare id contributes nothing rather than "4831"', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.planList([' Smoke ', { clean_title: 'Reg' }, { name: 'N' }, 4831, null])),
    ['Smoke', 'Reg', 'N']);
  assert.deepEqual(plain(h.fn.planList({ title: 'One' })), ['One'], 'a lone plan is not a list yet');
  assert.deepEqual(plain(h.fn.planList(null)), []);
});

test('16: the id list and the mode setting are not people, and neither is the word `none`', () => {
  const h = load();
  const out = plain(h.fn.flatPeople({
    assignee_ids: [3, 7], assign_mode: 'none', assigned_to: 'Ольга', assignees: ['none', 'bob@x.io'],
  }, /assign/));
  assert.deepEqual(out, [{ name: 'Ольга', email: '' }, { name: '', email: 'bob@x.io' }]);
});

test('16a: a key the pattern does not name is skipped whatever it holds', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.flatPeople({ owner: 'Ann' }, /assign/)), []);
  assert.deepEqual(plain(h.fn.flatPeople({ owner: 'Ann' }, /owner/)), [{ name: 'Ann', email: '' }]);
  assert.deepEqual(plain(h.fn.flatPeople(null, /assign/)), []);
});

test('17: a stamp is printed in the viewer\'s PROFILE zone, in the web\'s own wording', () => {
  const h = load();
  assert.equal(h.fn.formatTimeIn('2026-09-03T14:05:00Z', 'UTC'), 'Sep 3, 2026 2:05 PM');
  assert.equal(h.fn.formatTimeIn('2026-09-03T14:05:00Z', 'America/New_York'), 'Sep 3, 2026 10:05 AM');
});

test('18: a zone the profile made up falls back to the machine\'s, rather than throwing the row away', () => {
  const h = load();
  // The machine zone is pinned to Asia/Tokyo at the top of this file, so the fallback is legible.
  assert.equal(h.fn.formatTimeIn('2026-09-03T14:05:00Z', 'Not/AZone'), 'Sep 3, 2026 11:05 PM');
  assert.equal(h.fn.formatTimeIn('2026-09-03T14:05:00Z', null), 'Sep 3, 2026 11:05 PM');
});

test('19: an unparseable stamp is no row at all, and neither is a missing one', () => {
  const h = load();
  assert.equal(h.fn.formatTimeIn('not a date', 'UTC'), null);
  assert.equal(h.fn.runInfoTime(null), null);
  assert.equal(h.fn.runInfoTime(''), null);
  assert.equal(h.fn.runInfoTime('not a date'), null);
});

test('19a: a stamp that DOES parse carries the raw ISO beside the printed text', () => {
  const h = load({ timezone: 'UTC' });
  const span = h.fn.runInfoTime('2026-09-03T14:05:00Z');
  assert.equal(span.className, 'run-info-time');
  assert.equal(span.textContent, 'Sep 3, 2026 2:05 PM');
  assert.equal(span.dataset.time, '2026-09-03T14:05:00Z', 'zone- and locale-free');
  assert.equal(span.dataset.tip, '2026-09-03T14:05:00Z');
});

test('20: a CI build URL is http(s) or it is not a link — the regression lock on the scheme', () => {
  const h = load();
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil', 'ftp://x/y', '', null, 5]) {
    assert.equal(h.fn.ciBuildLink(url), null, String(url));
  }
});

test('21: a padded https URL is trimmed, opened in a new tab and never printed as the label', () => {
  const h = load();
  const a = h.fn.ciBuildLink('  https://ci.example/build/9  ');
  assert.equal(a.href, 'https://ci.example/build/9');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
  assert.equal(a.dataset.tip, 'https://ci.example/build/9', 'the raw URL is the tooltip');
  assert.ok(a.textContent.startsWith('Open CI build'), a.textContent);
  assert.equal(a.querySelector('.link-out-icon').dataset.icon, 'open_in_new');
  assert.equal(a.textContent.includes('ci.example'), false, 'and never the label');
});

test('89: a tag list is pills with the whole string on each tooltip; an empty list is no row', () => {
  const h = load();
  assert.equal(h.fn.runInfoTags([]), null);
  const box = h.fn.runInfoTags(['chrome', 'a-very-long-environment-name']);
  assert.equal(box.className, 'env-tags');
  assert.deepEqual(box.children.map((p) => p.className), ['badge env', 'badge env']);
  assert.deepEqual(box.children.map((p) => p.dataset.tip), ['chrome', 'a-very-long-environment-name']);
});

test('90: the status cell normalises the colour key but prints the word the server sent', () => {
  const h = load();
  const span = h.fn.runInfoStatus('launching');
  assert.equal(span.dataset.status, 'running');
  assert.equal(span.textContent, 'launching');
});

// ---------- the Run info rows (rows 22-28, 91-96) ----------

// state.runInfo is what runInfoRows reads; everything below states it directly.
const withInfo = (info, over = {}) => load({ runInfo: info, timezone: 'UTC', ...over });
const labelled = (h) => Object.fromEntries(h.fn.runInfoRows()
  .map(([label, value]) => [label, typeof value === 'string' ? value : value.textContent]));

test('22: the card prints the SERVER\'s total, not the number of rows loaded into the panel', () => {
  const h = withInfo({ testsCount: 180 }, { records: Array.from({ length: 50 }, (_, i) => rec(i + 1)) });
  assert.equal(labelled(h).Tests, '180');
  // …and never below the checklist: a run created moments ago has rows the count has not caught up to.
  h.state.runInfo = { testsCount: 0 };
  assert.equal(labelled(h).Tests, '50');
});

test('23: duration arrives in SECONDS and is handed to humanDuration in milliseconds', () => {
  const h = withInfo({ duration: 90 });
  assert.equal(labelled(h).Duration, '1m 30s');
  assert.deepEqual(h.calls.durations, [90000]);
});

test('24: a run still going has no duration to print', () => {
  const h = withInfo({ duration: 0 });
  assert.equal('Duration' in labelled(h), false);
  assert.deepEqual(h.calls.durations, []);
});

test('25: a finished run shows the executed span, and no separate Started row beside it', () => {
  const h = withInfo({ launchedAt: '2026-09-03T14:05:00Z', finishedAt: '2026-09-03T14:35:00Z' });
  const rows = labelled(h);
  assert.equal(rows.Executed, 'Sep 3, 2026 2:05 PM→Sep 3, 2026 2:35 PM');
  assert.equal('Started' in rows, false);
  // A live run has only the start, which is the row the span replaced.
  h.state.runInfo = { launchedAt: '2026-09-03T14:05:00Z' };
  const live = labelled(h);
  assert.equal(live.Started, 'Sep 3, 2026 2:05 PM');
  assert.equal('Executed' in live, false);
});

test('26: "Created by <person>, <date>" is ONE row — the date does not repeat itself below', () => {
  const h = withInfo({ createdBy: { name: 'Ann', email: 'ann@x.io' }, createdAt: '2026-09-03T14:05:00Z' });
  const rows = labelled(h);
  assert.equal(rows['Created by'], 'AnnSep 3, 2026 2:05 PM');
  assert.equal('Created' in rows, false);
  // Nobody named → the date alone, under its own label.
  h.state.runInfo = { createdAt: '2026-09-03T14:05:00Z' };
  const anon = labelled(h);
  assert.equal(anon.Created, 'Sep 3, 2026 2:05 PM');
  assert.equal('Created by' in anon, false);
});

test('27: a description is server data, printed as text — no element comes out of it', () => {
  const h = withInfo({ description: '<script>alert(1)</script>' });
  h.fn.renderRunInfo();
  const dd = h.infoValue('Description');
  assert.equal(dd.querySelectorAll('script').length, 0);
  assert.equal(dd.textContent, '<script>alert(1)</script>');
  assert.ok(dd.classList.contains('run-info-desc'));
  assert.ok(dd.querySelector('.run-info-desc-text').classList.contains('is-clamped'));
});

test('28: one person named twice is one cell — the key is the ADDRESS, whatever its case', () => {
  const h = withInfo({ assignees: ['Bob@X.io'] }, { records: [rec(1, { assigned_to: { name: 'Bob', email: 'bob@x.io' } })] });
  const box = h.fn.runInfoAssignees();
  assert.deepEqual(box.children.map((c) => c.textContent), ['Bob']);
  assert.equal(box.children[0].dataset.email, 'Bob@X.io', 'the first spelling seen is the one kept');
});

test('28a: the ticket\'s "one by email, one by name" is TWO cells — the key is not a human', () => {
  // Following the code, not row 28's wording: `(u.email || u.name).toLowerCase()` cannot know that
  // 'Bob' and 'bob@x.io' are the same tester, and the comment above it says "keyed by address".
  const h = withInfo({ assignees: ['Bob'] }, { records: [rec(1, { assigned_to: 'bob@x.io' })] });
  assert.deepEqual(h.fn.runInfoAssignees().children.map((c) => c.textContent), ['Bob', 'bob']);
});

test('28b: nobody assigned anywhere is no row at all', () => {
  const h = withInfo({}, { records: [rec(1)] });
  assert.equal(h.fn.runInfoAssignees(), null);
  assert.equal('Assigned to' in labelled(h), false);
});

test('91: a person named only by address is resolved through the project members for their name', () => {
  const h = withInfo({ executedBy: 'ann@x.io' }, { members: { 'ann@x.io': { name: 'Ann Lee', email: 'ann@x.io' } } });
  assert.equal(labelled(h)['Executed by'], 'Ann Lee');
  // What the PAYLOAD said wins over the members map.
  h.state.runInfo = { executedBy: { name: 'A. Lee', email: 'ann@x.io' } };
  assert.equal(labelled(h)['Executed by'], 'A. Lee');
  // Nobody in the map and no name: the address's local part, the way the assignee chip falls back.
  const bare = withInfo({ executedBy: 'zoe@x.io' });
  assert.equal(labelled(bare)['Executed by'], 'zoe');
  assert.equal(bare.fn.runInfoUser(null), null);
});

test('92: the card\'s rows come out in the web\'s own order', () => {
  const h = withInfo({
    status: 'passed', duration: 90, testsCount: 4, envs: ['chrome'], plans: ['Smoke'],
    launchedAt: '2026-09-03T14:05:00Z', finishedAt: '2026-09-03T14:35:00Z',
    executedBy: 'ann@x.io', assignees: ['bo@x.io'], ciBuildUrl: 'https://ci.example/9',
    createdBy: 'Cy', createdAt: '2026-09-01T10:00:00Z', description: 'why',
  });
  // Spread first: the array comes out of the vm realm with its own prototype, which deepEqual reads.
  assert.deepEqual([...h.fn.runInfoRows()].map(([label]) => label), [
    'Status', 'Duration', 'Tests', 'Environment', 'Test plan', 'Executed',
    'Executed by', 'Assigned to', 'Build URL', 'Created by', 'Description',
  ]);
});

test('96: a description too tall for its clamp grows a Show more, and the button says which way', () => {
  const h = withInfo({ description: 'a very long session report' });
  h.fn.renderRunInfo();
  const text = h.node.runInfoBody.querySelector('.run-info-desc-text');
  assert.equal(h.node.runInfoBody.querySelector('.run-info-desc-more'), null, 'it fits, so no button');
  text.scrollHeight = 400; // what a browser would measure for a report that overflows its clamp
  text.clientHeight = 60;
  h.fn.paintRunInfo();
  const more = h.node.runInfoBody.querySelector('.run-info-desc-more');
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  fire(more, 'click');
  assert.equal(more.textContent, 'Show less');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(text.classList.contains('is-clamped'), false);
  fire(more, 'click');
  assert.equal(more.textContent, 'Show more');
  assert.ok(text.classList.contains('is-clamped'));
  // A second measure does not stack a second button on top of the first.
  h.fn.paintRunInfo();
  assert.equal(h.node.runInfoBody.querySelectorAll('.run-info-desc-more').length, 1);
});

test('96a: a closed card measures nothing — a hidden body has no layout to read', () => {
  const h = withInfo({ description: 'x' });
  h.fn.renderRunInfo();
  h.fn.toggleRunInfo(); // closed
  const text = h.node.runInfoBody.querySelector('.run-info-desc-text');
  text.scrollHeight = 400;
  text.clientHeight = 60;
  h.fn.paintRunInfo();
  assert.equal(h.node.runInfoBody.querySelector('.run-info-desc-more'), null);
});

test('93: a run whose meta never loaded gets no empty card — the section hides itself', () => {
  const h = withInfo({});
  h.fn.renderRunInfo();
  assert.equal(h.node.runInfo.hidden, true);
  assert.deepEqual(h.infoRows(), []);
  // One field is enough to bring it back, so the hide is about content and not about the call.
  h.state.runInfo = { status: 'running' };
  h.fn.renderRunInfo();
  assert.equal(h.node.runInfo.hidden, false);
  assert.deepEqual(h.infoLabels(), ['Status']);
});

test('94: the disclosure remembers the tester\'s choice, and says so to a reader', () => {
  const h = withInfo({ status: 'running' });
  h.fn.renderRunInfo();
  assert.equal(h.node.runInfoHead.getAttribute('aria-expanded'), 'true');
  assert.equal(h.node.runInfoBody.hidden, false);
  h.fn.toggleRunInfo();
  assert.equal(h.node.runInfoHead.getAttribute('aria-expanded'), 'false');
  assert.equal(h.node.runInfoBody.hidden, true);
  assert.equal(h.calls.persists, 1, 'and the choice outlives this panel');
  h.fn.toggleRunInfo();
  assert.equal(h.node.runInfoBody.hidden, false);
  assert.equal(h.calls.persists, 2);
});

test('95: a page without the card is not an error — the test view shares this file', () => {
  const h = withInfo({ status: 'running' }, { without: ['run-info', 'run-info-body', 'run-info-head'] });
  assert.doesNotThrow(() => h.fn.renderRunInfo());
  assert.doesNotThrow(() => h.fn.paintRunInfo());
});

// ---------- selection, search and suites (rows 29-36, 97-106) ----------

test('29: a numeric row id finds its string-keyed example values, and the query is trimmed and folded', () => {
  const h = load({ runExamples: { 5: { values: ['ru', 'UA'] } }, runSearch: ' UA ' });
  assert.equal(h.fn.matchesRunSearch({ id: 5 }), true);
  h.state.runSearch = 'de';
  assert.equal(h.fn.matchesRunSearch({ id: 5 }), false, 'a value nothing carries does not match');
});

test('29a: the title and the suite title are searched too, both case-blind', () => {
  const h = load({ runSearch: 'CHECK' });
  assert.equal(h.fn.matchesRunSearch({ id: 1, test_title: 'checkout works' }), true);
  assert.equal(h.fn.matchesRunSearch({ id: 1, suite_title: 'Checkout' }), true);
  assert.equal(h.fn.matchesRunSearch({ id: 1, test_title: 'login' }), false);
  assert.equal(h.fn.matchesRunSearch({ id: 1 }), false, 'a row with no text at all matches nothing');
});

test('30: an empty search is not a filter — every row stays', () => {
  const h = load({ runSearch: '' });
  assert.equal(h.fn.matchesRunSearch({ id: 1 }), true);
  assert.equal(h.fn.matchesRunSearch({ id: 2, test_title: 'anything' }), true);
  h.state.runSearch = '   ';
  assert.equal(h.fn.matchesRunSearch({ id: 1 }), true, 'and neither is whitespace');
});

test('31: suites section in first-appearance order, with the bare rows under their own sentinel', () => {
  const h = load({
    records: [rec(1, { suite_title: 'A' }), rec(2, { suite_title: null }),
      rec(3, { suite_title: 'A' }), rec(4, { suite_title: 'B' })],
  });
  const secs = plain(h.fn.suiteSections());
  assert.deepEqual(secs.map((s) => s.key), ['A', '__none__', 'B']);
  assert.deepEqual(secs.map((s) => s.title), ['A', null, 'B']);
  assert.deepEqual(secs.map((s) => s.rows.map((r) => r.id)), [[1, 3], [2], [4]]);
  // …and the sentinel is drawn as "No suite" rather than printed raw.
  h.fn.renderRunSections();
  assert.deepEqual(h.sectionKeys(), ['A', '__none__', 'B']);
  assert.deepEqual(h.sectionTitles(), ['A', 'No suite', 'B']);
});

test('97: a suite title the server sent as an empty string is a bare row too', () => {
  const h = load();
  assert.equal(h.lex.suiteKeyOf({ suite_title: 'A' }), 'A');
  assert.equal(h.lex.suiteKeyOf({ suite_title: '' }), '__none__');
  assert.equal(h.lex.suiteKeyOf({}), '__none__');
});

test('32: a suite called `constructor` answers with its own mark, and `toString` with none', () => {
  const h = load();
  h.state.suiteEmoji = h.fn.indexSuiteEmoji([{ title: 'constructor', emoji: '🔥' }], Object.create(null));
  assert.equal(h.lex.suiteEmojiOf('constructor'), '🔥');
  assert.equal(h.lex.suiteEmojiOf('toString'), null);
  // The shipped path builds the null-prototype map itself — same answer.
  h.fn.rememberSuiteEmoji([{ title: 'constructor', emoji: '🔥' }]);
  assert.equal(h.lex.suiteEmojiOf('toString'), null);
  assert.equal(h.lex.suiteEmojiOf(''), null);
  assert.equal(h.lex.suiteEmojiOf('constructor'), '🔥');
});

test('33: only a title that CARRIES a mark is written, so a later duplicate still lands', () => {
  const h = load();
  const into = h.fn.indexSuiteEmoji([{ title: 'Checkout' }, { title: 'Checkout', emoji: '🛒' }], Object.create(null));
  assert.equal(into.Checkout, '🛒');
  // First-wins otherwise: two marks for one title keep the first.
  const twice = h.fn.indexSuiteEmoji([{ title: 'C', emoji: '🛒' }, { title: 'C', emoji: '🔥' }], Object.create(null));
  assert.equal(twice.C, '🛒');
});

test('33a: the index descends the whole tree, and no tree at all is an empty index', () => {
  const h = load();
  const into = h.fn.indexSuiteEmoji([{ title: 'Root', children: [{ title: 'Leaf', emoji: '🍃' }] }], Object.create(null));
  assert.deepEqual({ ...into }, { Leaf: '🍃' });
  assert.deepEqual({ ...h.fn.indexSuiteEmoji(null, Object.create(null)) }, {});
});

test('34: a mark the project took away disappears — the index is replaced, not merged', () => {
  const h = load();
  h.fn.rememberSuiteEmoji([{ title: 'Checkout', emoji: '🛒' }, { title: 'Login', emoji: '🔑' }]);
  assert.equal(h.lex.suiteEmojiOf('Checkout'), '🛒');
  h.fn.rememberSuiteEmoji([{ title: 'Login', emoji: '🔑' }]);
  assert.equal(h.lex.suiteEmojiOf('Checkout'), null);
  assert.equal(h.lex.suiteEmojiOf('Login'), '🔑');
});

test('35: a filter key nobody knows falls back to All — and that IS a change, so it repaints', () => {
  const h = load({ runFilter: 'failed', records: [rec(1)] });
  h.calls.order.length = 0;
  h.fn.setRunFilter('bogus');
  assert.equal(h.state.runFilter, 'all');
  assert.equal(h.calls.order.filter((s) => s === 'sections').length, 1);
  assert.equal(h.calls.fitChips, 1);
});

test('36: choosing the chip that is already on is an early return — nothing repaints', () => {
  const h = load({ runFilter: 'failed', records: [rec(1)] });
  h.calls.order.length = 0;
  h.fn.setRunFilter('failed');
  assert.deepEqual(h.calls.order, []);
  assert.equal(h.calls.fitChips, 0);
  // A different key from the same state DOES repaint, so the silence above is the guard talking.
  h.fn.setRunFilter('passed');
  assert.equal(h.state.runFilter, 'passed');
  assert.equal(h.calls.order.filter((s) => s === 'sections').length, 1);
});

test('98: All matches everything; a status chip matches what the row DISPLAYS, pending included', () => {
  const h = load({ runFilter: 'all' });
  assert.equal(h.lex.matchesRunFilter({ status: 'running' }), true);
  h.state.runFilter = 'untested';
  assert.equal(h.lex.matchesRunFilter({ status: 'pending' }), true);
  assert.equal(h.lex.matchesRunFilter({}), true, 'no status at all is untested too');
  assert.equal(h.lex.matchesRunFilter({ status: 'passed' }), false);
  h.state.runFilter = 'passed';
  assert.equal(h.lex.matchesRunFilter({ status: 'passed' }), true);
});

test('99: a row has to survive BOTH constraints — the filter and the search together', () => {
  const h = load({ runFilter: 'failed', runSearch: 'checkout' });
  const hit = { id: 1, status: 'failed', test_title: 'checkout works' };
  assert.equal(h.lex.rowVisible(hit), true);
  assert.equal(h.lex.rowVisible({ ...hit, status: 'passed' }), false, 'the filter alone can drop it');
  assert.equal(h.lex.rowVisible({ ...hit, test_title: 'login' }), false, 'and so can the search');
});

test('100: the traversal order is the SECTION order, and the visible sequence applies both filters', () => {
  const h = load({
    records: [rec(1, { suite_title: 'A' }), rec(2, { suite_title: 'B', status: 'passed' }),
      rec(3, { suite_title: 'A', status: 'passed' })],
  });
  assert.deepEqual([...h.lex.orderedRecords()].map((r) => r.id), [1, 3, 2], 'grouped, not id order');
  assert.deepEqual([...h.lex.visibleRecords()].map((r) => r.id), [1, 3, 2]);
  h.state.runFilter = 'passed';
  assert.deepEqual([...h.lex.visibleRecords()].map((r) => r.id), [3, 2]);
});

test('101: a plain row has no example values to search — the chip and the lookup are both empty', () => {
  const h = load({ runExamples: { 5: { values: ['ru'] } } });
  assert.equal(h.lex.exampleOf({ id: 5 }).values[0], 'ru');
  assert.equal(h.lex.exampleOf({ id: 6 }), null);
  assert.equal(h.fn.exampleChip({ id: 6 }), null);
  assert.equal(h.fn.exampleChip({ id: 7 }), null);
});

test('102: the chips are updated in place, never rebuilt — the counts move under the tester\'s eye', () => {
  const h = load({ records: [rec(1, { status: 'passed' }), rec(2), rec(3, { status: 'failed' })] });
  h.fn.renderRunFilterChips();
  assert.deepEqual(h.chipLabels(), ['all', 'passed', 'failed', 'skipped', 'untested']);
  assert.deepEqual(h.chipCounts(), ['3', '1', '1', '0', '1']);
  const first = h.node.runFilter.querySelector('[data-filter="all"]');
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  assert.ok(first.classList.contains('selected'));
  h.state.records[1].status = 'passed';
  h.fn.renderRunFilterChips();
  assert.equal(h.node.runFilter.querySelector('[data-filter="all"]'), first, 'the same node, repainted');
  assert.deepEqual(h.chipCounts(), ['3', '2', '1', '0', '0']);
  assert.equal(h.calls.fitChips, 2);
});

test('102a: clicking a chip is what changes the filter — the listener is registered once', () => {
  const h = load({ records: [rec(1, { status: 'failed' })] });
  h.fn.renderRunFilterChips();
  h.fn.renderRunFilterChips(); // a poll tick: no second listener may pile up
  const failed = h.node.runFilter.querySelector('[data-filter="failed"]');
  assert.equal(failed.listeners.get('click').length, 1);
  fire(failed, 'click');
  assert.equal(h.state.runFilter, 'failed');
  assert.equal(failed.getAttribute('aria-pressed'), 'true');
  assert.equal(h.node.runFilter.querySelector('[data-filter="all"]').getAttribute('aria-pressed'), 'false');
});

test('102b: a screen with no chip bar is not an error — the counts simply have nowhere to go', () => {
  const h = load({ without: ['run-filter'] });
  assert.doesNotThrow(() => h.fn.renderRunFilterChips());
  assert.equal(h.calls.fitChips, 0);
});

test('103: the search field is written only when it disagrees, so typing is never interrupted', () => {
  const h = load({ runSearch: 'check' });
  h.node.runSearch.value = 'chec'; // mid-keystroke
  h.fn.syncRunSearch();
  assert.equal(h.node.runSearch.value, 'check');
  assert.equal(h.node.runSearchClear.hidden, false);
  h.state.runSearch = '';
  h.fn.syncRunSearch();
  assert.equal(h.node.runSearch.value, '');
  assert.equal(h.node.runSearchClear.hidden, true);
});

test('104: Clear empties the field and the state, hides itself, repaints and takes the caret back', () => {
  const h = load({ runSearch: 'check', records: [rec(1)] });
  h.node.runSearch.value = 'check';
  h.calls.order.length = 0;
  h.fn.clearRunSearch();
  assert.equal(h.node.runSearch.value, '');
  assert.equal(h.state.runSearch, '');
  assert.equal(h.node.runSearchClear.hidden, true);
  assert.equal(h.calls.order.filter((s) => s === 'sections').length, 1);
  assert.equal(h.doc.activeElement, h.node.runSearch);
});

test('104a: typing keeps the RAW value in state but hides Clear for whitespace alone', () => {
  const h = load({ records: [rec(1)] });
  h.node.runSearch.value = '  check  ';
  h.fn.onRunSearch();
  assert.equal(h.state.runSearch, '  check  ', 'raw — matchesRunSearch trims it itself');
  assert.equal(h.node.runSearchClear.hidden, false);
  h.node.runSearch.value = '   ';
  h.fn.onRunSearch();
  assert.equal(h.state.runSearch, '   ');
  assert.equal(h.node.runSearchClear.hidden, true);
});

test('105: the suite marks come off the Tests tab first, and the server tree replaces them after', async () => {
  const h = load({ tcSuites: [{ title: 'Checkout', emoji: '🛒' }], records: [rec(1, { suite_title: 'Checkout' })] });
  h.on.getSuiteTree = async () => [{ title: 'Checkout', emoji: '🔥' }];
  h.fn.renderRunSections();
  await h.fn.loadSuiteEmoji('r1');
  assert.equal(h.lex.suiteEmojiOf('Checkout'), '🔥', 'the server tree wins in the end');
  assert.equal(h.node.runTests.querySelector('.suite-head .file-icon').dataset.emoji, '🔥');
});

test('105a: a failed tree read leaves the mark drawn from the Tests tab standing', async () => {
  const h = load({ tcSuites: [{ title: 'Checkout', emoji: '🛒' }], records: [rec(1, { suite_title: 'Checkout' })] });
  h.on.getSuiteTree = async () => { throw new Error('offline'); };
  h.fn.renderRunSections();
  await h.fn.loadSuiteEmoji('r1');
  assert.equal(h.lex.suiteEmojiOf('Checkout'), '🛒');
  assert.equal(h.node.runTests.querySelector('.suite-head .file-icon').dataset.emoji, '🛒');
});

test('105b: a tree that lands after the tester left the run is dropped, not painted', async () => {
  const h = load({ records: [rec(1, { suite_title: 'Checkout' })] });
  h.on.getSuiteTree = async () => { h.state.runId = 'r2'; return [{ title: 'Checkout', emoji: '🔥' }]; };
  h.fn.renderRunSections();
  await h.fn.loadSuiteEmoji('r1');
  assert.equal(h.state.suiteEmoji, null);
  assert.equal(h.node.runTests.querySelector('.suite-head .file-icon').dataset.emoji, undefined);
});

test('106: a repaint that changes nothing leaves the icon node alone', () => {
  const h = load({ suiteEmoji: { Checkout: '🛒' }, records: [rec(1, { suite_title: 'Checkout' })] });
  h.fn.renderRunSections();
  const before = h.node.runTests.querySelector('.suite-head .file-icon');
  assert.equal(before.dataset.emoji, '🛒');
  h.fn.paintSuiteEmoji();
  assert.equal(h.node.runTests.querySelector('.suite-head .file-icon'), before, 'same node');
  // A mark that MOVED swaps the node, so the identity above is a decision and not a dead call.
  h.state.suiteEmoji = { Checkout: '🔥' };
  h.fn.paintSuiteEmoji();
  const after = h.node.runTests.querySelector('.suite-head .file-icon');
  assert.notEqual(after, before);
  assert.equal(after.dataset.emoji, '🔥');
});

// ---------- what a row says (rows 37-39, 107-114) ----------

test('37: the custom status rides the mark\'s tooltip, and a token-only panel never sees it', () => {
  const h = load({ jwt: true });
  assert.equal(h.fn.statusTip({ status: 'failed', substatus: ' Needs investigation ' }),
    'failed · Needs investigation');
  h.sandbox.capabilities.jwt = false;
  assert.equal(h.fn.statusTip({ status: 'failed', substatus: ' Needs investigation ' }), 'failed');
});

test('37a: an untested row is tipped with the word a person reads, not this file\'s key', () => {
  const h = load();
  assert.equal(h.fn.statusTip({ status: 'pending' }), 'pending');
  assert.equal(h.fn.statusTip({}), 'pending');
  assert.equal(h.fn.statusTip(null), 'pending');
});

test('38: a row with no title says which test it is, and falls back to a word when it cannot', () => {
  const h = load();
  assert.equal(h.lex.rowTitle({ test_id: 9 }), 'Test 9');
  assert.equal(h.lex.rowTitle({}), 'Untitled test');
  assert.equal(h.lex.rowTitle({ test_title: 'Checkout', test_id: 9 }), 'Checkout');
});

test('39: the example chip shows the values and hangs the parameter names on the tooltip', () => {
  const h = load({ runExamples: { 5: { values: ['ru', 'UA'], params: ['lang', 'country'] } } });
  const chip = h.fn.exampleChip({ id: 5 });
  assert.equal(chip.className, 'example');
  assert.equal(chip.textContent, 'ru, UA');
  assert.equal(chip.dataset.tip, 'lang: ru · country: UA');
  // Misaligned names cannot be paired positionally, so the tooltip falls back to the values.
  h.state.runExamples = { 5: { values: ['ru', 'UA'], params: ['lang'] } };
  assert.equal(h.fn.exampleChip({ id: 5 }).dataset.tip, 'ru, UA');
  h.state.runExamples = { 5: { values: ['ru', 'UA'] } };
  assert.equal(h.fn.exampleChip({ id: 5 }).dataset.tip, 'ru, UA');
});

test('107: the mark is the LABEL, so a pending row carries data-status="pending", not "untested"', () => {
  const h = load();
  const mark = h.fn.statusMark({ id: 1, status: 'pending' });
  assert.equal(mark.dataset.status, 'pending');
  assert.ok(mark.classList.contains('row-status'));
  assert.equal(mark.dataset.tip, 'pending');
  assert.equal(h.fn.statusMark({ id: 1, status: 'passed' }).dataset.status, 'passed');
});

test('108: the three write buttons carry their labels, and the row\'s own status is the active one', () => {
  const h = load({ runStatus: 'running' });
  const li = h.fn.testRow(rec(1, { status: 'failed' }));
  const btns = li.querySelectorAll('.row-actions .row-st');
  assert.deepEqual(btns.map((b) => b.dataset.status), ['passed', 'failed', 'skipped']);
  assert.deepEqual(btns.map((b) => b.getAttribute('aria-label')), ['Mark passed', 'Mark failed', 'Mark skipped']);
  assert.deepEqual(btns.map((b) => b.dataset.tip), ['Mark passed', 'Mark failed', 'Mark skipped']);
  assert.deepEqual(btns.map((b) => b.classList.contains('active')), [false, true, false]);
  assert.deepEqual(btns.map((b) => b.disabled), [false, false, false]);
});

test('108a: a locked run draws the same row dead, with the reason where the label was', () => {
  const h = load({ runStatus: 'finished' });
  const btns = h.fn.testRow(rec(1)).querySelectorAll('.row-actions .row-st');
  assert.deepEqual(btns.map((b) => b.disabled), [true, true, true]);
  assert.deepEqual([...new Set(btns.map((b) => b.dataset.tip))], [FINISHED]);
});

test('109: a row carries its record id, its marks and its example — and opens the test when clicked', () => {
  const h = load({ runExamples: { 1: { values: ['ru'] } }, runStatus: 'running' });
  const li = h.fn.testRow(rec(1, { priority: 'high', automated: true, suite_title: 'A' }));
  assert.equal(li.className, 'test-row');
  assert.equal(li.dataset.recordId, '1');
  assert.equal(li.querySelector('.title').textContent, 'Test 1');
  assert.equal(li.querySelector('.prio').dataset.prio, 'high');
  assert.equal(li.querySelector('.type-mark').dataset.kind, 'automated');
  assert.equal(li.querySelector('.example').textContent, 'ru');
  assert.deepEqual(h.calls.decorated, ['1'], 'the queued marker is re-applied on every render');
  fire(li, 'click');
  assert.deepEqual(h.calls.opened, [1]);
});

test('110: the lock un-paints too — a run that reopened restores each button\'s own label', () => {
  const h = load({ runStatus: 'finished', records: [rec(1)] });
  h.fn.renderRunSections();
  const li = h.node.runTests.querySelector('li.test-row');
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [true, true, true]);
  h.state.runStatus = 'running';
  h.fn.applyRowLock(li);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [false, false, false]);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.dataset.tip),
    ['Mark passed', 'Mark failed', 'Mark skipped']);
});

test('111: releasing a busy row must never re-enable a LOCKED one', () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.fn.renderRunSections();
  const li = h.node.runTests.querySelector('li.test-row');
  h.fn.setRowButtonsBusy(li, true);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [true, true, true]);
  h.fn.setRowButtonsBusy(li, false);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [false, false, false]);
  // The same release under a lock leaves them dead — the lock outranks the busy flag.
  h.state.runStatus = 'finished';
  h.fn.setRowButtonsBusy(li, false);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [true, true, true]);
});

test('112: a row is found by its record id however the caller spelled it', () => {
  const h = load({ records: [rec(1), rec(2)] });
  h.fn.renderRunSections();
  assert.equal(h.fn.runRowEl(2).dataset.recordId, '2');
  assert.equal(h.fn.runRowEl('2').dataset.recordId, '2');
  assert.equal(h.fn.runRowEl(9), null);
});

test('113: a repaint swaps the mark, moves the active button and re-asserts the lock', () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.fn.renderRunSections();
  const li = h.node.runTests.querySelector('li.test-row');
  assert.equal(li.querySelector('.row-status').dataset.status, 'pending');
  h.state.records[0].status = 'passed';
  h.state.records[0].substatus = 'Flaky';
  h.fn.repaintRow(li, h.state.records[0]);
  assert.equal(li.querySelector('.row-status').dataset.status, 'passed');
  assert.equal(li.querySelector('.row-status').dataset.tip, 'passed · Flaky');
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.classList.contains('active')),
    [true, false, false]);
  assert.deepEqual(h.calls.decorated, ['1', '1']);
});

test('114: the suite fraction counts what is DONE in that suite, pending excluded', () => {
  const h = load({
    records: [rec(1, { suite_title: 'A', status: 'passed' }), rec(2, { suite_title: 'A' }),
      rec(3, { suite_title: 'B', status: 'failed' })],
  });
  h.fn.renderRunSections();
  assert.deepEqual(h.node.runTests.querySelectorAll('.suite-frac').map((f) => f.textContent), ['1/2', '1/1']);
  h.state.records[1].status = 'skipped';
  h.fn.refreshSuiteFraction(h.node.runTests.querySelector('li.test-row'));
  assert.deepEqual(h.node.runTests.querySelectorAll('.suite-frac').map((f) => f.textContent), ['2/2', '1/1']);
});

// ---------- the inline write (rows 40-44, 115-118) ----------

// A rendered checklist with one suite section, which is what writeRowStatus repaints into.
function written(opts = {}) {
  const h = load({ runStatus: 'running', records: [rec(1, { suite_title: 'A' }), rec(2, { suite_title: 'A' })], ...opts });
  h.fn.renderRunSections();
  h.fn.renderRunFilterChips();
  const li = h.node.runTests.querySelector('li[data-record-id="1"]');
  return { h, li, record: h.state.records[0], btn: (s) => li.querySelector(`.row-st[data-status="${s}"]`) };
}

test('40: clicking the status a row already carries writes nothing at all', async () => {
  const { h, li, record } = written();
  record.status = 'passed';
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.deepEqual(h.calls.writes, []);
  assert.equal(h.state.inlineWrites, 0);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [false, false, false]);
  // A DIFFERENT status does write, so the silence above is the guard and not a dead fixture.
  await h.fn.writeRowStatus(record, 'failed', li);
  assert.deepEqual(h.calls.writes, [{ id: 1, status: 'failed', comment: '' }]);
});

test('115: a row without a record is not written either', async () => {
  const { h, li } = written();
  await h.fn.writeRowStatus(null, 'passed', li);
  assert.deepEqual(h.calls.writes, []);
});

test('116: the row is claimed and the spinner painted in the click\'s own turn, before any await', () => {
  const { h, li, record, btn } = written();
  const pending = h.fn.writeRowStatus(record, 'passed', li); // deliberately not awaited yet
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [true, true, true],
    'a disabled button fires no second click');
  assert.ok(btn('passed').classList.contains('busy'));
  return pending;
});

test('42: a write that lands repaints the row, flashes it, then moves every counter — in that order', async () => {
  const { h, li, record, btn } = written();
  const mark = flashTarget(h, li);
  h.calls.order.length = 0;
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.deepEqual(h.calls.order, ['lock-read', 'write', 'lock-read', 'flash', 'progress', 'chips', 'lock-read']);
  assert.equal(li.querySelector('.row-status').dataset.status, 'passed');
  assert.ok(mark().classList.contains('saved-flash'));
  assert.deepEqual(h.clock.arms(), [1000], 'and it un-flashes a second later');
  assert.equal(h.fraction(), '1/2');
  assert.deepEqual(h.chipCounts(), ['2', '1', '0', '0', '1']);
  assert.equal(h.node.runTests.querySelector('.suite-frac').textContent, '1/2');
  assert.equal(h.state.inlineWrites, 0);
  assert.equal(btn('passed').classList.contains('busy'), false);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [false, false, false]);
});

test('43: a write that only QUEUED repaints the row but does not tell the tester it saved', async () => {
  const { h, li, record } = written();
  const mark = flashTarget(h, li);
  h.on.write = async () => ({ queued: true });
  h.calls.order.length = 0;
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.equal(li.querySelector('.row-status').dataset.status, 'passed', 'repainted');
  assert.deepEqual(h.calls.decorated.slice(-1), ['1'], 'and the queued marker re-applied');
  assert.equal(h.calls.order.includes('flash'), false);
  assert.equal(mark().classList.contains('saved-flash'), false);
  assert.deepEqual(h.clock.arms(), [], 'no un-flash timer either');
  // Row 42 flashed the identical badge on the identical row, so this absence is the `queued` branch.
});

test('44: a write that failed puts the record back and reports itself inline', async () => {
  const { h, li, record, btn } = written();
  h.on.write = async () => { throw Object.assign(new Error('boom'), { kind: 'http' }); };
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.equal(record.status, 'pending', 'restored from the snapshot taken before the write');
  assert.deepEqual(h.calls.apiErrors, [{ message: 'boom', id: 'run-status', opts: { inlineAuth: true } }]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Status not saved: boom', error: true }]);
  assert.equal(btn('passed').classList.contains('busy'), false);
  assert.deepEqual(li.querySelectorAll('.row-st').map((b) => b.disabled), [false, false, false]);
  assert.equal(h.state.inlineWrites, 0);
  // Object.assign is a MERGE: a key the write added is restored to nothing, it is not removed.
  assert.equal(record.message, '');
});

test('44a: an expired session is handled inline and NOT toasted a second time', async () => {
  const { h, li, record } = written();
  h.on.write = async () => { throw Object.assign(new Error('nope'), { kind: 'auth' }); };
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.equal(h.calls.apiErrors.length, 1);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(record.status, 'pending');
});

test('41: a lock that lands WHILE the probe is out stops the write it was waiting for', async () => {
  const h = load({ runStatus: 'running', holdSleep: true });
  const gate = deferred();
  h.on.projectInfo = () => gate.promise;     // the probe parks on the project read
  h.on.listTestruns = async () => [rec(1, { suite_title: 'A' })];
  await h.fn.openRunView('r1');              // …which is what arms runStateProbe
  const row = h.node.runTests.querySelector('li[data-record-id="1"]');
  const pending = h.fn.writeRowStatus(h.state.records[0], 'passed', row);
  await settle();
  assert.deepEqual(h.calls.writes, [], 'still waiting for the archived answer');
  h.state.runInfo = { isArchived: true };    // a colleague archives the run mid-probe
  gate.resolve();
  await pending;
  assert.deepEqual(h.calls.writes, [], 'and the write never goes out');
  assert.deepEqual(h.calls.toasts, [{ msg: ARCHIVED }]);
  assert.equal(h.node.runLockNote.textContent, ARCHIVED, 'the lock is force-painted');
  assert.equal(row.querySelector('.row-st[data-status="passed"]').classList.contains('busy'), false);
  assert.deepEqual(row.querySelectorAll('.row-st').map((b) => b.disabled), [true, true, true]);
});

test('41a: the same wait with no lock landing lets the write through — the probe is not a block', async () => {
  const h = load({ runStatus: 'running', holdSleep: true });
  const gate = deferred();
  h.on.projectInfo = () => gate.promise;
  h.on.listTestruns = async () => [rec(1, { suite_title: 'A' })];
  await h.fn.openRunView('r1');
  const row = h.node.runTests.querySelector('li[data-record-id="1"]');
  const pending = h.fn.writeRowStatus(h.state.records[0], 'passed', row);
  await settle();
  assert.deepEqual(h.calls.writes, []);
  gate.resolve();
  await pending;
  assert.deepEqual(h.calls.writes, [{ id: 1, status: 'passed', comment: '' }]);
  assert.deepEqual(h.calls.toasts, []);
});

test('117: a probe that HANGS is given up on after two seconds rather than parking the write', async () => {
  const h = load({ runStatus: 'running', holdSleep: true });
  h.on.projectInfo = () => new Promise(() => {});  // never answers
  h.on.listTestruns = async () => [rec(1, { suite_title: 'A' })];
  await h.fn.openRunView('r1');
  let done = false;
  const race = h.lex.awaitRunState().then(() => { done = true; });
  await settle();
  assert.equal(done, false, 'parked on the probe');
  assert.deepEqual(h.calls.sleeps.map((s) => s.ms), [h.lex.PROBE_WAIT_MS]);
  assert.equal(h.lex.PROBE_WAIT_MS, 2000);
  h.releaseSleeps();  // the 2000 ms give-up fires
  await race;
  assert.equal(done, true);
});

test('117a: with no probe out at all the write waits for nothing and arms no timer', async () => {
  const h = load({ runStatus: 'running', holdSleep: true });
  await h.lex.awaitRunState();
  assert.deepEqual(h.calls.sleeps, []);
});

test('117b: a probe that REJECTED is swallowed — the write goes on rather than throwing', async () => {
  const h = load({ runStatus: 'running' });
  h.on.projectInfo = async () => { throw new Error('probe died'); };
  h.on.listTestruns = async () => [rec(1, { suite_title: 'A' })];
  await h.fn.openRunView('r1');
  await assert.doesNotReject(() => h.lex.awaitRunState());
  const row = h.node.runTests.querySelector('li[data-record-id="1"]');
  await h.fn.writeRowStatus(h.state.records[0], 'passed', row);
  assert.deepEqual(h.calls.writes, [{ id: 1, status: 'passed', comment: '' }]);
});

test('118: with nothing pending, Finish waits for nobody', async () => {
  const h = load({ saving: false });
  await h.fn.settlePendingWrites();
  assert.deepEqual(h.calls.sleeps, []);
});

// ---------- opening a run (rows 54-60, 119-125) ----------

test('54: a failed meta read still paints the checklist, and says so above it', async () => {
  const h = load({ runTitle: '', records: [] });
  h.on.getRun = async () => { throw new Error('meta down'); };
  h.on.listTestruns = async () => [rec(1), rec(2)];
  await h.fn.openRunView('r1');
  assert.deepEqual(h.rowIds(), ['1', '2'], 'the essential leg carried the screen');
  assert.equal(h.node.runMetaNote.hidden, false);
  assert.equal(h.state.runTitle, 'Run');
  assert.equal(h.state.runStatus, null);
  assert.deepEqual(h.calls.apiErrors, []);
});

test('54a: a meta read that DID land hides the note and names the run', async () => {
  const h = load({ runTitle: '' });
  h.on.getRun = async () => ({ clean_title: 'Checkout', title: 'raw', status: 'running', kind: 'manual' });
  h.on.listTestruns = async () => [rec(1)];
  await h.fn.openRunView('r1');
  assert.equal(h.node.runMetaNote.hidden, true);
  assert.equal(h.state.runTitle, 'Checkout', 'clean_title first');
  assert.equal(h.state.runStatus, 'running');
  assert.equal(h.state.runKind, 'manual');
});

test('55: a failed checklist read is the one failure that stops the screen', async () => {
  const h = load({ runId: 'r0', records: [rec(9)] });
  h.on.listTestruns = async () => { throw new Error('list down'); };
  await h.fn.openRunView('r1');
  assert.deepEqual(h.calls.apiErrors, [{ message: 'list down', id: 'run-status', opts: undefined }]);
  assert.deepEqual(h.rowIds(), []);
  assert.deepEqual(h.state.records.map((r) => r.id), [9], 'the old records were never replaced');
  assert.equal(h.calls.liveSyncs, 0);
  assert.deepEqual(h.calls.skeleton, [['show', 'run'], ['hide', 'run']], 'and the placeholder came back off');
});

test('56: reopening the SAME run keeps the screen as the tester left it', async () => {
  const h = load({ runId: 'r1', records: [rec(1)], runFilter: 'failed', runSearch: 'check', expandedSuites: { A: false } });
  h.node.runSearch.value = 'check';
  h.on.listTestruns = async () => [rec(1), rec(2)];
  await h.fn.openRunView('r1');
  assert.deepEqual(h.calls.skeleton, [], 'no skeleton and no torn-down list');
  assert.equal(h.state.runFilter, 'failed');
  assert.equal(h.state.runSearch, 'check');
  assert.deepEqual(h.state.expandedSuites, { A: false });
  assert.equal(h.node.runSearch.value, 'check');
  assert.deepEqual(h.state.records.map((r) => r.id), [1, 2], 'and the re-read still landed');
});

test('57: opening a DIFFERENT run resets the filter, the search and the suite preferences', async () => {
  const h = load({ runId: 'r0', records: [rec(1)], runFilter: 'failed', runSearch: 'check', expandedSuites: { A: false } });
  h.node.runSearch.value = 'check';
  h.on.getRun = async () => ({});
  h.on.listTestruns = async () => [];
  await h.fn.openRunView('r2');
  assert.deepEqual(h.calls.skeleton, [['show', 'run'], ['hide', 'run']]);
  assert.equal(h.state.runFilter, 'all');
  assert.equal(h.state.runSearch, '');
  assert.deepEqual(plain(h.state.expandedSuites), {});
  assert.equal(h.node.runSearch.value, '');
  assert.equal(h.node.runInfo.hidden, true, 'and the previous run\'s card is gone');
  assert.equal(h.state.currentRecordId, null);
});

test('58: a run the tester left mid-flight is dropped before its records are written', async () => {
  const h = load({ runId: 'r1', records: [rec(9)] });
  h.on.listTestruns = async () => { h.state.runId = 'r2'; return [rec(1), rec(2)]; };
  await h.fn.openRunView('r1');
  assert.deepEqual(h.state.records.map((r) => r.id), [9]);
  assert.deepEqual(h.rowIds(), []);
  assert.equal(h.calls.liveSyncs, 0);
  assert.equal(h.calls.projectInfo, 0, 'and no state probe was armed for a run nobody is on');
});

test('59: a payload that says nothing about the custom counters must not blank them', () => {
  const h = load({ substatusCounts: { flaky: 2 } });
  h.fn.applyRunInfo({});
  assert.deepEqual(h.state.substatusCounts, { flaky: 2 });
  // One that DOES carry them replaces them, so the survival above is the guard talking.
  h.fn.applyRunInfo({ substatusCounts: { blocked: 1 } });
  assert.deepEqual(plain(h.state.substatusCounts), { blocked: 1 });
});

test('60: un-archiving is something the payload SAID — false lands, absent does not', () => {
  const h = load({ runInfo: { isArchived: true } });
  h.fn.applyRunInfo({});
  assert.equal(h.state.runInfo.isArchived, true, 'silence changes nothing');
  h.fn.applyRunInfo({ isArchived: false });
  assert.equal(h.state.runInfo.isArchived, false);
  assert.equal(h.fn.runWriteLock(), '');
});

test('60a: everything else on the payload is merged over the v2 base', () => {
  const h = load({ runInfo: { status: 'running', testsCount: 4 } });
  h.fn.applyRunInfo({ duration: 90, status: 'passed' });
  assert.deepEqual(plain(h.state.runInfo), { status: 'passed', testsCount: 4, duration: 90 });
});

test('119: a read-only project never opens the run at all — it is gated before any state is touched', async () => {
  const h = load({ gate: true, runId: 'r0', records: [rec(9)] });
  await h.fn.openRunView('r1', 'Checkout');
  assert.deepEqual(h.calls.shows, ['run']);
  assert.equal(h.state.runId, 'r0');
  assert.equal(h.state.runTitle, '');
  assert.deepEqual(h.calls.reads.testruns, []);
  // The same call with the gate open reads and opens, so the silence above is the lockout talking.
  const open = load({ gate: false, runId: 'r0' });
  open.on.listTestruns = async () => [rec(1)];
  open.on.getRun = async () => ({ title: 'Checkout run' });
  await open.fn.openRunView('r1', 'Checkout');
  assert.equal(open.state.runId, 'r1');
  // The passed-in title paints the header at once; the server's own replaces it a leg later.
  assert.equal(open.state.runTitle, 'Checkout run');
  assert.deepEqual(open.calls.reads.testruns, ['r1']);
});

test('120: a token-only panel makes no JSON:API reads on open, and the probe stops at the answer', async () => {
  const h = load({ jwt: false, jwtAvailable: false });
  h.on.listTestruns = async () => [rec(1)];
  await h.fn.openRunView('r1');
  await settle(4);
  assert.deepEqual(h.calls.reads.run, ['r1']);
  assert.deepEqual(h.calls.reads.info, []);
  assert.deepEqual(h.calls.reads.examples, []);
  assert.equal(h.sandbox.capabilities.jwt, false);
  assert.equal(h.calls.capabilities, 1, 'the panel is told what it may show');
  assert.equal(h.calls.projectUsers, 0, 'and the member read never runs');
});

test('120a: a session proven late reads the examples and the counters it could not read before', async () => {
  const h = load({ jwt: false, jwtAvailable: true, records: [] });
  h.on.listTestruns = async () => [rec(1, { suite_title: 'A' })];
  h.on.listTestrunExamples = async () => ({ 1: { values: ['ru'] } });
  h.on.getRunInfo = async () => ({ substatusCounts: { flaky: 1 }, duration: 90 });
  await h.fn.openRunView('r1');
  assert.deepEqual(h.calls.reads.examples, [], 'not on the open batch — the session was unproven');
  await settle(4);
  assert.equal(h.sandbox.capabilities.jwt, true);
  assert.deepEqual(h.calls.reads.examples, ['r1'], 'the probe went back for them');
  assert.deepEqual(h.calls.reads.info, ['r1']);
  assert.deepEqual(plain(h.state.substatusCounts), { flaky: 1 });
  assert.equal(h.node.runTests.querySelector('.example').textContent, 'ru');
  assert.equal(h.calls.projectUsers, 1);
});

test('121: opening a run restarts live sync, replays the queue and prunes the drafts it left behind', async () => {
  const h = load();
  h.on.listTestruns = async () => [rec(1)];
  await h.fn.openRunView('r1');
  assert.equal(h.calls.liveSyncs, 1);
  assert.equal(h.calls.replays, 1);
  assert.deepEqual(h.calls.prunes, ['r1']);
  assert.equal(h.calls.reads.suiteTree, 1);
  assert.ok(h.calls.contextBars >= 1, 'and the header is repainted with the real title');
});

test('122: the info read is best-effort — a session gate, a stale run and a failure all answer false', async () => {
  const basic = load({ jwt: false, runInfo: { status: 'running' } });
  assert.equal(await basic.fn.refreshRunInfo('r1'), false);
  assert.deepEqual(basic.calls.reads.info, []);

  const broken = load({ jwt: true });
  broken.on.getRunInfo = async () => { throw new Error('down'); };
  assert.equal(await broken.fn.refreshRunInfo('r1'), false);
  assert.deepEqual(plain(broken.state.runInfo), {}, 'the last painted values stand');

  const stale = load({ jwt: true });
  stale.on.getRunInfo = async () => { stale.state.runId = 'r2'; return { duration: 90 }; };
  assert.equal(await stale.fn.refreshRunInfo('r1'), false);
  assert.deepEqual(plain(stale.state.runInfo), {});

  const ok = load({ jwt: true });
  ok.on.getRunInfo = async () => ({ duration: 90 });
  assert.equal(await ok.fn.refreshRunInfo('r1'), true);
  assert.equal(ok.state.runInfo.duration, 90);
});

test('123: the example read answers true only when there is a chip to paint', async () => {
  const empty = load({ jwt: true });
  empty.on.listTestrunExamples = async () => ({});
  assert.equal(await empty.fn.refreshRunExamples('r1'), false);
  assert.deepEqual(plain(empty.state.runExamples), {}, 'but the map is still replaced');

  const full = load({ jwt: true, runExamples: { 9: { values: ['old'] } } });
  full.on.listTestrunExamples = async () => ({ 1: { values: ['ru'] } });
  assert.equal(await full.fn.refreshRunExamples('r1'), true);
  assert.deepEqual(plain(full.state.runExamples), { 1: { values: ['ru'] } });

  const broken = load({ jwt: true, runExamples: { 9: { values: ['old'] } } });
  broken.on.listTestrunExamples = async () => { throw new Error('down'); };
  assert.equal(await broken.fn.refreshRunExamples('r1'), false);
  assert.deepEqual(plain(broken.state.runExamples), { 9: { values: ['old'] } });

  const basic = load({ jwt: false });
  assert.equal(await basic.fn.refreshRunExamples('r1'), false);
  assert.deepEqual(basic.calls.reads.examples, []);
});

test('124: only a token-only panel re-reads v2 to learn a colleague finished the run', async () => {
  const full = load({ jwt: true, runStatus: 'running' });
  await full.fn.refreshRunFinished('r1');
  assert.deepEqual(full.calls.reads.run, [], 'the JSON:API read already tells it');

  const basic = load({ jwt: false, runStatus: 'running' });
  basic.on.getRun = async () => ({ status: 'finished', total_tests: 4 });
  await basic.fn.refreshRunFinished('r1');
  assert.equal(basic.state.runStatus, 'finished');
  assert.equal(basic.state.runInfo.testsCount, 4, 'and the v2 half of the card rides along');
  assert.equal(basic.fn.runWriteLock(), FINISHED);
});

test('124a: a failed or stale v2 re-read keeps what the panel had', async () => {
  const broken = load({ jwt: false, runStatus: 'running' });
  broken.on.getRun = async () => { throw new Error('down'); };
  await broken.fn.refreshRunFinished('r1');
  assert.equal(broken.state.runStatus, 'running');

  const stale = load({ jwt: false, runStatus: 'running' });
  stale.on.getRun = async () => { stale.state.runId = 'r2'; return { status: 'finished' }; };
  await stale.fn.refreshRunFinished('r1');
  assert.equal(stale.state.runStatus, 'running');

  const nothing = load({ jwt: false, runStatus: 'running' });
  nothing.on.getRun = async () => null;
  await nothing.fn.refreshRunFinished('r1');
  assert.equal(nothing.state.runStatus, 'running');
});

test('125: a failed example read leaves the rows bare rather than blanking the run', async () => {
  const h = load({ jwt: true });
  h.on.listTestruns = async () => [rec(1)];
  h.on.listTestrunExamples = async () => { throw new Error('down'); };
  await h.fn.openRunView('r1');
  assert.deepEqual(h.rowIds(), ['1']);
  assert.deepEqual(plain(h.state.runExamples), {});
  assert.equal(h.node.runTests.querySelector('.example'), null);
});

// ---------- sections and the two empty states (rows 61-63, 126-129) ----------

const twoSuites = () => [rec(1, { suite_title: 'A' }), rec(2, { suite_title: 'B', status: 'failed' })];

test('61: a filter overrides an explicit collapse — a matching suite may not hide its match', () => {
  const h = load({ records: twoSuites(), runFilter: 'failed', expandedSuites: { B: false } });
  h.fn.renderRunSections();
  const b = h.node.runTests.querySelector('[data-suite="B"]');
  assert.equal(b.classList.contains('collapsed'), false);
  // The identical preference with no filter on DOES collapse it.
  const quiet = load({ records: twoSuites(), runFilter: 'all', expandedSuites: { B: false } });
  quiet.fn.renderRunSections();
  assert.equal(quiet.node.runTests.querySelector('[data-suite="B"]').classList.contains('collapsed'), true);
});

test('61a: a search does the same as a filter, and whitespace alone does not', () => {
  const h = load({ records: twoSuites(), runSearch: 'test', expandedSuites: { A: false } });
  h.fn.renderRunSections();
  assert.equal(h.node.runTests.querySelector('[data-suite="A"]').classList.contains('collapsed'), false);
  const blank = load({ records: twoSuites(), runSearch: '   ', expandedSuites: { A: false } });
  blank.fn.renderRunSections();
  assert.equal(blank.node.runTests.querySelector('[data-suite="A"]').classList.contains('collapsed'), true);
});

test('126: a many-suite run opens collapsed; a lone suite opens itself', () => {
  const many = load({ records: twoSuites() });
  many.fn.renderRunSections();
  assert.deepEqual(many.node.runTests.querySelectorAll('.suite-section').map((s) => s.classList.contains('collapsed')),
    [true, true]);
  const one = load({ records: [rec(1, { suite_title: 'A' }), rec(2, { suite_title: 'A' })] });
  one.fn.renderRunSections();
  assert.equal(one.node.runTests.querySelector('.suite-section').classList.contains('collapsed'), false);
  // …and an explicit preference beats the lone-suite default in either direction.
  const shut = load({ records: [rec(1, { suite_title: 'A' })], expandedSuites: { A: false } });
  shut.fn.renderRunSections();
  assert.equal(shut.node.runTests.querySelector('.suite-section').classList.contains('collapsed'), true);
});

test('127: clicking a suite head folds it and remembers the choice for this run', () => {
  const h = load({ records: twoSuites() });
  h.fn.renderRunSections();
  const a = h.node.runTests.querySelector('[data-suite="A"]');
  assert.equal(a.classList.contains('collapsed'), true);
  fire(a.querySelector('.suite-head'), 'click');
  assert.equal(a.classList.contains('collapsed'), false);
  assert.equal(h.state.expandedSuites.A, true);
  fire(a.querySelector('.suite-head'), 'click');
  assert.equal(a.classList.contains('collapsed'), true);
  assert.equal(h.state.expandedSuites.A, false);
});

test('62: a constraint that matches nothing says so out loud, offering only the constraint that is on', () => {
  const search = load({ records: twoSuites(), runSearch: 'zzz' });
  search.fn.renderRunSections();
  assert.equal(search.emptyTitle(), 'No tests match');
  assert.equal(search.node.runTests.querySelector('.empty').getAttribute('role'), 'status');
  assert.equal(search.node.runTests.querySelector('.empty').dataset.icon, 'find_in_page');
  assert.deepEqual(search.emptyActions(), ['Clear search']);
  assert.equal(search.node.runTests.querySelector('.empty-text').textContent,
    'No test or suite title in this run matches what you typed.');

  const filtered = load({ records: twoSuites(), runFilter: 'skipped' });
  filtered.fn.renderRunSections();
  assert.equal(filtered.node.runTests.querySelector('.empty').dataset.icon, 'filter_list_off');
  assert.deepEqual(filtered.emptyActions(), ['Show all tests']);
  assert.equal(filtered.node.runTests.querySelector('.empty-text').textContent,
    'No test in this run carries that status.');

  const both = load({ records: twoSuites(), runFilter: 'skipped', runSearch: 'zzz' });
  both.fn.renderRunSections();
  assert.deepEqual(both.emptyActions(), ['Clear search', 'Show all tests']);
  assert.deepEqual(both.sectionKeys(), [], 'and no section is drawn beside the plaque');
});

test('62a: both offers actually undo their constraint', () => {
  const h = load({ records: twoSuites(), runFilter: 'skipped', runSearch: 'zzz' });
  h.node.runSearch.value = 'zzz';
  h.fn.renderRunSections();
  fire(h.node.runTests.querySelectorAll('.empty-actions > *')[0], 'click');
  assert.equal(h.state.runSearch, '');
  assert.equal(h.emptyTitle(), 'No tests match', 'the status filter is still on');
  fire(h.node.runTests.querySelectorAll('.empty-actions > *')[0], 'click');
  assert.equal(h.state.runFilter, 'all');
  assert.deepEqual(h.rowIds(), ['1', '2']);
  assert.equal(h.emptyTitle(), null);
});

test('63: an empty run offers the web app — but only when the panel knows where that is', () => {
  const h = load({ records: [], runId: 'r1', settings: { baseUrl: BASE, projectId: 'my project' } });
  h.fn.renderRunSections();
  assert.equal(h.emptyTitle(), 'No tests in this run');
  assert.equal(h.node.runTests.querySelector('.empty').dataset.icon, 'checklist');
  const link = h.node.runTests.querySelector('.empty-actions a');
  assert.equal(link.href, `${BASE}/projects/my%20project/runs/r1`);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.querySelector('span').textContent, 'Open in Testomat');
});

test('63a: no base URL, no project or no run id and the offer is simply absent', () => {
  for (const settings of [{}, { baseUrl: BASE }, { projectId: 'p' }]) {
    const h = load({ records: [], settings });
    h.fn.renderRunSections();
    assert.equal(h.emptyTitle(), 'No tests in this run');
    assert.deepEqual(h.emptyActions(), [], JSON.stringify(settings));
  }
  const noRun = load({ records: [], runId: null });
  noRun.fn.renderRunSections();
  assert.deepEqual(noRun.emptyActions(), []);
});

test('128: a suite section names itself, counts itself and carries only the rows that passed the filter', () => {
  const h = load({
    records: [rec(1, { suite_title: 'A', status: 'failed' }), rec(2, { suite_title: 'A' }),
      rec(3, { suite_title: 'B' })],
    runFilter: 'failed',
  });
  h.fn.renderRunSections();
  assert.deepEqual(h.sectionKeys(), ['A'], 'a section with no matching row is not drawn at all');
  assert.deepEqual(h.rowIds(), ['1']);
  // The fraction is over the WHOLE suite, not over what the filter left.
  assert.equal(h.node.runTests.querySelector('.suite-frac').textContent, '1/2');
  const head = h.node.runTests.querySelector('.suite-head');
  assert.deepEqual(head.querySelectorAll('.tree-icon').map((i) => i.className),
    ['tree-icon chevron', 'tree-icon file-icon']);
  assert.equal(h.node.runTests.querySelector('.suite-rows').className, 'suite-rows tree-children');
});

test('129: the status line is cleared on every rebuild — the plaque takes over the announcement', () => {
  const h = load({ records: twoSuites() });
  h.fn.renderRunSections();
  assert.deepEqual(h.calls.lines, [{ id: 'run-status', text: '', tone: undefined }]);
});

// ---------- two more greens the todos below lean on (130-131) ----------

test('130: every chip counts what its rows DISPLAY, and All is the whole run', () => {
  const h = load({
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'failed' }),
      rec(3, { status: 'skipped' }), rec(4, { status: 'pending' }), rec(5, { status: '' })],
  });
  const counts = plain(h.fn.runStatusCounts());
  assert.deepEqual(counts, { all: 5, passed: 1, failed: 1, skipped: 1, untested: 2 });
  assert.equal(counts.passed + counts.failed + counts.skipped + counts.untested, counts.all);
});

test('131: Finish waits while an inline write is still in flight, and goes on the moment it lands', async () => {
  const h = load({ holdSleep: true });
  h.state.inlineWrites = 1;
  const settling = h.fn.settlePendingWrites();
  await settle();
  assert.deepEqual(h.calls.sleeps.map((s) => s.ms), [25], 'it is waiting, not returning');
  h.state.inlineWrites = 0;
  h.releaseSleeps();
  await settling;
  assert.equal(h.calls.sleeps.length, 1, 'and it stops the moment the write lands');
});

// ---------- the bugs these tests found (rows 4, 45, 46, 47, 52, 53, 64, 65) ----------
// Five of them are fixed in this PR and read as rules; the three still deferred name their issue.

// 4 (#273): a running row used to be counted by nothing but All, so the chips summed to less than
// the total and no chip could show that row. It counts as Pending now — it has no result yet.
test('4 (#273): the status chips add up to the All chip, running rows included', () => {
  const h = load({
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'failed' }),
      rec(3, { status: 'pending' }), rec(4, { status: 'running' })],
  });
  const c = plain(h.fn.runStatusCounts());
  assert.equal(c.passed + c.failed + c.skipped + c.untested, c.all);
  assert.equal(c.untested, 2); // the pending one and the running one
  // …and the chip that counts it can also SHOW it, which is the half a count alone would not prove.
  h.state.runFilter = 'untested';
  assert.deepEqual(h.state.records.filter(h.lex.matchesRunFilter).map((r) => String(r.id)), ['3', '4']);
});

// 45 (#274): the flash looked for a `.badge`, which a run row never carries — the only one that ever
// appears is the queue's «queued» marker, and that is the case the caller skips. It lands on the
// row's own status mark now, so every saved row is confirmed.
test('45 (#274): a row the tester just marked flashes to say it saved', async () => {
  const { h, li, record } = written();
  await h.fn.writeRowStatus(record, 'passed', li);
  assert.ok(li.querySelector('.saved-flash'), 'nothing on the row was flashed');

  // A write that only QUEUED is still not a save, so it is still not flashed.
  const queued = written();
  queued.h.on.write = async () => ({ queued: true });
  await queued.h.fn.writeRowStatus(queued.record, 'passed', queued.li);
  assert.equal(queued.li.querySelector('.saved-flash'), null);
});

// 46: STATUS_ICON.skipped and NEUTRAL_ICON are the same glyph, so skipped and pending differ by
// colour alone — unreadable to a colour-blind tester and invisible in a greyscale screenshot.
test.todo('46 (#115): skipped and pending are told apart by their shape, not only their colour', () => {
  const h = load();
  assert.notEqual(h.fn.statusIcon('skipped').dataset.icon, h.fn.statusIcon('pending').dataset.icon);
});

// 47 (#275): updateRunActions compared state.runStatus to 'running' literally while the rest of the
// file folds launching into running, so the pill named the state and Finish was simply absent.
test('47 (#275): a launching run is a running run, and can be finished', () => {
  const h = load({ runStatus: 'launching', jwtAvailable: true });
  h.fn.paintRunState();
  assert.equal(h.node.runState.textContent, 'launching');
  h.fn.updateRunActions();
  assert.equal(h.node.btnFinishRun.hidden, false);

  // A finished run is still not offered it, so the row above is not asserting a button always shown.
  const done = load({ runStatus: 'finished', jwtAvailable: true });
  done.fn.updateRunActions();
  assert.equal(done.node.btnFinishRun.hidden, true);
});

// 52 (#276): the wait still gives up after 200 × 25 ms, but it now SAYS so — a finished run takes no
// more writes, so closing the run over a save still in flight lost the result the tester had marked.
test('52 (#276): a save still in flight stops the finish instead of being closed over', async () => {
  const stuck = load({ saving: true });
  assert.equal(await stuck.fn.settlePendingWrites(), false,
    `gave up after ${stuck.calls.sleeps.length} × 25 ms and said so`);

  // Nothing pending: it answers true, so the false above is a report and not a constant.
  const clear = load();
  assert.equal(await clear.fn.settlePendingWrites(), true);
  assert.equal(clear.calls.sleeps.length, 0);
});

// 53: three copies of `(a, b) => a.id > b.id ? 1 : -1` compare ids as TEXT (run-view.js:182 and
// :451, screens/livesync.js:80), so a run past its ninth record lists 10 before 9.
test.todo("53 (#258): record ids sort numerically whatever their type — '9' before '10'", async () => {
  const h = load({ runId: 'r0' });
  h.on.listTestruns = async () => [rec('9'), rec('10')];
  await h.fn.openRunView('r1');
  assert.deepEqual([...h.state.records].map((r) => r.id), ['9', '10']);
});

// 64: testRow (1107-1127) and the suiteSection head (1239-1266) carry a click listener and nothing
// else — no tabindex, no role, no keydown — so the whole checklist is unreachable by keyboard.
test.todo('64 (#109): a test row and a suite head can be reached and opened from the keyboard', () => {
  const h = load({ records: [rec(1, { suite_title: 'A' })] });
  h.fn.renderRunSections();
  const li = h.node.runTests.querySelector('li.test-row');
  const head = h.node.runTests.querySelector('.suite-head');
  assert.equal(li.listeners.has('click'), true, 'the mouse path is wired');   // green today
  // Today: no tabindex, no role and no keydown on either.
  assert.notEqual(li.getAttribute('tabindex'), null);
  assert.equal(li.listeners.has('keydown'), true);
  assert.notEqual(head.getAttribute('tabindex'), null);
  assert.equal(head.listeners.has('keydown'), true);
});

// 65 (#277): onRunSearch rebuilt every section on every keystroke — five characters typed into a
// 400-row run was five full rebuilds. The redraw waits for the typing to stop; the clear button,
// which is cheap, does not.
test('65 (#277): typing into the search does not rebuild the whole list per keystroke', async () => {
  const h = load({ records: Array.from({ length: 400 }, (_, i) => rec(i + 1, { suite_title: 'A' })) });
  h.calls.order.length = 0;
  const rebuilds = () => h.calls.order.filter((s) => s === 'sections').length;
  for (const q of ['c', 'ch', 'che', 'chec', 'check']) {
    h.node.runSearch.value = q;
    h.fn.onRunSearch();
    assert.equal(h.node.runSearchClear.hidden, false); // the cheap half stays immediate
  }
  assert.equal(rebuilds(), 0, 'nothing is redrawn while the tester is still typing');

  await h.clock.tick(); // …and once they stop, the list is rebuilt ONCE for all five keystrokes
  assert.equal(rebuilds(), 1);
  assert.deepEqual(h.clock.arms(), [250, 250, 250, 250, 250], 'each keystroke re-armed the one timer');
});
