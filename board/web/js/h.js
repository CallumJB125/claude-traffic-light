// A tiny virtual-node layer. Render functions are pure: they return plain
// {tag, props, children} trees, so node --test can inspect them without a DOM.
// `render()` turns a tree into DOM and patches it in place on the next call,
// so focus, caret position and scroll survive the once-a-second age tick.
//
// Text only ever reaches the DOM as text nodes (D25): there is no innerHTML
// path. Styles go through CSSOM (el.style.setProperty), which the hub's CSP
// (`style-src 'self'`) allows, unlike style="" attributes.

export const TEXT = '#text';
const SVG_NS = 'http://www.w3.org/2000/svg';

function norm(c, out) {
  if (c == null || c === false || c === true) return out;
  if (Array.isArray(c)) { for (const x of c) norm(x, out); return out; }
  if (typeof c === 'object') { out.push(c); return out; }
  out.push({ tag: TEXT, text: String(c) });
  return out;
}

export function h(tag, props, ...children) {
  return { tag, props: props ?? {}, children: norm(children, []) };
}

// ── inspection helpers (tests and a11y checks) ──────────────────────────────

export function textOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (v.tag === TEXT) return v.text;
  return v.children.map(textOf).join('');
}

export function walk(v, fn) {
  if (!v || v.tag === TEXT) return;
  fn(v);
  for (const c of v.children) walk(c, fn);
}

export function findAll(v, pred) {
  const out = [];
  walk(v, (n) => { if (pred(n)) out.push(n); });
  return out;
}

export const hasClass = (n, c) => typeof n.props.class === 'string' && n.props.class.split(/\s+/).includes(c);
export const byClass = (v, c) => findAll(v, (n) => hasClass(n, c));
export const byAttr = (v, k, val) => findAll(v, (n) => (val === undefined ? n.props[k] != null : n.props[k] === val));

// ── DOM ─────────────────────────────────────────────────────────────────────

const PROP_KEYS = new Set(['value', 'checked', 'selected', 'indeterminate']);

function setProp(el, k, v, prev, svg) {
  if (k === 'key') return;
  if (k === 'style') {
    const a = prev ?? {};
    const b = v ?? {};
    for (const p of Object.keys(a)) if (!(p in b)) el.style.removeProperty(p);
    for (const [p, val] of Object.entries(b)) if (a[p] !== val) el.style.setProperty(p, val);
    return;
  }
  if (PROP_KEYS.has(k)) {
    // An option's empty property initially equals '', but without an explicit
    // value attribute its eventual label becomes its submitted value.
    if (k === 'value' && el.tagName === 'OPTION') {
      if (v == null) el.removeAttribute('value');
      else el.setAttribute('value', String(v));
      return;
    }
    // Controlled only when the render value changes, so re-renders never
    // clobber what someone is typing.
    if (v !== prev && el[k] !== v) el[k] = v ?? (k === 'value' ? '' : false);
    return;
  }
  if (k === 'class' && !svg) { if (el.className !== (v ?? '')) el.className = v ?? ''; return; }
  if (v == null || v === false) el.removeAttribute(k);
  else el.setAttribute(k, v === true ? '' : String(v));
}

function create(v, svg) {
  if (v.tag === TEXT) return (v.el = document.createTextNode(v.text));
  const isSvg = svg || v.tag === 'svg';
  const el = isSvg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
  for (const [k, val] of Object.entries(v.props)) setProp(el, k, val, undefined, isSvg);
  for (const c of v.children) el.appendChild(create(c, isSvg && v.tag !== 'foreignObject'));
  if (v.tag === 'select' && v.props.value != null) el.value = v.props.value;
  return (v.el = el);
}

function same(a, b) {
  return a.tag === b.tag && a.props?.key === b.props?.key;
}

function patch(a, b, svg) {
  const el = a.el;
  if (!same(a, b)) {
    const n = create(b, svg);
    el.replaceWith(n);
    return n;
  }
  b.el = el;
  if (b.tag === TEXT) { if (a.text !== b.text) el.nodeValue = b.text; return el; }
  const isSvg = svg || b.tag === 'svg';
  const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
  for (const k of keys) if (a.props[k] !== b.props[k] || PROP_KEYS.has(k)) setProp(el, k, b.props[k], a.props[k], isSvg);
  patchChildren(el, a.children, b.children, isSvg && b.tag !== 'foreignObject');
  if (b.tag === 'select' && b.props.value !== a.props.value && b.props.value != null) el.value = b.props.value;
  return el;
}

function patchChildren(parent, olds, news, svg) {
  const byKey = new Map();
  olds.forEach((o, i) => { if (o.props?.key != null) byKey.set(o.props.key, i); });
  const used = new Array(olds.length).fill(false);
  const els = [];
  news.forEach((n, i) => {
    let j = -1;
    if (n.props?.key != null) j = byKey.get(n.props.key) ?? -1;
    else if (i < olds.length && !used[i] && olds[i].props?.key == null) j = i;
    if (j >= 0 && !used[j] && same(olds[j], n)) {
      used[j] = true;
      els.push(patch(olds[j], n, svg));
    } else {
      els.push(create(n, svg));
    }
  });
  olds.forEach((o, i) => { if (!used[i] && o.el?.parentNode === parent) o.el.remove(); });
  let ref = parent.firstChild;
  for (const el of els) {
    if (el !== ref) parent.insertBefore(el, ref);
    else ref = ref.nextSibling;
  }
}

/** Render (or patch) `vnode` as the only child of `container`. */
export function render(container, vnode) {
  const prev = container.__vtree;
  if (!prev) {
    container.textContent = '';
    container.appendChild(create(vnode, false));
  } else {
    patch(prev, vnode, false);
  }
  container.__vtree = vnode;
}
