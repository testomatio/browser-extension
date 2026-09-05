// The "you cannot do that right now" gates (IIFE global `TestGates`): what the verdict buttons, the
// comment box, the step circles and the three attach controls look like when a finished run, a row
// with no result yet or a login-blocked session refuses them — plus the full-page capture toggle
// those captures read, and the attachments fold a FAILED verdict reopens.
//
// Its own file because five surfaces re-run this and only one of them is the test view: the run
// list repaints it when the lock moves, the hotkeys and the screen recorder restore it after a
// capture, and every attachment write ends by asking for it.
//
// It also owns the COPY. The same refusal was five literals across two files in four wordings, and
// screens/attachments.js now takes its two from gateReason() instead of keeping its own. The drift
// is carried across exactly as it stands — the recorder's sentence uses commas where the others use
// em dashes, the delete path's is bare — because unifying the wording is a product decision.

/* global TestomatAPI, Tooltip, Dropdown, state, hasChrome, $, recordFor, recordWriteLock,
   renderAttachmentList, baseUrlHost, StatusIcons */

const TestGates = (() => {
  // ---- full-page capture toggle ----
  // Persisted in settings (default false); every capture path reads fullPageCaptureEnabled().
  function fullPageCaptureEnabled() { return !!(state.settings && state.settings.fullPageCapture); }

  function syncFullPageToggles() {
    const el = $('fullpage-test');
    if (el) el.checked = fullPageCaptureEnabled();
  }

  async function setFullPageCapture(on) {
    if (!state.settings) return;
    state.settings.fullPageCapture = !!on;
    syncFullPageToggles();
    if (hasChrome && chrome.storage?.local) {
      try { await chrome.storage.local.set({ settings: state.settings }); } catch { /* best effort */ }
    }
  }

  // A hover-only tooltip is invisible on touch, so the reason shows inline too. The
  // button's own tooltip is remembered once and restored when the gate lifts.
  function applyActionGate(btnId, reasonId, msg, { inline = true } = {}) {
    const btn = $(btnId);
    if (!btn) return;
    if (btn.dataset.baseTip === undefined) btn.dataset.baseTip = Tooltip.get(btn);
    btn.disabled = !!msg;
    Tooltip.set(btn, msg || btn.dataset.baseTip);
    const reason = $(reasonId);
    const show = !!msg && inline;
    if (reason) { reason.textContent = show ? msg : ''; reason.hidden = !show; }
  }

  // The buttons double as the result display: the matching one takes the `.solid` fill.
  function paintStatusButtons(status) {
    const s = status && status !== 'pending' ? StatusIcons.normStatus(status) : '';
    for (const st of ['passed', 'failed', 'skipped']) {
      const btn = $(`btn-${st}`);
      if (!btn) continue;
      btn.classList.toggle('solid', st === s);
      btn.classList.toggle('outline', st !== s);
    }
  }

  // The one owner of the "you cannot attach that right now" copy. Four wordings, verbatim as each
  // stood: the recorder's commas and the delete path's bare half-sentence are drift, not a design.
  const GATE_COPY = {
    screenshot: {
      noResult: 'No saved result yet — screenshots attach to a test result',
      degraded: (host) => `Attaching screenshots needs an active ${host} web login — sign in there, then Refresh`,
    },
    file: {
      noResult: 'No saved result yet — files attach to a test result',
      degraded: (host) => `Attaching files needs an active ${host} web login — sign in there, then Refresh`,
    },
    recording: {
      noResult: 'No saved result yet, a recording attaches to a test result',
      degraded: (host) => `Attaching a recording needs an active ${host} web login, sign in there, then Refresh`,
    },
    delete: {
      noResult: 'No saved result yet',
      degraded: (host) => `Deleting needs an active ${host} web login — sign in there, then Refresh`,
    },
  };

  // Both sentences for one need, the host already in them. The CALLER keeps its own precedence: the
  // gates below ask the lock first, screens/attachments.js asks the missing result first.
  function gateReason({ need } = {}) {
    const copy = GATE_COPY[need];
    if (!copy) return { noResult: '', degraded: '' };
    return { noResult: copy.noResult, degraded: copy.degraded(baseUrlHost()) };
  }

  function updateTestActionsState() {
    const record = recordFor(state.currentRecordId);
    // #152/#154: the lock outranks every other gate here — "no saved result yet"
    // would invite a click that can no longer create one. Per RECORD since #154.
    const lock = typeof recordWriteLock === 'function' ? recordWriteLock(record) : '';
    // The three buttons share ONE reason paragraph, so they are gated together.
    for (const id of ['btn-passed', 'btn-failed', 'btn-skipped']) applyActionGate(id, null, lock);
    const lockNote = $('status-lock-reason');
    if (lockNote) { lockNote.textContent = lock; lockNote.hidden = !lock; }
    paintStatusButtons(record?.status);
    // The comment rides the status write, so a lock makes it read-only too.
    const comment = $('test-comment');
    if (comment) { comment.disabled = !!lock; Tooltip.set(comment, lock); }
    // Tri-state step circles write straight to the server (add_step) — same lock.
    // The v1 local checkboxes (basic mode) are local-only ticks and stay live.
    document.querySelectorAll('#test-steps .step-state').forEach((b) => {
      b.disabled = !!lock;
      Tooltip.set(b, lock);
    });
    // Substatus stays visible and simply refuses to change; assignee is deliberately
    // NOT gated here — it is workflow metadata, tracked separately (#153).
    const substatus = Dropdown.of('substatus-select');
    if (substatus) { substatus.disabled = !!lock; Tooltip.set(substatus.trigger, lock); }
    // Attach gates on a missing result id, NOT the status — a pending row can have one.
    const noResult = !record?.id;
    // #107: uploads are JWT-only, so a PROVEN degraded session disables them —
    // 'unknown' is still probing and must never gate.
    const degraded = TestomatAPI.jwtAvailable() === false;
    // Lock first, then the missing result, then the session — one order for all three needs.
    const reasonFor = (need) => {
      const copy = gateReason({ need });
      return lock ? lock : noResult ? copy.noResult : degraded ? copy.degraded : '';
    };
    // The lock still DISABLES both buttons, but its reason is not repeated inline: the
    // group note above already says it once, and two more copies read as a stutter.
    // `inline: false` keeps the reason on the tooltip only.
    applyActionGate('btn-screenshot-annotate', 'screenshot-reason', reasonFor('screenshot'), { inline: !lock });
    applyActionGate('btn-attach-file', 'attach-file-reason', reasonFor('file'), { inline: !lock });
    applyActionGate('btn-screen-rec', 'screen-rec-reason', reasonFor('recording'), { inline: !lock });
    // The empty-list dropzone repeats this gate in its own copy, so it repaints when the gate
    // moves. ONLY while it IS the dropzone: rebuilding real rows would drop their thumbnails.
    const attList = $('attachment-list');
    if (typeof renderAttachmentList === 'function' && attList && !attList.querySelector('.file-tile-item')) {
      renderAttachmentList();
    }
  }

  // ---- Attachments disclosure ----
  // Open by default: the files on a result are what the tester came for, and a collapsed
  // section reads as "nothing attached". Closing it is remembered for the panel session.
  let attachmentsOpen = true;

  function applyAttachmentsDisclosure() {
    const head = $('attachments-head');
    const body = $('attachments-body');
    if (head) head.setAttribute('aria-expanded', attachmentsOpen ? 'true' : 'false');
    if (body) body.hidden = !attachmentsOpen;
  }

  function toggleAttachmentsDisclosure() {
    attachmentsOpen = !attachmentsOpen;
    applyAttachmentsDisclosure();
  }

  // Through the same toggle a click uses, so aria-expanded and the memory stay coherent.
  function openAttachmentsDisclosure() {
    if (!attachmentsOpen) toggleAttachmentsDisclosure();
  }

  // FAILED keeps the tester on the test to attach evidence, so open the section.
  function expandAttachmentsForFailure() {
    openAttachmentsDisclosure();
  }

  // The ticket's eleven, shortened on the namespace — nothing else: every reason a caller needs is
  // reachable through gateReason, and the fold's open flag is nobody else's to read.
  return {
    apply: applyActionGate,
    paintStatusButtons,
    update: updateTestActionsState,
    gateReason,
    fullPageCaptureEnabled,
    setFullPageCapture,
    syncFullPageToggles,
    applyAttachmentsDisclosure,
    toggleAttachmentsDisclosure,
    openAttachmentsDisclosure,
    expandForFailure: expandAttachmentsForFailure,
  };
})();
