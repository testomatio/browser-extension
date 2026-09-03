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
//   * events do not bubble: fire() runs the listeners registered on the node it is handed.

// The node's own machinery: never copied as a user property by cloneNode, never read as an
// attribute by the selector engine.
const STRUCT = new Set(['tagName', 'nodeType', 'nodeValue', 'childNodes', 'parentElement', 'listeners']);

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
      const m = /^\[([-\w]+)(?:=(.*))?\]$/.exec(t);
      cmp.attrs.push({ name: m[1], value: m[2] === undefined ? null : unquote(m[2]) });
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
    if (v === null || (a.value !== null && v !== a.value)) return false;
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

  cloneNode(deep = false) {
    const copy = new MiniElement(this.tagName);
    for (const k of Object.keys(this)) if (!STRUCT.has(k)) copy[k] = this[k];
    for (const { name, value } of this.attributes) copy.setAttribute(name, value);
    Object.assign(copy.dataset, this.dataset);
    if (deep) copy.append(...this.childNodes.map((n) => n.cloneNode(true)));
    return copy;
  }
}

class MiniFragment extends MiniParent {
  nodeType = 11;
}

class MiniDocument extends MiniNode {
  nodeType = 9;

  constructor(ids = []) {
    super();
    this.documentElement = new MiniElement('html');
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

// The only way into a handler a render wired up. `props` lands on the event, so a keydown test
// passes `{ key: 'Enter' }`; the returned event carries what the handler did to it.
export function fire(node, type, props = {}) {
  const ev = {
    type,
    target: node,
    currentTarget: node,
    defaultPrevented: false,
    propagationStopped: false,
    ...props,
  };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.propagationStopped = true; };
  node.dispatchEvent(ev);
  return ev;
}
