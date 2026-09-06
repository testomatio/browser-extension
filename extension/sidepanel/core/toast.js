// The panel's two ways of saying something: the toast at the bottom of the panel, and the status
// line a screen prints under its own field. Read by core/views.js, which keeps the bare names.

/* global $, Icons, Tooltip */

// Drawn from `Icons` (shared/icons.js), not the `StatusIcons.svgIcon` alias: the toast is
// core's own, and icons.js is the first script the page loads.
const ALERT_ICON = 'error';
const PROGRESS_ICON = 'progress_activity';

// The auto-hide handle. It was a property on the `toast` function object; module-private is the
// same single slot, and the rule it exists for is that a new toast disarms the previous timer.
let toastTimer = null;

const PanelToast = {
  // Auto-hide scales with message length so long messages stay readable.
  duration(msg) {
    const over = Math.max(0, String(msg).length - 40);
    return Math.min(8000, 3500 + over * 50);
  },

  // A new toast always replaces the previous one. Error toasts mirror the product's
  // error notify (custom-notify.scss `.error.alert`) and still auto-hide.
  // `{ progress: true }` is the running-job plaque: a spinner, no auto-hide, and it stands
  // until the next toast or hide() — a timer would take it down mid-work.
  show(msg, opts = {}) {
    if (typeof opts === 'number') opts = { ms: opts };
    const el = $('toast');
    const isError = !!opts.error;
    const progress = !!opts.progress;
    const ms = opts.ms != null ? opts.ms : PanelToast.duration(msg);
    clearTimeout(toastTimer);
    el.classList.toggle('error', isError);
    el.classList.toggle('progress', progress);
    // Set BEFORE the content lands: a live region is only read for changes made while
    // it is in the tree. alert interrupts, status waits; reverted when the toast hides.
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
    // Optional inline action (`{ action: { label, onClick } }`) — no caller today;
    // kept because the component layer ships and documents `.toast-action`.
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

  // What the panel is DOING right now — the bottom plaque, never an inline status line: the
  // line sits under the fold on a long screen, and a job that dies leaves it standing forever.
  progress: (msg) => PanelToast.show(msg, { progress: true }),

  // Takes down whatever is up. The end of a job whose ANSWER is a status line (or nothing at
  // all) calls this; an answer that is itself a toast just replaces the plaque.
  hide() {
    const el = $('toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.hidden = true;
    el.classList.remove('progress');
    el.setAttribute('role', 'status');
  },

  // A screen printing its own line is a job that has ANSWERED, so the running-job plaque goes
  // with it — the one rule that keeps a progress toast from outliving its work, wherever the
  // flow happens to end. A flow that ends printing nothing calls hide() itself.
  statusLine(id, msg, cls = '') {
    const el = $(id);
    el.textContent = msg;
    el.className = `status-line ${cls}`.trim();
    PanelToast.hide();
  },
};
