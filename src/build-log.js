'use strict';
// Shareable build logs (vibe-coder loop, lane F), the pure part. A draft is
// built from one or more session timelines (src/session-timeline.js) of the
// same project: a timeline, the prompts, the cost, the files changed, and
// optional deployed link, before/after and starter kit. Every piece of text is
// an item with an id, so the review screen can edit or remove each one and
// main applies those edits to its own copy. The final log is scrubbed again
// (secrets redacted, the home folder and absolute project paths removed), and
// its digest is what the person saw: publish and export take only that digest.
// The same log is exported as one self-contained HTML file (no script) and
// published to the team hub (board/hub/build-logs.js checks the same shape).

const crypto = require('node:crypto');
const path = require('node:path');
const { redactSecretsPass } = require('./scrub.js');
const { hasCredential } = require('./secret-patterns.js');
const Kit = require('./starter-kit.js');

const LIMITS = Object.freeze({ timeline: 200, prompts: 100, files: 200, text: 500, prompt: 2000, title: 120, note: 1000 });
const KINDS = new Set(['prompt', 'edit', 'command', 'checkpoint', 'note', 'deploy', 'tool', 'failed']);
const PROVIDER = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const clip = (s, n) => { const t = String(s ?? '').replace(HIDDEN, ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

// Secrets out, the home folder as ~, the project folder dropped, user/host names masked.
function scrubText(text, { home = null, roots = [], user = null, hostname = null } = {}) {
  let t = redactSecretsPass(String(text ?? ''));
  for (const r of [...roots].filter((x) => typeof x === 'string' && x.length > 1).sort((a, b) => b.length - a.length)) {
    const root = escRe(r.replace(/[\\/]+$/, ''));
    t = t.replace(new RegExp(`(?:file://)?${root}[\\\\/]`, 'g'), '').replace(new RegExp(`(?:file://)?${root}(?![\\w.-])`, 'g'), '.');
  }
  if (typeof home === 'string' && home.length > 1) t = t.replace(new RegExp(`(?:file://)?${escRe(home.replace(/[\\/]+$/, ''))}(?![\\w.-])`, 'g'), '~');
  for (const n of [user, hostname]) if (typeof n === 'string' && n.length > 2) t = t.replace(new RegExp(`(?<![\\w.-])${escRe(n)}(?![\\w-])`, 'g'), '[name]');
  return t.replace(HIDDEN, '');
}

// A project-relative path, or null when it is outside every root.
function relPath(p, roots) {
  if (typeof p !== 'string' || !p) return null;
  for (const r of roots) {
    if (typeof r !== 'string' || !r) continue;
    const rel = path.relative(r, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.isAbsolute(p) ? null : p.split(path.sep).join('/');
}

// A draft from timelines (Timeline.build output, any order). Items carry ids for the review screen.
function draftFrom(timelines, { now = Date.now, kit = null } = {}) {
  const tls = (Array.isArray(timelines) ? timelines : []).filter((t) => t && Array.isArray(t.events)).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const roots = [...new Set(tls.map((t) => t.cwd).filter(Boolean))];
  const items = [];
  let n = 0;
  const add = (section, fields) => { items.push({ id: `i${++n}`, section, include: true, ...fields }); };
  let cost = 0, priced = false;
  const files = new Map();
  for (const tl of tls) {
    if (tl.spend && Number.isFinite(tl.spend.usd)) { cost += tl.spend.usd; priced = true; }
    for (const f of tl.files || []) {
      const p = relPath(f.path, roots);
      if (!p) continue;
      const cur = files.get(p) || { path: p, edits: 0, add: null, del: null };
      cur.edits += f.edits || 0;
      if (f.add != null) cur.add = (cur.add || 0) + f.add;
      if (f.del != null) cur.del = (cur.del || 0) + f.del;
      files.set(p, cur);
    }
    for (const e of tl.events) {
      if (e.kind === 'prompt' && e.text) {
        if (items.filter((x) => x.section === 'prompts').length < LIMITS.prompts) add('prompts', { at: e.at, text: clip(e.text, LIMITS.prompt) });
        if (items.filter((x) => x.section === 'timeline').length < LIMITS.timeline) add('timeline', { at: e.at, kind: 'prompt', text: clip(e.text.split('\n')[0], 160) });
      } else if (e.kind === 'command' && e.text && items.filter((x) => x.section === 'timeline').length < LIMITS.timeline) add('timeline', { at: e.at, kind: 'command', text: clip(e.text, LIMITS.text) });
      else if (e.kind === 'checkpoint' && items.filter((x) => x.section === 'timeline').length < LIMITS.timeline) add('timeline', { at: e.at, kind: 'checkpoint', text: `Checkpoint: ${(e.files || []).length} file${(e.files || []).length === 1 ? '' : 's'} changed` });
      else if (e.kind === 'failed' && items.filter((x) => x.section === 'timeline').length < LIMITS.timeline) add('timeline', { at: e.at, kind: 'failed', text: `A tool failed${e.tool ? `: ${clip(e.tool, 80)}` : ''}` });
    }
  }
  for (const f of [...files.values()].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)).slice(0, LIMITS.files)) add('files', { path: clip(f.path, 200), edits: f.edits, add: f.add, del: f.del });
  if (kit) {
    if (kit.claude_md) add('kit', { part: 'claude_md', text: kit.claude_md });
    for (const s of kit.skills || []) add('kit', { part: 'skill', name: s.name, text: s.content });
    for (const m of kit.mcp || []) add('kit', { part: 'mcp', name: m.name, command: m.command, args: m.args, url: m.url });
  }
  const tools = [...new Set(tls.map((t) => PROVIDER[t.adapter] || t.adapter).filter(Boolean))].slice(0, 8);
  const project = tls.find((t) => t.project)?.project || '';
  return {
    v: 1,
    roots,
    fields: {
      title: clip(project ? `Building ${project}` : 'Build log', LIMITS.title),
      summary: '', project: clip(project, 80), deployed_url: '', before: '', after: '',
      repo: kit?.repo || '', budget_usd: kit?.budget_usd ?? null,
    },
    tools,
    started_at: isoOrNull(tls[0]?.startedAt),
    ended_at: isoOrNull(tls.map((t) => t.lastActive).filter(Boolean).sort().pop()),
    cost_usd: priced ? Math.round(cost * 100) / 100 : null,
    items,
    createdAt: now(),
  };
}

const FIELD_MAX = { title: LIMITS.title, summary: LIMITS.note, project: 80, deployed_url: 300, before: LIMITS.note, after: LIMITS.note, repo: 300 };
// The review screen's edits: field text, and per item id {include, text}. Anything else is ignored.
function applyReview(draft, review) {
  const out = { ...draft, fields: { ...draft.fields }, items: draft.items.map((i) => ({ ...i })) };
  if (!review || typeof review !== 'object') return out;
  const f = review.fields && typeof review.fields === 'object' ? review.fields : {};
  for (const [k, max] of Object.entries(FIELD_MAX)) if (typeof f[k] === 'string') out.fields[k] = clip(f[k], max);
  if (f.budget_usd === null || (typeof f.budget_usd === 'number' && f.budget_usd > 0 && f.budget_usd <= 10_000)) out.fields.budget_usd = f.budget_usd;
  const edits = Array.isArray(review.items) ? review.items : [];
  for (const e of edits) {
    const it = e && typeof e.id === 'string' ? out.items.find((x) => x.id === e.id) : null;
    if (!it) continue;
    if (typeof e.include === 'boolean') it.include = e.include;
    if (typeof e.text === 'string' && 'text' in it) it.text = clip(e.text, it.section === 'prompts' ? LIMITS.prompt : it.section === 'kit' ? 20_000 : LIMITS.text);
  }
  return out;
}

const httpsOrNull = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };

// The log exactly as it would leave: only included items, scrubbed, in the hub's shape.
function finalize(draft, ctx = {}) {
  const s = (t) => scrubText(t, { ...ctx, roots: draft.roots });
  const inc = (sec) => draft.items.filter((i) => i.section === sec && i.include);
  const kitParts = inc('kit');
  const kit = kitParts.length || draft.fields.repo ? Kit.normalize({
    repo: httpsOrNull(draft.fields.repo),
    claude_md: s(kitParts.find((p) => p.part === 'claude_md')?.text || ''),
    skills: kitParts.filter((p) => p.part === 'skill').map((p) => ({ name: p.name, content: s(p.text) })),
    mcp: kitParts.filter((p) => p.part === 'mcp').map((p) => ({ name: p.name, command: p.command ? s(p.command) : null, args: (p.args || []).map(s), url: p.url ? httpsOrNull(p.url) : null })),
    budget_usd: draft.fields.budget_usd ?? null,
  }) : null;
  return {
    schema: 1,
    title: s(draft.fields.title).trim() || 'Build log',
    summary: s(draft.fields.summary),
    project: s(draft.fields.project),
    tools: draft.tools,
    started_at: draft.started_at,
    ended_at: draft.ended_at,
    cost_usd: draft.cost_usd,
    deployed_url: draft.fields.deployed_url ? httpsOrNull(draft.fields.deployed_url) : null,
    before: s(draft.fields.before),
    after: s(draft.fields.after),
    timeline: inc('timeline').map((i) => ({ at: i.at || null, kind: KINDS.has(i.kind) ? i.kind : 'note', text: clip(s(i.text), LIMITS.text) })),
    prompts: inc('prompts').map((i) => ({ at: i.at || null, text: clip(s(i.text), LIMITS.prompt) })).filter((p) => p.text.trim()),
    files: inc('files').map((i) => ({ path: s(i.path), edits: i.edits, add: i.add, del: i.del })).filter((f) => f.path && !f.path.startsWith('/') && !f.path.split('/').includes('..')),
    kit: kit ? { ...kit, permissions: Kit.manifest(kit) } : null,
  };
}

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const digest = (log) => crypto.createHash('sha256').update(canonical(log)).digest('hex');
// What the review screen shows as "still looks like a secret": the publish is refused while any remain.
const leftovers = (log) => (hasCredential(JSON.stringify(log)) ? ['Something in this log still looks like a password, key or token. Edit or remove it before sharing.'] : []);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// One self-contained page: inline style, no script, no remote content; the same layout as the hub page.
function renderHtml(log, { author = 'Me' } = {}) {
  const when = (a) => (a ? `<span class="m">${esc(a.slice(0, 16).replace('T', ' '))}</span> ` : '');
  const ul = (xs, fn) => (xs.length ? `<ul>${xs.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '<p class="m">None.</p>');
  const style = 'body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1d1d1f;background:#fff}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.m{color:#6e6e73;font-size:13px}pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px;font-size:13px}.k{font-size:12px;text-transform:uppercase;color:#6e6e73;margin-right:6px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#222}}';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(log.title)} · build log</title><style>${style}</style></head><body>
<h1>${esc(log.title)}</h1><p class="m">Build log${log.project ? ` of ${esc(log.project)}` : ''} by ${esc(author)}${log.tools.length ? ` · ${esc(log.tools.join(', '))}` : ''}${log.cost_usd != null ? ` · about $${log.cost_usd.toFixed(2)} in AI usage` : ''}</p>
${log.summary ? `<p>${esc(log.summary)}</p>` : ''}${log.deployed_url ? `<p>Live at <a href="${esc(log.deployed_url)}" rel="nofollow noopener noreferrer">${esc(log.deployed_url)}</a></p>` : ''}
${log.before || log.after ? `<h2>Before and after</h2><p><b>Before:</b> ${esc(log.before) || '—'}</p><p><b>After:</b> ${esc(log.after) || '—'}</p>` : ''}
<h2>Timeline</h2>${ul(log.timeline, (e) => `${when(e.at)}<span class="k">${esc(e.kind)}</span>${esc(e.text)}`)}
<h2>Prompts</h2>${log.prompts.length ? `<ol>${log.prompts.map((p) => `<li>${when(p.at)}<pre>${esc(p.text)}</pre></li>`).join('')}</ol>` : '<p class="m">None shared.</p>'}
<h2>Files changed</h2>${ul(log.files, (f) => `<code>${esc(f.path)}</code> <span class="m">${f.edits} edit${f.edits === 1 ? '' : 's'}${f.add != null ? ` · +${f.add}` : ''}${f.del != null ? ` −${f.del}` : ''}</span>`)}
${log.kit ? `<h2>Starter kit</h2><p class="m">What installing it would do:</p>${ul(log.kit.permissions, esc)}` : ''}
<footer><p><b>Made with Plexiform — remix this.</b></p></footer>
</body></html>`;
}

const fileName = (log) => `${(log.title || 'build-log').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'build-log'}.html`;

module.exports = { draftFrom, applyReview, finalize, digest, leftovers, renderHtml, scrubText, relPath, fileName, LIMITS };
