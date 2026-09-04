// The editor's recording session (IIFE global `RecSession`): the transport to the worker, where a
// recording's items sit in the body, and the AI polish that rewrites them once, at Stop.
// No DOM of its own — it decides what the record and polish controls say and hands that to `ui`,
// which is the only half that touches the page.

/* global MdSections, RecFormat, ensureSiteAccess */
const RecSession = (() => {
  const { STEPS_OPTS, splitRecorded, insertRecorded, polishedSection, parsePolishedItems, serverMessage } = RecFormat;

  // BLIND: the recorded tab moved to a page Chrome keeps extensions off (chrome://, the
  // Web Store, another extension); the worker revives the recording when it comes back.
  const REC_BLIND = 'Chrome doesn’t allow extensions on this page — steps are not being recorded. '
    + 'Go back to the site under test and recording resumes by itself.';

  // A manual pause (indicator Pause) is NOT the cap pause: Continue stays hidden, since
  // the way out is Resume on the page and it must not also hand out another cap.
  const REC_MANUAL_PAUSE = 'Paused from the page indicator — click Resume there to carry on recording.';

  const REC_TIP_OFF = 'Record what you do on the page as numbered steps';
  const REC_TIP_ON = 'Stop recording — the steps go into this test';
  const REC_TIP_POLISHING = 'Testomat AI is rewriting the steps you just recorded';

  const POLISH_KEY = 'polishSteps';   // its OWN storage.local key, like stepRecNeverValues
  // One button, two jobs — and no button at all when there is no recording to do them to.
  const POLISH_DO = 'Polish recorded steps';
  const POLISH_UNDO = 'Undo polish';
  const POLISH_TIP_DO = 'Rewrite the steps you recorded with your Testomat.io AI';
  const POLISH_TIP_UNDO = 'Put the recorded steps back the way they were recorded';

  // 30s and the raw sentences stand: a recording cannot wait on a model that never answers.
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const reasonOf = (e) => (e && e.status ? `HTTP ${e.status}` : (e && e.message) || 'failed');

  // The deferred first step is `Open <url>` and carries no packet — its own sentence is
  // the only place that url is written down.
  const openUrl = (raw) => (String(raw).match(/^Open\s+(\S+)/) || [])[1] || '';

  // The wire format the prompt expects. Values are double-quoted with inner quotes escaped
  // and newlines collapsed, so one fact is always one line.
  const pq = (v) => `"${String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').replace(/"/g, '\\"')}"`;

  // ---- step recorder (message-driven; background owns the canonical state) --
  // `editor` is the body (`getValue`/`setValue`); `ui` paints what the decisions below produce —
  // `rec`, `polish`, `polishRow`, `polishSwitch`, plus `caret` and `edited`, the two the page owns.
  function createRecSession({ editor, getTitle, showToast, api, chrome, testUid = null, recorded = null, onPersist, ui }) {
    const canRecord = !!(chrome && chrome.runtime && chrome.runtime.sendMessage);
    const hasLocal = () => !!(chrome && chrome.storage && chrome.storage.local);

    let recording = false;
    let recPollTimer = null;
    let recEnding = false;   // guards the drain against a poll/stop race
    let recBlind = false;    // recorder lost host access to the recorded tab (see REC_BLIND)
    let recManualPause = false; // tester paused it from the on-page indicator (#71)
    let recStepInserted = false; // a step of THIS recording is already in the body (#160)
    let recAnyInserted = false;  // …anything at all, so Stop knows it recorded something
    let handedOver = false;  // the read-only view took over the page — no controls left to offer

    // ---- AI polish (#23) — off by default, ONE request when the recording stops ----
    let polishOn = false;
    let polishAvailable = true;  // a session to ask; basic mode has none, so the row goes away
    let polishTimeoutMs = 30000;        // per request; __tc.setPolishTimeout shortens it in e2e
    let lastPolishMessage = '';         // e2e reads the exact message that went out
    let recPolishing = false;           // a request is out — the record button says so
    let recBusy = null;                 // …that request, or a Stop: Save and a leave wait on it
    // The recording this editor holds: its entries (packets and all), where its items sit in
    // the Steps list, and both texts every item has had — raw as recorded, polished if it was.
    let recEntries = (recorded && recorded.entries) || [];
    let recStart = recorded && recorded.start >= 0 ? recorded.start : -1;
    let recCount = (recorded && recorded.count) || 0;
    let recPolished = !!(recorded && recorded.polished);
    let recRawItems = (recorded && recorded.rawItems) || [];
    let recPolishedItems = (recorded && recorded.polishedItems) || [];
    // What we last wrote into those items — the only texts a replacement is allowed to touch.
    const recWritten = () => (recPolished ? recPolishedItems : recRawItems);

    // The words and the flags the record button wears — the markup that carries them is the
    // page's business, so only this shape crosses over.
    function updateRecUi(count, paused, blind, manualPaused) {
      // The polish is the tail of the recording: nothing may start a second one over it.
      if (recPolishing) {
        ui.rec({ label: 'Polishing…', tip: REC_TIP_POLISHING, disabled: true, active: false, continueHidden: true });
        return;
      }
      let tip = recording ? REC_TIP_ON : REC_TIP_OFF;
      if (blind) tip = REC_BLIND;
      else if (manualPaused) tip = REC_MANUAL_PAUSE;
      const n = count || 0;
      if (!recording) {
        ui.rec({ label: 'Record steps', tip, disabled: false, active: false, continueHidden: true });
      } else if (manualPaused && !blind) {
        ui.rec({ label: `Stop recording (${n}) — paused`, tip, disabled: false, active: true, continueHidden: true });
      } else if (blind) {
        // A blind recorder can ALSO be at the cap — Continue stays reachable so both
        // blockers can clear in any order.
        ui.rec({ label: `Stop (${n}) — page not recordable`, tip, disabled: false, active: true, continueHidden: !paused });
      } else if (paused) {
        ui.rec({ label: 'Stop', tip, disabled: false, active: true, continueHidden: false });
      } else {
        ui.rec({ label: `Stop recording (${n})`, tip, disabled: false, active: true, continueHidden: true });
      }
    }

    function setMarkdown(md) {
      // A live insert (#160) lands while the editor is open — keep the caret put.
      const ta = ui.caret();
      const at = ta ? ta.selectionStart : -1;
      editor.setValue(md);
      if (at >= 0) { try { ta.setSelectionRange(at, at); } catch { /* re-rendered */ } }
      ui.edited(md);
    }

    // The recording's single insertion point — the live poll and Stop's tail flush both come
    // through here. The sentences go in RAW, switch or no switch: polishing happens at Stop,
    // over the whole recording, and what it needs is kept alongside the body.
    function insertEntries(entries) {
      for (const e of entries) {
        if (!e || !e.text) continue;
        recEntries.push({ kind: e.kind, text: e.text, ctx: e.ctx || null, manual: !!e.manual });
      }
      return insertRaw(entries);
    }

    function insertRaw(entries) {
      const md = editor.getValue();
      const parts = splitRecorded(entries, recStepInserted && MdSections.hasItems(md, 'Steps', STEPS_OPTS));
      if (!parts.steps.length && !parts.expected.length && !parts.leadSubs.length) return false;
      // #23: where this recording's own items begin — counted in the list BEFORE the insert.
      if (recStart === -1 && parts.steps.length) recStart = MdSections.items(md, 'Steps', STEPS_OPTS).length;
      setMarkdown(insertRecorded(md, parts));
      if (parts.steps.length) recStepInserted = true;
      recAnyInserted = true;
      readRecItems();
      return true;
    }

    // The recording's items as they now stand: its span in the list, and the raw texts a
    // replacement is allowed to overwrite (nothing else in the body is ever touched).
    function readRecItems() {
      if (recStart === -1) return;
      const existing = MdSections.items(editor.getValue(), 'Steps', STEPS_OPTS);
      recCount = Math.max(0, existing.length - recStart);
      recRawItems = existing.slice(recStart).map((it) => ({ text: it.text, subs: (it.subs || []).slice() }));
    }

    // ---- polishing: one request, at Stop, over the whole recording -----------
    const hasRecording = () => recEntries.length > 0 && recStart >= 0 && recCount > 0;

    async function polishRecording() {
      if (!hasRecording() || recPolishing) return;
      recPolishing = true;
      updateRecUi(0, false, false, false);
      updatePolishBtn();
      lastPolishMessage = polishMessage();
      try {
        const res = await withTimeout(
          api.polishRecordedSteps(lastPolishMessage, testUid), polishTimeoutMs,
        );
        const items = parsePolishedItems(polishedSection(res));
        if (!items.length) throw new Error('nothing came back');
        // The raw texts are captured BEFORE the write, so Undo has somewhere to go back to.
        const raw = recRawItems.map((it) => (it ? { text: it.text, subs: it.subs.slice() } : null));
        const done = MdSections.replaceItems(editor.getValue(), 'Steps', STEPS_OPTS, {
          start: recStart, count: recCount, next: items, written: recWritten(),
        });
        if (done.md !== editor.getValue()) setMarkdown(done.md);
        recRawItems = raw;
        recPolishedItems = done.items;
        recPolished = true;
        showToast('Steps polished ✓');
      } catch (e) {
        polishFailed(e); // the raw steps stand exactly as they were recorded
      } finally {
        recPolishing = false;
        updateRecUi(0, false, false, false);
        updatePolishBtn();
        onPersist();
      }
    }

    // Back to the sentences the recorder wrote — item by item, and never over one the tester
    // has since rewritten.
    function undoPolish() {
      const done = MdSections.replaceItems(editor.getValue(), 'Steps', STEPS_OPTS, {
        start: recStart, count: recCount, next: recRawItems, written: recWritten(),
      });
      if (done.md !== editor.getValue()) setMarkdown(done.md);
      recRawItems = done.items;
      recPolished = false;
      updatePolishBtn();
      onPersist();
    }

    // 401/403: this instance has no such prompt (or no session for it), so the switch goes
    // away rather than failing again on the next recording.
    function polishFailed(e) {
      if (e && (e.kind === 'auth' || e.status === 401 || e.status === 403)) { disablePolish(); return; }
      const own = e && e.status === 422 ? serverMessage(e) : '';
      showToast(own || `Couldn’t polish — raw steps kept (${reasonOf(e)})`, { error: true });
    }

    function disablePolish() {
      polishOn = false;
      ui.polishSwitch(false);
      polishAvailable = false;
      ui.polishRow(true);
      writePolishPref(false);
      updatePolishBtn();
      showToast('Polishing isn’t enabled on this server yet');
    }

    // The recording's steps, each carrying the manual note that followed it. The worker's own
    // nav line adds nothing: its url/title change is already in the packet's `after`.
    function recActions() {
      const acts = [];
      for (const e of recEntries) {
        if (e.kind === 'expected') {
          const last = acts[acts.length - 1];
          if (last && e.manual) last.note = last.note ? `${last.note}; ${e.text}` : e.text;
          continue;
        }
        acts.push({ raw: e.text, ctx: e.ctx || null, note: '' });
      }
      return acts;
    }

    function polishMessage() {
      const acts = recActions();
      const withPage = acts.find((a) => a.ctx && a.ctx.page);
      const page = (withPage && withPage.ctx.page) || null;
      const out = [`TEST: ${getTitle().replace(/\s+/g, ' ').trim()}`];
      if (page && (page.title || page.url)) out.push(`PAGE: ${page.title || ''} | ${page.url || ''}`);
      const before = MdSections.items(editor.getValue(), 'Steps', STEPS_OPTS).slice(0, Math.max(0, recStart));
      if (before.length) {
        out.push('EXISTING STEPS (written before the recording — keep their wording, do not repeat them):');
        before.forEach((it, i) => out.push(`${i + 1}. ${it.text}`));
      }
      out.push('RECORDED ACTIONS:');
      acts.forEach((a, i) => {
        const c = a.ctx || {};
        const e = c.element || {};
        const n = c.near || {};
        const af = c.after || {};
        out.push(`${i + 1}. raw: ${String(a.raw).replace(/\s*[\r\n]+\s*/g, ' ')}`);
        out.push(`   action: ${c.action || 'open'}`);
        if (c.element) {
          out.push(`   element: ${e.tag || ''} role=${pq(e.role)} type=${pq(e.type)} text=${pq(e.text)}`
            + ` aria-label=${pq(e.ariaLabel)} title=${pq(e.title)} placeholder=${pq(e.placeholder)}`
            + ` name=${pq(e.name)} id=${pq(e.id)} class=${pq(e.class)} icon=${pq(e.icon)}`);
        }
        if (c.value) out.push(`   value: ${pq(c.value.text)}${c.value.masked ? ' (masked)' : ''}`);
        if (c.near) {
          out.push(`   near: label=${pq(n.label)} row=${pq(n.row)} column=${pq(n.column)}`
            + ` section=${pq(n.section)} heading=${pq(n.heading)} siblings=${pq(n.siblings)}`);
        }
        out.push(`   after: url=${pq(af.url || openUrl(a.raw) || 'unchanged')} title=${pq(af.title || 'unchanged')}`
          + ` toast=${pq(af.toast)} dialog=${pq(af.dialog)} state=${pq(af.state)} counter=${pq(af.counter)}`);
        if (a.note) out.push(`   note: ${a.note}`);
      });
      return out.join('\n');
    }

    function updatePolishBtn() {
      const show = !recording && !recPolishing && !handedOver && polishOn && polishAvailable && hasRecording();
      ui.polish(show
        ? {
          hidden: false,
          label: recPolished ? POLISH_UNDO : POLISH_DO,
          tip: recPolished ? POLISH_TIP_UNDO : POLISH_TIP_DO,
        }
        : { hidden: true, label: null, tip: null });
    }

    // Stop (drain + polish) and the button's own polish both run through here — one after the
    // other, never side by side — so Save and a leave have exactly ONE promise to wait on.
    function runExclusive(fn) {
      const prev = recBusy;
      const p = (async () => {
        if (prev) await prev.catch(() => {});
        try { await fn(); } finally { if (recBusy === p) recBusy = null; }
      })();
      recBusy = p;
      return p;
    }
    async function settleRec() { while (recBusy) await recBusy.catch(() => {}); }

    // Its OWN storage.local key (never `settings`), read once when the editor opens.
    function writePolishPref(on) {
      if (!hasLocal()) return;
      try { chrome.storage.local.set({ [POLISH_KEY]: !!on }); } catch { /* best effort */ }
    }
    // Basic mode has no session to ask, so the row does not offer it at all.
    function syncPolishVisible() {
      polishAvailable = api.jwtAvailable() !== false;
      ui.polishRow(!polishAvailable);
      updatePolishBtn();
    }
    // The switch may move at any point in a recording — only where it stands at Stop counts.
    function setPolishOn(on) {
      polishOn = !!on;
      ui.polishSwitch(polishOn);
      writePolishPref(polishOn);
      updatePolishBtn();
    }
    async function loadPolishPref() {
      if (hasLocal()) {
        try { polishOn = (await chrome.storage.local.get(POLISH_KEY))[POLISH_KEY] === true; }
        catch { /* default off */ }
      }
      ui.polishSwitch(polishOn);
      syncPolishVisible();
    }

    async function startRecording() {
      if (!canRecord) { showToast('Recording needs the extension context'); return; }
      // The SW resolves the same active tab. Never a prompt: the only "no" left is a
      // restricted page.
      const access = await ensureSiteAccess();
      if (!access.ok) { showToast(access.error); return; }
      const resp = await chrome.runtime.sendMessage({ type: 'STEPREC_START' }).catch(() => null);
      if (!resp || !resp.ok) { showToast((resp && resp.reason) || 'This page can’t be recorded'); return; }
      recording = true;
      recEnding = false;
      recBlind = false;
      recManualPause = false;
      recStepInserted = false;
      recAnyInserted = false;
      // A new recording replaces the one this editor was holding — polished or not.
      recEntries = [];
      recStart = -1;
      recCount = 0;
      recPolished = false;
      recRawItems = [];
      recPolishedItems = [];
      updateRecUi(0, false, false, false);
      updatePolishBtn();
      clearInterval(recPollTimer);
      recPollTimer = setInterval(pollRec, 500);
    }

    // Ends the recording and inserts the tail the live poll had not pulled yet (#160 —
    // the steps before it are in the body already). Then, with the switch on, the whole
    // recording goes out for polishing in ONE request; Save waits on the same latch.
    async function finishRecording(toastMsg) {
      if (recEnding) return;
      recEnding = true;
      clearInterval(recPollTimer);
      recording = false;
      recBlind = false;
      recManualPause = false;
      updateRecUi(0, false, false, false);
      // Stopping from here blurs nothing on the page, so the field still under the caret has yet to
      // become a step — it is asked for before the stop below reads the entries and clears them (#62).
      if (canRecord) await chrome.runtime.sendMessage({ type: 'STEPREC_FLUSH' }).catch(() => {});
      const resp = canRecord ? await chrome.runtime.sendMessage({ type: 'STEPREC_STOP' }).catch(() => null) : null;
      const inserted = insertEntries((resp && resp.entries) || []);
      if (toastMsg) showToast(toastMsg);
      else if (!inserted && !recAnyInserted) showToast('No steps recorded');
      if (polishOn && polishAvailable) await polishRecording();
      updatePolishBtn();
    }

    // One message per tick: it carries the status AND the entries that are final,
    // which land in the open test right away (#160).
    async function pollRec() {
      if (!canRecord || !recording) return;
      const s = await chrome.runtime.sendMessage({ type: 'STEPREC_PULL' }).catch(() => null);
      if (!s) return;
      if (s.entries && s.entries.length) insertEntries(s.entries);
      // stopped on the page / tab closed — the same exclusive lane Stop takes
      if (s.recording === false) { runExclusive(() => finishRecording()); return; }
      // Toast once per blind stretch (the poll runs every 500ms); the button label and
      // its tooltip carry the warning for as long as it lasts.
      if (s.blind && !recBlind) showToast(REC_BLIND);
      recBlind = !!s.blind;
      recManualPause = !!s.manualPause;
      updateRecUi(s.count, s.paused, recBlind, recManualPause);
    }

    // Carry on past the cap: the worker hands out another one and the same recording goes on.
    async function continueRecording() {
      if (!canRecord) return;
      await chrome.runtime.sendMessage({ type: 'STEPREC_CONTINUE' }).catch(() => {});
      updateRecUi(0, false, recBlind, recManualPause);
    }

    // The view took this page over: the poll stops and the polish button is gone for good.
    function handOver() {
      handedOver = true;
      clearInterval(recPollTimer);
    }

    return {
      start: startRecording,
      finish: finishRecording,
      poll: pollRec,
      polish: polishRecording,
      undo: undoPolish,
      runExclusive,
      settle: settleRec,
      continueRecording,
      handOver,
      // The first paint, and every repaint the page asks for after a control moves.
      refresh: () => updateRecUi(0, false, false, false),
      loadPolishPref,
      syncPolishVisible,
      setPolishOn,
      setPolishTimeout: (ms) => { polishTimeoutMs = Number(ms) || polishTimeoutMs; },
      isRecording: () => recording,
      isPolished: () => recPolished,
      isBlind: () => recBlind,
      isBusy: () => recBusy !== null,
      polishOn: () => polishOn,
      hasRecording,
      lastPolishMessage: () => lastPolishMessage,
      // What the draft persists: the live entries, where their items are, and both texts.
      draftShape: () => ({
        entries: recEntries, start: recStart, count: recCount,
        polished: recPolished, rawItems: recRawItems, polishedItems: recPolishedItems,
      }),
    };
  }

  return { createRecSession };
})();
