// The toast at the panel's bottom and a screen's status line; core/views.js keeps the bare names.

/* global $, Icons, Tooltip */

// From `Icons`, not the `StatusIcons.svgIcon` alias: icons.js is the first script loaded.
const ALERT_ICON = 'error';
const PROGRESS_ICON = 'progress_activity';

// A new toast disarms the previous timer.
let toastTimer = null;

const PanelToast = {
  // Auto-hide scales with message length so long messages stay readable.
  duration(msg) {
    const over = Math.max(0, String(msg).length - 40);
    return Math.min(8000, 3500 + over * 50);
  },

  // `{ progress: true }` has no auto-hide: a timer would take the running-job plaque down mid-work.
  show(msg, opts = {}) {
    if (typeof opts === 'number') opts = { ms: opts };
    const el = $('toast');
    const isError = !!opts.error;
    const progress = !!opts.progress;
    const ms = opts.ms != null ? opts.ms : PanelToast.duration(msg);
    clearTimeout(toastTimer);
    el.classList.toggle('error', isError);
    el.classList.toggle('progress', progress);
    // Set before the content lands: a live region is only read for changes made while in the tree.
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.hidden = false;
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;
    el.replaceChildren(text);
    if (isError || progress) {
      const icon = document.createElement('span');
      icon.className = 'toast-icon';
      const mark = Icons.el(isError ? ALERT_ICON : PROGRESS_ICON, 16);
      if (progress) mark.classList.add('spin'); // the shared rotation (SPIN, shared/components.css)
      icon.append(mark);
      el.prepend(icon);
    }
    // Optional inline action, no caller today: the component layer ships `.toast-action`.
    if (opts.action && typeof opts.action.onClick === 'function') {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'btn size-xs toast-action';
      act.textContent = opts.action.label || 'OK';
      act.addEventListener('click', () => {
        clearTimeout(toastTimer);
        el.hidden = true;
        opts.action.onClick();
      });
      el.append(act);
    }
    if (isError) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'icon-btn size-xs toast-dismiss';
      Tooltip.set(x, 'Dismiss');
      x.setAttribute('aria-label', 'Dismiss');
      x.append(Icons.el('close', 16));
      x.addEventListener('click', () => { clearTimeout(toastTimer); el.hidden = true; });
      el.append(x);
    }
    // A step of a running job holds; everything else auto-hides.
    if (!progress) toastTimer = setTimeout(() => { el.hidden = true; el.setAttribute('role', 'status'); }, ms);
  },

  // Never an inline line: it sits under the fold, and a job that dies leaves it standing forever.
  progress: (msg) => PanelToast.show(msg, { progress: true }),

  // For a job whose answer is a status line or nothing; a toast answer just replaces the plaque.
  hide() {
    const el = $('toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.hidden = true;
    el.classList.remove('progress');
    el.setAttribute('role', 'status');
  },

  // A printed line means the job answered, so the plaque goes: no progress toast outlives its work.
  statusLine(id, msg, cls = '') {
    const el = $(id);
    el.textContent = msg;
    el.className = `status-line ${cls}`.trim();
    PanelToast.hide();
  },
};
