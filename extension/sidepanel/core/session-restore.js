// What a reopened panel is allowed to trust: the guards a stored session is read back through, and
// the one-shot breadcrumb the editor leaves behind. Core — app.js reads both at boot, nothing else.

// No `/* global */` list, the way core/suite-tree.js has none: the filter keys arrive as an ARGUMENT
// and `sessionStorage` is the browser's own, so this file names no other file's global.

const SessionRestore = {
  // Pure. A stored session is last month's JSON written by an older panel, so every field is read
  // through its own guard; `filterKeys` is handed in (screens/runs-list.js) rather than reached for.
  fromStored(session, filterKeys) {
    return {
      stepTicks: session?.stepTicks || {},
      expandedGroups: Array.isArray(session?.expandedGroups) ? session.expandedGroups : [],
      runsFilter: filterKeys.has(session?.runsFilter) ? session.runsFilter : 'all',
      // Open unless this user closed it — no key (old session, fresh profile) means the default, open.
      runInfoOpen: session?.runInfoOpen !== false,
      tabViews: (session && session.tabViews && typeof session.tabViews === 'object') ? session.tabViews : {},
      // Old sessions (no activeTab) infer 'runs' from a persisted run/test view, so an in-flight run restores.
      activeTab: session?.activeTab
        || ((session?.view === 'run' || session?.view === 'test') ? 'runs' : null),
    };
  },

  // The breadcrumb is spent once, so a later plain reload does not hijack the runs view. An
  // unreadable one is null, not a throw: it must not take the whole boot down with it.
  takeTcReturn() {
    let tcReturn = null;
    try { tcReturn = JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { /* ignore */ }
    if (!tcReturn || !tcReturn.suiteId) return null;
    try { sessionStorage.removeItem('tcReturn'); } catch { /* ignore */ }
    return { suiteId: tcReturn.suiteId, suiteTitle: tcReturn.suiteTitle };
  },
};
