#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';
import { loadInto, chromeFake, plain, settle } from './helpers/shared-harness.mjs';

// SHARED_SRC or SHARED_MODULES runs the suite against a mutated copy, never editing the shipped file.
const REVIEW = 'screenrec/review.js';

// init() reads every id before registering a listener, so a missing one throws at load.
const IDS = ['video#player', 'div#timeline', 'div#playhead', 'div#review-status', 'div#chips',
  'div#after-label', 'button#btn-attach', 'button#btn-discard', 'button#btn-play',
  'div#file-meta', 'span#t-cur', 'span#t-total', 'div#export-veil', 'div#export-bar'];

// This box puts every quarter-second on an exact double, so the thresholds test rules, not drift.
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

// No Blob in a vm realm, so the export would pass via a silent catch; this one really concatenates.
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

// No setTimeout in a vm realm; the seek and metadata waits are asserted on a hand-turned clock.
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

async function load(opts = {}) {
  const {
    file = TAKE, framed = true, duration = 10, metadata = 'fires', presetDuration,
    probeMs = null, answersSeeks = true, playRejects = false, confirmAnswer = true,
    reply = defaultReply, payload = bytes(1024), mimes = ['video/webm;codecs=vp9'],
    sessionFail = {},
    // The worker's one-time key and the one this document was framed with; equal on every legitimate row.
    key = 'rk-1', hashKey = key,
    // The key read left hanging: init() has not yet established who framed this document.
    stallKey = false,
    // The seconds the 1000px timeline covers, so a gesture can state a time.
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
  // Measured in Chrome: dead blobs park at readyState 0 / error 4; a real webm has readyState ≥ 1.
  video.readyState = 0;   // HAVE_NOTHING
  video.networkState = 0; // NETWORK_EMPTY
  video.error = null;
  video.videoWidth = 0;
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

  const fake = chromeFake({
    session: {
      ...(file ? { screenRecFile: plain(file) } : {}),
      ...(key ? { screenRecReviewKey: key } : {}),
    },
    sessionFail,
  });
  fake.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return reply(msg, sent.length); };
  // The worker's broadcasts reach this page through its own runtime listener.
  const heard = [];
  fake.chrome.runtime.onMessage = { addListener: (fn) => { heard.push(fn); } };
  if (stallKey) {
    const read = fake.chrome.storage.session.get;
    fake.chrome.storage.session.get = (k) => (k === 'screenRecReviewKey' ? new Promise(() => {}) : read(k));
  }

  const keydown = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); },
    removeEventListener: () => {},
    close: () => { closes.push(true); },
    confirm: () => confirmAnswer,
    postMessage: (data, origin) => { posts.push({ data: plain(data), origin }); },
    // There is no location in a vm realm, and the hash is where the framing key rides.
    location: { hash: hashKey ? `#k=${encodeURIComponent(hashKey)}` : '' },
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

  // init() is async: boot it the way a browser would before any row touches the screen.
  await settle();
  if (metadata === 'fires') {
    video.duration = duration; video.readyState = 4; video.networkState = 1; video.videoWidth = 320;
    fire(video, 'loadedmetadata');
  }
  if (metadata === 'error') { video.error = { code: 4 }; video.networkState = 3; fire(video, 'error'); }
  // Metadata arrived, then the decode gave out: past HAVE_NOTHING, only `error` says the take is dead.
  if (metadata === 'decode') {
    video.duration = duration; video.readyState = 4; video.networkState = 1; video.videoWidth = 320;
    fire(video, 'loadedmetadata');
    video.error = { code: 3 }; // MEDIA_ERR_DECODE
  }
  // Metadata that landed unheard: a player that knows its duration is past HAVE_NOTHING anyway.
  if (metadata === 'never' && presetDuration !== undefined) {
    video.duration = presetDuration; video.readyState = 1; video.networkState = 1; video.videoWidth = 320;
  }
  for (let i = 0; i < 4; i += 1) { await settle(); clock.flush(); }
  await settle();

  const $ = (id) => doc.getElementById(id);
  // The pixel a given second sits at, so a gesture states a time and the module does the mapping.
  const x = (t) => BOX.left + (t / span) * BOX.width;

  const h = {
    doc, video, timeline, clock, seeks, plays, recLog, posts, sent, closes, $, x,
    broadcast: (msg) => { for (const fn of heard) fn(msg, {}, () => {}); },
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
    // The flush is for the seek watchdog: a row whose player answers no seek still moves forward.
    async replay(...ends) {
      for (const end of ends) { await settle(3); clock.flush(); await settle(2); h.tick(end); }
      await settle(4);
    },
  };
  return h;
}

// `ends`: the instant each kept range ends, as a player reports it; too few and the export parks.
async function attach(h, { ends }) {
  h.press('btn-attach');
  await h.replay(...ends);
}

const swap = (h) => plain(h.sent.find((m) => m.cmd === 'trim-swap'));
const trimmed = (h) => plain(h.sent.find((m) => m.type === 'SCREENREC_TRIMMED'));

test('1: a drag pulled leftwards cuts the same seconds as one pulled right', async () => {
  const h = await load();
  h.drag(7, 3);
  assert.deepEqual(h.cuts(), [{ start: 3, end: 7 }]);
  assert.equal(h.after(), '0:10 → 0:06 after cuts');
});

// Only a handle can hand normalizeCuts a cut that ends before it starts; a fresh drag orders itself.
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

// The merge only looks at the last entry, so an unsorted cut list is the case to pin.
test('2c: trimming the end first and the beginning second keeps both cuts', async () => {
  const h = await load();
  h.drag(5, 6);
  h.drag(1, 2);
  assert.equal(h.cuts().length, 2, 'the second cut is not swallowed by the first');
  assert.equal(h.after(), '0:10 → 0:08 after cuts');
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

// Mid-drag the cuts are unsorted and unmerged, so a nested one must not rewind keptRanges.
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

test('12d: the ✕ takes away the cut it sits on, not whichever came first', async () => {
  const h = await load();
  h.drag(1, 3);
  h.drag(6, 8);
  fire(h.$('chips').children[1].querySelector('button'), 'click');
  assert.deepEqual(h.cuts(), [{ start: 1, end: 3 }]);
  assert.equal(h.after(), '0:10 → 0:08 after cuts');
});

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

// Without the reset the review is dead after one attach, every control ignored.
test('18b: once the export is over the screen answers the tester again', async () => {
  const h = await load();
  h.drag(2, 4);
  await attach(h, { ends: [2, 10] });
  const seeks = h.seeks.length;

  h.tap(1);
  assert.ok(h.seeks.length > seeks, 'a tap on the timeline still seeks');
  h.key('Escape');
  assert.ok(h.posts.some((p) => p.data && p.data.type === 'TESTOMAT_REVIEW_CLOSE'), 'and Escape still closes');
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

// Its `loadedmetadata` landed before anyone listened; reading the element is what keeps it playable.
test('31: metadata that never arrives is waited out for three seconds, not forever', async () => {
  const h = await load({ metadata: 'never', presetDuration: 9 });
  assert.equal(h.clock.delays.includes(3000), true);
  assert.equal(h.$('t-total').textContent, '0:09');
  assert.equal(h.video.src, 'blob:take-1');
  assert.equal(h.status(), '');
  assert.notEqual(h.$('btn-attach').disabled, true);
});

test('32 (#337): a recording whose bytes are gone says so and will not let the tester attach it', async () => {
  const h = await load({ metadata: 'error', file: { ...TAKE, ms: 8000 } });
  assert.match(h.status(), /will not play/);
  assert.equal(h.$('btn-attach').disabled, true);
  assert.equal(h.$('btn-play').disabled, true);
  assert.equal(h.$('t-total').textContent, ''); // no timeline is drawn at all
  assert.deepEqual(h.clock.delays, [3000]);     // and no second three-second probe is sat through
});

// The bytes are gone but the record in chrome.storage.session is not, and only Discard clears it.
test('32a (#337): the tester can still throw away a take whose video is dead', async () => {
  const h = await load({ metadata: 'error', file: { ...TAKE, ms: 8000 } });
  assert.notEqual(h.$('btn-discard').disabled, true);
  h.press('btn-discard');
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_DONE']);
});

// Past HAVE_NOTHING, readyState alone calls this take healthy; only `video.error` catches the decode.
test('32c (#337): a take that loaded and then failed to decode is refused too, not just an empty one', async () => {
  const h = await load({ metadata: 'decode', file: { ...TAKE, ms: 8000 } });
  assert.match(h.status(), /will not play/);
  assert.equal(h.$('btn-attach').disabled, true);
  assert.equal(h.$('btn-play').disabled, true);
  assert.equal(h.$('t-total').textContent, '');
});

test('32b (#337): a video that never loaded is not dressed in the stopwatch’s timeline, even though no error was ever fired', async () => {
  const h = await load({ metadata: 'never', file: { ...TAKE, ms: 8000 } });
  assert.equal(h.video.error, null);
  assert.match(h.status(), /will not play/);
  assert.equal(h.$('btn-attach').disabled, true);
  assert.equal(h.$('t-total').textContent, '');
});

// Any page can frame review.html invisibly; only the worker-minted key tells our frame from theirs.

test('34 (#105): a page that framed the review itself gets no buttons and is told who opened it', async () => {
  const h = await load({ hashKey: null });
  assert.match(h.status(), /opened by the page/i);
  assert.deepEqual(['btn-attach', 'btn-discard', 'btn-play'].map((id) => h.$(id).disabled), [true, true, true]);
  assert.equal(h.$('file-meta').textContent, '', 'the parked take is not even named to the page holding us');
  assert.equal(h.video.src, undefined, 'and its blob URL never reaches a <video> that page put on screen');
  assert.equal(h.$('t-total').textContent, '');
});

test('34a (#105): a framed review carrying a guessed key is refused the same way', async () => {
  const h = await load({ hashKey: 'guessed-by-the-page' });
  assert.match(h.status(), /opened by the page/i);
  assert.deepEqual(['btn-attach', 'btn-discard', 'btn-play'].map((id) => h.$(id).disabled), [true, true, true]);
  assert.equal(h.video.src, undefined);
});

// A disabled button is the browser's guard; this row proves the refusal is a refusal to act.
test('34b (#105): a click harvested on a refused review attaches nothing and discards nothing', async () => {
  const h = await load({ hashKey: null });
  h.press('btn-discard');
  h.press('btn-attach');
  await settle(3);
  assert.deepEqual(h.types(), [], 'not one word reaches the worker');
  assert.deepEqual(h.posts, [], 'and the frame does not even close itself on the page’s behalf');
});

test('34c (#105): the frame our own overlay opened, with the key it was handed, attaches as before', async () => {
  const h = await load();
  assert.equal(h.status(), '');
  assert.notEqual(h.$('btn-attach').disabled, true);
  assert.notEqual(h.$('btn-discard').disabled, true);
  assert.equal(h.video.src, 'blob:take-1');
  h.press('btn-attach');
  await settle(3);
  assert.deepEqual(h.types(), ['SCREENREC_REVIEWED']);
});

// A page can frame us invisibly but cannot open an invisible tab, so a tab needs no key.
test('34d (#105): a review opened in a tab of its own needs no key at all', async () => {
  const h = await load({ framed: false, key: null });
  assert.equal(h.status(), '');
  assert.notEqual(h.$('btn-attach').disabled, true);
  assert.equal(h.video.src, 'blob:take-1');
  h.press('btn-attach');
  await settle(3);
  assert.deepEqual(h.types(), ['SCREENREC_REVIEWED']);
});

// With nothing parked and no hash, a bare `!==` reads '' against '' as a match.
test('34g (#105): a framed review with no key on either side refuses — an empty hash matches nothing', async () => {
  const h = await load({ framed: true, key: null, hashKey: null });
  assert.match(h.status(), /opened by the page/i);
  assert.equal(h.$('btn-attach').disabled, true);
  assert.equal(h.$('btn-discard').disabled, true);
  h.press('btn-discard');
  await settle(3);
  assert.deepEqual(h.types(), [], 'not one word reaches the worker');
});

test('34e (#105): with no key parked at all, a framed review refuses rather than trusting the hash', async () => {
  const h = await load({ key: null, hashKey: 'anything-at-all' });
  assert.match(h.status(), /opened by the page/i);
  assert.equal(h.$('btn-discard').disabled, true);
});

// Until the boot-time key check answers, the document does not know who framed it.
test('34f (#105): a click harvested before the key check has answered acts on nothing', async () => {
  const h = await load({ stallKey: true });
  h.press('btn-discard');
  h.press('btn-attach');
  await settle(3);
  assert.deepEqual(h.types(), []);
  assert.deepEqual(h.posts, []);
});

test('an erase that threw the take away closes the review, framed or in a tab of its own', async () => {
  const framed = await load();
  framed.broadcast({ type: 'SCREENREC_EVENT', event: 'ended', reason: 'wiped' });
  assert.deepEqual(framed.posts.map((p) => p.data), [{ type: 'TESTOMAT_REVIEW_CLOSE' }]);
  const tab = await load({ framed: false });
  tab.broadcast({ type: 'SCREENREC_EVENT', event: 'ended', reason: 'wiped' });
  assert.equal(tab.closes.length, 1);
});

test('any other end the worker announces leaves the review open', async () => {
  const h = await load();
  for (const msg of [
    { type: 'SCREENREC_EVENT', event: 'ended', reason: 'discarded' },
    { type: 'SCREENREC_EVENT', event: 'ended', reason: 'user', empty: true },
    { type: 'SCREENREC_EVENT', event: 'review' },
    { type: 'EVIDENCE_WIPE' },
    null,
  ]) h.broadcast(msg);
  assert.deepEqual(h.posts, []);
  assert.equal(h.closes.length, 0);
});
