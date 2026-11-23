// Recording step order: where a line lands, which double-click twins drop, when a line is final.

const StepRecCore = (() => {
  // At the cap the recording pauses and drops the action (-1); mutates `st`, the caller persists.
  function srPush(st, entry, cap) {
    if (st.paused || st.manualPause) return -1;
    if (st.entries.length >= cap) { st.paused = true; return -1; }
    entry.at = Date.now(); // the live pull hands an entry over once it settles
    st.entries.push(entry);
    if (st.entries.length >= cap) st.paused = true;
    return st.entries.length - 1;
  }

  // A page title is a sentence: cut at the last word/dash boundary, not mid-word.
  const SR_TITLE_MAX = 80;
  const srTrimTitle = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= SR_TITLE_MAX) return t;
    const cut = t.slice(0, SR_TITLE_MAX);
    const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('-'), cut.lastIndexOf('–'),
      cut.lastIndexOf('—'), cut.lastIndexOf('|'), cut.lastIndexOf('·'));
    return `${cut.slice(0, at > SR_TITLE_MAX / 2 ? at : SR_TITLE_MAX).replace(/[\s\-–—|·:;,]+$/, '')}…`;
  };

  // Chrome's placeholder is the address, query and all: such a page is named by its host.
  const srCleanTitle = (title, url) => {
    const t = srIsUrlTitle(title, url) ? '' : srTrimTitle(title);
    if (t) return t;
    try { return new URL(url).hostname; } catch { return url || 'the'; }
  };

  // One SPA navigation fires URL/title events twice; a manual expected is never deduped.
  const srDupNavIdx = (st, text) => {
    const i = st.entries.length - 1;
    const e = st.entries[i];
    return e && e.kind === 'expected' && !e.manual && e.text === text ? i : -1;
  };
  function srPushNav(st, text, cap) {
    const dup = srDupNavIdx(st, text);
    return dup !== -1 ? dup : srPush(st, { kind: 'expected', text }, cap);
  }

  // Queries are cut (they carry reset tokens); a `#/…` route is the page, not a fragment.
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

  // The recorder holds an action ~400ms, so its nav can arrive first; the step goes back in front.
  const SR_NAV_LEAD_MS = 900;
  function srPlace(st, entry, cap) {
    const idx = srPush(st, entry, cap);
    if (idx < 1 || entry.kind !== 'step') return idx;
    const prev = st.entries[idx - 1];
    if (!prev || prev.kind !== 'expected' || prev.manual) return idx;
    if (idx - 1 < (st.sent || 0)) return idx; // already in the editor — never unwrite it
    if ((entry.at || 0) - (prev.at || 0) > SR_NAV_LEAD_MS) return idx;
    st.entries[idx - 1] = entry;
    st.entries[idx] = prev;
    if (st.lastNavIdx === idx - 1) st.lastNavIdx = idx;
    return idx - 1;
  }

  // Field by field on purpose: `replaces` is a wire instruction and must never enter the recording.
  function srEntry(kind, text, entry) {
    const e = { kind, text };
    if (entry.action) e.action = String(entry.action);
    if (entry.name) e.name = String(entry.name);
    if (entry.context && typeof entry.context === 'object') {
      const c = {};
      for (const k of ['row', 'section', 'column']) if (entry.context[k]) c[k] = String(entry.context[k]);
      if (Object.keys(c).length) e.context = c;
    }
    // The context packet rides along whole: it is data the editor reads, not a wire instruction.
    if (entry.ctx && typeof entry.ctx === 'object') e.ctx = entry.ctx;
    if (kind === 'expected' && entry.manual) e.manual = true; // typed by the tester, not a navigation
    return e;
  }

  // A double-click fires click, click, dblclick; matched on text, so a renamed control keeps both.
  function srPopTwins(st, text) {
    for (let i = 0; i < 2; i++) {
      const last = st.entries[st.entries.length - 1];
      if (!last || last.text !== text) break;
      if (st.entries.length <= (st.sent || 0)) break; // already in the editor — never unwrite it
      st.entries.pop();
      if (st.lastNavIdx >= st.entries.length) st.lastNavIdx = -1;
    }
  }

  // Final once it can't change: twins pop within ms, a nav's real title can land a load later.
  const SR_SETTLE_MS = 700;
  const SR_NAV_SETTLE_MS = 3000;

  // The first index that is not final yet; everything before it may be handed over.
  function srFinalEnd(st, now) {
    const es = st.entries || [];
    for (let i = 0; i < es.length; i++) {
      const age = now - (es[i].at || 0);
      if (age < SR_SETTLE_MS) return i;
      if (i === st.lastNavIdx && age < SR_NAV_SETTLE_MS) return i;
    }
    return es.length;
  }

  // Chrome's URL-derived placeholder title for a page with none: the host alone, or host and more.
  function srIsUrlTitle(title, url) {
    const t = (title || '').trim();
    if (!t) return true;
    try {
      const u = new URL(url);
      const seen = t.toLowerCase().replace(/^[a-z][a-z\d+.-]*:\/\//, '').replace(/\/+$/, '');
      const host = u.host.toLowerCase();
      return seen === host || (seen.startsWith(host) && /^[/?#]/.test(seen.slice(host.length)));
    } catch { return false; }
  }

  // The title lands after the url change: placeholders are ignored, the first real title wins.
  function srRefineNav(st, title, url) {
    if (st.lastNavIdx == null || st.lastNavIdx < 0) return false;
    const e = st.entries[st.lastNavIdx];
    if (!e) return false;
    // Already handed over: the line is the editor's — never rewrite only our copy.
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
