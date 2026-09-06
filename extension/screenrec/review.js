// Review + trim (#68): preview the parked recording, cut any number of ranges, and nothing
// leaves the machine until Attach. The trim is a NATIVE re-record — the kept ranges replay
// once into a fresh MediaRecorder, which is PAUSED across every cut and every seek, so a cut
// frame is never painted into the stream. The worker drops the original the moment a trim lands.
//
// Runs framed over the page (content/review-overlay.js) or as a tab of its own.

/* global chrome */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const fmt = (s) => { const n = Math.max(0, Math.round(s)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  const mb = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

  const video = $('player');
  const timeline = $('timeline');
  const playhead = $('playhead');

  let file = null;     // the parked marker (screenRecFile)
  let duration = 0;    // seconds — resolved below; MediaRecorder webm reports Infinity
  let cuts = [];       // [{ start, end }] seconds — kept sorted and non-overlapping
  let dragging = null; // { kind: 'new'|'handle', cut, side?, anchor?, moved }
  let exporting = false;

  function closeReview() {
    if (window.parent !== window) window.parent.postMessage({ type: 'TESTOMAT_REVIEW_CLOSE' }, '*');
    else window.close();
  }

  // The export is a real-time replay: the host overlay must stop closing us on a reflex Escape.
  function tellHostBusy(busy) {
    if (window.parent !== window) window.parent.postMessage({ type: 'TESTOMAT_REVIEW_BUSY', busy }, '*');
  }

  const status = (msg) => { $('review-status').textContent = msg || ''; };

  // ---- cut arithmetic --------------------------------------------------------

  const clamp = (t) => Math.min(Math.max(t, 0), duration);

  // Overlapping or touching cuts collapse into one; slivers a drag left behind are dropped.
  function normalizeCuts() {
    const rows = cuts
      .map((c) => ({ start: Math.min(c.start, c.end), end: Math.max(c.start, c.end) }))
      .filter((c) => c.end - c.start >= 0.25)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const c of rows) {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end + 0.05) last.end = Math.max(last.end, c.end);
      else merged.push(c);
    }
    cuts = merged;
  }

  // What survives the cuts — the ranges the export replays and Play walks through.
  function keptRanges() {
    const kept = [];
    let at = 0;
    for (const c of cuts) {
      if (c.start - at > 0.05) kept.push({ start: at, end: c.start });
      at = Math.max(at, c.end);
    }
    if (duration - at > 0.05) kept.push({ start: at, end: duration });
    return kept;
  }

  const keptSec = () => keptRanges().reduce((n, r) => n + (r.end - r.start), 0);

  // ---- painting --------------------------------------------------------------

  function render() {
    for (const el of timeline.querySelectorAll('.cut')) el.remove();
    for (const c of cuts) {
      const el = document.createElement('div');
      el.className = 'cut';
      el.style.left = `${(c.start / duration) * 100}%`;
      el.style.width = `${((c.end - c.start) / duration) * 100}%`;
      const l = document.createElement('span'); l.className = 'h l';
      const r = document.createElement('span'); r.className = 'h r';
      l.dataset.side = 'start'; r.dataset.side = 'end';
      el.append(l, r);
      el._cut = c;
      timeline.append(el);
    }
    const chips = $('chips');
    chips.replaceChildren(...cuts.map((c) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.append(`✂ ${fmt(c.start)}–${fmt(c.end)}`);
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove this cut');
      x.textContent = '✕';
      x.addEventListener('click', () => { cuts = cuts.filter((k) => k !== c); render(); });
      chip.append(x);
      return chip;
    }));
    $('after-label').textContent = cuts.length
      ? `${fmt(duration)} → ${fmt(keptSec())} after cuts` : fmt(duration);
    $('btn-attach').textContent = cuts.length
      ? `Attach ${fmt(keptSec())} to the result` : 'Attach to the result';
  }

  // ---- the timeline: drag to cut, drag a handle to adjust, click to seek -----

  const timeAt = (clientX) => {
    const r = timeline.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * duration);
  };

  timeline.addEventListener('pointerdown', (e) => {
    if (exporting) return;
    const t = timeAt(e.clientX);
    if (e.target.classList.contains('h')) {
      dragging = { kind: 'handle', cut: e.target.parentElement._cut, side: e.target.dataset.side, moved: false };
    } else {
      const cut = { start: t, end: t };
      cuts.push(cut);
      dragging = { kind: 'new', cut, anchor: t, moved: false };
    }
    timeline.setPointerCapture(e.pointerId);
  });

  timeline.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const t = timeAt(e.clientX);
    dragging.moved = true;
    if (dragging.kind === 'new') {
      dragging.cut.start = Math.min(dragging.anchor, t);
      dragging.cut.end = Math.max(dragging.anchor, t);
    } else {
      dragging.cut[dragging.side] = t;
    }
    render();
  });

  timeline.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const wasClick = !dragging.moved && dragging.kind === 'new';
    if (wasClick) {
      cuts = cuts.filter((c) => c !== dragging.cut); // a click marks no cut…
      video.currentTime = timeAt(e.clientX);         // …it moves the playhead
    }
    dragging = null;
    normalizeCuts();
    render();
  });

  // ---- playback that skips the cuts -----------------------------------------

  video.addEventListener('timeupdate', () => {
    playhead.style.left = duration ? `${(video.currentTime / duration) * 100}%` : '0';
    $('t-cur').textContent = fmt(video.currentTime);
    if (exporting || video.paused) return;
    const inside = cuts.find((c) => video.currentTime >= c.start && video.currentTime < c.end);
    if (inside) video.currentTime = Math.min(inside.end + 0.01, duration);
  });

  video.addEventListener('play', () => { $('btn-play').textContent = '⏸ Pause'; });
  video.addEventListener('pause', () => { $('btn-play').textContent = '▶ Play'; });

  $('btn-play').addEventListener('click', () => {
    if (exporting) return;
    if (video.paused) {
      if (video.currentTime >= duration - 0.05) video.currentTime = 0;
      video.play().catch(() => {});
    } else video.pause();
  });

  // ---- the export: replay the kept ranges once ------------------------------

  const seekTo = (t) => new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
    setTimeout(done, 2000); // a seek that never answers must not hang the export
  });

  function playUntil(end, onTick) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        onTick(video.currentTime);
        if (video.currentTime >= end - 0.03) finish();
      };
      const finish = () => {
        video.removeEventListener('timeupdate', tick);
        video.removeEventListener('ended', finish);
        video.pause();
        resolve();
      };
      video.addEventListener('timeupdate', tick);
      video.addEventListener('ended', finish);
      video.play().catch(reject);
    });
  }

  const pickMime = () => ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';

  async function exportTrimmed() {
    const ranges = keptRanges();
    if (!ranges.length) { status('Everything is cut — nothing would be left to attach'); return null; }
    exporting = true;
    tellHostBusy(true);
    $('export-veil').hidden = false;
    video.muted = true;
    video.pause();
    const total = keptSec();
    let doneSec = 0;
    const bar = $('export-bar');
    const chunks = [];
    const rec = new MediaRecorder(video.captureStream(), pickMime() ? { mimeType: pickMime() } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    try {
      // Seek FIRST, start the recorder on the landed frame — nothing before the first kept
      // range can reach the stream. Across every later seek the recorder is paused.
      await seekTo(ranges[0].start);
      rec.start(250);
      for (let i = 0; i < ranges.length; i += 1) {
        const r = ranges[i];
        if (i > 0) {
          rec.pause();
          await seekTo(r.start);
          rec.resume();
        }
        await playUntil(r.end, (at) => {
          const frac = (doneSec + Math.max(0, at - r.start)) / total;
          bar.style.width = `${Math.min(100, frac * 100)}%`;
        });
        doneSec += r.end - r.start;
      }
      rec.stop();
      await stopped;
      return new Blob(chunks, { type: 'video/webm' });
    } catch (e) {
      try { rec.stop(); } catch { /* already stopped */ }
      status(`Trim failed: ${(e && e.message) || e}`);
      return null;
    } finally {
      exporting = false;
      tellHostBusy(false); // in the finally so a failed export can never leave the overlay unclosable
      $('export-veil').hidden = true;
      video.muted = false;
    }
  }

  // ---- attach / discard ------------------------------------------------------

  $('btn-attach').addEventListener('click', async () => {
    if (exporting) return;
    if (!cuts.length) {
      // Watched and approved as it is — the panel attaches the original.
      await send({ type: 'SCREENREC_REVIEWED' });
      closeReview();
      return;
    }
    const blob = await exportTrimmed();
    if (!blob || !blob.size) { if (blob) status('The trim came out empty — try again'); return; }
    // The bytes must outlive this document, and the offscreen page is already the byte holder —
    // streamed over in chunks (messages carry JSON, not blobs), then swapped in for the
    // original, whose URL is revoked right there: the untrimmed take dies with the swap.
    try {
      const CHUNK = 2 * 1024 * 1024;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ack = (r) => { if (!r || !r.ok) throw new Error('the recorder page dropped a chunk'); };
      ack(await send({ type: 'SCREENREC_OFF', cmd: 'trim-begin' }));
      for (let at = 0; at < bytes.length; at += CHUNK) {
        let bin = '';
        const slice = bytes.subarray(at, at + CHUNK);
        for (let i = 0; i < slice.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
        }
        ack(await send({ type: 'SCREENREC_OFF', cmd: 'trim-chunk', b64: btoa(bin) }));
      }
      const swapped = await send({ type: 'SCREENREC_OFF', cmd: 'trim-swap', oldUrl: file.url, ms: Math.round(keptSec() * 1000) });
      if (!swapped || !swapped.ok) throw new Error('the recorder page did not take the file');
      await send({ type: 'SCREENREC_TRIMMED', url: swapped.url, size: swapped.size, ms: Math.round(keptSec() * 1000) });
      closeReview();
    } catch (e) {
      status(`Saving the trim failed: ${(e && e.message) || e}`);
    }
  });

  $('btn-discard').addEventListener('click', async () => {
    if (exporting) return;
    if (!window.confirm('Discard this recording? Nothing was uploaded.')) return;
    await send({ type: 'SCREENREC_DONE' });
    closeReview();
  });

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !exporting) closeReview(); });

  // ---- boot ------------------------------------------------------------------

  async function init() {
    try { file = (await chrome.storage.session.get('screenRecFile')).screenRecFile || null; } catch { file = null; }
    if (!file || !file.url) {
      status('The recording is gone — it does not survive a browser restart.');
      $('btn-attach').disabled = true;
      $('btn-discard').disabled = true;
      $('btn-play').disabled = true;
      return;
    }
    $('file-meta').textContent = `${file.name} · ${mb(file.size)}`;
    video.src = file.url;
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', resolve, { once: true }); // stop waiting early; the state below decides
      setTimeout(resolve, 3000);
    });
    // Ask the element, not the event: a dead take parks at readyState 0 with `error` set, a healthy
    // webm is past HAVE_NOTHING even at duration Infinity. Below, file.ms would dress it up as fine.
    if (video.error || !(video.readyState > 0)) {
      status('This recording will not play — nothing has been attached. '
        + 'The take is still parked: reopen the review from the panel to try again, or discard it.');
      $('btn-attach').disabled = true;
      $('btn-play').disabled = true;
      return;
    }
    // MediaRecorder's webm carries no duration header — seeking far past the end makes
    // Chrome compute the real one (the standard workaround).
    if (!Number.isFinite(video.duration)) {
      await new Promise((resolve) => {
        video.addEventListener('durationchange', resolve, { once: true });
        video.currentTime = 1e9;
        setTimeout(resolve, 3000);
      });
      video.currentTime = 0;
    }
    duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration : (file.ms || 0) / 1000;
    $('t-total').textContent = fmt(duration);
    render();
  }

  init();
})();
