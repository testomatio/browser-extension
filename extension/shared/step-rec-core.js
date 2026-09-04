// Step ordering rules of the recording (IIFE global `StepRecCore`): where a line lands, which twins
// a double-click drops, and when a line is final. Pure over the `st` record — Date.now and URL only.

const StepRecCore = (() => {
  // At the cap the recording PAUSES and drops the action; -1 = dropped. Mutates `st` (caller persists).
  function srPush(st, entry, cap) {
    if (st.paused || st.manualPause) return -1;
    if (st.entries.length >= cap) { st.paused = true; return -1; }
    entry.at = Date.now(); // #160: the live pull hands an entry over once it settles
    st.entries.push(entry);
    if (st.entries.length >= cap) st.paused = true;
    return st.entries.length - 1;
  }

  // #86: a page title is a sentence, not an element name — cut at the last word/dash boundary, not mid-word.
  const SR_TITLE_MAX = 80;
  const srTrimTitle = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= SR_TITLE_MAX) return t;
    const cut = t.slice(0, SR_TITLE_MAX);
    const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('-'), cut.lastIndexOf('–'),
      cut.lastIndexOf('—'), cut.lastIndexOf('|'), cut.lastIndexOf('·'));
    return `${cut.slice(0, at > SR_TITLE_MAX / 2 ? at : SR_TITLE_MAX).replace(/[\s\-–—|·:;,]+$/, '')}…`;
  };

  const srCleanTitle = (title, url) => {
    const t = srTrimTitle(title);
    if (t) return t;
    try { return new URL(url).hostname; } catch { return url || 'the'; }
  };

  // One SPA navigation fires the URL/title events twice: collapse consecutive identical AUTO entries
  // onto the first one. A manual expected is the tester's own sentence and is never deduped.
  const srDupNavIdx = (st, text) => {
    const i = st.entries.length - 1;
    const e = st.entries[i];
    return e && e.kind === 'expected' && !e.manual && e.text === text ? i : -1;
  };
  function srPushNav(st, text, cap) {
    const dup = srDupNavIdx(st, text);
    return dup !== -1 ? dup : srPush(st, { kind: 'expected', text }, cap);
  }

  // Trimmed like the recorded URL — queries carry reset tokens. A `#/…` route is the page, not a fragment.
  function srOpenUrl(raw, full) {
    if (full) return raw;
    let u;
    try { u = new URL(raw); } catch { return raw; }
    return `${u.origin}${u.pathname}${u.hash.startsWith('#/') ? u.hash.split('?')[0] : ''}`;
  }

  // Prepend the deferred `Open <url>` step before the first recorded entry.
  function srFlushOpen(st, cap) {
    if (!st.pendingOpen) return;
    srPush(st, { kind: 'step', text: `Open ${st.pendingOpen}` }, cap);
    st.pendingOpen = null;
  }

  // #23: the recorder holds an action for ~400ms to see what it caused, so the navigation that
  // action triggered can reach the worker FIRST. A step landing right behind an AUTO nav line
  // goes in front of it — the page opened BECAUSE of it, and the line belongs under it.
  const SR_NAV_LEAD_MS = 900;
  function srPlace(st, entry, cap) {
    const idx = srPush(st, entry, cap);
    if (idx < 1 || entry.kind !== 'step') return idx;
    const prev = st.entries[idx - 1];
    if (!prev || prev.kind !== 'expected' || prev.manual) return idx;
    if (idx - 1 < (st.sent || 0)) return idx; // already in the editor — never unwrite it (#160)
    if ((entry.at || 0) - (prev.at || 0) > SR_NAV_LEAD_MS) return idx;
    st.entries[idx - 1] = entry;
    st.entries[idx] = prev;
    if (st.lastNavIdx === idx - 1) st.lastNavIdx = idx;
    return idx - 1;
  }

  // Copied field by field on purpose: `replaces` is a wire instruction and must never enter the recording.
  function srEntry(kind, text, entry) {
    const e = { kind, text };
    if (entry.action) e.action = String(entry.action);
    if (entry.name) e.name = String(entry.name);
    if (entry.context && typeof entry.context === 'object') {
      const c = {};
      for (const k of ['row', 'section', 'column']) if (entry.context[k]) c[k] = String(entry.context[k]);
      if (Object.keys(c).length) e.context = c;
    }
    // #23: the action's context packet rides along WHOLE — it is data the editor reads (and
    // may send to the instance's AI), not a wire instruction like `replaces`.
    if (entry.ctx && typeof entry.ctx === 'object') e.ctx = entry.ctx;
    if (kind === 'expected' && entry.manual) e.manual = true; // typed by the tester, not a navigation
    return e;
  }

  // A real double-click fires click, click, dblclick — up to TWO identical entries precede it.
  // Matched on text: a control that renamed itself between the clicks keeps both steps.
  function srPopTwins(st, text) {
    for (let i = 0; i < 2; i++) {
      const last = st.entries[st.entries.length - 1];
      if (!last || last.text !== text) break;
      if (st.entries.length <= (st.sent || 0)) break; // already in the editor — never unwrite it (#160)
      st.entries.pop();
      if (st.lastNavIdx >= st.entries.length) st.lastNavIdx = -1;
    }
  }

  // An entry may only be handed over once it can no longer change: a dblclick pops its twins within
  // milliseconds, while a navigation's real title can land a whole load later — hence two windows.
  const SR_SETTLE_MS = 700;
  const SR_NAV_SETTLE_MS = 3000;

  // The first index that is NOT final yet; everything before it may be handed over.
  function srFinalEnd(st, now) {
    const es = st.entries || [];
    for (let i = 0; i < es.length; i++) {
      const age = now - (es[i].at || 0);
      if (age < SR_SETTLE_MS) return i;
      if (i === st.lastNavIdx && age < SR_NAV_SETTLE_MS) return i;
    }
    return es.length;
  }

  // Chrome fills tab.title with a URL-derived placeholder until the real <title> parses. A title
  // is that placeholder only when it IS the address — host+path+search, the host, or the href.
  function srIsUrlTitle(title, url) {
    const t = (title || '').trim();
    if (!t) return true;
    try {
      const u = new URL(url);
      const bare = (s) => String(s).replace(/\/+$/, '');
      const seen = bare(t);
      return seen === bare(u.host + u.pathname + u.search) || seen === bare(u.host) || seen === bare(u.href);
    } catch { return false; }
  }

  // The title lands AFTER the url change (a later onUpdated, or the re-injected script's
  // document.title): a placeholder is ignored, the first real title wins and then stops rewriting.
  function srRefineNav(st, title, url) {
    if (st.lastNavIdx == null || st.lastNavIdx < 0) return false;
    const e = st.entries[st.lastNavIdx];
    if (!e) return false;
    // Already handed over: the line is the editor's — never rewrite only our copy (#160).
    if (st.lastNavIdx < (st.sent || 0)) { st.lastNavIdx = -1; return false; }
    const t = (title || '').replace(/\s+/g, ' ').trim();
    if (!t || srIsUrlTitle(t, url || st.lastUrl)) return false;
    e.text = `The "${srTrimTitle(t)}" page opens`;
    // The refine itself can produce the twin (the first of the two events carried the stale title).
    const prev = st.entries[st.entries.length - 2];
    if (st.lastNavIdx === st.entries.length - 1 && prev && prev.kind === 'expected'
      && !prev.manual && prev.text === e.text) st.entries.pop();
    st.lastNavIdx = -1;
    return true;
  }

  return {
    srPush, srPlace, srEntry, srPopTwins, srPushNav, srDupNavIdx, srFlushOpen, srFinalEnd,
    srRefineNav, srIsUrlTitle, srTrimTitle, srCleanTitle, srOpenUrl,
    SR_TITLE_MAX, SR_NAV_LEAD_MS, SR_SETTLE_MS, SR_NAV_SETTLE_MS,
  };
})();
