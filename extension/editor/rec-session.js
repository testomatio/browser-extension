// The editor's recording session and its AI polish at Stop; no DOM, `ui` paints what it decides.

/* global MdSections, RecFormat, ensureSiteAccess */
const RecSession = (() => {
  const {
    STEPS_OPTS, stepsHeading, splitRecorded, insertRecorded,
    polishedSection, parsePolishedItems, serverMessage, aiRefused,
  } = RecFormat;

  // Blind: the tab is on a page Chrome keeps extensions off; the worker revives the recording later.
  const REC_BLIND = 'Chrome doesn’t allow extensions on this page — steps are not being recorded. '
    + 'Go back to the site under test and recording resumes by itself.';

  // A manual pause hides Continue: the way out is Resume on the page, which must not add another cap.
  const REC_MANUAL_PAUSE = 'Paused from the page indicator — click Resume there to carry on recording.';

  const REC_TIP_OFF = 'Record what you do on the page as numbered steps';
  const REC_TIP_ON = 'Stop recording — the steps go into this test';
  const REC_TIP_POLISHING = 'Testomat AI is rewriting the steps you just recorded';

  const POLISH_KEY = 'polishSteps';   // its own storage.local key, like stepRecNeverValues
  const AI_OFF_MSG = 'AI isn’t available for your company: it needs a plan with AI, switched on by the company owner in the company settings';
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

  // The deferred `Open <url>` step has no packet, so its sentence is the only place the url lives.
  const OPEN_STEP = /^(Open\s+)(\S+)/;
  const openUrl = (raw) => (String(raw).match(OPEN_STEP) || [])[2] || '';

  // The prompt leaves the browser: urls are cut to origin + path (queries carry tokens), `#/` kept.
  const trimUrl = (raw) => {
    let u;
    try { u = new URL(raw); } catch { return raw; }
    return `${u.origin}${u.pathname}${u.hash.startsWith('#/') ? u.hash.split('?')[0] : ''}`;
  };
  const trimOpen = (raw) => String(raw).replace(OPEN_STEP, (m, head, url) => head + trimUrl(url));

  // Quoted, inner quotes escaped, newlines collapsed: one fact is always one line in the prompt.
  const pq = (v) => `"${String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').replace(/"/g, '\\"')}"`;

  // The background owns the canonical recorder state; `caret` and `edited` are owned by the page.
  function createRecSession({ editor, getTitle, showToast, api, chrome, testUid = null, recorded = null, onPersist, ui }) {
    const canRecord = !!(chrome && chrome.runtime && chrome.runtime.sendMessage);
    const hasLocal = () => !!(chrome && chrome.storage && chrome.storage.local);

    let recording = false;
    let recPollTimer = null;
    let recEnding = false;   // guards the drain against a poll/stop race
    let recBlind = false;    // recorder lost host access to the recorded tab (see REC_BLIND)
    let recManualPause = false; // tester paused it from the on-page indicator
    let recStepInserted = false; // a step of this recording is already in the body
    let recAnyInserted = false;  // …anything at all, so Stop knows it recorded something
    let handedOver = false;  // the read-only view took over the page — no controls left to offer

    let polishOn = false;
    let polishAvailable = true;  // a session to ask; basic mode has none, so the row goes away
    let aiOff = false;           // the company has no AI: the switch stays in view, explains, sends nothing
    let aiNone = false;          // the instance has no AI at all: the switch is not offered
    let polishTimeoutMs = 30000;        // per request; __tc.setPolishTimeout shortens it in e2e
    let lastPolishMessage = '';         // e2e reads the exact message that went out
    let recPolishing = false;           // a request is out — the record button says so
    let recBusy = null;                 // …that request, or a Stop: Save and a leave wait on it
    // The recording this editor holds: entries, its span in Steps, and raw and polished texts.
    let recEntries = (recorded && recorded.entries) || [];
    let recStart = recorded && recorded.start >= 0 ? recorded.start : -1;
    let recCount = (recorded && recorded.count) || 0;
    let recPolished = !!(recorded && recorded.polished);
    let recRawItems = (recorded && recorded.rawItems) || [];
    let recPolishedItems = (recorded && recorded.polishedItems) || [];
    // What we last wrote into those items — the only texts a replacement is allowed to touch.
    const recWritten = () => (recPolished ? recPolishedItems : recRawItems);

    // Only this shape crosses over; the markup that carries it is the page's business.
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
        // A blind recorder can also be at the cap: Continue stays so both clear in any order.
        ui.rec({ label: `Stop (${n}) — page not recordable`, tip, disabled: false, active: true, continueHidden: !paused });
      } else if (paused) {
        ui.rec({ label: 'Stop', tip, disabled: false, active: true, continueHidden: false });
      } else {
        ui.rec({ label: `Stop recording (${n})`, tip, disabled: false, active: true, continueHidden: true });
      }
    }

    function setMarkdown(md) {
      // A live insert lands while the editor is open, so keep the caret put.
      const ta = ui.caret();
      const at = ta ? ta.selectionStart : -1;
      editor.setValue(md);
      if (at >= 0) { try { ta.setSelectionRange(at, at); } catch { /* re-rendered */ } }
      ui.edited(md);
    }

    // Single insertion point for poll and Stop; always raw, since polishing runs at Stop.
    function insertEntries(entries) {
      for (const e of entries) {
        if (!e || !e.text) continue;
        recEntries.push({ kind: e.kind, text: e.text, ctx: e.ctx || null, manual: !!e.manual });
      }
      return insertRaw(entries);
    }

    function insertRaw(entries) {
      const md = editor.getValue();
      // Looked up once: the count before the insert must name the section the insert writes into.
      const heading = stepsHeading(md);
      const parts = splitRecorded(entries, recStepInserted && MdSections.hasItems(md, heading, STEPS_OPTS));
      if (!parts.steps.length && !parts.expected.length && !parts.leadSubs.length) return false;
      // Where this recording's items begin, counted before the insert.
      if (recStart === -1 && parts.steps.length) recStart = MdSections.items(md, heading, STEPS_OPTS).length;
      setMarkdown(insertRecorded(md, parts, heading));
      if (parts.steps.length) recStepInserted = true;
      recAnyInserted = true;
      readRecItems(heading);
      return true;
    }

    // The raw texts a replacement may overwrite; nothing else in the body is ever touched.
    function readRecItems(heading) {
      if (recStart === -1) return;
      const existing = MdSections.items(editor.getValue(), heading, STEPS_OPTS);
      recCount = Math.max(0, existing.length - recStart);
      recRawItems = existing.slice(recStart).map((it) => ({ text: it.text, subs: (it.subs || []).slice() }));
    }

    const hasRecording = () => recEntries.length > 0 && recStart >= 0 && recCount > 0;

    async function polishRecording() {
      if (!hasRecording() || recPolishing) return;
      if (aiOff) { showToast(AI_OFF_MSG); return; }
      recPolishing = true;
      updateRecUi(0, false, false, false);
      updatePolishBtn();
      lastPolishMessage = polishMessage();
      try {
        const res = await withTimeout(
          api.polishRecordedSteps(lastPolishMessage, testUid), polishTimeoutMs,
        );
        if (aiRefused(res)) throw { kind: 'ai-off' };
        const items = parsePolishedItems(polishedSection(res));
        if (!items.length) throw new Error('nothing came back');
        // Raw texts are captured before the write, so Undo has somewhere to go back to.
        const raw = recRawItems.map((it) => (it ? { text: it.text, subs: it.subs.slice() } : null));
        const body = editor.getValue();
        const done = MdSections.replaceItems(body, stepsHeading(body), STEPS_OPTS, {
          start: recStart, count: recCount, next: items, written: recWritten(),
        });
        if (done.md !== body) setMarkdown(done.md);
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

    // Item by item, never over one the tester has since rewritten.
    function undoPolish() {
      const body = editor.getValue();
      const done = MdSections.replaceItems(body, stepsHeading(body), STEPS_OPTS, {
        start: recStart, count: recCount, next: recRawItems, written: recWritten(),
      });
      // `recRawItems` is not re-derived: a skipped item would file the tester's edit away as ours.
      if (!done.touched) { showToast('Nothing to put back — these steps were edited by hand'); return; }
      if (done.md !== body) setMarkdown(done.md);
      recPolished = false;
      updatePolishBtn();
      onPersist();
    }

    // 401/403: no such prompt or session here, so the switch goes away instead of failing again.
    function polishFailed(e) {
      if (e && (e.kind === 'auth' || e.status === 401 || e.status === 403)) { disablePolish(); return; }
      if (e && (e.kind === 'ai-off' || aiRefused(null, e))) { turnAiOff(true); return; }
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

    // The worker's nav line adds nothing: its url/title change is already in the packet's `after`.
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
      const body = editor.getValue();
      const before = MdSections.items(body, stepsHeading(body), STEPS_OPTS).slice(0, Math.max(0, recStart));
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
        const rawLine = trimOpen(a.raw).replace(/\s*[\r\n]+\s*/g, ' ');
        out.push(`${i + 1}. raw: ${rawLine}`);
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
        out.push(`   after: url=${pq(af.url || openUrl(rawLine) || 'unchanged')} title=${pq(af.title || 'unchanged')}`
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

    // Stop and the polish button run one after another, so Save and a leave wait on one promise.
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

    // Its own storage.local key (never `settings`), read once when the editor opens.
    function writePolishPref(on) {
      if (!hasLocal()) return;
      try { chrome.storage.local.set({ [POLISH_KEY]: !!on }); } catch { /* best effort */ }
    }
    // The switch goes off for this editor only: the stored choice stands for a company that has AI.
    function turnAiOff(say) {
      aiOff = true;
      polishOn = false;
      ui.polishSwitch(false);
      updatePolishBtn();
      if (say) showToast(AI_OFF_MSG);
    }
    // 'off': in view but inert; 'none': not offered; 'on' and 'unknown' change nothing.
    function setAiStatus(status) {
      if (status === 'none') { aiNone = true; turnAiOff(false); syncPolishVisible(); }
      else if (status === 'off') turnAiOff(false);
    }
    // Basic mode has no session to ask, so the row does not offer it at all.
    function syncPolishVisible() {
      polishAvailable = api.jwtAvailable() !== false && !aiNone;
      ui.polishRow(!polishAvailable);
      updatePolishBtn();
    }
    // The switch may move at any point in a recording — only where it stands at Stop counts.
    function setPolishOn(on) {
      if (on && aiOff) { ui.polishSwitch(false); showToast(AI_OFF_MSG); return; }
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
      if (aiOff) polishOn = false;
      ui.polishSwitch(polishOn);
      syncPolishVisible();
    }

    async function startRecording() {
      if (!canRecord) { showToast('Recording needs the extension context'); return; }
      // The SW resolves the same active tab; never a prompt, so the only "no" is a restricted page.
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

    // Inserts the tail the live poll missed, then polishes the whole recording in one request.
    async function finishRecording(toastMsg) {
      if (recEnding) return;
      recEnding = true;
      clearInterval(recPollTimer);
      recording = false;
      recBlind = false;
      recManualPause = false;
      updateRecUi(0, false, false, false);
      // Stopping here blurs nothing on the page, so flush the focused field before the stop reads entries.
      if (canRecord) await chrome.runtime.sendMessage({ type: 'STEPREC_FLUSH' }).catch(() => {});
      const resp = canRecord ? await chrome.runtime.sendMessage({ type: 'STEPREC_STOP' }).catch(() => null) : null;
      const inserted = insertEntries((resp && resp.entries) || []);
      if (toastMsg) showToast(toastMsg);
      else if (!inserted && !recAnyInserted) showToast('No steps recorded');
      if (polishOn && polishAvailable) await polishRecording();
      updatePolishBtn();
    }

    // One message per tick carries the status and the final entries, which land right away.
    async function pollRec() {
      if (!canRecord || !recording) return;
      const s = await chrome.runtime.sendMessage({ type: 'STEPREC_PULL' }).catch(() => null);
      if (!s) return;
      if (s.entries && s.entries.length) insertEntries(s.entries);
      // stopped on the page / tab closed — the same exclusive lane Stop takes
      if (s.recording === false) { runExclusive(() => finishRecording()); return; }
      // Toast once per blind stretch (polled every 500ms); the button carries the warning meanwhile.
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
      setAiStatus,
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
