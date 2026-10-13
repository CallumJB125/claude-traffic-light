'use strict';
// "Share to gallery…": turns one of the person's own recipes, a hatched
// character or a set of widget rules into a gallery item (gallery/README.md),
// checked with the same validator CI runs, and hands it over as a prefilled
// GitHub "new file" page or as JSON on the clipboard. No token, no API call:
// the person opens the pull request in their own browser, signed in as
// themselves. Setups are owner-only and never offered here.
//
// Drafts are kept in main by token for a few minutes; the page names a token
// and never sends a URL or JSON to be opened or copied.

const { randomUUID } = require('node:crypto');
const S = require('./gallery-schema.js');
const Recipes = require('./recipes.js');

const REPO = 'https://github.com/CallumJB125/claude-traffic-light';
const BRANCH = 'main';
const ITEMS_DIR = 'gallery/items';
// Browsers and GitHub take longer, but a prefilled page past this is unreliable; the JSON copy covers it.
const URL_LIMIT = 8 * 1024;
const SHAREABLE = Object.freeze(['recipe', 'character', 'rules']);
const DRAFT_TTL = 10 * 60 * 1000;
const META_KEYS = ['title', 'summary', 'tags', 'stacks', 'license', 'authorName', 'authorGithub'];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// "Explain this repo (my copy)" → "explain-this-repo-my-copy", within the gallery id rules.
function slug(text) {
  const words = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words.slice(0, 8)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > S.LIMITS.id) break;
    out = next;
  }
  return out;
}

const words = (v, max) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).slice(0, max);

// The item for one source. meta is what the person typed; the payload comes
// from the stored thing, never from the page. → { item, problems }
function buildItem({ kind, source, meta = {}, now = Date.now() }) {
  if (!SHAREABLE.includes(kind)) return { item: null, problems: [`${String(kind).slice(0, 20)}: not something you can share from here`] };
  const m = isObject(meta) ? meta : {};
  const title = typeof m.title === 'string' ? m.title.trim() : '';
  const id = slug(title);
  const author = { name: typeof m.authorName === 'string' ? m.authorName.trim() : '' };
  const github = typeof m.authorGithub === 'string' ? m.authorGithub.trim().replace(/^@/, '') : '';
  if (github) author.github = github;
  const problems = [];
  let payload = null, tools = [];
  if (kind === 'recipe') {
    if (!isObject(source) || !Recipes.valid(source)) return { item: null, problems: ['That recipe is no longer available.'] };
    if (source.edits) problems.push('Gallery recipes only read: this one changes files. Save a read-only version first.');
    payload = { id, title, what: source.what, prompt: source.prompt, tool: source.tool, edits: false, cost: source.cost };
    tools = [source.tool];
  } else if (kind === 'character') {
    if (!isObject(source) || typeof source.name !== 'string') return { item: null, problems: ['That character is no longer available.'] };
    const { css: _css, ...rest } = source;
    payload = { ...rest, id };
  } else {
    const Rules = require('../rules.js');
    const list = isObject(source) && Array.isArray(source.rules) ? source.rules : Array.isArray(source) ? source : null;
    if (!list) return { item: null, problems: ['No rules to share.'] };
    payload = { rulesVersion: Rules.RULES_VERSION, rules: list.map((r) => Rules.normalizeRule(r)) };
  }
  const item = {
    schema: 1, kind, id, title,
    summary: typeof m.summary === 'string' ? m.summary.trim() : '',
    author,
    license: S.LICENSES.includes(m.license) ? m.license : S.LICENSES[0],
    tags: words(m.tags, S.LIMITS.tags),
    stacks: words(m.stacks, S.LIMITS.stacks).filter((s) => S.STACKS.includes(s)),
    tools,
    added: day(now), updated: day(now),
    payload,
  };
  if (!item.stacks.length) item.stacks = ['any'];
  if (!id) problems.unshift('title: give it a title to make its id');
  problems.push(...S.validateItem(item, id).filter((p) => !(p.startsWith('id:') && !id)));
  return { item, problems };
}

// The bytes of gallery/items/<kind>/<id>.json, in the field order the README shows.
const itemText = (item) => `${JSON.stringify(item, null, 2)}\n`;

// GitHub's "new file" page, prefilled: /new/<branch>/<dir>?filename=…&value=…
function prUrl(item, { repo = REPO, branch = BRANCH, limit = URL_LIMIT } = {}) {
  const url = `${repo}/new/${branch}/${ITEMS_DIR}/${item.kind}?filename=${encodeURIComponent(`${item.id}.json`)}&value=${encodeURIComponent(itemText(item))}`;
  return Buffer.byteLength(url) > limit ? null : url;
}

// recipes: src/recipes.js engine; characterStore: src/character-store.js;
// presets(): the saved widget presets; profile: { get, set } for the author
// the person typed once; openExternal and clipboard from Electron.
function create({ recipes, characterStore, presets = () => [], profile, openExternal, clipboard, now = Date.now, demo = () => false }) {
  const drafts = new Map();
  const sweep = () => { const t = now(); for (const [k, d] of drafts) if (t - d.at > DRAFT_TTL) drafts.delete(k); };

  function sourceOf(kind, ref) {
    if (kind === 'recipe') {
      const r = typeof ref === 'string' ? recipes.mine().find((x) => x.id === ref) : null;
      if (!r) return { error: 'That recipe is not one of yours. Save it as your own first.' };
      if (recipes.originOf(r.id)) return { error: 'This recipe came from the gallery already.' };
      return { source: r, defaults: { title: r.title.replace(/\s*\(my copy\)$/, ''), summary: r.what, tags: [], stacks: ['any'] } };
    }
    if (kind === 'character') {
      const c = typeof ref === 'string' ? characterStore.list().find((x) => x.character.id === ref) : null;
      if (!c) return { error: 'That character is not one of yours.' };
      return { source: c.character, defaults: { title: c.character.name, summary: `A widget character named ${c.character.name}.`, tags: ['character'], stacks: ['any'] } };
    }
    if (kind === 'rules') {
      if (isObject(ref) && typeof ref.preset === 'string') {
        const p = presets().find((x) => x && x.id === ref.preset);
        if (!p || !Array.isArray(p.rules)) return { error: 'That preset is no longer there.' };
        return { source: { rules: p.rules }, defaults: { title: p.name, summary: '', tags: [], stacks: ['any'] } };
      }
      if (isObject(ref) && Array.isArray(ref.rules) && ref.rules.length && ref.rules.length <= S.LIMITS.rules) return { source: { rules: ref.rules }, defaults: { title: '', summary: '', tags: [], stacks: ['any'] } };
      return { error: 'No rules to share.' };
    }
    return { error: 'That cannot be shared from here.' };
  }

  // What the form starts with: the stored author and what the thing already says about itself.
  function begin(kind, ref) {
    if (!SHAREABLE.includes(kind)) return { ok: false, error: 'That cannot be shared from here.' };
    const s = sourceOf(kind, ref);
    if (s.error) return { ok: false, error: s.error };
    const a = profile.get() || {};
    return { ok: true, kind, defaults: { ...s.defaults, license: S.LICENSES[0], authorName: typeof a.name === 'string' ? a.name : '', authorGithub: typeof a.github === 'string' ? a.github : '' }, licenses: S.LICENSES, stacks: S.STACKS };
  }

  // The item as it would be published, checked, kept under a token for Open and Copy.
  function draft(kind, ref, meta) {
    sweep();
    if (demo()) return { ok: false, error: 'This is the demo: exit it to share to the gallery.' };
    const s = sourceOf(kind, ref);
    if (s.error) return { ok: false, error: s.error };
    const m = isObject(meta) ? Object.fromEntries(META_KEYS.filter((k) => Object.hasOwn(meta, k)).map((k) => [k, meta[k]])) : {};
    const { item, problems } = buildItem({ kind, source: s.source, meta: m, now: now() });
    if (!item) return { ok: false, error: problems[0] };
    if (!problems.length) profile.set({ name: item.author.name, ...(item.author.github && { github: item.author.github }) });
    const text = itemText(item);
    const url = problems.length ? null : prUrl(item);
    const token = randomUUID();
    drafts.set(token, { item, text, url, at: now() });
    while (drafts.size > 8) drafts.delete(drafts.keys().next().value);
    return { ok: true, token, item, text, problems, canOpen: !!url, path: `${ITEMS_DIR}/${item.kind}/${item.id}.json`, repo: REPO };
  }

  const take = (token) => { sweep(); return typeof token === 'string' ? drafts.get(token) : null; };
  async function open(token) {
    const d = take(token);
    if (!d) return { ok: false, error: 'Start the share again.' };
    if (!d.url) return { ok: false, error: 'This item is too big for a prefilled page. Copy the JSON instead.' };
    await openExternal(d.url); // privacy-flow: gallery-publish
    return { ok: true };
  }
  function copy(token) {
    const d = take(token);
    if (!d) return { ok: false, error: 'Start the share again.' };
    clipboard.writeText(d.text);
    return { ok: true, path: `${ITEMS_DIR}/${d.item.kind}/${d.item.id}.json` };
  }
  return { begin, draft, open, copy };
}

function register({ ipcMain, allowed, publish }) {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(e, ...args); } catch { return { ok: false, error: 'Something went wrong. Nothing was sent.' }; }
  });
  on('gallery-publish:begin', (_e, kind, ref) => publish.begin(kind, ref));
  on('gallery-publish:draft', (_e, kind, ref, meta) => publish.draft(kind, ref, meta));
  on('gallery-publish:open', (_e, token) => publish.open(token));
  on('gallery-publish:copy', (_e, token) => publish.copy(token));
}

module.exports = { create, register, buildItem, itemText, prUrl, slug, SHAREABLE, REPO, BRANCH, URL_LIMIT };
