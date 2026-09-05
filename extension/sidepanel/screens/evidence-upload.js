// The .txt that goes onto a failed result — the recorder's whole window, uploaded and handed back as
// the URL its META key carries. It leaves the browser on every FAIL, so it is worth reading alone.

// `evSend` and `evidenceAutoAttachEnabled` stay in screens/evidence.js and `EvidenceFormat` is the
// escaping layer beside it — all three late-bound globals, reached only when a test is marked failed.
/* global evSend, evidenceAutoAttachEnabled, EvidenceFormat, TestomatAPI, state, $, toast */

const EvidenceUpload = {
  // Uploads the window as .txt and returns its URL for the `Console & network log`
  // META key (#116); '' writes no key. Runs AFTER the status save, so record.id exists.
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
