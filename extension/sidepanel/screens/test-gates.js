// The "you cannot do that right now" gates: what each write control shows when a lock refuses it.

/* global TestomatAPI, Tooltip, Dropdown, state, hasChrome, $, recordFor, RunLock,
   renderAttachmentList, baseUrlHost, StatusIcons */

const TestGates = (() => {
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

  // A hover-only tooltip is invisible on touch, so the reason shows inline too.
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

  // The four wordings drift (commas, a bare delete line); unifying them is a product decision.
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

  // Callers keep their own order: gates below check the lock first, attachments.js the missing result.
  function gateReason({ need } = {}) {
    const copy = GATE_COPY[need];
    if (!copy) return { noResult: '', degraded: '' };
    return { noResult: copy.noResult, degraded: copy.degraded(baseUrlHost()) };
  }

  function updateTestActionsState() {
    const record = recordFor(state.currentRecordId);
    // The lock outranks every other gate: "no saved result yet" would invite a futile click.
    const lock = typeof RunLock !== 'undefined' ? RunLock.recordWriteLock(record) : '';
    // The three buttons share one reason paragraph, so they are gated together.
    for (const id of ['btn-passed', 'btn-failed', 'btn-skipped']) applyActionGate(id, null, lock);
    const lockNote = $('status-lock-reason');
    if (lockNote) { lockNote.textContent = lock; lockNote.hidden = !lock; }
    paintStatusButtons(record?.status);
    // The comment rides the status write, so a lock makes it read-only too.
    const comment = $('test-comment');
    if (comment) { comment.disabled = !!lock; Tooltip.set(comment, lock); }
    // Step circles write to the server (add_step), so they lock; basic-mode local ticks stay live.
    document.querySelectorAll('#test-steps .step-state').forEach((b) => {
      b.disabled = !!lock;
      Tooltip.set(b, lock);
    });
    // Assignee is deliberately not gated: it is workflow metadata, not part of the result.
    const substatus = Dropdown.of('substatus-select');
    if (substatus) { substatus.disabled = !!lock; Tooltip.set(substatus.trigger, lock); }
    // Attach gates on a missing result id, not the status: a pending row can have one.
    const noResult = !record?.id;
    // Uploads are JWT-only; 'unknown' is still probing and must never gate, only a proven false.
    const degraded = TestomatAPI.jwtAvailable() === false;
    const reasonFor = (need) => {
      const copy = gateReason({ need });
      return lock ? lock : noResult ? copy.noResult : degraded ? copy.degraded : '';
    };
    // The lock still disables the buttons but stays off their inline line: the group note says it once.
    applyActionGate('btn-screenshot-annotate', 'screenshot-reason', reasonFor('screenshot'), { inline: !lock });
    applyActionGate('btn-attach-file', 'attach-file-reason', reasonFor('file'), { inline: !lock });
    applyActionGate('btn-screen-rec', 'screen-rec-reason', reasonFor('recording'), { inline: !lock });
    // The empty dropzone repeats the gate copy; real rows are not rebuilt, or their thumbnails drop.
    const attList = $('attachment-list');
    if (typeof renderAttachmentList === 'function' && attList && !attList.querySelector('.file-tile-item')) {
      renderAttachmentList();
    }
  }

  // Open by default: a collapsed section reads as "nothing attached". Closing lasts the panel session.
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

  // A failed verdict keeps the tester on the test to attach evidence, so open the section.
  function expandAttachmentsForFailure() {
    openAttachmentsDisclosure();
  }

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
