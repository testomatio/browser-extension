// What a pasted run link or a bare run id is allowed to mean, and the one message every
// unresolvable one gets. The parsers read `state` alone; only the reporter touches the panel.

/* global state, setStatusLine, toast */

const RunsUrl = {
  // One message for every unresolvable link (#106) — wrong host, wrong project,
  // unknown id, no access. Deliberately blunt: no offer to switch project.
  NOT_FOUND: 'Run not found',

  // The list's own line, because a toast is wiped by the next toast or status line and it is not.
  reportNotFound(msg = RunsUrl.NOT_FOUND) {
    if (state.view === 'runs') setStatusLine('runs-status', msg, 'error');
    else toast(msg, { error: true }); // a line on a hidden view would be invisible
  },

  // A scheme, or the bare `host/projects/…/runs/…` shape copied from the address
  // bar. Must stay narrow — a URL-shaped value is never used as a title filter.
  looksLikeRunUrl(raw) {
    const v = String(raw || '').trim();
    if (!v || /\s/.test(v)) return false;
    return /^https?:\/\//i.test(v) || /\/projects\/[^/]+\/runs\//.test(v);
  },

  // What the link itself says — no settings read, so a foreign host or project is the
  // caller's to judge. null for anything that is not a run/group link.
  parseParts(raw) {
    const v = String(raw || '').trim();
    let u;
    try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
    // Group shape first — the run pattern would capture the literal "groups" as an id.
    const gm = u.pathname.match(/\/projects\/([^/]+)\/runs\/groups\/([^/]+)/);
    if (gm) return { host: u.hostname, projectId: gm[1], kind: 'group', id: gm[2] };
    // The web's "Copy url" slugs the run segment (`<uid>-<kebab-title>`) and its
    // route reads back only `id.split('-')[0]` — mirror it or every copied link 404s.
    const rm = u.pathname.match(/\/projects\/([^/]+)\/runs\/([^/]+)/);
    if (rm) return { host: u.hostname, projectId: rm[1], kind: 'run', id: rm[2].split('-')[0] };
    return null;
  },

  // Resolved against the configured host + project; null for anything else.
  parse(raw) {
    const parts = RunsUrl.parseParts(raw);
    if (!parts) return null;
    let cfgHost;
    try { cfgHost = new URL(state.settings.baseUrl).hostname; } catch { return null; }
    if (parts.host !== cfgHost) return null;
    if (parts.projectId !== state.settings.projectId) return null;
    return { kind: parts.kind, id: parts.id };
  },

  // Real ids are 8 hex chars; 6–12 tolerates a trimmed or over-copied paste. A bare id
  // can never be URL-shaped, so the two search intents cannot collide.
  looksLikeRunId: (raw) => /^[0-9a-f]{6,12}$/i.test(String(raw || '').trim()),

  searchRunId: () => (RunsUrl.looksLikeRunId(state.runsSearch) ? state.runsSearch.trim() : null),
};
