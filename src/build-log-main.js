'use strict';
// Main-process side of the vibe-coder loop on the Discover page: build logs
// (draft → item-by-item review → export or Publish), "Start from this"
// remixes, and the unified catalogue. The page only names session keys, item
// ids, its edits, and the digest of the log it was shown; main keeps the draft.
// Nothing leaves this computer until the person presses Publish (and confirms
// the consent sheet), Report, or Remix on a link they pasted.

const fs = require('node:fs');
const path = require('node:path');
const BuildLog = require('./build-log.js');
const Kit = require('./starter-kit.js');
const Catalog = require('./discover-catalog.js');

const KEY = /^[\w.-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEYS = 20, MAX_BODY = 400_000, TIMEOUT_MS = 15_000;
const HUB_REASON = 'The team hub did not accept that just now. Nothing was changed.';

function create({ timelines, gallery = null, hub = () => null, fetch, confirm, pickSave, pickFolder, writeFile = (f, t) => fs.writeFileSync(f, t, { mode: 0o600 }), openExternal = () => {}, home = null, user = null, hostname = null, now = Date.now, demo = () => false, author = () => 'Me' }) {
  let draft = null;
  let pendingKit = null;
  const ctx = { home, user, hostname };

  async function readJson(res) {
    if (Number(res.headers?.get?.('content-length')) > MAX_BODY) return null;
    const raw = await res.text();
    if (Buffer.byteLength(raw) > MAX_BODY) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  async function hubCall(method, route, { team = null, body } = {}) {
    const id = hub();
    if (!id || typeof id.origin !== 'string' || typeof id.token !== 'function') return { ok: false, error: 'Sign in to a team hub first (Preferences → Team). Nothing was sent.' };
    const token = id.token();
    if (typeof token !== 'string' || !token) return { ok: false, error: 'Sign in to a team hub first (Preferences → Team). Nothing was sent.' };
    let res;
    try {
      res = await fetch(`${id.origin}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(team ? { 'X-Board-Team': team } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); // privacy-flow: build-log-publish
    } catch { return { ok: false, error: 'Could not reach the team hub. Nothing was changed.' }; }
    const json = await readJson(res).catch(() => null);
    if (res.status !== 200) return { ok: false, status: res.status, error: typeof json?.error?.message === 'string' ? json.error.message.slice(0, 300) : HUB_REASON };
    return { ok: true, body: json, origin: id.origin };
  }

  const view = () => {
    const final = BuildLog.finalize(draft, ctx);
    return { ok: true, fields: draft.fields, tools: draft.tools, cost_usd: draft.cost_usd, items: draft.items, final, digest: BuildLog.digest(final), problems: BuildLog.leftovers(final) };
  };
  const current = (dg) => { if (!draft) return null; const final = BuildLog.finalize(draft, ctx); return typeof dg === 'string' && BuildLog.digest(final) === dg ? final : null; };

  function sessions() {
    const rows = (timelines.list() || []).filter((r) => r && KEY.test(r.key));
    return { ok: true, sessions: rows.map((r) => ({ key: r.key, label: String(r.label || r.key).slice(0, 120), project: r.cwd ? path.basename(r.cwd) : '' })) };
  }
  async function makeDraft(keys, { kit = false } = {}) {
    if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS || keys.some((k) => typeof k !== 'string' || !KEY.test(k))) return { ok: false, error: 'Choose one or more sessions.' };
    const tls = [];
    for (const k of keys) { try { const t = await timelines.timelineOf(k); if (t) tls.push(t); } catch { /* skipped */ } }
    if (!tls.length) return { ok: false, error: 'Those sessions have no timeline on this computer (or their project is muted).' };
    let k = null;
    if (kit && tls[0].cwd) { try { k = Kit.fromProject(tls[0].cwd); } catch { k = null; } }
    draft = BuildLog.draftFrom(tls, { now, kit: k });
    return view();
  }
  function review(r) { if (!draft) return { ok: false, error: 'Make a draft first.' }; draft = BuildLog.applyReview(draft, r); return view(); }
  async function addKitFromFolder(e) {
    if (!draft) return { ok: false, error: 'Make a draft first.' };
    const dir = await pickFolder(e, 'Package a project as a starter kit');
    if (!dir) return { ok: false, cancelled: true };
    let k; try { k = Kit.fromProject(dir); } catch (err) { return { ok: false, error: `That project could not be packaged: ${err.message}.` }; }
    const kitItems = BuildLog.draftFrom([], { kit: k }).items.map((i, n) => ({ ...i, id: `k${n + 1}` }));
    draft = { ...draft, items: [...draft.items.filter((i) => i.section !== 'kit'), ...kitItems], fields: { ...draft.fields, repo: k.repo || draft.fields.repo } };
    return view();
  }

  async function exportHtml(e, dg) {
    const final = current(dg);
    if (!final) return { ok: false, error: 'The log changed since you reviewed it. Review it again.' };
    if (BuildLog.leftovers(final).length) return { ok: false, error: BuildLog.leftovers(final)[0] };
    const file = await pickSave(e, BuildLog.fileName(final));
    if (!file) return { ok: false, cancelled: true };
    try { writeFile(file, BuildLog.renderHtml(final, { author: author() })); } catch { return { ok: false, error: 'Could not save the file.' }; }
    return { ok: true, name: path.basename(file) };
  }

  async function teams() {
    const r = await hubCall('GET', '/api/account');
    if (!r.ok) return r;
    const list = Array.isArray(r.body?.teams) ? r.body.teams : [];
    return { ok: true, teams: list.filter((t) => t && UUID.test(t.id)).slice(0, 64).map((t) => ({ id: t.id, name: String(t.name || 'Team').slice(0, 80), role: String(t.role || '') })) };
  }
  async function publish(e, dg, team) {
    if (demo()) return { ok: false, error: 'This is the demo: nothing is published.' };
    const final = current(dg);
    if (!final) return { ok: false, error: 'The log changed since you reviewed it. Review it again.' };
    if (BuildLog.leftovers(final).length) return { ok: false, error: BuildLog.leftovers(final)[0] };
    if (typeof team !== 'string' || !UUID.test(team)) return { ok: false, error: 'Choose a team.' };
    const counts = `${final.timeline.length} timeline entries, ${final.prompts.length} prompts, ${final.files.length} file names${final.kit ? ', a starter kit' : ''}`;
    const yes = await confirm({ title: final.title, action: 'Publish', detail: [`Your team hub will keep this build log (${counts}) exactly as you reviewed it.`, 'Anyone with its link can read it, without signing in. You or a team admin can unpublish it at any time, which deletes it from the hub.', 'Copies people already saved are not recalled.'].join('\n') }, e);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was sent.' };
    const r = await hubCall('POST', '/api/build-logs', { team, body: { request_id: require('node:crypto').randomUUID(), log: final } });
    if (!r.ok) return r;
    const l = r.body?.log;
    return l && typeof l.path === 'string' ? { ok: true, id: l.id, url: `${r.origin}${l.path}` } : { ok: false, error: HUB_REASON };
  }
  async function published(team) {
    if (typeof team !== 'string' || !UUID.test(team)) return { ok: false, error: 'Choose a team.' };
    const r = await hubCall('GET', '/api/build-logs', { team });
    if (!r.ok) return r;
    const logs = Array.isArray(r.body?.logs) ? r.body.logs : [];
    return { ok: true, logs: logs.filter((l) => l && UUID.test(l.id) && typeof l.path === 'string' && /^\/b\/[A-Za-z0-9_-]{22}$/.test(l.path)).slice(0, 200).map((l) => ({ id: l.id, title: String(l.title || '').slice(0, 120), remix_count: Number.isSafeInteger(l.remix_count) ? l.remix_count : 0, hidden: l.hidden === true, created_at: String(l.created_at || '').slice(0, 40), url: `${r.origin}${l.path}` })) };
  }
  async function unpublish(e, team, id) {
    if (typeof team !== 'string' || !UUID.test(team) || typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'Choose a build log.' };
    const yes = await confirm({ title: 'this build log', action: 'Unpublish', detail: 'It is deleted from your team hub and its link stops working.' }, e);
    if (!yes) return { ok: false, cancelled: true };
    const r = await hubCall('DELETE', `/api/build-logs/${id}`, { team, body: { request_id: require('node:crypto').randomUUID() } });
    return r.ok ? { ok: true } : r;
  }

  // A pasted link's kit: fetched without any credential, checked, held for one install.
  async function remixPreview(link) {
    const L = Kit.remixLink(link);
    if (!L) return { ok: false, error: 'Paste a build log link (https://…/b/…).' };
    let res;
    try { res = await fetch(L.kit, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } }); } catch { return { ok: false, error: 'Could not reach that link.' }; } // privacy-flow: build-log-remix
    const j = res.status === 200 ? await readJson(res).catch(() => null) : null;
    if (!j || !j.kit) return { ok: false, error: res.status === 404 ? 'That build log is not available (it may have been unpublished).' : 'That build log has no starter kit to remix.' };
    let kit; try { kit = Kit.normalize(j.kit); } catch (err) { return { ok: false, error: `That starter kit is not valid: ${err.message}.` }; }
    pendingKit = { kit, link: L, title: String(j.title || 'a build log').slice(0, 120), author: String(j.author || 'someone').slice(0, 80), expires: now() + 10 * 60_000 };
    return { ok: true, title: pendingKit.title, author: pendingKit.author, remix_count: Number.isSafeInteger(j.remix_count) ? j.remix_count : 0, permissions: Kit.manifest(kit), kit };
  }
  async function remixInstall(e) {
    if (demo()) return { ok: false, error: 'This is the demo: nothing is installed.' };
    const p = pendingKit;
    if (!p || p.expires < now()) { pendingKit = null; return { ok: false, error: 'Open the link again first.' }; }
    const yes = await confirm({ title: p.title, action: 'Choose a folder and install', detail: [`A starter kit by ${p.author} (self-declared), from ${p.link.origin}.`, 'Installing it:', ...Kit.manifest(p.kit).map((l) => `• ${l}`), '', 'You choose the folder next. The author is credited at the top of CLAUDE.md, and the remix is counted on their page.'].join('\n') }, e);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was installed.' };
    const dir = await pickFolder(e, 'Install the starter kit into');
    if (!dir) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was installed.' };
    let out; try { out = Kit.install(p.kit, dir, { credit: { title: p.title, author: p.author, link: p.link.page } }); } catch (err) { return { ok: false, error: `Could not install: ${err.message}.` }; }
    pendingKit = null;
    try { await fetch(p.link.remix, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { /* the count is best effort */ } // privacy-flow: build-log-remix
    return { ok: true, ...out };
  }
  async function reportLink(e, link, reason) {
    const L = Kit.remixLink(link);
    if (!L) return { ok: false, error: 'Paste a build log link (https://…/b/…).' };
    const yes = await confirm({ title: 'this build log', action: 'Report', detail: `Sends your reason (not your name) to ${L.origin}. After several reports it is hidden until its team reviews it.` }, e);
    if (!yes) return { ok: false, cancelled: true };
    try {
      const res = await fetch(`${L.page}/report`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: String(reason || '').slice(0, 500) }) }); // privacy-flow: build-log-remix
      return res.status === 200 ? { ok: true } : { ok: false, error: 'That report was not accepted. Try again later.' };
    } catch { return { ok: false, error: 'Could not reach that link.' }; }
  }

  async function catalogView(team) {
    let view = null, installed = null, logs = [];
    try { view = gallery?.cached() ?? null; } catch { view = null; }
    try { installed = gallery?.installed() ?? null; } catch { installed = null; }
    if (typeof team === 'string' && UUID.test(team)) { const r = await published(team); if (r.ok) logs = r.logs; }
    return { ok: true, fetched: !!view?.ok, ...Catalog.catalog({ view, installed, logs }) };
  }
  async function install(e, id, sha, kind) {
    if (!gallery) return { ok: false, error: 'The gallery is not available.' };
    return kind === 'pack' ? gallery.addPack(id, sha, e) : gallery.add(id, sha, e);
  }
  async function report(e, id) {
    const item = (gallery?.entries() || []).find((x) => x.id === id);
    if (!item) return { ok: false, error: 'That item is no longer in the gallery.' };
    const yes = await confirm({ title: item.title, action: 'Report in the browser', detail: 'Opens a prefilled GitHub issue in your browser naming this item, for the gallery maintainers to review and take down. Nothing is sent until you submit it there.' }, e);
    if (!yes) return { ok: false, cancelled: true };
    openExternal(Catalog.reportUrl(item)); // privacy-flow: discover-report
    return { ok: true };
  }

  return { sessions, makeDraft, review, addKitFromFolder, exportHtml, teams, publish, published, unpublish, remixPreview, remixInstall, reportLink, catalog: catalogView, install, report, _draft: () => draft };
}

function register({ ipcMain, allowed, service }) {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(e, ...args); } catch { return { ok: false, error: 'Something went wrong. Nothing was changed.' }; }
  });
  const s = service;
  on('vibe:sessions', () => s.sessions());
  on('vibe:draft', (e, keys, opts) => s.makeDraft(keys, { kit: !!opts?.kit }));
  on('vibe:review', (e, r) => s.review(r));
  on('vibe:kit-from-folder', (e) => s.addKitFromFolder(e));
  on('vibe:export', (e, dg) => s.exportHtml(e, dg));
  on('vibe:teams', () => s.teams());
  on('vibe:publish', (e, dg, team) => s.publish(e, dg, team));
  on('vibe:published', (e, team) => s.published(team));
  on('vibe:unpublish', (e, team, id) => s.unpublish(e, team, id));
  on('vibe:remix-preview', (e, link) => s.remixPreview(link));
  on('vibe:remix-install', (e) => s.remixInstall(e));
  on('vibe:report-link', (e, link, reason) => s.reportLink(e, link, reason));
  on('vibe:catalog', (e, team) => s.catalog(team));
  on('vibe:install', (e, id, sha, kind) => s.install(e, String(id), String(sha), kind === 'pack' ? 'pack' : 'add'));
  on('vibe:report', (e, id) => s.report(e, String(id)));
}

module.exports = { create, register };
