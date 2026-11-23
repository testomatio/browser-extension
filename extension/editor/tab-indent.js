// Tab / Shift+Tab move the caret's line in the Markdown editor; Esc then Tab leaves it.

const TabIndent = (() => {
  const STEP = '  ';
  const OUTDENT_RE = /^( {1,2}|\t)/;

  // The slice to replace, its new text and the caret after; null when nothing moves.
  function lineEdit(value, caret, outdent) {
    const start = caret === 0 ? 0 : value.lastIndexOf('\n', caret - 1) + 1;
    const nl = value.indexOf('\n', caret);
    const end = nl === -1 ? value.length : nl;
    const line = value.slice(start, end);
    const text = outdent ? line.replace(OUTDENT_RE, '') : STEP + line;
    if (text === line) return null;
    return { start, end, text, caret: Math.max(start, caret + text.length - line.length) };
  }

  // Through insertText so the browser's undo keeps the step; setRangeText where that is refused.
  function apply(textarea, { start, end, text, caret }) {
    textarea.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { done = false; }
    if (!done) textarea.setRangeText(text, start, end, 'end');
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Capture on the host runs before the editor's own keydown, which handles a Tab over a selection.
  function attach(host, textarea) {
    let released = false; // Esc was the last key: the next Tab leaves the field
    host.addEventListener('keydown', (e) => {
      if (e.target !== textarea) return;
      if (e.key === 'Escape') { released = true; return; }
      if (e.key !== 'Tab') { if (e.key !== 'Shift') released = false; return; }
      if (released) { released = false; e.stopPropagation(); return; } // the browser moves focus
      if (e.ctrlKey || e.metaKey || e.altKey || textarea.readOnly || textarea.disabled) return;
      if (textarea.selectionStart !== textarea.selectionEnd) return;
      e.preventDefault();
      e.stopPropagation();
      const edit = lineEdit(textarea.value, textarea.selectionStart, e.shiftKey);
      if (edit) apply(textarea, edit);
    }, true);
    textarea.addEventListener('blur', () => { released = false; });
  }

  return { lineEdit, attach };
})();
