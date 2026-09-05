// The "Add new test" bar pinned under the TC list: one title, or a whole pasted list under Bulk.
// Its own file, not the Tests screen's — app.js wires its four handlers, tc-studio.js resets it.

/* global $, state, TestomatAPI, Tooltip, baseUrlHost, toast, resetTcSearch, loadTcList */

// ---------- Add new test: the quick/bulk bar (#3) ----------
// Quick mode creates ONE test from a title, bulk mode a whole list in a single request.
// Both append at the end of the suite, which is where the re-read finds them.

// Lines parked while quick mode shows only the first of them — Bulk gets them back.
let tcQuickParked = [];
let tcQuickBusy = false;

// '' = the whole list can go out, else why not. Bulk rides the WEB session (jwtRequest) while a
// single title does not, so a token-only panel must not be offered a switch its request would refuse.
const tcBulkLock = () => {
  // 'unknown' is still probing and must never gate — only an explicit refusal does.
  return TestomatAPI.jwtAvailable() === false
    ? `Bulk needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
    : '';
};

const TcQuickBar = {
  bulkOn: () => !!$('tc-quick-bulk')?.checked,

  // One space between words and none at the ends, the way the web trims a title.
  title: () => String($('tc-quick-title').value).replace(/\s+/g, ' ').trim(),

  // Order kept and duplicates left alone: the tester typed the list they meant.
  lines: () =>
    String($('tc-quick-titles').value).split('\n').map((s) => s.trim()).filter(Boolean),

  // What the button would send, in either mode.
  titles: () => (TcQuickBar.bulkOn() ? TcQuickBar.lines() : [TcQuickBar.title()].filter(Boolean)),

  // Nothing to send, or a send already out — either way there is nothing to press.
  sync() {
    const btn = $('tc-quick-create');
    if (btn) btn.disabled = tcQuickBusy || !TcQuickBar.titles().length;
  },

  // The fields stay READ-ONLY rather than disabled: a title in flight is still the tester's to read.
  setBusy(busy) {
    tcQuickBusy = busy;
    $('tc-quick-title').readOnly = busy;
    $('tc-quick-titles').readOnly = busy;
    const lock = tcBulkLock();
    $('tc-quick-bulk').disabled = busy || !!lock;
    // The tip sits on the LABEL: a disabled input answers no pointer, so its own tip would never show.
    Tooltip.set($('tc-quick-bulk').parentElement, lock || 'Add more');
    $('tc-quick-create').textContent = busy ? 'Creating…' : 'Create';
    TcQuickBar.sync();
  },

  // Every suite open starts the bar clean — quick mode, both fields empty, nothing parked.
  reset() {
    const input = $('tc-quick-title');
    const area = $('tc-quick-titles');
    if (!input || !area) return;
    tcQuickParked = [];
    input.value = '';
    area.value = '';
    $('tc-quick-bulk').checked = false;
    input.hidden = false;
    area.hidden = true;
    TcQuickBar.setBusy(false);
  },

  // The text follows the switch, as it does in the web widget: the quick field is the FIRST line
  // of the list, and the lines under it wait in memory for Bulk to come back.
  onBulkToggle() {
    const input = $('tc-quick-title');
    const area = $('tc-quick-titles');
    const bulk = TcQuickBar.bulkOn();
    if (bulk) {
      area.value = [input.value.trim(), ...tcQuickParked].filter(Boolean).join('\n');
      tcQuickParked = [];
      input.value = '';
    } else {
      const lines = TcQuickBar.lines();
      input.value = lines[0] || '';
      tcQuickParked = lines.slice(1);
      area.value = '';
    }
    input.hidden = bulk;
    area.hidden = !bulk;
    (bulk ? area : input).focus();
    TcQuickBar.sync();
  },

  onInput: () => TcQuickBar.sync(),

  // Quick: Enter creates, and a modifier held with it does nothing (web parity). Bulk: Enter is a
  // newline, Cmd/Ctrl+Enter the create. Panel hotkeys never see either — hotkeys.js skips fields.
  onKeydown(e) {
    if (e.key !== 'Enter') return;
    if (TcQuickBar.bulkOn()) {
      if (!e.metaKey && !e.ctrlKey) return;
    } else if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }
    e.preventDefault();
    TcQuickBar.submit();
  },

  async submit() {
    const titles = TcQuickBar.titles();
    if (tcQuickBusy || !titles.length || !state.tcSuiteId) return;
    const bulk = TcQuickBar.bulkOn();
    // The web session can lapse between opening the suite and pressing Create.
    const lock = bulk ? tcBulkLock() : '';
    if (lock) { toast(lock); return; }
    const suiteId = state.tcSuiteId;
    const field = bulk ? $('tc-quick-titles') : $('tc-quick-title');
    TcQuickBar.setBusy(true);
    try {
      if (bulk) await TestomatAPI.bulkCreateTests(suiteId, titles);
      else await TestomatAPI.createTest({ title: titles[0], suite_id: suiteId });
      field.value = '';
      if (bulk) tcQuickParked = [];
      resetTcSearch(); // a live filter would hide the very row just made
      await loadTcList(suiteId, { quiet: true });
      // The new tests are appended, so the end of the list is where they landed. The page's own
      // bottom, not the last row: scrolled all the way, the pinned bar sits under the list, over nothing.
      if (state.tcSuiteId === suiteId) window.scrollTo({ top: document.documentElement.scrollHeight });
    } catch (e) {
      toast(e.message || String(e)); // the typed titles stay in the field
    } finally {
      TcQuickBar.setBusy(false);
      if (state.tcSuiteId === suiteId) field.focus();
    }
  },
};
