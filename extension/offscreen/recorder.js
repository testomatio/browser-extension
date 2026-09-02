// The tab's picture is consumed HERE: an MV3 worker has no DOM, and MediaRecorder needs one.
// Two sources, one pipeline: a tabCapture stream when Chrome granted one, or CDP screencast
// frames drawn onto a canvas when it did not. The file leaves as a blob: URL, same extension
// origin, so the panel fetches it to upload.

'use strict';

/* global WebmDuration */

const REC_TIME_CAP_MS = 5 * 60 * 1000;
const REC_SIZE_CAP = 50 * 1024 * 1024;
const REC_CHUNK_MS = 1000;

let rec = null;
let mode = null;     // 'tab' | 'cast' while a recording is armed; state reports on IT, not on rec
let stream = null;
let chunks = [];
let bytes = 0;
let castCanvas = null;   // cast mode: frames land here, the canvas IS the camera
let castTrack = null;
let castFrames = 0;      // received, decoded frames; the state answer carries it
let castErr = '';        // the last frame failure, surfaced instead of swallowed
let startedAt = 0;
let pausedAt = 0;   // 0 = running
let pausedMs = 0;
let capTimer = null;
let finishing = null;

// VP9 where Chrome has it, VP8 on the rest; an empty string leaves the choice to Chrome.
function pickMime() {
  const wanted = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return wanted.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function elapsedMs() {
  if (!startedAt) return 0;
  const paused = pausedMs + (pausedAt ? Date.now() - pausedAt : 0);
  return Math.max(0, Date.now() - startedAt - paused);
}

function reset() {
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  rec = null; mode = null; stream = null; chunks = []; bytes = 0;
  castCanvas = null; castTrack = null; castFrames = 0; castErr = '';
  startedAt = 0; pausedAt = 0; pausedMs = 0;
}

// Shared by both sources: the recorder, its caps and the clock start together.
function armRecorder(mediaStream) {
  stream = mediaStream;
  const mimeType = pickMime();
  rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    bytes += e.data.size;
    if (bytes >= REC_SIZE_CAP) finish('size').then(pushFile);
  };
  rec.start(REC_CHUNK_MS);
  startedAt = Date.now();
  // An earlier interval would still be ticking on a recorder this one just replaced.
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  // Ticked rather than timed out: a pause must not spend the tester's five minutes.
  capTimer = setInterval(() => { if (elapsedMs() >= REC_TIME_CAP_MS) finish('time').then(pushFile); }, 1000);
  return rec.mimeType || mimeType;
}

// ---- cast mode: CDP screencast frames ---------------------------------------

// Frames arrive faster than they decode, and two in flight each find no canvas and arm a
// recorder of their own — one at a time, so the pipeline is built once and drawn in order.
let castChain = Promise.resolve();
function castFrame(b64) {
  castChain = castChain.then(() => castFrameNow(b64)).catch((e) => { castErr = String((e && e.message) || e); });
}

// The pipeline is built on the FIRST frame, its size fixes the canvas, so the
// clock and the caps start when there is a picture, not when the worker asked.
async function castFrameNow(b64) {
  if (pausedAt) return; // paused: the screencast is stopped too, but never race it
  // createImageBitmap, not <img>.decode(): a hidden document decodes bitmaps reliably.
  let img;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    img = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  } catch (e) { castErr = `decode: ${e && e.message}`; return; }
  // After the decode, not before: the recording can end mid-flight and arm a recorder no session is behind.
  if (mode == null) return;
  castFrames += 1;
  if (!castCanvas) {
    castCanvas = document.createElement('canvas');
    castCanvas.width = img.width || 1280;
    castCanvas.height = img.height || 720;
    armRecorder(castCanvas.captureStream(0));
    castTrack = stream.getVideoTracks()[0];
  }
  // A later frame of another size (device toolbar, a rotated window) is FITTED, not
  // restretched: mid-stream resolution changes break enough players to avoid.
  const ctx = castCanvas.getContext('2d');
  const cw = castCanvas.width;
  const ch = castCanvas.height;
  const k = Math.min(cw / img.width, ch / img.height);
  const w = img.width * k;
  const h = img.height * k;
  if (w !== cw || h !== ch) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
  ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  if (castTrack && castTrack.requestFrame) castTrack.requestFrame();
  img.close();
}

// ONE promise per recording: the caps, a closed tab and the tester's Stop all end here.
function finish(reason) {
  if (finishing) return finishing;
  // A cast stopped before its first frame has nothing to hand over, only state to drop.
  if (!rec) { reset(); return Promise.resolve(null); }
  const ms = elapsedMs();
  finishing = new Promise((resolve) => {
    const settle = async () => {
      const raw = new Blob(chunks, { type: 'video/webm' });
      // The streamed take carries no Duration header — written in here, or every player
      // treats it as endless: the scrubber sits at the end and seeking misbehaves.
      let blob = raw;
      try { blob = new Blob([WebmDuration.patch(await raw.arrayBuffer(), ms)], { type: 'video/webm' }); }
      catch { /* the raw take still plays */ }
      const file = { url: URL.createObjectURL(blob), size: blob.size, ms, reason: reason || 'user' };
      reset();
      finishing = null;
      resolve(file);
    };
    rec.onstop = settle;
    try { rec.stop(); } catch { settle(); }
  });
  return finishing;
}

// A recording that ends on its own (cap reached, tab gone) has no request to answer.
const pushFile = (file) => chrome.runtime.sendMessage({ type: 'SCREENREC_FILE', file }).catch(() => {});

async function start(streamId) {
  reset();
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  // Closing the tab ends the track. What was recorded up to then is kept, not dropped.
  media.getVideoTracks().forEach((t) => t.addEventListener('ended', () => finish('tab-gone').then(pushFile)));
  const mimeType = armRecorder(media);
  mode = 'tab';
  return { ok: true, mimeType };
}

function pause(on) {
  // Cast mode can pause before the first frame built the recorder, the flag alone drops frames.
  if (on && !pausedAt) { pausedAt = Date.now(); if (rec && rec.state === 'recording') rec.pause(); }
  else if (!on && pausedAt) { pausedMs += Date.now() - pausedAt; pausedAt = 0; if (rec && rec.state === 'paused') rec.resume(); }
}

// The trimmed take (#68 review), streamed here in chunks: this document is the byte holder —
// blob: URLs die with their maker, and the review overlay is gone long before the upload.
let trimParts = [];

// 'trim-swap' replaces the parked ORIGINAL with the trimmed take: the old URL is revoked,
// so the untrimmed picture is unreachable from that moment on. The re-recorded take lacks a
// Duration header the same way a live one does — patched with the kept footage's length.
function trimSwap(oldUrl, ms) {
  let merged = new Uint8Array(trimParts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of trimParts) { merged.set(p, at); at += p.length; }
  trimParts = [];
  try { merged = WebmDuration.patch(merged.buffer, ms); } catch { /* the raw take still plays */ }
  const blob = new Blob([merged], { type: 'video/webm' });
  if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch { /* not ours */ } }
  return { ok: true, url: URL.createObjectURL(blob), size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'SCREENREC_OFF') return undefined;
  switch (msg.cmd) {
    case 'trim-begin':
      trimParts = [];
      sendResponse({ ok: true });
      return false;
    case 'trim-chunk':
      trimParts.push(Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0)));
      sendResponse({ ok: true });
      return false;
    case 'trim-swap':
      sendResponse(trimSwap(msg.oldUrl, msg.ms || 0));
      return false;
    // A take the worker refused to park: its bytes are held by nothing else, let them go.
    case 'revoke':
      try { URL.revokeObjectURL(msg.url); } catch { /* not ours */ }
      sendResponse({ ok: true });
      return false;
    case 'start':
      start(msg.streamId).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'stop':
      finish(msg.reason).then((file) => sendResponse({ ok: true, file }));
      return true;
    case 'cast-start':
      reset();
      mode = 'cast';
      sendResponse({ ok: true });
      return false;
    case 'frame':
      castFrame(msg.data);
      return false;
    case 'pause':
      pause(!!msg.on);
      sendResponse({ ok: true, paused: !!pausedAt });
      return false;
    case 'state':
      sendResponse({ ok: true, recording: mode != null, paused: !!pausedAt, ms: elapsedMs(), bytes, frames: castFrames, err: castErr });
      return false;
    default:
      return undefined;
  }
});
