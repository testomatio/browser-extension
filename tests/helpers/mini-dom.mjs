// A hand-made page for `node --test`: the panel screens build their UI out of elements, and this
// repo has no package.json, so there is no jsdom to borrow one from. See DIVERGENCES below.

// DIVERGENCES, each earned by a test. querySelectorAll returns a PLAIN ARRAY, and document order
// is depth-first, because indexOf on that array is how a step's position is computed.

// append('<b>x</b>') is ONE TEXT NODE: append never parses HTML. A property assigned to a node
// stays verbatim, while getAttribute, the selectors and `attributes` all report it.

// innerHTML DOES parse, because shared/markdown.js hands showdown's output to it and the sanitizer
// is then asked what survived. It is a tokeniser, not a browser: comments and doctypes are dropped,
// void and raw-text elements are honoured, an unmatched `</p>` is ignored, and there is no implied
// tag insertion — `<table><tr>` nests as written. Entities decode on the way in and `& < >` re-encode
// on the way out, so the round trip a sanitizer test reads is the one a browser shows.

// Events do not bubble — fire() runs the listeners on the node it is handed. Pre-created ids:
// makeDocument(['ul#tc-tree']) appends one element per entry to <body>.

// The node's own machinery: never copied by cloneNode, never read as an attribute. Layout, `style`
// and a shadow root belong here too — a browser reflects none of them.
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

// ---------- the innerHTML tokeniser ----------

// Nothing may be inside these; `<br>two` is a sibling, not a child.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr']);
// Their body is text however tag-shaped it looks — which is the whole point of a `<script>` row.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#96': '`' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[key] ?? whole;
  });
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// name, then `="v"` / `='v'` / `=v` / nothing. A name may carry `:` and `-` — xlink:href, data-id.
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

function parseAttrs(node, src) {
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(src)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    node.setAttribute(m[1].toLowerCase(), decodeEntities(value)); // HTML names are case-insensitive
  }
}

// One pass, left to right; `stack` is the open elements, and an end tag that matches nothing is
// dropped rather than unwinding the tree — a browser recovers differently, no fixture needs it to.
function parseHtml(html, into) {
  const stack = [into];
  const top = () => stack[stack.length - 1];
  const src = String(html);
  let at = 0;
  const push = (t) => { if (t) top().append(new MiniText(decodeEntities(t))); };
  while (at < src.length) {
    const lt = src.indexOf('<', at);
    if (lt < 0) { push(src.slice(at)); break; }
    push(src.slice(at, lt));
    if (src.startsWith('<!--', lt)) { // a comment reaches no fixture: drop it whole
      const end = src.indexOf('-->', lt + 4);
      at = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      at = end < 0 ? src.length : end + 1;
      continue;
    }
    const close = /^<\/\s*([^\s>]+)\s*>/.exec(src.slice(lt));
    if (close) {
      const tag = close[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      at = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/.exec(src.slice(lt));
    if (!open) { push('<'); at = lt + 1; continue; } // a stray `<` is text, as in a browser
    const name = open[1].toLowerCase();
    const node = new MiniElement(name);
    parseAttrs(node, open[2]);
    top().append(node);
    at = lt + open[0].length;
    if (open[0].endsWith('/>') || VOID.has(name)) continue;
    if (RAW_TEXT.has(name)) { // its body is text: `<script>a < b</script>` holds no element
      const end = src.toLowerCase().indexOf(`</${name}`, at);
      const body = src.slice(at, end < 0 ? src.length : end);
      if (body) node.append(new MiniText(body));
      at = end < 0 ? src.length : src.indexOf('>', end) + 1;
      continue;
    }
    stack.push(node);
  }
  return into;
}

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  const name = node.tagName.toLowerCase();
  const attrs = node.attributes.map(({ name: n, value }) => ` ${n}="${escapeAttr(value)}"`).join('');
  if (VOID.has(name)) return `<${name}${attrs}>`;
  return `<${name}${attrs}>${node.childNodes.map(serialize).join('')}</${name}>`;
}

// ---------- nodes ----------

class MiniNode {
  parentElement = null;
  childNodes = [];
  listeners = new Map();

  // The raw-tree view of the same three facts, for code that walks a page it did not build:
  // nextSibling counts the text between two elements, isConnected climbs out of every shadow root.
  get parentNode() { return this.parentElement; }

  get nextSibling() {
    const p = this.parentElement;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }

  get isConnected() {
    for (let n = this; n;) {
      const root = rootOf(n);
      if (!root) return false;
      if (root.nodeType === 9) return true;
      n = root.host || null;
    }
    return false;
  }

  // The tree this node lives in: the document, a component's shadow root, or — detached — the
  // topmost node itself, exactly the three a browser hands back.
  getRootNode() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n.root || n;
  }

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

  // Put back exactly where it was, which is what a node parked by position is for. A reference
  // node that is not a child throws, as in a browser: the caller has to notice the tree moved.
  insertBefore(node, ref) {
    const [inc] = incoming(this, [node]); // detaches first, so read the reference index after
    const at = ref == null ? -1 : this.childNodes.indexOf(ref);
    if (ref != null && at < 0) throw new Error('insertBefore: the reference node is not a child');
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, inc);
    return inc;
  }

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

  // The one place HTML is parsed: shared/markdown.js hands showdown's output straight to it.
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    for (const old of this.childNodes.splice(0)) old.parentElement = null;
    parseHtml(html, this);
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

// A member a browser computes, which a fixture must still be able to overwrite: a getter-only
// property would throw, and `sel.selectedOptions = undefined` is how a test takes a selection away.
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

// Inherited: the nearest ancestor that STATES the attribute decides, and `contenteditable=""`
// is "true". The walk stops at a shadow root, where a browser's `parentElement` ends anyway.
computed('isContentEditable', (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const v = n.getAttribute('contenteditable');
    if (v != null) return v === '' || v.toLowerCase() === 'true';
  }
  return false;
});

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

  // A fragment and a shadow root answer ids in their OWN tree; an element never answers at all.
  getElementById(id) { return walk(this).find((n) => n.id === id) || null; }
}

// What attachShadow() hands back: a tree of its own that the document's selectors never reach,
// which records what was appended to it and where the focus went inside it.
class MiniShadowRoot extends MiniFragment {
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
