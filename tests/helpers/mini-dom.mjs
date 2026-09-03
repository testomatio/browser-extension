// A hand-made page for `node --test`. The side-panel screens build their UI out of elements, so
// almost everything worth testing about them is a decision about a node — and this repo has no
// package.json and no node_modules, so there is no jsdom to borrow one from. This is the stand-in
// every test fixture is made of: `el`/`text` build nodes, `makeDocument()` builds the `document`
// that goes into a `runInNewContext` sandbox, and `fire()` is the only way into a handler that a
// render wired up. Imported by tests/*.test.mjs only — nothing under extension/ may ever load it.
//
// Pre-created ids: `makeDocument(['test-status', 'ul#tc-tree'])` creates one element per entry and
// appends it to <body>, so a screen reaching for its mount points finds them. An entry is an id on
// its own (a <div>) or an id qualified with a tag (`ul#tc-tree`); `getElementById` then answers
// that element — the same node every time it is asked, because it is looked up in the tree.
//
// Where it diverges from a browser, each divergence earned by a test:
//   * querySelectorAll returns a PLAIN ARRAY — every caller spreads it or reads indexOf on it;
//   * document order is depth-first, node then children, because indexOf on that array is how a
//     recorded step's position is computed;
//   * append('<b>hi</b>') is ONE TEXT NODE — nothing here parses HTML, and nothing ever should;
//   * a property assigned to a node stays verbatim (`el.hidden === true`), while getAttribute, the
//     selector engine and `attributes` all report it, so el('input', { type: 'checkbox' }) answers
//     input[type="checkbox"] the way a reflected attribute does in a browser — the three views
//     agree, or a walk over `attributes` would miss a href the selectors can still see;
//   * events do not bubble: fire() runs the listeners registered on the node it is handed;
//   * `=` and `*=` are the only attribute operators the selector engine knows;
//   * layout is TOLD, never computed: offsetLeft/Top/Width/Height are plain numbers a fixture
//     writes, and getBoundingClientRect() is built out of them;
//   * a computed member (see computed(): the element siblings, `labels`, `selectedOptions` and the
//     table shape) is overwritable, and an override is the property alone — never an attribute;
//   * createTreeWalker() hands back a SNAPSHOT: nothing here re-walks when the tree moves;
//   * composedPath() crosses shadow roots and stops at the topmost node — no document, no window.

// The node's own machinery: never copied as a user property by cloneNode, never read as an
// attribute by the selector engine. Layout, `style` and a shadow root belong here too — a browser
// reflects none of them as an attribute, and a clone builds its own from its constructor.
const STRUCT = new Set(['tagName', 'nodeType', 'nodeValue', 'childNodes', 'parentElement', 'listeners',
  'style', 'shadowRoot', 'pointerCapture', 'overrides', 'root',
  'offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight']);

function detach(node) {
  const parent = node.parentElement;
  if (!parent) return;
  const i = parent.childNodes.indexOf(node);
  if (i >= 0) parent.childNodes.splice(i, 1);
  node.parentElement = null;
}

// The two shapes append() takes besides a node: a string becomes text, a fragment hands over its
// children and empties. Everything is detached from its old parent first — a move, not a copy.
function incoming(parent, nodes) {
  const out = [];
  for (const n of nodes) {
    if (n == null || n === false) continue; // `el('div', null, badge && badge)` is how a fixture reads
    if (typeof n !== 'object') out.push(new MiniText(n));
    else if (n.nodeType === 11) out.push(...n.childNodes.splice(0));
    else out.push(n);
  }
  for (const n of out) { detach(n); n.parentElement = parent; }
  return out;
}

// Depth-first, node then children — indexOf on this order is how a step's position is computed.
function walk(root, out = []) {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    out.push(child);
    walk(child, out);
  }
  return out;
}

// The same order with the text nodes kept — what a TreeWalker hands out run by run.
function walkAll(root, out = []) {
  for (const child of root.childNodes) {
    out.push(child);
    walkAll(child, out);
  }
  return out;
}

// The next or previous ELEMENT: the whitespace between two <li>s is not a sibling anyone means.
function sibling(node, step) {
  const kids = node.parentElement ? node.parentElement.childNodes : [];
  for (let i = kids.indexOf(node) + step; i >= 0 && i < kids.length; i += step) {
    if (kids[i].nodeType === 1) return kids[i];
  }
  return null;
}

// The root a node lives in: the document it is attached to, or a component's shadow root.
function rootOf(node) {
  let n = node;
  while (n.parentElement) n = n.parentElement;
  return n.root || (n.host ? n : null);
}

// An event's path, the way composedPath() reports it: the target, its ancestors, and the host of
// every shadow root on the way out — which is how a click inside a pill is recognised as the pill's.
function pathOf(node) {
  const out = [];
  for (let n = node; n; n = n.parentElement || n.host || null) out.push(n);
  return out;
}

// ---------- selectors ----------

const TOKEN = /:scope|\*|#[-\w]+|\.[-\w]+|\[[^\]]*\]|[-\w]+/g;
const unquote = (v) => v.replace(/^["']|["']$/g, '');

// One compound: a tag, #id, .class, [attr] / [attr=value], * and :scope, in any order.
function parseCompound(src) {
  const cmp = { tag: null, id: null, classes: [], attrs: [], scope: false };
  for (const t of src.match(TOKEN) || []) {
    if (t === ':scope') cmp.scope = true;
    else if (t === '*') continue;
    else if (t[0] === '#') cmp.id = t.slice(1);
    else if (t[0] === '.') cmp.classes.push(t.slice(1));
    else if (t[0] === '[') {
      // `*=` as well as `=`: a page's chrome is found by a class SUBSTRING ([class*="toast"]).
      const m = /^\[([-\w]+)(?:(\*?=)(.*))?\]$/.exec(t);
      cmp.attrs.push({ name: m[1], op: m[2] || null, value: m[3] === undefined ? null : unquote(m[3]) });
    } else cmp.tag = t.toUpperCase();
  }
  return cmp;
}

// A complex selector as steps, left to right; `comb` is the combinator in FRONT of each compound.
function parseSelector(sel) {
  const steps = [];
  let buf = '';
  let comb = null;
  let depth = 0;
  const flush = () => { if (buf) { steps.push({ comb, cmp: parseCompound(buf) }); buf = ''; comb = ' '; } };
  for (const ch of sel.trim()) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) { flush(); continue; }
    if (depth === 0 && ch === '>') { flush(); comb = '>'; continue; }
    buf += ch;
  }
  flush();
  return steps;
}

// Commas inside an attribute value are not separators — the split has to see the brackets.
function splitList(sel) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of sel) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function matchCompound(node, cmp, scope) {
  if (node.nodeType !== 1) return false;
  if (cmp.scope && node !== scope) return false;
  if (cmp.tag && node.tagName !== cmp.tag) return false;
  if (cmp.id && node.id !== cmp.id) return false;
  for (const c of cmp.classes) if (!node.classList.contains(c)) return false;
  for (const a of cmp.attrs) {
    const v = node.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && (a.op === '*=' ? !v.includes(a.value) : v !== a.value)) return false;
  }
  return true;
}

// Right to left, the way a browser does it: the rightmost compound decides, the rest is ancestry.
function matchSteps(node, steps, i, scope) {
  if (!node || !matchCompound(node, steps[i].cmp, scope)) return false;
  if (i === 0) return true;
  if (steps[i].comb === '>') return matchSteps(node.parentElement, steps, i - 1, scope);
  for (let a = node.parentElement; a; a = a.parentElement) if (matchSteps(a, steps, i - 1, scope)) return true;
  return false;
}

function matchesSelector(node, sel, scope) {
  return splitList(sel).some((one) => {
    const steps = parseSelector(one);
    return steps.length > 0 && matchSteps(node, steps, steps.length - 1, scope);
  });
}

// The two attribute names a browser mirrors onto a differently-named property.
const REFLECT = { id: 'id', class: 'className' };

// A property stands in for a reflected attribute: el('a', { href: '#' }) has to answer `a[href]`.
function reflected(node, name) {
  if (STRUCT.has(name) || !Object.hasOwn(node, name)) return null;
  const v = node[name];
  if (v == null || v === '' || typeof v === 'object' || typeof v === 'function') return null;
  return String(v);
}

// ---------- nodes ----------

class MiniNode {
  parentElement = null;
  childNodes = [];
  listeners = new Map();

  remove() { detach(this); }

  replaceWith(...nodes) {
    const parent = this.parentElement;
    if (!parent) return;
    const list = incoming(parent, nodes); // detaches first, so read this node's index after
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, ...list);
    this.parentElement = null;
  }

  addEventListener(type, fn, options) {
    const capture = options === true || !!(options && options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture, options });
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }

  // No bubbling: a screen's handler is asserted on the node it was registered on.
  dispatchEvent(ev) {
    for (const l of [...(this.listeners.get(ev.type) || [])]) l.fn.call(this, ev);
    return !ev.defaultPrevented;
  }
}

class MiniText extends MiniNode {
  nodeType = 3;
  constructor(value) { super(); this.nodeValue = String(value); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
  cloneNode() { return new MiniText(this.nodeValue); }
}

class MiniParent extends MiniNode {
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }

  append(...nodes) { this.childNodes.push(...incoming(this, nodes)); }
  prepend(...nodes) { this.childNodes.unshift(...incoming(this, nodes)); }

  replaceChildren(...nodes) {
    const list = incoming(this, nodes);
    for (const old of this.childNodes.splice(0)) old.parentElement = null;
    this.childNodes.push(...list);
  }

  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }

  // Glued, exactly as a browser glues it: <li>one<br>two</li> reads 'onetwo', no space inserted.
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    for (const old of this.childNodes.splice(0)) old.parentElement = null;
    if (v != null && v !== '') this.childNodes.push(...incoming(this, [String(v)]));
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return walk(this).filter((n) => matchesSelector(n, sel, this)); }
  matches(sel) { return matchesSelector(this, sel, this); }

  closest(sel) {
    for (let n = this; n; n = n.parentElement) {
      if (n.nodeType === 1 && matchesSelector(n, sel, n)) return n;
    }
    return null;
  }
}

class MiniElement extends MiniParent {
  nodeType = 1;
  id = '';
  className = '';
  style = { cssText: '' }; // an inline style is a string a fixture reads back, not a CSS engine
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  overrides = new Map(); // a fixture's own value for a computed member — see computed() below
  #attrs = new Map();
  #data;

  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    // A proxy, not a plain object: the real dataset stringifies on write and answers `delete`.
    this.#data = new Proxy({}, { set: (t, k, v) => { t[k] = String(v); return true; } });
  }

  get dataset() { return this.#data; }

  // A reflected property is listed here too: a walk over `attributes` has to see everything
  // getAttribute and the selectors already answer, or a sanitizer test strips a href it cannot see.
  get attributes() {
    const out = [...this.#attrs].map(([name, value]) => ({ name, value }));
    for (const key of Object.keys(this)) {
      const name = key === 'className' ? 'class' : key;
      if (this.#attrs.has(name)) continue;
      const value = reflected(this, key);
      if (value !== null) out.push({ name, value });
    }
    return out;
  }

  getAttribute(name) {
    if (this.#attrs.has(name)) return this.#attrs.get(name);
    return reflected(this, REFLECT[name] || name);
  }

  // `id` and `class` live on the property alone, so getElementById and a fixture that writes
  // either side never disagree.
  setAttribute(name, value) {
    if (REFLECT[name]) this[REFLECT[name]] = String(value);
    else this.#attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.#attrs.delete(name);
    // The property stands in for the attribute, so it has to go too or the selector keeps matching.
    const key = REFLECT[name] || name;
    if (REFLECT[name]) this[key] = '';
    else if (Object.hasOwn(this, key) && !STRUCT.has(key)) delete this[key];
  }

  // Backed by `className` itself, so the two can never drift apart in either direction.
  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list) => { this.className = list.join(' '); };
    return {
      contains: (c) => read().includes(c),
      add: (...cs) => write([...new Set([...read(), ...cs])]),
      remove: (...cs) => write(read().filter((c) => !cs.includes(c))),
      toggle: (c, force) => {
        const on = force === undefined ? !read().includes(c) : !!force;
        write(on ? [...new Set([...read(), c])] : read().filter((x) => x !== c));
        return on;
      },
    };
  }

  // A browser measures the box; here the fixture states it, and the rect is built from the four.
  getBoundingClientRect() {
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = this;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }

  // Focus lands on the nearest root: a shadow root records the node, the document records its host
  // — which is exactly the ladder a caller descends to find the caret inside a web component.
  focus() {
    for (let n = this; n;) {
      const root = rootOf(n);
      if (!root) return;
      root.activeElement = n;
      n = root.host || null;
    }
  }

  // `open` is the mode everything here uses; a closed root is reachable from the return value only.
  attachShadow({ mode = 'open' } = {}) {
    const root = new MiniShadowRoot(this, mode);
    if (mode === 'open') this.shadowRoot = root;
    return root;
  }

  // Pointer capture is a nicety its caller is expected to survive losing, so this only records it.
  setPointerCapture(id) { this.pointerCapture = id; }

  releasePointerCapture() { this.pointerCapture = null; }

  cloneNode(deep = false) {
    const copy = new MiniElement(this.tagName);
    for (const k of Object.keys(this)) if (!STRUCT.has(k)) copy[k] = this[k];
    for (const { name, value } of this.attributes) copy.setAttribute(name, value);
    Object.assign(copy.dataset, this.dataset);
    if (deep) copy.append(...this.childNodes.map((n) => n.cloneNode(true)));
    return copy;
  }
}

// A member a browser computes from the tree, which a fixture must still be able to overwrite:
// el('textarea', { rows: 3 }) would throw on a getter-only property, and `sel.selectedOptions =
// undefined` is how a test takes a selection away. An override is the property alone — the
// selector engine goes on reading the real attributes.
function computed(name, from) {
  Object.defineProperty(MiniElement.prototype, name, {
    configurable: true,
    get() { return this.overrides.has(name) ? this.overrides.get(name) : from(this); },
    set(v) { this.overrides.set(name, v); },
  });
}

// Only these answer `labels`; on anything else the property does not exist, as in a browser.
const LABELABLE = /^(BUTTON|INPUT|METER|OUTPUT|PROGRESS|SELECT|TEXTAREA)$/;
const labelsOf = (el) => {
  let top = el;
  while (top.parentElement) top = top.parentElement;
  return top.querySelectorAll('label')
    .filter((l) => l.contains(el) || (el.id && l.getAttribute('for') === el.id));
};

// HTMLTableElement.rows: the head's rows come first however the fixture ordered the sections.
function rowsOf(el) {
  if (el.tagName !== 'TABLE') return el.querySelectorAll(':scope > tr');
  const section = (t) => el.querySelectorAll(`:scope > ${t} > tr`);
  return [...section('thead'), ...el.querySelectorAll(':scope > tr'), ...section('tbody'), ...section('tfoot')];
}

computed('previousElementSibling', (el) => sibling(el, -1));
computed('nextElementSibling', (el) => sibling(el, 1));
computed('labels', (el) => (LABELABLE.test(el.tagName) ? labelsOf(el) : undefined));
computed('selectedOptions', (el) => (el.tagName === 'SELECT'
  ? el.querySelectorAll('option').filter((o) => o.selected) : undefined));
// The table shape a column header is found through: cell -> its index -> the header row's cell.
computed('cellIndex', (el) => (el.parentElement ? el.parentElement.cells.indexOf(el) : -1));
computed('cells', (el) => el.querySelectorAll(':scope > td, :scope > th'));
computed('rows', (el) => rowsOf(el));
computed('tHead', (el) => el.querySelector(':scope > thead'));

class MiniFragment extends MiniParent {
  nodeType = 11;
}

// What attachShadow() hands back: a tree of its own that the document's selectors never reach,
// which records what was appended to it and where the focus went inside it.
class MiniShadowRoot extends MiniParent {
  nodeType = 11;
  activeElement = null;

  constructor(host, mode) {
    super();
    this.host = host;
    this.mode = mode;
  }
}

class MiniDocument extends MiniNode {
  nodeType = 9;
  title = '';
  activeElement = null;

  constructor(ids = []) {
    super();
    this.documentElement = new MiniElement('html');
    this.documentElement.root = this; // how focus() finds its way back out of the tree
    this.body = new MiniElement('body');
    this.documentElement.append(this.body);
    for (const spec of ids) {
      const [tag, id] = spec.includes('#') ? spec.split('#') : ['div', spec];
      const node = new MiniElement(tag || 'div');
      node.id = id;
      this.body.append(node);
    }
  }

  createElement(tag) { return new MiniElement(tag); }
  createTextNode(value) { return new MiniText(value); }
  createDocumentFragment() { return new MiniFragment(); }
  getElementById(id) { return walk(this.documentElement).find((n) => n.id === id) || null; }

  // A snapshot, not the live walker a browser hands back — nothing here re-walks when the tree moves.
  createTreeWalker(root, whatToShow = NodeFilter.SHOW_ALL) {
    const list = walkAll(root).filter((n) => (1 << (n.nodeType - 1)) & whatToShow);
    let i = 0;
    return { root, nextNode: () => list[i++] || null };
  }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
}

// ---------- the exports the fixtures use ----------

export function el(tag, props = null, ...children) {
  const node = new MiniElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'dataset') Object.assign(node.dataset, v); // `dataset` is read-only, like the real one
    else node[k] = v;
  }
  if (children.length) node.append(...children);
  return node;
}

export const text = (value) => new MiniText(value);

export const makeDocument = (ids = []) => new MiniDocument(ids);

// What createTreeWalker() filters on; `1 << (nodeType - 1)` is the whole engine.
export const NodeFilter = { SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_TEXT: 4 };

// The event fire() builds, on its own: a listener fire() cannot reach — one on a window, or one a
// harness captured itself — still gets the one event shape rather than a second, thinner fake.
export function event(target, type, props = {}) {
  const ev = {
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    propagationStopped: false,
    ...props,
  };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.propagationStopped = true; };
  if (!ev.composedPath) ev.composedPath = () => pathOf(ev.target);
  return ev;
}

// The only way into a handler a render wired up. `props` lands on the event, so a keydown test
// passes `{ key: 'Enter' }`; the returned event carries what the handler did to it.
export function fire(node, type, props = {}) {
  const ev = event(node, type, props);
  node.dispatchEvent(ev);
  return ev;
}
