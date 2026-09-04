#!/usr/bin/env node
// The contract of extension/editor/rec-session.js (#192): what the recorder writes into the body,
// the order it talks to the worker in, and what the AI polish may and may not overwrite.
// Cases numbered as in #192. Run: node --test tests/rec-session.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// RECSESS_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.RECSESS_SRC || join(repoRoot, 'extension/editor/rec-session.js');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// md-sections.js and rec-format.js are the REAL files, evaluated into the same context
// editor.html loads them into. They are what cases 72-73 are about — a stub of the section
// arithmetic is exactly the thing that could not prove the tester's own markdown survives.
const REAL = ['extension/editor/md-sections.js', 'extension/editor/rec-format.js'];
const SOURCE = [...REAL.map(read), readFileSync(SRC, 'utf8'), 'RecSession;'].join('\n');

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The 500ms poll and the 30s polish deadline are both the point of a case below, so the sandbox
// gets its own clock: nothing fires by itself, and `fireTimeouts()` is the deadline going off.
function makeClock() {
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    fireTimeouts: () => { const all = [...timeouts.values()]; timeouts.clear(); all.forEach((t) => t.fn()); },
    intervals: () => [...intervals.values()].map((i) => i.ms),
  };
}

// One sandbox and one session per case: the session keeps every rec* field, and a shared one would
// let a case read the recording the previous one left behind.
function open({
  body = '# T\n',
  title = 'A test',
  jwt = true,
  access = { ok: true },
  startResp = { ok: true },
  local = {},
  testUid = 't1',
  recorded = null,
  caret = null,
} = {}) {
  const clock = makeClock();
  const state = { body };
  const toasts = [];
  const sent = [];        // every message type, in the order it went out — case 86 is this list
  const recViews = [];
  const polishViews = [];
  const rowHidden = [];
  const switchOn = [];
  const edits = [];
  const caretSet = [];
  const localSets = [];
  const apiCalls = [];
  const stored = { ...local };
  const pulls = [];       // queued STEPREC_PULL answers
  const stops = [];       // queued STEPREC_STOP answers
  let answerPolish = () => Promise.resolve({});

  const caretEl = caret === null ? null : {
    selectionStart: caret,
    setSelectionRange: (a, b) => caretSet.push([a, b]),
  };

  const chrome = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg.type);
        if (msg.type === 'STEPREC_START') return Promise.resolve(startResp);
        if (msg.type === 'STEPREC_PULL') return Promise.resolve(pulls.length ? pulls.shift() : null);
        if (msg.type === 'STEPREC_STOP') return Promise.resolve(stops.length ? stops.shift() : { entries: [] });
        return Promise.resolve({});
      },
    },
    storage: {
      local: {
        get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
        set: (obj) => { localSets.push(obj); Object.assign(stored, obj); },
      },
    },
  };

  const ctx = createContext({
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    // The bare global shared/site-access.js publishes; the editor page reaches it the same way.
    ensureSiteAccess: async () => access,
  });
  const { createRecSession } = runInContext(SOURCE, ctx);

  const session = createRecSession({
    editor: { getValue: () => state.body, setValue: (md) => { state.body = md; } },
    getTitle: () => title,
    showToast: (msg, o) => toasts.push({ msg, error: !!(o && o.error) }),
    api: {
      jwtAvailable: () => jwt,
      polishRecordedSteps: (msg, uid) => { apiCalls.push([msg, uid]); return answerPolish(); },
    },
    chrome,
    testUid,
    recorded,
    onPersist: () => { edits.push('persist'); },
    ui: {
      rec: (v) => recViews.push(plain(v)),
      polish: (v) => polishViews.push(plain(v)),
      polishRow: (hidden) => rowHidden.push(hidden),
      polishSwitch: (on) => switchOn.push(on),
      caret: () => caretEl,
      edited: (md) => edits.push(md),
    },
  });

  return {
    session, clock, toasts, sent, recViews, polishViews, rowHidden, switchOn, edits, caretSet,
    localSets, apiCalls, stored,
    body: () => state.body,
    setBody: (md) => { state.body = md; }, // the tester typing in the editor, not us
    pull: (answer) => pulls.push(answer),
    stopWith: (answer) => stops.push(answer),
    answerWith: (fn) => { answerPolish = fn; },
    lastRec: () => recViews[recViews.length - 1],
    lastPolish: () => polishViews[polishViews.length - 1],
    toastText: () => toasts.map((t) => t.msg),
  };
}

const step = (text, ctx = null) => ({ kind: 'step', text, ctx });

// A recording that really went through the worker. The polish cases all start here: `written` has
// to match the body byte for byte, or `replaceItems` treats every item as hand-edited and skips it.
async function record(env, texts, over = {}) {
  await env.session.start();
  const entries = texts.map((t) => (typeof t === 'string' ? step(t) : t));
  env.pull({ recording: true, count: texts.length, entries, ...over });
  await env.session.poll();
}
async function recordAndStop(env, texts) {
  await record(env, texts);
  await env.session.finish();
}

const POLISHED = (...lines) => ({
  steps: `<!-- ![START polished_steps]! -->\n${lines.join('\n')}\n<!-- ![END polished_steps]! -->`,
});

// ---- 72-73: what the tester wrote is never re-emitted (D P0-1, fixed in #136) ----

test('72: a bullet-list Steps section keeps its bullets and takes the recorded step as a third', async () => {
  const env = open({ body: '# T\n\n### Steps\n\n- open the app\n- log in\n' });
  await record(env, ['Click Save']);
  assert.equal(env.body(), '# T\n\n### Steps\n\n- open the app\n- log in\n- Click Save\n');
});

test('73: prose, a fence and an image in Steps all survive, and the step lands after them', async () => {
  const body = '# T\n\n### Steps\n\nSome prose about the setup.\n\n```js\nconst a = 1;\n```\n\n![shot](x.png)\n';
  const env = open({ body });
  await record(env, ['Click Save']);
  assert.equal(env.body(), `${body}\n1. Click Save\n`);
  // Byte for byte: the fence and the image reference are the tester's, not ours to re-render.
  assert.ok(env.body().startsWith(body));
});

// ---- 74-77: where a recording's items are, and the body write that puts them there ----

test('74: the first insert pins recStart at the item count BEFORE it, and both inserted flags flip', async () => {
  const env = open({ body: '# T\n\n### Steps\n\n1. by hand one\n2. by hand two\n' });
  await record(env, ['Click Save']);
  const d = env.session.draftShape();
  assert.equal(d.start, 2);  // two items were already there
  assert.equal(d.count, 1);
  // recStepInserted: the next expected-only batch attaches to the step, instead of opening
  // its own `### Expected` section.
  env.pull({ recording: true, count: 2, entries: [{ kind: 'expected', text: 'a toast' }] });
  await env.session.poll();
  assert.ok(env.body().includes('3. Click Save\n   - Expected: a toast'));
  assert.ok(!env.body().includes('### Expected'));
  // recAnyInserted: Stop with an empty drain still knows this recording produced something.
  await env.session.finish();
  assert.ok(!env.toastText().includes('No steps recorded'));
});

test('75: an expected result with no step of its own opens `### Expected` and starts no recording', async () => {
  const env = open({ body: '# T\n' });
  await env.session.start();
  env.pull({ recording: true, count: 1, entries: [{ kind: 'expected', text: 'ok' }] });
  await env.session.poll();
  assert.equal(env.body(), '# T\n\n### Expected\n\n- ok');
  assert.equal(env.session.draftShape().start, -1);
  assert.equal(env.session.hasRecording(), false);
  // …so there is nothing for the polish button to act on, switch on or not.
  env.session.setPolishOn(true);
  assert.equal(env.lastPolish().hidden, true);
});

test('76: a hand-deleted step is read back off the body, so the span shrinks with it', async () => {
  const env = open({ body: '# T\n\n### Steps\n\n1. by hand\n' });
  await record(env, ['A', 'B', 'C']);
  assert.deepEqual(plain(env.session.draftShape()).rawItems.map((i) => i.text), ['A', 'B', 'C']);
  // The tester deletes B and C by hand — the module only re-reads behind its own next insert.
  env.setBody('# T\n\n### Steps\n\n1. by hand\n2. A\n');
  env.pull({ recording: true, count: 4, entries: [step('D')] });
  await env.session.poll();
  const d = plain(env.session.draftShape());
  assert.equal(d.start, 1);
  assert.equal(d.count, 2);
  assert.deepEqual(d.rawItems.map((i) => i.text), ['A', 'D']);
});

test('77: a live insert puts the caret back where the tester left it', async () => {
  const env = open({ body: '# T\n', caret: 4 });
  await record(env, ['Click Save']);
  assert.deepEqual(env.caretSet, [[4, 4]]);
  // …and with the caret elsewhere on the page there is nothing to restore.
  const away = open({ body: '# T\n' });
  await record(away, ['Click Save']);
  assert.deepEqual(away.caretSet, []);
  // Either way the body change is announced once, so the preview and the draft both follow.
  assert.ok(away.edits.includes(away.body()));
});

// ---- 78-81: the record button's words. The module decides them; renderEditor paints them ----

test('78: while polishing the record button says so, is disabled, and hides Continue', async () => {
  const env = open({ recorded: null });
  await recordAndStop(env, ['A']);
  env.answerWith(() => new Promise(() => {})); // a request that never comes back
  const p = env.session.polish();
  assert.deepEqual(env.lastRec(), {
    label: 'Polishing…',
    tip: 'Testomat AI is rewriting the steps you just recorded',
    disabled: true,
    active: false,
    continueHidden: true,
  });
  env.session.setPolishTimeout(1);
  env.clock.fireTimeouts();
  await p;
});

test('79: recording, not paused, not blind — `Stop recording (12)`', async () => {
  const env = open();
  await env.session.start();
  env.pull({ recording: true, count: 12, paused: false, blind: false, manualPause: false });
  await env.session.poll();
  assert.deepEqual(env.lastRec(), {
    label: 'Stop recording (12)',
    tip: 'Stop recording — the steps go into this test',
    disabled: false,
    active: true,
    continueHidden: true,
  });
});

test('80: a pause from the page indicator keeps Continue hidden — Resume is on the page', async () => {
  const env = open();
  await env.session.start();
  env.pull({ recording: true, count: 12, paused: false, blind: false, manualPause: true });
  await env.session.poll();
  const v = env.lastRec();
  assert.equal(v.label, 'Stop recording (12) — paused');
  assert.equal(v.continueHidden, true);
  assert.equal(v.tip, 'Paused from the page indicator — click Resume there to carry on recording.');
});

test('81: blind AND at the cap — the warning wins the label, and Continue stays reachable', async () => {
  const env = open();
  await env.session.start();
  env.pull({ recording: true, count: 12, paused: true, blind: true, manualPause: false });
  await env.session.poll();
  const v = env.lastRec();
  assert.equal(v.label, 'Stop (12) — page not recordable');
  assert.equal(v.continueHidden, false); // both blockers can clear in any order
  assert.ok(v.tip.startsWith('Chrome doesn’t allow extensions on this page'));
});

// ---- 82-88: the worker transport ----

test('82: the blind warning is toasted once per blind stretch, not once per poll', async () => {
  const env = open();
  await env.session.start();
  env.pull({ recording: true, count: 1, blind: true });
  env.pull({ recording: true, count: 1, blind: true });
  await env.session.poll();
  await env.session.poll();
  const blind = env.toastText().filter((m) => m.startsWith('Chrome doesn’t allow extensions'));
  assert.equal(blind.length, 1);
  // …and it comes back when the recorder goes blind a second time.
  env.pull({ recording: true, count: 1, blind: false });
  env.pull({ recording: true, count: 1, blind: true });
  await env.session.poll();
  await env.session.poll();
  assert.equal(env.toastText().filter((m) => m.startsWith('Chrome doesn’t allow extensions')).length, 2);
});

test('83: a recording stopped on the page finishes through the exclusive lane, and inserts once', async () => {
  const env = open();
  await env.session.start();
  env.pull({ recording: false, count: 1, entries: [step('Click Save')] });
  await env.session.poll();
  assert.equal(env.session.isBusy(), true); // the drain is out, Save has one promise to wait on
  await env.session.settle();
  assert.equal(env.session.isRecording(), false);
  assert.equal(env.session.draftShape().count, 1);
  assert.equal((env.body().match(/Click Save/g) || []).length, 1);
  // The poll returned at the stop — it did not also repaint the button with the stale count.
  assert.equal(env.lastRec().label, 'Record steps');
});

test('84: a Stop click racing the poll drains exactly once', async () => {
  const env = open();
  await record(env, ['A']);
  env.sent.length = 0;
  await Promise.all([env.session.finish(), env.session.finish()]);
  assert.deepEqual(env.sent, ['STEPREC_FLUSH', 'STEPREC_STOP']);
});

test('85: Stop with nothing recorded says so', async () => {
  const env = open();
  await env.session.start();
  await env.session.finish();
  assert.ok(env.toastText().includes('No steps recorded'));
});

test('86: FLUSH goes out BEFORE STOP, so the field under the caret still becomes a step', async () => {
  const env = open();
  await env.session.start();
  env.sent.length = 0;
  env.stopWith({ entries: [step('Fill Email with "a@b.c"')] });
  await env.session.finish();
  assert.deepEqual(env.sent, ['STEPREC_FLUSH', 'STEPREC_STOP']);
  assert.ok(env.body().includes('Fill Email'));
});

test('87: a page the extension may not touch is said out loud and arms no poll', async () => {
  const env = open({ access: { ok: false, error: 'Chrome keeps extensions off this page' } });
  await env.session.start();
  assert.deepEqual(env.toastText(), ['Chrome keeps extensions off this page']);
  assert.equal(env.session.isRecording(), false);
  assert.deepEqual(env.clock.intervals(), []);
  assert.deepEqual(env.sent, []); // the worker is never asked to start one
});

test('88: a new recording replaces the polished one this editor was holding, field by field', async () => {
  const env = open({
    body: '# T\n\n### Steps\n\n1. old polished\n',
    recorded: {
      entries: [step('old')], start: 0, count: 1, polished: true,
      rawItems: [{ text: 'old raw', subs: [] }], polishedItems: [{ text: 'old polished', subs: [] }],
    },
  });
  assert.equal(env.session.hasRecording(), true);
  await env.session.start();
  assert.deepEqual(plain(env.session.draftShape()), {
    entries: [], start: -1, count: 0, polished: false, rawItems: [], polishedItems: [],
  });
  assert.equal(env.session.isPolished(), false);
  assert.deepEqual(env.clock.intervals(), [500]);
});

// ---- 89: one lane, so Save and a leave have exactly one promise to wait on ----

test('89: the second job waits for the first to settle, even when the first rejects', async () => {
  const env = open();
  const order = [];
  let releaseA;
  const gate = new Promise((r) => { releaseA = r; });
  const a = env.session.runExclusive(async () => {
    order.push('a-start');
    await gate;
    order.push('a-end');
    throw new Error('a failed');
  });
  a.catch(() => {});
  const b = env.session.runExclusive(async () => { order.push('b-start'); });
  assert.deepEqual(order, ['a-start']);
  releaseA();
  await b;
  await env.session.settle();
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
  assert.equal(env.session.isBusy(), false);
});

// ---- 90-96: the polish round trip ----

test('90: a model that never answers loses to the deadline, and the raw steps stand', async () => {
  const env = open();
  await recordAndStop(env, ['Click Save']);
  const before = env.body();
  env.answerWith(() => new Promise(() => {}));
  env.session.setPolishTimeout(50);
  const p = env.session.polish();
  env.clock.fireTimeouts();
  await p;
  assert.ok(env.toastText().includes('Couldn’t polish — raw steps kept (timed out)'));
  assert.equal(env.body(), before);
  assert.equal(env.session.isPolished(), false);
});

test('91: 401/403 or an auth refusal switches polishing off for this server', async () => {
  for (const err of [{ status: 401 }, { status: 403 }, { kind: 'auth' }]) {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    env.localSets.length = 0;
    env.answerWith(() => Promise.reject(err));
    await env.session.polish();
    assert.ok(env.toastText().includes('Polishing isn’t enabled on this server yet'));
    assert.equal(env.switchOn[env.switchOn.length - 1], false);
    assert.equal(env.rowHidden[env.rowHidden.length - 1], true);
    assert.deepEqual(plain(env.localSets), [{ polishSteps: false }]);
    assert.equal(env.session.polishOn(), false);
  }
});

test('92: a 422 is the server explaining itself — its sentence, not ours', async () => {
  const env = open();
  await recordAndStop(env, ['Click Save']);
  env.answerWith(() => Promise.reject({
    status: 422, message: '{"error":"Ai is not available in your subscription plan"}',
  }));
  await env.session.polish();
  assert.ok(env.toastText().includes('Ai is not available in your subscription plan'));
  assert.equal(env.rowHidden.length, 0); // a plan limit is not a reason to hide the switch
});

test('93: an answer with no numbered items is a failure, not an empty rewrite', async () => {
  const env = open();
  await recordAndStop(env, ['Click Save']);
  const before = env.body();
  env.answerWith(() => Promise.resolve({ steps: 'Sure! Here is what I would write.' }));
  await env.session.polish();
  assert.ok(env.toastText().includes('Couldn’t polish — raw steps kept (nothing came back)'));
  assert.equal(env.body(), before);
});

test('94: a polish keeps the recorder\'s own texts, so Undo has somewhere to go back to', async () => {
  const env = open();
  await recordAndStop(env, ['Click the Save button', 'Type admin into Login']);
  env.answerWith(() => Promise.resolve(POLISHED('1. Save the form', '2. Sign in as admin')));
  await env.session.polish();
  const d = plain(env.session.draftShape());
  assert.deepEqual(d.rawItems.map((i) => i.text), ['Click the Save button', 'Type admin into Login']);
  assert.deepEqual(d.polishedItems.map((i) => i.text), ['Save the form', 'Sign in as admin']);
  assert.equal(d.polished, true);
  assert.ok(env.toastText().includes('Steps polished ✓'));
  assert.ok(env.body().includes('1. Save the form'));
  assert.ok(env.body().includes('2. Sign in as admin'));
  assert.equal(env.apiCalls[0][1], 't1'); // editing, so the request names the test
  // …and Undo puts the recorder's sentences back, word for word.
  env.session.undo();
  assert.ok(env.body().includes('1. Click the Save button'));
  assert.equal(env.session.isPolished(), false);
});

// D P2-10, still open — the todo is the INTENDED behaviour, not today's.
test.todo('95: TODO undo with every step hand-edited should say so instead of silently relabelling', async () => {
  const env = open();
  await recordAndStop(env, ['Click the Save button']);
  env.answerWith(() => Promise.resolve(POLISHED('1. Save the form')));
  await env.session.polish();
  env.setBody(env.body().replace('1. Save the form', '1. My own words'));
  const before = env.body();
  env.session.undo();
  assert.equal(env.body(), before); // nothing was put back — and today nothing says so
  assert.ok(env.toastText().includes('Nothing to put back — these steps were edited by hand'));
});

// D P2-11, still open (same issue as 95).
test.todo('96: TODO polish → undo → polish → undo must still reach the recorder\'s original wording', async () => {
  const env = open();
  await recordAndStop(env, ['Click the Save button', 'Type admin into Login']);
  env.answerWith(() => Promise.resolve(POLISHED('1. Save the form', '2. Sign in as admin')));
  await env.session.polish();
  // The tester rewrites one of the two polished steps by hand, then undoes the polish.
  env.setBody(env.body().replace('2. Sign in as admin', '2. Log in as the admin user'));
  env.session.undo();
  // `recRawItems` is now what the BODY holds, so step 2's recorded sentence is already gone.
  assert.deepEqual(
    plain(env.session.draftShape()).rawItems.map((i) => i.text),
    ['Click the Save button', 'Type admin into Login'],
  );
  await env.session.polish();
  env.session.undo();
  assert.ok(env.body().includes('Type admin into Login'));
});

// ---- 97-101: the prompt that goes out ----

test('97: steps written before the recording are listed as context, and the recording starts at 1', async () => {
  const env = open({ body: '# T\n\n### Steps\n\n1. by hand one\n2. by hand two\n', title: '  Sign\nin  ' });
  await recordAndStop(env, ['Click Save']);
  env.answerWith(() => Promise.resolve({}));
  await env.session.polish();
  const msg = env.apiCalls[0][0];
  const lines = msg.split('\n');
  assert.equal(lines[0], 'TEST: Sign in'); // the title is one line, whatever was pasted into it
  const at = lines.indexOf('EXISTING STEPS (written before the recording — keep their wording, do not repeat them):');
  assert.ok(at > -1);
  assert.deepEqual(lines.slice(at + 1, at + 3), ['1. by hand one', '2. by hand two']);
  assert.equal(lines[at + 3], 'RECORDED ACTIONS:');
  assert.equal(lines[at + 4], '1. raw: Click Save');
});

test('98: every value is one quoted line, and a masked one is marked', async () => {
  const env = open();
  await recordAndStop(env, [step('Fill Email', {
    action: 'fill',
    element: { tag: 'input', text: 'He said "hi"\n  and left' },
    value: { text: 'line one\nline two', masked: true },
  })]);
  env.answerWith(() => Promise.resolve({}));
  await env.session.polish();
  const msg = env.apiCalls[0][0];
  assert.ok(msg.includes('text="He said \\"hi\\" and left"'));
  assert.ok(msg.includes('   value: "line one line two" (masked)'));
});

test('99: a manual note folds onto the step it followed, and a second one joins it with `;`', async () => {
  const env = open();
  await recordAndStop(env, [
    step('Click Save'),
    { kind: 'expected', text: 'a toast shows', manual: true },
    { kind: 'expected', text: 'the row turns green', manual: true },
    step('Click Close'),
    { kind: 'expected', text: 'recorded, not written by hand' }, // no `manual` — no note
  ]);
  env.answerWith(() => Promise.resolve({}));
  await env.session.polish();
  const lines = env.apiCalls[0][0].split('\n');
  assert.ok(lines.includes('   note: a toast shows; the row turns green'));
  assert.equal(lines.filter((l) => l.startsWith('   note:')).length, 1);
  assert.ok(lines.includes('1. raw: Click Save'));
  assert.ok(lines.includes('2. raw: Click Close'));
});

test('100: the Open step is the only place a url is written down — and it arrives already trimmed', async () => {
  const env = open();
  await recordAndStop(env, [step('Open https://x.io/reset'), step('Click Save')]);
  env.answerWith(() => Promise.resolve({}));
  await env.session.polish();
  const msg = env.apiCalls[0][0];
  assert.ok(msg.includes('after: url="https://x.io/reset"'));
  assert.ok(!msg.includes('token='));
  // A P0-1: the trim itself is NOT here. `srOpenUrl` (shared/step-rec-core.js, #116) does it in
  // the worker, and this line is only as safe as the sentence it is handed.
  const leak = open();
  await recordAndStop(leak, [step('Open https://x.io/reset?token=abc#f')]);
  leak.answerWith(() => Promise.resolve({}));
  await leak.session.polish();
  assert.ok(leak.apiCalls[0][0].includes('after: url="https://x.io/reset?token=abc#f"'));
});

test('101: no packet carried a page, so the prompt has no PAGE line to write', async () => {
  const env = open();
  await recordAndStop(env, [step('Click Save', { action: 'click' })]);
  env.answerWith(() => Promise.resolve({}));
  await env.session.polish();
  assert.ok(!env.apiCalls[0][0].includes('PAGE:'));
  // …and one that did carry a page puts it on line two.
  const withPage = open();
  await recordAndStop(withPage, [step('Click Save', { action: 'click', page: { title: 'Login', url: 'https://x.io/in' } })]);
  withPage.answerWith(() => Promise.resolve({}));
  await withPage.session.polish();
  assert.equal(withPage.apiCalls[0][0].split('\n')[1], 'PAGE: Login | https://x.io/in');
});

// ---- 102: the polish button is offered in exactly one situation ----

test('102: six ways the polish button is not offered, and the two words it wears when it is', async () => {
  // The shown case first, so each leg below is the same session minus one condition.
  {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    assert.deepEqual(env.lastPolish(), {
      hidden: false,
      label: 'Polish recorded steps',
      tip: 'Rewrite the steps you recorded with your Testomat.io AI',
    });
    env.answerWith(() => Promise.resolve(POLISHED('1. Save the form')));
    await env.session.polish();
    assert.equal(env.lastPolish().label, 'Undo polish'); // …iff recPolished
    assert.equal(env.lastPolish().tip, 'Put the recorded steps back the way they were recorded');
    env.session.undo();
    assert.equal(env.lastPolish().label, 'Polish recorded steps');
  }
  // 1: nothing recorded yet.
  {
    const env = open();
    env.session.setPolishOn(true);
    assert.equal(env.lastPolish().hidden, true);
  }
  // 2: the switch is off.
  {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(false);
    assert.equal(env.lastPolish().hidden, true);
  }
  // 3: basic mode — no session to ask, so the row is not offered at all.
  {
    const env = open({ jwt: false });
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    env.session.syncPolishVisible();
    assert.equal(env.rowHidden[env.rowHidden.length - 1], true);
    assert.equal(env.lastPolish().hidden, true);
  }
  // 4: a recording is running — Stop first.
  {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    await env.session.start();
    assert.equal(env.lastPolish().hidden, true);
  }
  // 5: a request is already out.
  {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    env.answerWith(() => new Promise(() => {}));
    const p = env.session.polish();
    assert.equal(env.lastPolish().hidden, true);
    env.session.setPolishTimeout(1);
    env.clock.fireTimeouts();
    await p;
  }
  // 6: saved — the read-only view has taken the page over.
  {
    const env = open();
    await recordAndStop(env, ['Click Save']);
    env.session.setPolishOn(true);
    env.session.handOver();
    env.session.syncPolishVisible();
    assert.equal(env.lastPolish().hidden, true);
  }
});

// ---- the pref the switch remembers, read once when the editor opens ----

test('the polish switch comes back the way it was left, off by default', async () => {
  const on = open({ local: { polishSteps: true } });
  await on.session.loadPolishPref();
  assert.equal(on.session.polishOn(), true);
  assert.equal(on.switchOn[on.switchOn.length - 1], true);

  const off = open();
  await off.session.loadPolishPref();
  assert.equal(off.session.polishOn(), false);
});
