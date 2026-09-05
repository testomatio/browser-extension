// The panel's one confirm dialog: the message, the labelled OK, and a promise for the answer.
// Core, not a screen — settings.js, attachments.js and run-lock.js all ask the same one.

/* global $ */

const ConfirmDialog = {
  // Resolves true on confirm, false on cancel/Esc/backdrop; listeners torn down on close.
  ask(message, confirmLabel = 'Finish run') {
    const dlg = $('confirm-dialog');
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = confirmLabel;
    dlg.showModal();
    return new Promise((resolve) => {
      const done = (val) => {
        $('confirm-ok').removeEventListener('click', onOk);
        $('confirm-cancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(val);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      $('confirm-ok').addEventListener('click', onOk);
      $('confirm-cancel').addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onCancel); // Esc / backdrop
    });
  },
};
