#!/usr/bin/env node
// extension/screenrec/review.js: the window that opens over the page after the tester stops
// recording. They watch the take, drag on the timeline to cut the fumbling off either end, and
// press Attach. Two numbers have to be true — the "after cuts" length they are shown, and the
// seconds that actually reach the file — or they attach a clip that is not the one they watched.
//
// The file is a BARE IIFE: it publishes nothing, exports nothing and has no completion value, so
// every row here drives the listeners it registered and reads the DOM it painted. `duration` and
// `cuts` are closure variables; the only ways in are init's storage read and the pointer gestures.
//
// Cases numbered as in issue 176. Run: node --test tests/screenrec-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';
import { loadInto, chromeFake, plain, settle } from './helpers/shared-harness.mjs';

// loadInto() resolves this through sharedPath(), so SHARED_SRC=<dir> or SHARED_MODULES=review.js=…
// runs the whole suite against a mutated copy without the shipped file ever being edited.
const REVIEW = 'screenrec/review.js';

// Every id review.html carries. init() reads all fourteen before the IIFE registers a listener,
// so a missing one throws at load and takes the whole file with it.
const IDS = ['video#player', 'div#timeline', 'div#playhead', 'div#review-status', 'div#chips',
  'div#after-label', 'button#btn-attach', 'button#btn-discard', 'button#btn-play',
  'div#file-meta', 'span#t-cur', 'span#t-total', 'div#export-veil', 'div#export-bar'];

// The timeline's box. A browser measures it; here the fixture states it, and this left/width pair
// makes every quarter-second land on an EXACT double — the 0.25 s and 0.05 s thresholds below sit
// on their own boundary, and a float that drifted would test the drift instead of the rule.
const BOX = { left: 40, width: 1000 };

// The parked record the worker leaves in chrome.storage.session (screenrec/parked.js buildParked).
const TAKE = Object.freeze({
  url: 'blob:take-1',
  size: 52428800, // 50.0 MB
  ms: 10000,
  reason: 'user',
  name: 'screen-recording-2026-09-05-1204.webm',
  recordId: 'r-1',
  reviewed: false,
});

// The offscreen page's answers: only trim-swap carries the new take back.
const defaultReply = (msg) => (msg && msg.cmd === 'trim-swap'
  ? { ok: true, url: 'blob:trimmed-take', size: 4242 }
  : { ok: true });

const bytes = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i += 1) u[i] = i % 251; return u; };

// ---- the pieces a vm realm has none of --------------------------------------

// No Blob in a vm context, and without one the trimmed file lands in a silent catch and the whole
// export path passes for the wrong reason. This one really concatenates, so `size` is the truth.
class FakeBlob {
  constructor(parts = [], opts = {}) {
    const chunks = parts.map((p) => (p instanceof FakeBlob ? p.bytes : p)).filter((p) => p && p.length);
    this.bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { this.bytes.set(c, at); at += c.length; }
    this.size = this.bytes.length;
    this.type = opts.type || '';
  }

  async arrayBuffer() { return this.bytes.slice().buffer; }
}

// setTimeout is not in a vm realm either, and the two waits that matter (a seek that never answers,
// the 3 000 ms metadata fallback) are only assertable against a clock a row turns by hand.
function makeClock() {
  const delays = [];
  let seq = 0;
  const pending = new Map();
  return {
    delays,
    setTimeout: (fn, ms) => { delays.push(ms); pending.set(seq += 1, fn); return seq; },
    clearTimeout: (id) => { pending.delete(id); },
    flush(rounds = 6) {
      for (let i = 0; i < rounds && pending.size; i += 1) {
        const due = [...pending.values()];
        pending.clear();
        for (const fn of due) fn();
      }
    },
  };
}

// ---- the harness -------------------------------------------------------------

async function load(opts = {}) {
  const {
    file = TAKE, framed = true, duration = 10, metadata = 'fires', presetDuration,
    probeMs = null, answersSeeks = true, playRejects = false, confirmAnswer = true,
    reply = defaultReply, payload = bytes(1024), mimes = ['video/webm;codecs=vp9'],
    sessionFail = {},
    // The seconds the 1000px timeline ends up covering, so a gesture can state a TIME. A row whose
    // take is measured some other way than `duration` says so; the box itself is 1000px regardless.
    span = Number.isFinite(duration) && duration > 0 ? duration : 10,
  } = opts;

  const doc = makeDocument(IDS);
  const timeline = doc.getElementById('timeline');
  Object.assign(timeline, { offsetLeft: BOX.left, offsetWidth: BOX.width });

  const seeks = [];   // every currentTime assignment, in order
  const plays = [];   // the time each play() was asked from
  const recLog = [];  // every MediaRecorder call
  const posts = [];   // every window.parent.postMessage
  const sent = [];    // every chrome.runtime.sendMessage payload
  const closes = [];
  const clock = makeClock();

  const video = doc.getElementById('player');
  let at = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => at,
    set: (next) => {
      at = next;
      seeks.push(next);
      // Chrome's answer to the seek-far-past-the-end probe: it computes the real duration and says so.
      if (next === 1e9 && probeMs != null) { video.duration = probeMs / 1000; fire(video, 'durationchange'); }
      if (answersSeeks) fire(video, 'seeked');
    },
  });
  video.duration = NaN; // a MediaRecorder webm reports nothing until metadata lands — real behaviour
  video.paused = true;
  video.muted = false;
  video.captureStream = () => ({ kind: 'stream' });
  video.play = () => {
    plays.push(at);
    if (playRejects) return Promise.reject(new Error('the tab would not play'));
    video.paused = false;
    fire(video, 'play');
    return Promise.resolve();
  };
  video.pause = () => { const was = video.paused; video.paused = true; if (!was) fire(video, 'pause'); };

  const fake = chromeFake({ session: file ? { screenRecFile: plain(file) } : {}, sessionFail });
  fake.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return reply(msg, sent.length); };

  const keydown = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); },
    removeEventListener: () => {},
    close: () => { closes.push(true); },
    confirm: () => confirmAnswer,
    postMessage: (data, origin) => { posts.push({ data: plain(data), origin }); },
  };
  win.parent = framed ? { postMessage: win.postMessage } : win;

  class FakeRecorder {
    static isTypeSupported(m) { return mimes.includes(m); }

    constructor(stream, options) {
      recLog.push({ call: 'new', stream: plain(stream), options: plain(options) });
      this.state = 'inactive';
    }

    start(slice) { recLog.push({ call: 'start', slice }); this.state = 'recording'; }
    pause() { recLog.push({ call: 'pause' }); this.state = 'paused'; }
    resume() { recLog.push({ call: 'resume' }); this.state = 'recording'; }

    stop() {
      recLog.push({ call: 'stop' });
      if (this.state === 'inactive') throw new Error('the recorder is already stopped');
      this.state = 'inactive';
      if (payload.length && this.ondataavailable) this.ondataavailable({ data: new FakeBlob([payload]) });
      if (this.onstop) this.onstop();
    }
  }

  loadInto({
    document: doc,
    window: win,
    chrome: fake.chrome,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Blob: FakeBlob,
    MediaRecorder: FakeRecorder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  }, [REVIEW]);

  // init() runs at load and is async: the storage read, then the metadata wait, then the
  // Infinity workaround. Boot it the way a browser would before any row touches the screen.
  await settle();
  if (metadata === 'fires') { video.duration = duration; fire(video, 'loadedmetadata'); }
  if (metadata === 'error') fire(video, 'error');
  if (metadata === 'never' && presetDuration !== undefined) video.duration = presetDuration;
  for (let i = 0; i < 4; i += 1) { await settle(); clock.flush(); }
  await settle();

  const $ = (id) => doc.getElementById(id);
  // The pixel a given second sits at, so a gesture states a TIME and the module does the mapping.
  const x = (t) => BOX.left + (t / span) * BOX.width;

  const h = {
    doc, video, timeline, clock, seeks, plays, recLog, posts, sent, closes, $, x,
    session: fake.session,
    // render() writes the live cut object onto the element it paints — the module's own readout.
    cuts: () => timeline.querySelectorAll('.cut').map((el) => plain(el._cut)),
    chips: () => $('chips').children.map((c) => c.textContent),
    after: () => $('after-label').textContent,
    attachLabel: () => $('btn-attach').textContent,
    status: () => $('review-status').textContent,
    types: () => sent.map((m) => m.cmd || m.type),
    press: (id) => fire($(id), 'click'),
    key: (key) => { for (const fn of keydown) fn({ key }); },
    // One press-move-release: a cut is born on the move, never on the press.
    drag(from, to, id = 1) {
      fire(timeline, 'pointerdown', { clientX: x(from), pointerId: id });
      fire(timeline, 'pointermove', { clientX: x(to), pointerId: id });
      fire(timeline, 'pointerup', { clientX: x(to), pointerId: id });
    },
    // A press and a release with nothing in between — the click the module must read as a seek.
    tap(t, id = 2) {
      fire(timeline, 'pointerdown', { clientX: x(t), pointerId: id });
      fire(timeline, 'pointerup', { clientX: x(t), pointerId: id });
    },
    // Grab one painted handle and pull it: the module finds the cut through the element's parent.
    dragHandle(index, side, to, id = 3) {
      const cut = timeline.querySelectorAll('.cut')[index];
      const handle = cut.querySelector(side === 'start' ? '.h.l' : '.h.r');
      fire(timeline, 'pointerdown', { clientX: x(to), pointerId: id, target: handle });
      fire(timeline, 'pointermove', { clientX: x(to), pointerId: id });
      fire(timeline, 'pointerup', { clientX: x(to), pointerId: id });
    },
    tick(t) { video.currentTime = t; fire(video, 'timeupdate'); },
    mark: () => seeks.length,
    since: (at0) => seeks.slice(at0),
    // The export is a real-time replay; a row hands it the instants a player would have reported.
    // The flush is for the seek watchdog: a row whose player answers no seek still moves forward.
    async replay(...ends) {
      for (const end of ends) { await settle(3); clock.flush(); await settle(2); h.tick(end); }
      await settle(4);
    },
  };
  return h;
}

// Drive one Attach-with-cuts to completion: `ends` are the instants a player would have reported
// at the end of each kept range, one tick per range. Fewer ends than ranges and the export parks.
async function attach(h, { ends }) {
  h.press('btn-attach');
  await h.replay(...ends);
}

const swap = (h) => plain(h.sent.find((m) => m.cmd === 'trim-swap'));
const trimmed = (h) => plain(h.sent.find((m) => m.type === 'SCREENREC_TRIMMED'));

// ---- A: the cut arithmetic ---------------------------------------------------

test('1: a drag pulled leftwards cuts the same seconds as one pulled right', async () => {
  const h = await load();
  h.drag(7, 3);
  assert.deepEqual(h.cuts(), [{ start: 3, end: 7 }]);
  assert.equal(h.after(), '0:10 → 0:06 after cuts');
});

// The only gesture that can hand normalizeCuts a cut whose end is before its start: the drag
// itself orders a new cut, a handle does not. This is the row the ordering at :46 is for.
test('1b: pulling the right handle back past the left one keeps the seconds between them', async () => {
  const h = await load();
  h.drag(2, 5);
  h.dragHandle(0, 'end', 1);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 2 }]);
  assert.equal(h.after(), '0:10 → 0:09 after cuts');
});

test('2: a twitch of a tenth of a second leaves no cut behind', async () => {
  const h = await load();
  h.drag(3, 3.1);
  assert.deepEqual(h.cuts(), []);
  assert.equal(h.after(), '0:10');
});

test('2b: a quarter of a second is the smallest cut the screen keeps', async () => {
  const h = await load();
  h.drag(3, 3.25);
  assert.deepEqual(h.cuts(), [{ start: 3, end: 3.25 }]);
});

test('3: two cuts a frame apart become one, not two touching ones', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(3.04, 5);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 5 }]);
});

test('3b: a gap of exactly the touch tolerance still merges', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(3.05, 5);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 5 }]);
});

test('3c: a gap wider than the tolerance stays two cuts', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(3.5, 5);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 3 }, { start: 3.5, end: 5 }]);
});

test('4: a cut drawn inside another one does not cut those seconds twice', async () => {
  const h = await load();
  h.drag(1, 4);
  h.drag(2, 3);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 4 }]);
  assert.equal(h.after(), '0:10 → 0:07 after cuts');
});

test('5: cutting the fumbling off the front leaves one range, not an empty one in front of it', async () => {
  const h = await load();
  h.drag(0, 2);
  const at0 = h.mark();
  await attach(h, { ends: [10] });
  assert.equal(h.since(at0)[0], 2); // the replay opens on the first kept second, never on 0
  assert.equal(h.recLog.filter((r) => r.call === 'pause').length, 0);
  assert.equal(swap(h).ms, 8000);
});

test('6: cutting the tail off leaves nothing trailing behind the last kept second', async () => {
  const h = await load();
  h.drag(8, 10);
  const at0 = h.mark();
  await attach(h, { ends: [8] });
  assert.equal(h.since(at0)[0], 0);
  assert.equal(h.recLog.filter((r) => r.call === 'pause').length, 0);
  assert.equal(swap(h).ms, 8000);
});

test('7: cutting the whole take refuses to attach and says why', async () => {
  const h = await load();
  h.drag(0, 10);
  assert.deepEqual(h.cuts(), [{ start: 0, end: 10 }]);
  assert.equal(h.after(), '0:10 → 0:00 after cuts');
  h.press('btn-attach');
  await settle(4);
  assert.equal(h.status(), 'Everything is cut — nothing would be left to attach');
  assert.deepEqual(h.types(), []);
  assert.deepEqual(h.posts, []);
});

test('8: a take the tester approves as recorded is attached without an export', async () => {
  const h = await load();
  assert.equal(h.attachLabel(), 'Attach to the result');
  h.press('btn-attach');
  await settle(4);
  assert.deepEqual(plain(h.sent), [{ type: 'SCREENREC_REVIEWED' }]);
  assert.deepEqual(h.recLog, []);
  assert.deepEqual(h.posts, [{ data: { type: 'TESTOMAT_REVIEW_CLOSE' }, origin: '*' }]);
});

test('9: a drag that runs off the right edge cuts to the end of the take, not past it', async () => {
  const h = await load();
  h.drag(9, 14);
  assert.deepEqual(h.cuts(), [{ start: 9, end: 10 }]);
  assert.equal(h.after(), '0:10 → 0:09 after cuts');
});

test('9b: a drag that starts off the left edge cuts from the first second, not from a negative one', async () => {
  const h = await load();
  h.drag(-4, 2);
  assert.deepEqual(h.cuts(), [{ start: 0, end: 2 }]);
  assert.equal(h.timeline.querySelector('.cut').style.left, '0%');
  assert.equal(h.timeline.querySelector('.cut').style.width, '20%');
});

test('10: two cuts in the middle leave three pieces, and the export seeks over each gap', async () => {
  const h = await load();
  h.drag(1, 2);
  h.drag(5, 6);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
  assert.equal(h.after(), '0:10 → 0:08 after cuts');
  const at0 = h.mark();
  await attach(h, { ends: [1, 5, 10] });
  assert.deepEqual(h.recLog.map((r) => r.call), ['new', 'start', 'pause', 'resume', 'pause', 'resume', 'stop']);
  // 0, 2 and 6 are the module opening each kept range; 1, 5 and 10 are the player reporting it ended.
  assert.deepEqual(h.since(at0), [0, 1, 2, 5, 6, 10]);
  assert.equal(swap(h).ms, 8000);
});

// keptRanges walks the cuts once, carrying the second it has reached. Mid-drag the list is neither
// sorted nor merged yet, so a cut drawn INSIDE another must not wind that marker backwards.
test('10b: drawing a second cut inside the first does not hand the tester back seconds twice', async () => {
  const h = await load();
  h.drag(1, 6);
  fire(h.timeline, 'pointerdown', { clientX: h.x(3), pointerId: 9 });
  fire(h.timeline, 'pointermove', { clientX: h.x(2), pointerId: 9 });
  assert.equal(h.after(), '0:10 → 0:05 after cuts');
  fire(h.timeline, 'pointerup', { clientX: h.x(2), pointerId: 9 });
  assert.deepEqual(h.cuts(), [{ start: 1, end: 6 }]);
  assert.equal(h.after(), '0:10 → 0:05 after cuts');
});

test('11: a take that lasted no time at all cannot be cut', async () => {
  const h = await load({ duration: 0, file: { ...TAKE, ms: 0 } });
  h.drag(0, 1);
  assert.deepEqual(h.cuts(), []);
  assert.equal(h.after(), '0:00');
  assert.equal(h.attachLabel(), 'Attach to the result');
});

test('14: the clock never counts backwards and rounds to the nearest second', async () => {
  const h = await load({ duration: 600 });
  const reads = [];
  for (const t of [0, 59.4, 59.6, -3, 600]) { h.tick(t); reads.push(h.$('t-cur').textContent); }
  assert.deepEqual(reads, ['0:00', '0:59', '1:00', '0:00', '10:00']);
  assert.equal(h.$('t-total').textContent, '10:00');
});

test('15: the header names the file and its size in megabytes', async () => {
  const h = await load();
  assert.equal(h.$('file-meta').textContent, 'screen-recording-2026-09-05-1204.webm · 50.0 MB');
});

// ---- B: what the tester is shown ---------------------------------------------

test('12: four cut seconds are shown as the length that is left, on the label and on the button', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(6, 8);
  assert.equal(h.after(), '0:10 → 0:06 after cuts');
  assert.equal(h.attachLabel(), 'Attach 0:06 to the result');
});

test('13: with nothing cut the screen just states the length', async () => {
  const h = await load();
  assert.equal(h.after(), '0:10');
  assert.equal(h.attachLabel(), 'Attach to the result');
});

test('12b: every cut gets a chip naming the seconds it takes away', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(6, 8);
  assert.deepEqual(h.chips(), ['✂ 0:01–0:03✕', '✂ 0:06–0:08✕']);
});

test('12c: the ✕ on a chip gives those seconds back', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(6, 8);
  fire(h.$('chips').children[0].querySelector('button'), 'click');
  assert.deepEqual(h.cuts(), [{ start: 6, end: 8 }]);
  assert.equal(h.after(), '0:10 → 0:08 after cuts');
});

// ---- C: the gestures ----------------------------------------------------------

test('16: a click on the timeline moves the playhead, it does not start a cut', async () => {
  const h = await load();
  h.tap(4);
  assert.deepEqual(h.cuts(), []);
  assert.equal(h.video.currentTime, 4);
  assert.equal(h.after(), '0:10');
});

test('16b: a click past the end of the timeline parks the playhead on the last second', async () => {
  const h = await load();
  h.tap(13);
  assert.equal(h.video.currentTime, 10);
});

test('16c: a click before the start of the timeline parks the playhead on zero', async () => {
  const h = await load();
  h.tap(-2);
  assert.equal(h.video.currentTime, 0);
});

test('17: pulling one handle moves that side of the cut and leaves the other where it was', async () => {
  const h = await load();
  h.drag(2, 5);
  h.dragHandle(0, 'end', 8);
  assert.deepEqual(h.cuts(), [{ start: 2, end: 8 }]);
  h.dragHandle(0, 'start', 1);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 8 }]);
});

test('17b: a handle drag adjusts its own cut, never the neighbouring one', async () => {
  const h = await load();
  h.drag(1, 2);
  h.drag(5, 6);
  h.dragHandle(1, 'end', 8);
  assert.deepEqual(h.cuts(), [{ start: 1, end: 2 }, { start: 5, end: 8 }]);
});

test('18: while the trim is exporting the timeline, Play, Attach, Discard and Escape all sit still', async () => {
  const h = await load({ answersSeeks: false });
  h.drag(2, 4);
  h.press('btn-attach');
  const before = { cuts: h.cuts(), seeks: h.seeks.length, sent: h.sent.length, plays: h.plays.length };
  h.drag(6, 8);
  h.tap(1);
  h.press('btn-play');
  h.press('btn-attach');
  h.press('btn-discard');
  h.key('Escape');
  await settle(3);
  assert.deepEqual(h.cuts(), before.cuts);
  assert.equal(h.seeks.length, before.seeks);
  assert.equal(h.sent.length, before.sent);
  assert.equal(h.plays.length, before.plays);
  assert.deepEqual(h.posts.map((p) => p.data), [{ type: 'TESTOMAT_REVIEW_BUSY', busy: true }]);
});

// ---- D: playback that skips the cuts ------------------------------------------

test('19: playback that reaches a cut jumps over it instead of showing it', async () => {
  const h = await load();
  h.drag(3, 7);
  await h.video.play();
  h.tick(4);
  assert.equal(h.video.currentTime, 7.01);
});

test('19b: the jump lands exactly on the first second the cut covers', async () => {
  const h = await load();
  h.drag(3, 7);
  await h.video.play();
  h.tick(3);
  assert.equal(h.video.currentTime, 7.01);
});

test('19c: a cut that runs to the very end parks the playhead on the end, not past it', async () => {
  const h = await load();
  h.drag(8, 10);
  await h.video.play();
  h.tick(9);
  assert.equal(h.video.currentTime, 10);
});

test('20: a paused player is not dragged out of a cut the tester is scrubbing through', async () => {
  const h = await load();
  h.drag(3, 7);
  h.tick(4);
  assert.equal(h.video.currentTime, 4);
  assert.equal(h.$('t-cur').textContent, '0:04');
  assert.equal(h.$('playhead').style.left, '40%');
});

test('20b: the export replays the kept ranges itself, so the skip stays out of its way', async () => {
  const h = await load({ answersSeeks: false });
  h.drag(3, 7);
  h.press('btn-attach');
  await settle(2);
  await h.video.play();
  h.tick(4);
  assert.equal(h.video.currentTime, 4);
});

test('19d: Play from the end of the take rewinds instead of sitting on the last frame', async () => {
  const h = await load();
  h.tick(10);
  h.press('btn-play');
  await settle();
  assert.equal(h.video.currentTime, 0);
  assert.equal(h.$('btn-play').textContent, '⏸ Pause');
  h.press('btn-play');
  assert.equal(h.$('btn-play').textContent, '▶ Play');
});

// ---- E: the export, and the bytes that leave ----------------------------------

test('26: a five-megabyte trim reaches the recorder page in three chunks and nothing is lost', async () => {
  const h = await load({ payload: bytes(5 * 1024 * 1024) });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.deepEqual(h.types(), ['trim-begin', 'trim-chunk', 'trim-chunk', 'trim-chunk', 'trim-swap', 'SCREENREC_TRIMMED']);
  const back = Buffer.concat(h.sent.filter((m) => m.cmd === 'trim-chunk').map((m) => Buffer.from(m.b64, 'base64')));
  assert.equal(back.length, 5 * 1024 * 1024);
  assert.ok(back.equals(Buffer.from(bytes(5 * 1024 * 1024))));
  assert.deepEqual(swap(h), { type: 'SCREENREC_OFF', cmd: 'trim-swap', oldUrl: 'blob:take-1', ms: 8000 });
});

test('26b: a trim that is exactly one chunk long is sent once, not twice', async () => {
  const h = await load({ payload: bytes(2 * 1024 * 1024) });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.equal(h.sent.filter((m) => m.cmd === 'trim-chunk').length, 1);
});

test('26c: the worker is handed the new file, its size and its length — a trim missing any of them is refused', async () => {
  const h = await load();
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.deepEqual(trimmed(h), {
    type: 'SCREENREC_TRIMMED', url: 'blob:trimmed-take', size: 4242, ms: 8000,
  });
  assert.deepEqual(h.posts.map((p) => p.data), [
    { type: 'TESTOMAT_REVIEW_BUSY', busy: true },
    { type: 'TESTOMAT_REVIEW_BUSY', busy: false },
    { type: 'TESTOMAT_REVIEW_CLOSE' },
  ]);
});

test('25: a recorder page that drops the first chunk leaves the review open and says so', async () => {
  const h = await load({ reply: (m) => (m.cmd === 'trim-begin' ? { ok: false } : defaultReply(m)) });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.equal(h.status(), 'Saving the trim failed: the recorder page dropped a chunk');
  assert.deepEqual(h.types(), ['trim-begin']);
  assert.equal(h.posts.some((p) => p.data.type === 'TESTOMAT_REVIEW_CLOSE'), false);
});

test('27: a recorder page that will not take the trimmed file leaves the review open and says so', async () => {
  const h = await load({ reply: (m) => (m.cmd === 'trim-swap' ? { ok: false } : { ok: true }) });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.equal(h.status(), 'Saving the trim failed: the recorder page did not take the file');
  assert.equal(h.types().includes('SCREENREC_TRIMMED'), false);
  assert.equal(h.closes.length, 0);
});

test('28: a trim that came out with no frames in it is not sent anywhere', async () => {
  const h = await load({ payload: bytes(0) });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.equal(h.status(), 'The trim came out empty — try again');
  assert.deepEqual(h.types(), []);
});

test('22: the host overlay is told to stop closing us before the replay starts', async () => {
  const h = await load({ answersSeeks: false });
  h.drag(2, 4);
  h.press('btn-attach');
  await settle(2);
  assert.deepEqual(h.posts.map((p) => p.data), [{ type: 'TESTOMAT_REVIEW_BUSY', busy: true }]);
  assert.equal(h.$('export-veil').hidden, false);
  assert.equal(h.video.muted, true);
});

test('22b: an export that fails still frees the overlay, or the tester could never close it', async () => {
  const h = await load({ playRejects: true });
  h.drag(2, 4);
  h.press('btn-attach');
  h.key('Escape');
  await settle(5);
  assert.equal(h.status(), 'Trim failed: the tab would not play');
  assert.deepEqual(h.posts.map((p) => p.data), [
    { type: 'TESTOMAT_REVIEW_BUSY', busy: true },
    { type: 'TESTOMAT_REVIEW_BUSY', busy: false },
  ]);
  assert.equal(h.$('export-veil').hidden, true);
  assert.equal(h.video.muted, false);
});

test('22c: a seek that never answers is given up on rather than hanging the export', async () => {
  const h = await load({ answersSeeks: false });
  h.drag(2, 4);
  h.press('btn-attach');
  await settle(2);
  assert.deepEqual(h.recLog.map((r) => r.call), ['new']);
  h.clock.flush();
  await h.replay(2, 10);
  assert.equal(trimmed(h).url, 'blob:trimmed-take');
});

test('33: the length the worker is told is the length the cuts planned, not the one the replay took', async () => {
  const h = await load();
  h.drag(2, 4);
  await attach(h, { ends: [2.4, 10.6] });
  assert.equal(swap(h).ms, 8000);
  assert.equal(trimmed(h).ms, 8000);
});

test('26d: the export records the player through the codec the browser admits to', async () => {
  const h = await load({ mimes: ['video/webm;codecs=vp8', 'video/webm'] });
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  assert.deepEqual(h.recLog[0], { call: 'new', stream: { kind: 'stream' }, options: { mimeType: 'video/webm;codecs=vp8' } });
  assert.deepEqual(h.recLog[1], { call: 'start', slice: 250 });
});

// ---- F: discard, and getting out ----------------------------------------------

test('23: a discard the tester backs out of throws nothing away', async () => {
  const h = await load({ confirmAnswer: false });
  h.press('btn-discard');
  await settle(3);
  assert.deepEqual(h.types(), []);
  assert.deepEqual(h.posts, []);
  assert.equal(h.closes.length, 0);
});

test('24: a confirmed discard tells the worker first, then closes', async () => {
  const h = await load();
  h.press('btn-discard');
  await settle(3);
  assert.deepEqual(plain(h.sent), [{ type: 'SCREENREC_DONE' }]);
  assert.deepEqual(h.posts.map((p) => p.data), [{ type: 'TESTOMAT_REVIEW_CLOSE' }]);
});

test('21: Escape over the page asks the overlay that framed us to take itself down', async () => {
  const h = await load();
  h.key('Escape');
  assert.deepEqual(h.posts, [{ data: { type: 'TESTOMAT_REVIEW_CLOSE' }, origin: '*' }]);
  assert.equal(h.closes.length, 0);
});

test('21b: Escape in a tab of its own closes the tab', async () => {
  const h = await load({ framed: false });
  h.key('Escape');
  assert.deepEqual(h.posts, []);
  assert.equal(h.closes.length, 1);
});

test('21c: any other key leaves the review alone', async () => {
  const h = await load();
  h.key('Enter');
  h.key('Backspace');
  assert.deepEqual(h.posts, []);
  assert.equal(h.closes.length, 0);
});

// ---- G: boot -------------------------------------------------------------------

test('29: a recording that did not survive the browser restart says so and offers no buttons', async () => {
  const h = await load({ file: null });
  assert.equal(h.status(), 'The recording is gone — it does not survive a browser restart.');
  assert.deepEqual(['btn-attach', 'btn-discard', 'btn-play'].map((id) => h.$(id).disabled), [true, true, true]);
  assert.equal(h.video.src, undefined);
  assert.equal(h.$('t-total').textContent, '');
});

test('29b: a session store that refuses to answer is read as no recording at all', async () => {
  const h = await load({ sessionFail: { get: true } });
  assert.equal(h.status(), 'The recording is gone — it does not survive a browser restart.');
  assert.equal(h.$('btn-attach').disabled, true);
});

test('30: a webm with no duration header is measured by seeking past its end', async () => {
  const h = await load({ duration: Infinity, probeMs: 12000, span: 12 });
  assert.deepEqual(h.seeks, [1e9, 0]);
  assert.equal(h.$('t-total').textContent, '0:12');
  h.drag(0, 6);
  assert.equal(h.after(), '0:12 → 0:06 after cuts');
});

test('30b: a webm that still will not say how long it is falls back to the recorder’s stopwatch', async () => {
  const h = await load({ duration: Infinity, file: { ...TAKE, ms: 7000 }, span: 7 });
  assert.equal(h.$('t-total').textContent, '0:07');
  h.drag(0, 3.5);
  assert.equal(h.after(), '0:07 → 0:04 after cuts');
});

test('30c: a video that reports a length of zero falls back to the stopwatch too', async () => {
  const h = await load({ duration: 0, file: { ...TAKE, ms: 9000 } });
  assert.equal(h.$('t-total').textContent, '0:09');
});

test('31: metadata that never arrives is waited out for three seconds, not forever', async () => {
  const h = await load({ metadata: 'never', presetDuration: 9 });
  assert.equal(h.clock.delays.includes(3000), true);
  assert.equal(h.$('t-total').textContent, '0:09');
  assert.equal(h.video.src, 'blob:take-1');
});

// The `error` event has no listener anywhere in review.js, so a dead blob URL is indistinguishable
// from slow metadata: the screen waits out both 3 000 ms timers and then trusts the worker's
// stopwatch. The tester gets a timeline of the right length over a video that will never play.
test('32: a recording whose bytes are gone still draws a full timeline, because nothing watches for the error', async () => {
  const h = await load({ metadata: 'error', file: { ...TAKE, ms: 8000 } });
  assert.deepEqual(h.clock.delays, [3000, 3000]);
  assert.equal(h.$('t-total').textContent, '0:08');
  assert.equal(h.status(), '');
  assert.notEqual(h.$('btn-attach').disabled, true);
});

test.todo('32b (#176 row 32): a recording whose blob URL is dead should say so instead of offering a timeline over a video that cannot play');
