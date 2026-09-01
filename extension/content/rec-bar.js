// The screen recording's controls (#68), on the page rather than in the panel: the tester is
// looking at the site under test, not at a 400px strip beside it.

(() => {
  'use strict';

  const HOST_ID = 'testomat-screen-rec-bar';
  const POS_KEY = 'screenRecBarPos';
  const POLL_MS = 500;
  const EDGE = 8;
  const DRAG_SLOP = 4;
  const NOTICE_MS = 4000;

  const old = document.getElementById(HOST_ID);
  if (old) old.remove(); // a full load re-injects this file; one bar, never two

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .box {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 9999px;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; color: #fff; background: #0a0a0a;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4); user-select: none;
      cursor: grab; touch-action: none;
    }
    .box.dragging { cursor: grabbing; }
    .box.paused { background: #7c2d12; }
    .box.notice { background: #1f2937; cursor: default; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; flex: none; animation: pulse 1.2s infinite; }
    .box.paused .dot { animation: none; background: #f59e0b; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    .txt { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
    button {
      flex: none; font: inherit; font-weight: 600; cursor: pointer;
      padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(255,255,255,0.35);
      background: transparent; color: #fff;
    }
    button:hover { background: rgba(255,255,255,0.15); }
    button.stop { color: #fca5a5; border-color: rgba(252,165,165,0.5); }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  shadow.append(style, box);

  const dot = document.createElement('span');
  dot.className = 'dot';
  const txt = document.createElement('span');
  txt.className = 'txt';

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  const pauseBtn = button('Pause', '', () => send({ type: 'SCREENREC_PAUSE', on: !paused }));
  const stopBtn = button('Stop', 'stop', () => send({ type: 'SCREENREC_STOP' }));

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  let paused = false;
  let timer = null;

  function paintRecording(st) {
    paused = !!st.paused;
    box.className = `box${paused ? ' paused' : ''}`;
    txt.textContent = paused ? `Paused ${clock(st.ms || 0)}` : `Recording ${clock(st.ms || 0)}`;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    box.replaceChildren(dot, txt, pauseBtn, stopBtn);
  }

  // A cap that stopped the recording is said HERE: the tester is on the page, not in the panel.
  function paintNotice(reason) {
    box.className = 'box notice';
    txt.textContent = reason === 'size'
      ? 'Size limit reached, recording stopped'
      : 'Time limit reached, recording stopped';
    box.replaceChildren(txt);
  }

  function teardown() {
    if (timer) { clearInterval(timer); timer = null; }
    host.remove();
  }

  async function poll() {
    const st = await send({ type: 'SCREENREC_STATUS' });
    if (!st) { teardown(); return; }
    if (st.recording) { paintRecording(st); return; }
    const reason = st.file && st.file.reason;
    if (timer) { clearInterval(timer); timer = null; }
    if (reason === 'time' || reason === 'size') { paintNotice(reason); setTimeout(teardown, NOTICE_MS); }
    else teardown();
  }

  // ---- moving the bar ------------------------------------------------------
  // The dropped position lives under its own storage key, so it survives the re-injection
  // every navigation performs. The viewport it was saved from is rarely this one: re-clamp.
  let pos = null;

  function clamp(p) {
    const r = box.getBoundingClientRect();
    const w = r.width || 220;
    const h = r.height || 36;
    return {
      left: Math.min(Math.max(EDGE, p.left), Math.max(EDGE, window.innerWidth - w - EDGE)),
      top: Math.min(Math.max(EDGE, p.top), Math.max(EDGE, window.innerHeight - h - EDGE)),
    };
  }

  function apply() {
    if (!pos) return;
    const p = clamp(pos);
    host.style.cssText = `position:fixed;z-index:2147483647;left:${p.left}px;top:${p.top}px;`;
  }

  chrome.storage.local.get(POS_KEY).then((got) => {
    const p = got && got[POS_KEY];
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) { pos = p; apply(); }
  }).catch(() => {});

  box.addEventListener('pointerdown', (e) => {
    if (e.target !== box && e.target !== txt && e.target !== dot) return; // a control is not a handle
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let moved = false;
    box.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < DRAG_SLOP) return;
      moved = true;
      box.classList.add('dragging');
      pos = { left: ev.clientX - dx, top: ev.clientY - dy };
      apply();
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.classList.remove('dragging');
      if (moved && pos) chrome.storage.local.set({ [POS_KEY]: clamp(pos) }).catch(() => {});
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  });

  // The page never sees the tester typing or clicking in here.
  ['keydown', 'keyup', 'keypress', 'input', 'change', 'click'].forEach(
    (t) => shadow.addEventListener(t, (e) => e.stopPropagation()),
  );

  window.addEventListener('resize', apply);

  (document.body || document.documentElement).append(host);
  paintRecording({ ms: 0, paused: false });
  poll();
  timer = setInterval(poll, POLL_MS);
})();
