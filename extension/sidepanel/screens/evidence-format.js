// Formatting and escaping for the console & network log — the row line, the snippet Attach quotes
// into the comment, the uploaded .txt. The text is the page's, so the escaping keeps it out of markdown.

// `envTrimUrl` (core/env-info.js) and `evWindowSeconds` (screens/evidence.js) are reached as
// late-bound globals, the way every module here reaches a shared helper — both only at call time.
/* global envTrimUrl, evWindowSeconds */

const EvidenceFormat = {
  time(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  oneLine(s, max = 200) {
    const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  },

  netStatus(e) { return e.errorText ? (e.status || 'ERR') : (e.status != null ? e.status : '—'); },

  // `uncaught` (#163) is an exception or unhandled rejection — no console call made
  // that row, so it must not read as one.
  label(e) {
    if (e.kind === 'exception') return `uncaught.${e.level}`;
    return e.kind === 'log' ? `log.${e.level}` : `console.${e.level}`;
  },

  // source:line:col — the col only an uncaught row carries. `trim` is the CALLER's policy
  // (envTrimUrl where the text is uploaded, nothing on screen); the line and col never change.
  loc(e, trim) {
    if (!e.url) return '';
    const url = trim ? trim(e.url) : e.url;
    return `${url}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : ''}`;
  },

  // Stands in for a body the recorder deliberately did not read (#95 toggle OFF).
  BODY_DISABLED: '(body capture disabled)',

  // The fence is longer than any backtick run inside, so the body cannot break out.
  fence(body) {
    const runs = String(body).match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1));
    return `${fence}\n${body}\n${fence}`;
  },

  // #175: message/url/errorText are written by the PAGE — a backtick would close the
  // inline span and hand the rest to the markdown renderer; a newline ends the quote.
  inlineCode(text) {
    const s = String(text).replace(/\s+/g, ' ');
    const runs = s.match(/`+/g) || [];
    const ticks = '`'.repeat(runs.reduce((m, r) => Math.max(m, r.length), 0) + 1);
    const pad = /^`|`$/.test(s) ? ' ' : ''; // CommonMark strips one space from each end
    return `${ticks}${pad}${s}${pad}${ticks}`;
  },

  // Goes into the tester's comment, which is UPLOADED with the result — so the address is
  // trimmed here, exactly as the .txt trims its own (PRIVACY.md); the on-screen row keeps it whole.
  entrySnippet(e) {
    const t = EvidenceFormat.time(e.ts);
    if (e.kind === 'network') {
      const url = envTrimUrl(e.url);
      const inner = e.errorText
        ? `${EvidenceFormat.netStatus(e)} ${e.method} ${url} ${e.errorText} ${t}`
        : `${EvidenceFormat.netStatus(e)} ${e.method} ${url} ${t}`;
      let out = `> ${EvidenceFormat.inlineCode(`[${inner}]`)}`;
      if (e.bodySnippet) {
        out += `\n\n${EvidenceFormat.fence(e.bodySnippet + (e.bodyTruncated ? '\n… (truncated)' : ''))}`;
      }
      return out;
    }
    return `> ${EvidenceFormat.inlineCode(`[${EvidenceFormat.label(e)} ${t}] ${EvidenceFormat.oneLine(e.text)}`)}`;
  },

  rowText(e) {
    const t = EvidenceFormat.time(e.ts);
    if (e.kind === 'network') {
      return `${EvidenceFormat.netStatus(e)} ${e.method} ${EvidenceFormat.oneLine(e.url, 120)} · ${t}`;
    }
    return `${EvidenceFormat.label(e)} · ${EvidenceFormat.oneLine(e.text, 120)} · ${t}`;
  },

  // Stable across re-renders (#150): `ts` is stamped once and never rewritten, the
  // requestId separates redirect hops, and page-hook rows carry no requestId.
  key(e) {
    if (e.kind === 'network') return `network:${e.ts}:${e.requestId || `${e.method} ${e.url}`}`;
    return `${e.kind}:${e.ts}:${e.text || ''}`;
  },

  // Returns the icon AND the severity that colours it — an icon carries no colour
  // of its own, and the two must never disagree.
  icon(e) {
    if (e.kind === 'network') {
      return e.errorText ? { name: 'block', kind: 'error' } : { name: 'language', kind: 'net' };
    }
    return e.level === 'warning' ? { name: 'warning', kind: 'warning' } : { name: 'error', kind: 'error' };
  },

  // Readable .txt artifact (header + Console + Network sections) for auto-attach. UPLOADED onto the
  // result, so every address in it goes through envTrimUrl — a query string carries tokens (PRIVACY.md).
  // Unconditional, unlike the env meta's one line: this file is every request of a whole minute, and
  // it stays on the result for the team to read, so the full-URL setting deliberately does not reach it.
  buildTxt(runTitle, testTitle, entries, status) {
    const lines = [];
    lines.push(`Console & network log — ${runTitle || 'Run'} / ${testTitle || 'Test'}`);
    lines.push(`Recorded tab: ${status.tabTitle || '—'}`);
    if (status.tabUrl) lines.push(`URL: ${envTrimUrl(status.tabUrl)}`);
    // A status with no window would write "last undefineds" into a file that is uploaded onto
    // the result: the panel's own kept window stands in, the way every other field here falls back.
    const win = Number.isFinite(status.windowSec) ? status.windowSec : evWindowSeconds();
    lines.push(`Window: last ${win}s · ${entries.length} entries · ${new Date().toISOString()}`);
    lines.push('');
    const cons = entries.filter((e) => e.kind !== 'network');
    const nets = entries.filter((e) => e.kind === 'network');
    lines.push(`== Console (${cons.length}) ==`);
    if (!cons.length) lines.push('(none)');
    for (const e of cons) {
      const at = EvidenceFormat.loc(e, envTrimUrl);
      const said = EvidenceFormat.oneLine(e.text, 500);
      lines.push(`[${EvidenceFormat.time(e.ts)}] ${EvidenceFormat.label(e)}: ${said}${at ? ` (${at})` : ''}`);
    }
    lines.push('');
    lines.push(`== Network (${nets.length}) ==`);
    if (!nets.length) lines.push('(none)');
    for (const e of nets) {
      const rt = e.resourceType ? ` [${e.resourceType}]` : '';
      const err = e.errorText ? ` — ${e.errorText}` : '';
      lines.push(`[${EvidenceFormat.time(e.ts)}] ${EvidenceFormat.netStatus(e)} ${e.method} ${envTrimUrl(e.url)}${rt}${err}`);
      // The captured response body, indented under its request.
      if (e.bodySnippet) {
        for (const bl of e.bodySnippet.split('\n')) lines.push(`    ${bl}`);
        if (e.bodyTruncated) lines.push('    … (truncated)');
      } else if (e.bodySkipped) lines.push(`    ${EvidenceFormat.BODY_DISABLED}`);
    }
    lines.push('');
    return lines.join('\n');
  },
};
