// The recorder's window leaves the browser on every failed result, so this upload lives alone.

/* global evSend, evidenceAutoAttachEnabled, EvidenceFormat, TestomatAPI, state, $, toast */

const EvidenceUpload = {
  // Returns the URL for the `Console & network log` META key; '' writes no key.
  async log(record) {
    if (!record || !record.id) return '';
    if (!evidenceAutoAttachEnabled(state.settings)) return '';
    const st = await evSend({ type: 'EVIDENCE_STATUS' });
    if (!st || !st.ok || !st.status.recording) return '';
    const snap = await evSend({ type: 'EVIDENCE_SNAPSHOT' });
    if (!snap || !snap.ok) return '';
    const entries = snap.entries || [];
    const testTitle = record.test_title || ($('test-title') && $('test-title').textContent) || '';
    const txt = EvidenceFormat.buildTxt(state.runTitle, testTitle, entries, snap.status || {});
    try {
      const blob = new Blob([txt], { type: 'text/plain' });
      const res = await TestomatAPI.uploadAttachment(record.id, blob, `evidence-${record.id}-${Date.now()}.txt`);
      const url = res && res.url;
      if (!url) throw new Error('upload returned no url');
      return url;
    } catch (e) {
      // Non-fatal: the status write already succeeded — only the log couldn't attach.
      toast(`Test marked failed — the console & network log couldn't attach (${e.message})`, { error: true });
      return '';
    }
  },
};
