// The log text is written by the page, so every format here escapes it out of markdown.

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

  // An exception row reads `uncaught.*`: no console call made it, so it must not read as one.
  label(e) {
    if (e.kind === 'exception') return `uncaught.${e.level}`;
    return e.kind === 'log' ? `log.${e.level}` : `console.${e.level}`;
  },

  // `trim` is the caller's policy: envTrimUrl where the text is uploaded, nothing on screen.
  loc(e, trim) {
    if (!e.url) return '';
    const url = trim ? trim(e.url) : e.url;
    return `${url}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : ''}`;
  },

  // Stands in for a body the recorder did not read because body capture is off.
  BODY_DISABLED: '(body capture disabled)',

  // The fence is longer than any backtick run inside, so the body cannot break out.
  fence(body) {
    const runs = String(body).match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1));
    return `${fence}\n${body}\n${fence}`;
  },

  // Page-written text: a backtick would close the span and a newline would end the quote.
  inlineCode(text) {
    const s = String(text).replace(/\s+/g, ' ');
    const runs = s.match(/`+/g) || [];
    const ticks = '`'.repeat(runs.reduce((m, r) => Math.max(m, r.length), 0) + 1);
    const pad = /^`|`$/.test(s) ? ' ' : ''; // CommonMark strips one space from each end
    return `${ticks}${pad}${s}${pad}${ticks}`;
  },

  // A console message can quote an address, token and all (our own "Failed to load resource" does).
  trimAddresses(s) {
    return String(s == null ? '' : s).replace(/\bhttps?:\/\/[^\s"'<>`()[\]{}]+/g, (u) => envTrimUrl(u));
  },

  // Uploaded with the comment, so the address is trimmed here (PRIVACY.md); the row keeps it whole.
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
    return `> ${EvidenceFormat.inlineCode(`[${EvidenceFormat.label(e)} ${t}] ${EvidenceFormat.oneLine(EvidenceFormat.trimAddresses(e.text))}`)}`;
  },

  rowText(e) {
    const t = EvidenceFormat.time(e.ts);
    if (e.kind === 'network') {
      return `${EvidenceFormat.netStatus(e)} ${e.method} ${EvidenceFormat.oneLine(e.url, 120)} · ${t}`;
    }
    return `${EvidenceFormat.label(e)} · ${EvidenceFormat.oneLine(e.text, 120)} · ${t}`;
  },

  // Stable across re-renders: `ts` never changes and requestId separates redirect hops.
  key(e) {
    if (e.kind === 'network') return `network:${e.ts}:${e.requestId || `${e.method} ${e.url}`}`;
    return `${e.kind}:${e.ts}:${e.text || ''}`;
  },

  // Icon and severity come together: an icon has no colour of its own, so the two must agree.
  icon(e) {
    if (e.kind === 'network') {
      return e.errorText ? { name: 'block', kind: 'error' } : { name: 'language', kind: 'net' };
    }
    return e.level === 'warning' ? { name: 'warning', kind: 'warning' } : { name: 'error', kind: 'error' };
  },

  // Uploaded onto the result: every address is trimmed, whatever the full-URL setting (PRIVACY.md).
  buildTxt(runTitle, testTitle, entries, status) {
    const lines = [];
    lines.push(`Console & network log — ${runTitle || 'Run'} / ${testTitle || 'Test'}`);
    lines.push(`Recorded tab: ${status.tabTitle || '—'}`);
    if (status.tabUrl) lines.push(`URL: ${envTrimUrl(status.tabUrl)}`);
    // A status with no window falls back to the panel's own, or the file would say "last undefineds".
    const win = Number.isFinite(status.windowSec) ? status.windowSec : evWindowSeconds();
    lines.push(`Window: last ${win}s · ${entries.length} entries · ${new Date().toISOString()}`);
    lines.push('');
    const cons = entries.filter((e) => e.kind !== 'network');
    const nets = entries.filter((e) => e.kind === 'network');
    lines.push(`== Console (${cons.length}) ==`);
    if (!cons.length) lines.push('(none)');
    for (const e of cons) {
      const at = EvidenceFormat.loc(e, envTrimUrl);
      const said = EvidenceFormat.oneLine(EvidenceFormat.trimAddresses(e.text), 500);
      lines.push(`[${EvidenceFormat.time(e.ts)}] ${EvidenceFormat.label(e)}: ${said}${at ? ` (${at})` : ''}`);
    }
    lines.push('');
    lines.push(`== Network (${nets.length}) ==`);
    if (!nets.length) lines.push('(none)');
    for (const e of nets) {
      const rt = e.resourceType ? ` [${e.resourceType}]` : '';
      const err = e.errorText ? ` — ${e.errorText}` : '';
      lines.push(`[${EvidenceFormat.time(e.ts)}] ${EvidenceFormat.netStatus(e)} ${e.method} ${envTrimUrl(e.url)}${rt}${err}`);
      if (e.bodySnippet) {
        for (const bl of e.bodySnippet.split('\n')) lines.push(`    ${bl}`);
        if (e.bodyTruncated) lines.push('    … (truncated)');
      } else if (e.bodySkipped) lines.push(`    ${EvidenceFormat.BODY_DISABLED}`);
    }
    lines.push('');
    return lines.join('\n');
  },
};
