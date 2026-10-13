'use strict';
// The community gallery in the app (Tasks → Recipes → Browse the gallery).
// The list is fetched from plexiform.dev only when the person clicks, never
// at start or on a timer, through an injected fetch (main passes the
// 'gallery' session's, so nothing else's cookies ride along). It is checked
// like the plugin index: strict JSON, bounded, dated, and signed by a pinned
// key once build/gallery-key.pub.pem ships. Until then it is shown as
// unsigned. Every entry is checked again with the site's own validator
// (src/gallery-schema.js) and a bad one is dropped, not trusted.
//
// The page names only an entry id and its sha256; main looks the entry up
// in what it verified, shows a native confirm with everything it contains,
// and only then adds it. Recipes and characters are saved at once; widget
// rules open in Widget rules as an offer that still needs Load and
// Save there; a setup is parked here (one use, 10 minutes) for the Setups page
// to pull when it is shown, and is written only after its review and Apply.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const V = require('./plugins/index-verify.js');
const S = require('./gallery-schema.js');
const Brand = require('../brand.js');
const { validateCharacter } = require('../characters/validate.js');

const INDEX_URL = `${Brand.urls.site}/gallery/index.json`;
const SIG_URL = `${INDEX_URL}.sig`;
const KEY_FILES = ['gallery-key.pub.pem', 'gallery-key-next.pub.pem'];
const TIMEOUT_MS = 10_000;
const PENDING_TTL_MS = 10 * 60_000;
const KIND_LABEL = { recipe: 'recipe', character: 'character', pack: 'pack', rules: 'widget rules', setup: 'setup' };
const REASON = {
  'no-production-key': 'The gallery key on this Mac could not be read, so the list is not shown. Reinstall the app.',
  signature: 'The gallery list’s signature did not check out, so nothing from it is shown.',
  'unknown-key': 'The gallery list is signed with a key this version does not know. Update the app, then try again.',
  'index-time': 'The gallery list is dated in the future or before the gallery existed, so it is not shown.',
  rollback: 'The gallery list is older than the one you already have, so it is not shown.',
  replay: 'The gallery list does not match the one you already have under the same version, so it is not shown.',
};
const unreadable = 'The gallery list was not in the expected format, so nothing from it is shown.';

function readKeys(dir) {
  const pems = [];
  for (const name of KEY_FILES) {
    try {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 64 * 1024) pems.push(fs.readFileSync(file, 'utf8'));
    } catch { /* not shipped */ }
  }
  let keys = [];
  try { keys = V.keysFromPems(pems); } catch { keys = []; }
  // A key file that is there but unusable fails closed, never back to unsigned.
  return { keys, broken: pems.length > 0 && keys.length === 0 };
}

// The body, refusing more than max bytes whatever Content-Length says.
async function readBounded(res, max) {
  if (Number(res.headers.get('content-length')) > max) throw new Error('too large');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function preview(e, byId) {
  const p = e.payload;
  if (e.kind === 'recipe') return { what: p.what, prompt: p.prompt, tool: p.tool, cost: p.cost };
  if (e.kind === 'character') return { name: p.name };
  if (e.kind === 'rules') return { names: p.rules.map((r) => r.name) };
  if (e.kind === 'setup') return { note: p.note, files: p.files.map((f) => ({ path: f.relative_path, content: f.content })) };
  if (e.kind === 'pack') return { note: p.note, members: p.members.map((id) => { const m = byId.get(id); return m ? { id, kind: m.kind, title: m.title, sha256: m.sha256, addable: S.ADDABLE.includes(m.kind) } : { id, missing: true }; }) };
  return null;
}

function create({ dataDir, fetch, keysDir, now = Date.now, recipes, characterStore, confirm, broadcastCharacters = () => {}, offerRules = () => {}, openSetups = () => {}, demo = () => false }) {
  const cacheDir = path.join(dataDir, 'gallery');
  const { keys, broken } = readKeys(keysDir);
  const signed = keys.length > 0 || broken;
  let state = null;
  let pending = null;

  function check(bytes, sig) {
    const opts = { now, floor: V.FLOOR, maxBytes: S.LIMITS.indexBytes, validateIndex: S.validateIndex };
    if (broken) return { status: 'unverified', reason: 'no-production-key' };
    return keys.length ? V.createSignedVerifier({ ...opts, keys })(bytes, sig) : V.parseUnsigned(bytes, opts);
  }
  function load(result, fetchedAt) {
    const entries = [], seen = new Set();
    let dropped = 0;
    for (const e of result.index.entries) {
      if (S.validateEntry(e).length || seen.has(e.id)) { dropped += 1; continue; }
      seen.add(e.id);
      entries.push(e);
    }
    return { entries, dropped, fetchedAt, serial: result.index.serial, indexHash: result.index_hash, keyId: result.keyId || null };
  }
  function view(s) {
    const byId = new Map(s.entries.map((e) => [e.id, e]));
    return {
      ok: true,
      fetchedAt: s.fetchedAt,
      provenance: s.keyId ? `Signed (key ${s.keyId})` : 'Unsigned · fetched from plexiform.dev over HTTPS',
      signed: !!s.keyId,
      dropped: s.dropped,
      demo: demo(),
      items: s.entries.map((e) => ({ id: e.id, kind: e.kind, title: e.title, summary: e.summary, author: e.author, license: e.license, tags: e.tags, stacks: e.stacks, tools: e.tools, updated: e.updated, sha256: e.sha256, addable: S.ADDABLE.includes(e.kind), preview: preview(e, byId) })),
    };
  }
  function save(bytes, sig, fetchedAt) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const put = (name, data) => { const file = path.join(cacheDir, name), tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); };
    put('index.json', bytes);
    if (sig) put('index.json.sig', sig); else fs.rmSync(path.join(cacheDir, 'index.json.sig'), { force: true });
    put('fetched.json', JSON.stringify({ fetchedAt }));
  }
  // The cache is checked again on the way in: it is a file anyone on this account could edit.
  function fromCache() {
    try {
      const bytes = fs.readFileSync(path.join(cacheDir, 'index.json'));
      let sig = null;
      try { sig = fs.readFileSync(path.join(cacheDir, 'index.json.sig')); } catch { /* unsigned */ }
      const r = check(bytes, sig);
      if (!r.index) return null;
      const { fetchedAt } = JSON.parse(fs.readFileSync(path.join(cacheDir, 'fetched.json'), 'utf8'));
      return load(r, Number.isFinite(fetchedAt) ? fetchedAt : null);
    } catch { return null; }
  }

  async function get(url, max) {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }); // privacy-flow: gallery
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return readBounded(res, max);
  }

  async function fetchIndex() {
    if (broken) return { ok: false, error: REASON['no-production-key'] };
    let bytes, sig = null;
    try {
      bytes = await get(INDEX_URL, S.LIMITS.indexBytes);
      if (signed) sig = await get(SIG_URL, V.LIMITS.signatureBytes);
    } catch (e) {
      if (e.message === 'too large') return { ok: false, error: unreadable };
      return { ok: false, error: e.status === 404 && bytes ? REASON.signature : 'Could not reach plexiform.dev. Check your connection and try again.' };
    }
    const r = check(bytes, sig);
    if (!r.index) return { ok: false, error: REASON[r.reason] || unreadable };
    // The owner's serial, not generatedAt, orders lists: a takedown can lower generatedAt.
    const before = fromCache() || state;
    if (before && r.index.serial < before.serial) return { ok: false, error: REASON.rollback };
    if (before && r.index.serial === before.serial && r.index_hash !== before.indexHash) return { ok: false, error: REASON.replay };
    const fetchedAt = now();
    try { save(bytes, sig, fetchedAt); } catch { /* shown anyway; fetched again next time */ }
    state = load(r, fetchedAt);
    return view(state);
  }

  // Read from disk each time, so Delete my data (or a hand-edited cache) is reflected.
  function cached() {
    state = fromCache();
    return state ? view(state) : { ok: false, none: true };
  }

  const by = (e) => `From the community gallery by ${e.author.name}${e.author.github ? ` (@${e.author.github})` : ''}, self-declared · ${e.license} · updated ${e.updated}`;
  async function add(id, sha, ev) {
    if (demo()) return { ok: false, error: 'This is the demo: exit it to add things from the gallery.' };
    const e = typeof id === 'string' && typeof sha === 'string' ? state?.entries.find((x) => x.id === id) : null;
    if (!e || e.sha256 !== sha) return { ok: false, error: 'That item changed or is no longer in the gallery. Refresh and try again.' };
    if (e.kind === 'pack') return { ok: false, error: 'Add the items in a pack one at a time.' };
    if (!S.ADDABLE.includes(e.kind)) return { ok: false, error: `Adding ${KIND_LABEL[e.kind]} from the gallery is available in a later version.` };
    if (e.kind === 'recipe') {
      const p = e.payload;
      const yes = await confirm({ title: e.title, action: 'Add to My recipes', detail: [by(e), p.what, 'It only reads: plan mode, no file changes.', 'The full prompt it gives your AI:', '', p.prompt].join('\n') }, ev);
      if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was added.' };
      return recipes.addFromGallery(e);
    }
    if (e.kind === 'rules') return addRules(e, ev);
    if (e.kind === 'setup') return addSetup(e, ev);
    const v = validateCharacter(e.payload, { source: 'import' });
    if (!v.ok) return { ok: false, error: 'That character could not be added.' };
    const yes = await confirm({ title: v.character.name, action: 'Add to Characters', detail: [by(e), 'A widget character: art only, checked again by the app’s sanitiser before it is saved.'].join('\n') }, ev);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was added.' };
    try {
      const ch = characterStore.save({ ...v.character, id: characterStore.freeId(v.character.id) }, { source: 'gallery' });
      broadcastCharacters();
      return { ok: true, id: ch.id, kind: 'character' };
    } catch (err) {
      return { ok: false, error: /^at most/.test(err.message) ? `You can keep ${err.message}. Delete one first.` : 'That character could not be added.' };
    }
  }

  // Migrated like an imported rules file, then offered in Widget rules,
  // where they replace the person's rules only after Load and then Save.
  async function addRules(e, ev) {
    const Rules = require('../rules.js');
    const rules = Rules.migrateRules(e.payload.rules.map(Rules.normalizeRule), Rules.rulesVersionOf(e.payload));
    if (Rules.clickCommands(e.payload.rules).length) return { ok: false, error: 'Those widget rules could not be added.' };
    const k = e.payload.rules.length;
    const yes = await confirm({ title: e.title, action: 'Open in Widget rules', detail: [by(e), `${k} widget rule${k === 1 ? '' : 's'}: ${e.payload.rules.map((r) => r.name).join(', ')}.`, 'They open in Widget rules as an offer. Your rules change only if you press Load there and then Save, and Revert goes back to your saved rules. Clicks in gallery rules never run commands, Shortcuts, links or apps.'].join('\n') }, ev);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was changed.' };
    offerRules(rules);
    return { ok: true, kind: 'rules' };
  }

  // The full reviewed-setups check runs here, in the app. The Setups page then
  // shows every file, each with its own tick, before Apply writes anything.
  async function addSetup(e, ev) {
    let checked;
    try { checked = S.validateSetupPayload(e.payload); } catch { return { ok: false, error: 'That setup could not be added.' }; }
    const files = checked.payload.files.map((f) => f.relative_path);
    const yes = await confirm({ title: e.title, action: 'Review on the Setups page', detail: [by(e), `${files.length} file${files.length === 1 ? '' : 's'} an AI will read as instructions:`, ...files.map((f) => `• ~/${f}`), '', 'It opens on the Setups page with every file in full. Nothing is written until you tick each file and press Apply there, and a backup is saved first.'].join('\n') }, ev);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was changed.' };
    pending = { payload: checked.payload, by: by(e), expires: now() + PENDING_TTL_MS };
    openSetups();
    return { ok: true, kind: 'setup' };
  }
  // One use: the Setups page takes it when it is shown, or it lapses.
  function takePending() {
    const p = pending;
    pending = null;
    return p && p.expires > now() ? { payload: p.payload, by: p.by } : null;
  }

  return { fetchIndex, cached, add, takePending, INDEX_URL };
}

// IPC for the Tasks page (allowed: main's Tasks-page sender check).
function register({ ipcMain, allowed, gallery }) {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(e, ...args); } catch { return { ok: false, error: 'Something went wrong. Nothing was changed.' }; }
  });
  on('gallery:fetch', () => gallery.fetchIndex());
  on('gallery:cached', () => gallery.cached());
  on('gallery:add', (e, id, sha) => gallery.add(id, sha, e));
}

module.exports = { create, register, readBounded, INDEX_URL, SIG_URL };
