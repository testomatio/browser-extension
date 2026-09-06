#!/usr/bin/env node
// extension/sidepanel/core/toast.js (#202, the second seam out of core/views.js): the plaque at the
// bottom of the panel and the status line a screen prints under its own field.
// The module needs four names — a document, `$`, `Icons` and `Tooltip` — so the sandbox below is a
// `#toast` div, two status paragraphs and stubs for the three. That is the seam's value: the timer
// arithmetic and the one rule that ties a status line to the plaque can be falsified without a tab
// bar, a `state`, eight screen openers or a navigation model standing behind them.
// tests/views.test.mjs keeps its own rows (V69-V81) over the same behaviour as the panel performs
// it, through the bare `toast()` / `setStatusLine()` delegates every screen calls. The duplication
// is deliberate: those say the panel still behaves, these say what the numbers are.
// The auto-hide handle used to be `toast._t`, a property on the function object; it is a private
// `let` now, so "a new toast replaces the previous one" is asserted through the clock instead.
// Run: node --test tests/toast.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el, fakeClock } from './helpers/panel-harness.mjs';

// index.html:816 for the plaque, :569 and :638 for two of the lines a screen writes.
function load() {
  const doc = makeDocument([]);
  const node = {
    toast: el('div', { id: 'toast', className: 'toast', hidden: true }),
    'run-status': el('p', { id: 'run-status', className: 'status-line' }),
    'test-status': el('p', { id: 'test-status', className: 'status-line' }),
  };
  doc.body.append(...Object.values(node));

  const clock = fakeClock(); // a real 3.5s timer would hold the whole test run open

  const h = loadScreen('toast', {
    dir: CORE_SRC,
    document: doc,
    clock,
    globals: {
      $: (id) => doc.getElementById(id),
      // shared/icons.js:238 — the arity matters: `cls` reaches classList.add, which throws on a space.
      Icons: {
        el: (name, size = 16, ...cls) => {
          const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
          n.classList.add(...cls.filter(Boolean));
          return n;
        },
      },
      Tooltip: { set: (n, tip) => { if (n) n.dataset.tip = tip; } },
    },
    exported: 'PanelToast',
  });
  return { ...h, node, toast: h.screen };
}

const say = (n) => 'x'.repeat(n);

// ---------- the seam itself ----------

test('T1 (#202): the plaque and the status line load with a document, $, Icons and Tooltip — nothing else', () => {
  const h = load();
  assert.deepEqual(Object.keys(h.toast).sort(),
    ['duration', 'hide', 'progress', 'show', 'statusLine']);
  h.toast.show('Saved');
  assert.equal(h.node.toast.hidden, false);
});

// ---------- how long a message stays up ----------

test('T2 (#202): a message is up for 3.5s, a word longer for 50ms more, and never past 8s', () => {
  const { toast } = load();
  // The floor: 40 characters is still "short", and nothing shorter buys less time.
  assert.equal(toast.duration(''), 3500);
  assert.equal(toast.duration(say(39)), 3500);
  assert.equal(toast.duration(say(40)), 3500);
  // The 41st character is the first one that is paid for.
  assert.equal(toast.duration(say(41)), 3550);
  assert.equal(toast.duration(say(90)), 6000);
  // The cap lands exactly on 130 characters; one short of it is still counting.
  assert.equal(toast.duration(say(129)), 7950);
  assert.equal(toast.duration(say(130)), 8000);
  assert.equal(toast.duration(say(200)), 8000);
});

test('T3 (#202): a message that is not a string is still measured, not crashed over', () => {
  const { toast } = load();
  assert.equal(toast.duration(null), 3500);
  assert.equal(toast.duration({ toString: () => say(41) }), 3550);
});

test('T4 (#202): the plaque is armed for its own message length, and a caller may name the number', () => {
  const h = load();
  h.toast.show(say(41));
  assert.deepEqual(h.clock.arms(), [3550], 'the timer reads the same rule duration() states');

  // `opts.ms != null`, not truthiness: 0 is a caller saying "take it away at once".
  const z = load();
  z.toast.show('Saved', { ms: 0 });
  assert.deepEqual(z.clock.arms(), [0]);
});

// ---------- one plaque, never two ----------

test('T5 (#202): a new message disarms the one it replaces, so the older timer cannot hide it', async () => {
  const h = load();
  h.toast.show('Uploading the first file');
  const first = h.clock.armed[0].id;

  h.toast.show('Saved');
  assert.ok(h.clock.cleared.includes(first), 'the first timer would have hidden the second message');
  assert.equal(h.clock.count(), 1, 'one plaque, one timer');

  await h.clock.tick();
  assert.equal(h.node.toast.hidden, true);
});

test('T6 (#202): the running-job plaque carries no timer, and does not cost the next message its own', () => {
  const h = load();
  h.toast.progress('Uploading…');
  assert.equal(h.node.toast.classList.contains('progress'), true);
  assert.equal(h.clock.count(), 0, 'a timer would take the plaque down mid-work');

  h.toast.show('Saved');
  assert.equal(h.node.toast.classList.contains('progress'), false);
  assert.deepEqual(h.clock.arms(), [3500], 'the message after a job still goes away on its own');
});

test('T7 (#202): hide() disarms the timer as well as taking the plaque down', () => {
  const h = load();
  h.toast.show('Saved');
  const armed = h.clock.armed[0].id;

  h.toast.hide();
  assert.equal(h.node.toast.hidden, true);
  assert.ok(h.clock.cleared.includes(armed));
  assert.equal(h.clock.count(), 0);
});

// ---------- the line under a field ----------

test('T8 (#202): a line with a tone wears it, and a line without one carries no trailing space', () => {
  const h = load();
  h.toast.statusLine('run-status', 'Saved', 'ok');
  assert.equal(h.node['run-status'].textContent, 'Saved');
  assert.equal(h.node['run-status'].className, 'status-line ok');

  h.toast.statusLine('test-status', '');
  assert.equal(h.node['test-status'].className, 'status-line',
    'a trailing space is a second, empty class name the stylesheet never mentions');
  assert.equal(h.node['test-status'].textContent, '');
});

test('T9 (#202): a line printed takes the plaque down every time, even one nobody is looking at', () => {
  const h = load();
  h.toast.progress('Saving…');
  h.toast.statusLine('run-status', 'Saved', 'ok');
  assert.equal(h.node.toast.hidden, true, 'the job answered, so the plaque over it goes');
  assert.equal(h.clock.count(), 0);

  // Already hidden, but left dirty by an error that was dismissed rather than expired: the call is
  // unconditional, so the live region and the spinner class are handed back here too.
  const t = h.node.toast;
  t.classList.add('progress');
  t.setAttribute('role', 'alert');
  h.toast.statusLine('run-status', 'Saved again');
  assert.equal(t.classList.contains('progress'), false);
  assert.equal(t.getAttribute('role'), 'status');
});

test('T10 (#202): a line the screen does not have throws — hide() guards, this one never has', () => {
  const h = load();
  h.toast.progress('Saving…');
  assert.throws(() => h.toast.statusLine('nope', 'Saved'));
  assert.equal(h.node.toast.hidden, false, 'and the plaque it never reached is still standing');

  h.node.toast.remove();
  h.toast.hide(); // the guarded one, on the same missing node: no throw
});
