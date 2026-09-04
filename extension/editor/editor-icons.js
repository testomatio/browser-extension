// The editor page's glyph names and the one-line wrapper every screen draws them through.
// Its own file because editor.js, params-grid.js and the modules after them all need the same
// names: a copy per module is how two screens quietly end up with different glyphs.

const EditorIcons = (() => {
  const ICON_BACK = 'arrow_back';
  const ICON_ERROR = 'error';
  const ICON_OPEN_IN_NEW = 'open_in_new';
  const ICON_CAMERA = 'photo_camera';
  const ICON_CLOSE = 'close';
  const ICON_ADD = 'add';
  const ICON_MINUS = 'remove';
  const ICON_FOLD = 'chevron_right';
  const ICON_RECORD = 'fiber_manual_record';
  const ICON_STOP = 'stop';
  const ICON_EDIT = 'edit';
  // The markdown mark, not a pencil: the pencil is the Edit button's glyph one screen up.
  const ICON_MARKDOWN = 'markdown';
  const ICON_PREVIEW = 'visibility';
  const ICON_TEMPLATE = 'description';
  const icon = (name, size = 20) => Icons.markup(name, size);

  return {
    icon, ICON_BACK, ICON_ERROR, ICON_OPEN_IN_NEW, ICON_CAMERA, ICON_CLOSE, ICON_ADD, ICON_MINUS, ICON_FOLD,
    ICON_RECORD, ICON_STOP, ICON_EDIT, ICON_MARKDOWN, ICON_PREVIEW, ICON_TEMPLATE,
  };
})();
