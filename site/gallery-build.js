'use strict';
// The community gallery: gallery/items/<kind>/<id>.json, checked with the
// app's own validator (src/gallery-schema.js), plus the index the owner builds
// and signs offline. The Pages build never writes or signs the index: it
// rebuilds it in memory, refuses to deploy unless that is byte-identical to the
// committed gallery/index.json, then copies index (and .sig) and writes a page
// per item.
//
//   node site/gallery-build.js --check               items valid and index up to date
//   node site/gallery-build.js --check --items-only  items valid; a stale index is only a notice (PR CI)
//   node site/gallery-build.js --write               raise the serial and regenerate gallery/index.json (owner, then sign it)
const fs = require('fs');
const path = require('path');
const Brand = require('../brand.js');
const S = require('../src/gallery-schema.js');
const V = require('../src/plugins/index-verify.js');
const { strictJSON } = V;

const ROOT = path.join(__dirname, '..');
const REGENERATE = 'node site/gallery-build.js --write, then node site/tools/sign-gallery.mjs gallery/index.json <private.pem>';
const KIND_LABEL = { recipe: 'Recipe', character: 'Character', pack: 'Pack', rules: 'Widget rules', setup: 'Setup' };
const REPO = 'https://github.com/CallumJB125/claude-traffic-light';

function readItems(root) {
  const dir = path.join(root, 'gallery', 'items');
  const items = [], problems = [];
  let kinds = [];
  try { kinds = fs.readdirSync(dir).sort(); } catch { problems.push('gallery/items is missing'); }
  for (const kind of kinds) {
    const kindDir = path.join(dir, kind);
    if (!S.KINDS.includes(kind) || !fs.lstatSync(kindDir).isDirectory()) { problems.push(`items/${kind}: not a gallery kind folder (${S.KINDS.join(', ')})`); continue; }
    for (const f of fs.readdirSync(kindDir).sort()) {
      const file = path.join(kindDir, f);
      const st = fs.lstatSync(file);
      if (!f.endsWith('.json') || !st.isFile()) { problems.push(`items/${kind}/${f}: not a .json file`); continue; }
      if (st.size > S.LIMITS.entryBytes) { problems.push(`items/${kind}/${f}: over ${S.LIMITS.entryBytes} bytes`); continue; }
      try { items.push({ item: strictJSON(fs.readFileSync(file), S.LIMITS.entryBytes), name: f.slice(0, -5), kind }); } catch (e) { problems.push(`items/${kind}/${f}: not valid JSON (${e.message})`); }
    }
  }
  return { items, problems };
}

function readSerial(root) {
  try {
    const meta = strictJSON(fs.readFileSync(path.join(root, 'gallery', 'index-meta.json')), 1024);
    if (V.closed(meta, ['serial']) && Number.isSafeInteger(meta.serial) && meta.serial >= 1) return meta.serial;
  } catch { /* reported below */ }
  throw new Error('gallery/index-meta.json must be { "serial": <whole number from 1> }');
}

// → { index, text, committed, stale, serial }; throws listing every invalid item.
// serial: build with this one instead of the committed one (--write).
function check(root = ROOT, { serial = readSerial(root) } = {}) {
  const { items, problems } = readItems(root);
  let built = null;
  try { built = S.buildIndex(items, { serial }); } catch (e) { problems.push(...(e.problems || [e.message])); }
  if (problems.length) throw new Error(`gallery items are not valid:\n${problems.join('\n')}`);
  let committed = null;
  try { committed = fs.readFileSync(path.join(root, 'gallery', 'index.json')); } catch { /* none yet */ }
  return { ...built, serial, committed, stale: !committed || !committed.equals(Buffer.from(built.text)) };
}

// Once a gallery key is pinned, the deploy carries only an index that key signed.
function checkSignature(root, bytes) {
  const pems = [];
  for (const name of ['gallery-key.pub.pem', 'gallery-key-next.pub.pem']) { try { pems.push(fs.readFileSync(path.join(root, 'build', name), 'utf8')); } catch { /* not pinned */ } }
  if (!pems.length) return null;
  let sig;
  try { sig = fs.readFileSync(path.join(root, 'gallery', 'index.json.sig')); } catch { throw new Error(`gallery/index.json.sig is missing but a gallery key is pinned. Sign it: ${REGENERATE}`); }
  const r = V.createSignedVerifier({ keys: V.keysFromPems(pems), maxBytes: S.LIMITS.indexBytes, validateIndex: S.validateIndex })(bytes, sig);
  if (r.status !== 'verified') throw new Error(`gallery/index.json.sig does not verify against the pinned gallery key (${r.reason}). Sign it again: ${REGENERATE}`);
  return sig;
}

const by = (e, esc) => `${esc(e.author.name)}${e.author.github ? ` (<a href="https://github.com/${esc(e.author.github)}" rel="nofollow ugc">@${esc(e.author.github)}</a>)` : ''} <span class="cg-note">self-declared</span>`;
const href = (id) => `/gallery/${id}`;

function itemBody(e, esc) {
  const p = e.payload;
  const facts = [['Kind', esc(KIND_LABEL[e.kind])], ['By', by(e, esc)], ['License', esc(e.license)], ['Added', esc(e.added)], ['Updated', esc(e.updated)], ['Stacks', esc(e.stacks.join(', ') || 'any')], ['Tools', esc(e.tools.join(', ') || 'any')], ['Tags', esc(e.tags.join(', ') || 'none')], ['sha256', `<code>${esc(e.sha256)}</code>`]];
  let body;
  if (e.kind === 'recipe') body = `<p>${esc(p.what)}</p><p>Read-only: it plans and reports, and never changes files. Cost: ${esc(p.cost)}</p><h2>The prompt</h2><pre class="cg-pre">${esc(p.prompt)}</pre>`;
  else if (e.kind === 'character') body = `<p>A widget character named <strong>${esc(p.name)}</strong>. Its art is checked by the app's sanitiser when you add it.</p>`;
  else if (e.kind === 'pack') body = `${p.note ? `<p>${esc(p.note)}</p>` : ''}<h2>In this pack</h2><ul>${p.members.map((m) => `<li><a href="${esc(href(m))}">${esc(m)}</a></li>`).join('')}</ul>`;
  else if (e.kind === 'rules') body = `<p>Widget rules. Adding them opens them in Widget configuration, where they replace your rules only when you press Load and then Save. Clicks in gallery rules never run commands.</p><h2>The rules</h2><ul>${p.rules.map((r) => `<li>${esc(r.name)}</li>`).join('')}</ul><pre class="cg-pre">${esc(JSON.stringify(p, null, 2))}</pre>`;
  else body = `<p>Adding ${esc(KIND_LABEL[e.kind].toLowerCase())} from the gallery comes in a later version of the app.</p><pre class="cg-pre">${esc(JSON.stringify(p, null, 2))}</pre>`;
  const how = S.ADDABLE.includes(e.kind) ? `<p class="cg-how">To add it: in ${esc(Brand.name)}, open Tasks → Recipes → Browse the gallery, then Add. You see everything it contains before anything is saved.</p>` : '';
  return `<p class="lede">${esc(e.summary)}</p><dl class="cg-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${body}${how}`;
}

function listItem(e, esc) {
  const text = [e.title, e.summary, e.author.name, ...e.tags].join(' ').toLowerCase();
  return `<li class="cg-item" data-kind="${esc(e.kind)}" data-stacks="${esc(e.stacks.join(' '))}" data-text="${esc(text)}"><a href="${esc(href(e.id))}"><span class="cg-kind">${esc(KIND_LABEL[e.kind])}</span> <strong>${esc(e.title)}</strong></a><p>${esc(e.summary)}</p><p class="cg-by">by ${by(e, esc)}</p></li>`;
}

// Called by site/build.js when site.config.json has "gallery": true.
function buildGallery({ root = ROOT, dist, src, renderPage, esc }) {
  const { index, committed, stale } = check(root);
  if (stale) throw new Error(`gallery/index.json does not match gallery/items. Regenerate and sign it: ${REGENERATE}`);
  const out = path.join(dist, 'gallery');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.json'), committed);
  const verified = checkSignature(root, committed);
  const sig = path.join(root, 'gallery', 'index.json.sig');
  if (verified) fs.writeFileSync(path.join(out, 'index.json.sig'), verified);
  else if (fs.existsSync(sig)) fs.copyFileSync(sig, path.join(out, 'index.json.sig'));
  const template = fs.readFileSync(path.join(src, 'gallery', 'item.html'), 'utf8');
  const pages = [];
  for (const e of index.entries) {
    const meta = { title: `${e.title} · Gallery · ${Brand.name}`, desc: e.summary, path: href(e.id), canonical: `${Brand.urls.site}${href(e.id)}` };
    const html = renderPage(template, meta, `gallery/${e.id}.html`).replace('<!--cg:item-->', () => itemBody(e, esc)).replace('<!--cg:title-->', () => esc(e.title));
    fs.mkdirSync(path.join(out, e.kind), { recursive: true });
    fs.writeFileSync(path.join(out, e.kind, `${e.slug}.html`), html);
    pages.push(meta);
  }
  return { pages, list: index.entries.map((e) => listItem(e, esc)).join('\n') };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    const r = check(ROOT);
    if (args.includes('--write')) {
      if (!r.stale) { console.log('[gallery] gallery/index.json is already up to date; nothing written'); return; }
      const next = check(ROOT, { serial: r.serial + 1 });
      fs.writeFileSync(path.join(ROOT, 'gallery', 'index-meta.json'), `${JSON.stringify({ serial: next.serial })}\n`);
      fs.writeFileSync(path.join(ROOT, 'gallery', 'index.json'), next.text);
      console.log(`[gallery] wrote gallery/index.json (serial ${next.serial}, ${next.index.entries.length} entries). Now sign it: node site/tools/sign-gallery.mjs gallery/index.json <private.pem>`);
    } else if (r.stale) {
      const msg = `gallery/index.json does not match gallery/items. The owner must regenerate and sign it: ${REGENERATE}`;
      if (args.includes('--items-only')) console.log(`::notice::${msg}`);
      else { console.error(msg); process.exitCode = 1; }
    } else console.log(`[gallery] ${r.index.entries.length} items valid; gallery/index.json is up to date`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { buildGallery, check, readItems, REGENERATE };
