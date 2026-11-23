// What a reopened panel may trust: stored-session guards and the editor's one-shot breadcrumb.

// No global list: the filter keys arrive as an argument, and `sessionStorage` is the browser's own.

const SessionRestore = {
  // A stored session may be old JSON from an older panel, so every field is read through a guard.
  fromStored(session, filterKeys) {
    return {
      stepTicks: session?.stepTicks || {},
      expandedGroups: Array.isArray(session?.expandedGroups) ? session.expandedGroups : [],
      runsFilter: filterKeys.has(session?.runsFilter) ? session.runsFilter : 'all',
      // Open unless this user closed it — no key (old session, fresh profile) means the default, open.
      runInfoOpen: session?.runInfoOpen !== false,
      tabViews: (session && session.tabViews && typeof session.tabViews === 'object') ? session.tabViews : {},
      // A session with no activeTab infers 'runs' from a run/test view, so an in-flight run restores.
      activeTab: session?.activeTab
        || ((session?.view === 'run' || session?.view === 'test') ? 'runs' : null),
    };
  },

  // Spent once, so a later reload does not hijack the runs view; unreadable is null, not a throw.
  takeTcReturn() {
    let tcReturn = null;
    try { tcReturn = JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { /* ignore */ }
    if (!tcReturn || !tcReturn.suiteId) return null;
    try { sessionStorage.removeItem('tcReturn'); } catch { /* ignore */ }
    return { suiteId: tcReturn.suiteId, suiteTitle: tcReturn.suiteTitle };
  },
};
