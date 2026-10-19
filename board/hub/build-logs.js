// Published build logs and their starter kits (vibe-coder loop, lane F).
// A team writer publishes a log the desktop app already scrubbed and the
// person reviewed item by item; the hub checks its shape again and refuses
// anything that still looks like a credential. It is then readable by anyone
// holding its unguessable link (/b/<slug>, handled before the route table
// with no sign-in), until its author or a team admin unpublishes it, which
// deletes it. The public page carries no script and no third-party content.
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { HubError } from './db.js';
import { can, isAdmin } from './permissions.js';
import { hasCredential } from '../shared/secret-patterns.mjs';
import { ipKey } from './ratelimit.js';

export const LIMITS = Object.freeze({ bytes: 300_000, perOrg: 200, timeline: 200, prompts: 100, files: 200, skills: 20, mcp: 20, permissions: 50, reportsToHide: 3 });
const KINDS = ['prompt', 'edit', 'command', 'checkpoint', 'note', 'deploy', 'tool', 'failed'];
const SLUG = /^[A-Za-z0-9_-]{22}$/;
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/u;
const bad = (m) => { throw new HubError('VALIDATION', m); };
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys, where) => { if (!obj(v) || Object.keys(v).some((k) => !keys.includes(k))) bad(`${where}: unknown or missing field`); };
const text = (v, max, where, { nullable = false, empty = true } = {}) => {
  if (v == null && nullable) return null;
  if (typeof v !== 'string' || v.length > max || HIDDEN.test(v) || (!empty && !v.trim())) bad(`${where} must be text of at most ${max} characters`);
  return v;
};
const int = (v, where, nullable = false) => { if (v == null && nullable) return null; if (!Number.isSafeInteger(v) || v < 0) bad(`${where} must be a whole number`); return v; };
const iso = (v, where) => { if (v == null) return null; if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) bad(`${where} must be a date`); return v; };
const httpsUrl = (v, where) => {
  if (v == null) return null;
  let u; try { u = new URL(text(v, 300, where)); } catch { bad(`${where} must be an https link`); }
  if (u.protocol !== 'https:' || u.username || u.password) bad(`${where} must be an https link`);
  return u.href;
};
const list = (v, max, where) => { if (!Array.isArray(v) || v.length > max) bad(`${where} must be a list of at most ${max}`); return v; };

// The one shape a published log may have. Unknown fields are refused, never kept.
export function validateLog(log) {
  closed(log, ['schema', 'title', 'summary', 'project', 'tools', 'started_at', 'ended_at', 'cost_usd', 'deployed_url', 'before', 'after', 'timeline', 'prompts', 'files', 'kit'], 'log');
  if (log.schema !== 1) bad('log.schema must be 1');
  const out = {
    schema: 1,
    title: text(log.title, 120, 'title', { empty: false }),
    summary: text(log.summary ?? '', 1000, 'summary'),
    project: text(log.project ?? '', 80, 'project'),
    tools: list(log.tools ?? [], 8, 'tools').map((t, i) => text(t, 40, `tools[${i}]`)),
    started_at: iso(log.started_at, 'started_at'),
    ended_at: iso(log.ended_at, 'ended_at'),
    cost_usd: log.cost_usd == null ? null : (typeof log.cost_usd === 'number' && Number.isFinite(log.cost_usd) && log.cost_usd >= 0 && log.cost_usd < 1e6 ? Math.round(log.cost_usd * 100) / 100 : bad('cost_usd must be a number')),
    deployed_url: httpsUrl(log.deployed_url, 'deployed_url'),
    before: text(log.before ?? '', 1000, 'before'),
    after: text(log.after ?? '', 1000, 'after'),
    timeline: list(log.timeline ?? [], LIMITS.timeline, 'timeline').map((e, i) => { closed(e, ['at', 'kind', 'text'], `timeline[${i}]`); if (!KINDS.includes(e.kind)) bad(`timeline[${i}].kind`); return { at: iso(e.at, `timeline[${i}].at`), kind: e.kind, text: text(e.text, 500, `timeline[${i}].text`) }; }),
    prompts: list(log.prompts ?? [], LIMITS.prompts, 'prompts').map((p, i) => { closed(p, ['at', 'text'], `prompts[${i}]`); return { at: iso(p.at, `prompts[${i}].at`), text: text(p.text, 2000, `prompts[${i}].text`, { empty: false }) }; }),
    files: list(log.files ?? [], LIMITS.files, 'files').map((f, i) => { closed(f, ['path', 'edits', 'add', 'del'], `files[${i}]`); const p = text(f.path, 200, `files[${i}].path`, { empty: false }); if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) bad(`files[${i}].path must be relative to the project`); return { path: p, edits: int(f.edits ?? 0, `files[${i}].edits`), add: int(f.add, `files[${i}].add`, true), del: int(f.del, `files[${i}].del`, true) }; }),
    kit: log.kit == null ? null : validateKit(log.kit),
  };
  return out;
}

export function validateKit(kit) {
  closed(kit, ['repo', 'claude_md', 'skills', 'mcp', 'budget_usd', 'permissions'], 'kit');
  return {
    repo: httpsUrl(kit.repo, 'kit.repo'),
    claude_md: text(kit.claude_md ?? '', 20_000, 'kit.claude_md'),
    skills: list(kit.skills ?? [], LIMITS.skills, 'kit.skills').map((s, i) => { closed(s, ['name', 'content'], `kit.skills[${i}]`); const name = text(s.name, 60, `kit.skills[${i}].name`, { empty: false }); if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) bad(`kit.skills[${i}].name must be lower-case letters, digits and dashes`); return { name, content: text(s.content, 20_000, `kit.skills[${i}].content`, { empty: false }) }; }),
    mcp: list(kit.mcp ?? [], LIMITS.mcp, 'kit.mcp').map((m, i) => { closed(m, ['name', 'command', 'args', 'url'], `kit.mcp[${i}]`); const name = text(m.name, 60, `kit.mcp[${i}].name`, { empty: false }); if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) bad(`kit.mcp[${i}].name`); const command = text(m.command ?? null, 200, `kit.mcp[${i}].command`, { nullable: true }); const url = httpsUrl(m.url, `kit.mcp[${i}].url`); if (!command === !url) bad(`kit.mcp[${i}] needs a command or an https url`); return { name, command, args: list(m.args ?? [], 20, `kit.mcp[${i}].args`).map((a, j) => text(a, 200, `kit.mcp[${i}].args[${j}]`)), url }; }),
    budget_usd: kit.budget_usd == null ? null : (typeof kit.budget_usd === 'number' && kit.budget_usd > 0 && kit.budget_usd <= 10_000 ? Math.round(kit.budget_usd * 100) / 100 : bad('kit.budget_usd')),
    permissions: list(kit.permissions ?? [], LIMITS.permissions, 'kit.permissions').map((p, i) => text(p, 200, `kit.permissions[${i}]`, { empty: false })),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const STYLE = 'body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1d1d1f;background:#fff}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.m{color:#6e6e73;font-size:13px}ol,ul{padding-left:20px}li{margin:4px 0}pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px;font-size:13px}.k{font-size:12px;text-transform:uppercase;color:#6e6e73;margin-right:6px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#222}}';

// A self-contained page (no script). The desktop export uses the same layout.
export function renderPage(log, { author, remixes = 0, kitUrl = null }) {
  const li = (items, fn) => (items.length ? `<ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '<p class="m">None.</p>');
  const when = (a) => (a ? `<span class="m">${esc(a.slice(0, 16).replace('T', ' '))}</span> ` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(log.title)} · build log</title><style>${STYLE}</style></head><body>
<h1>${esc(log.title)}</h1><p class="m">Build log${log.project ? ` of ${esc(log.project)}` : ''} by ${esc(author)}${log.tools.length ? ` · ${esc(log.tools.join(', '))}` : ''}${log.cost_usd != null ? ` · about $${log.cost_usd.toFixed(2)} in AI usage` : ''}</p>
${log.summary ? `<p>${esc(log.summary)}</p>` : ''}${log.deployed_url ? `<p>Live at <a href="${esc(log.deployed_url)}" rel="nofollow noopener noreferrer">${esc(log.deployed_url)}</a></p>` : ''}
${log.before || log.after ? `<h2>Before and after</h2><p><b>Before:</b> ${esc(log.before) || '—'}</p><p><b>After:</b> ${esc(log.after) || '—'}</p>` : ''}
<h2>Timeline</h2>${li(log.timeline, (e) => `${when(e.at)}<span class="k">${esc(e.kind)}</span>${esc(e.text)}`)}
<h2>Prompts</h2>${log.prompts.length ? `<ol>${log.prompts.map((p) => `<li>${when(p.at)}<pre>${esc(p.text)}</pre></li>`).join('')}</ol>` : '<p class="m">None shared.</p>'}
<h2>Files changed</h2>${li(log.files, (f) => `<code>${esc(f.path)}</code> <span class="m">${f.edits} edit${f.edits === 1 ? '' : 's'}${f.add != null ? ` · +${f.add}` : ''}${f.del != null ? ` −${f.del}` : ''}</span>`)}
${log.kit ? `<h2>Starter kit</h2><p>${log.kit.skills.length} skill${log.kit.skills.length === 1 ? '' : 's'}, ${log.kit.mcp.length} MCP server${log.kit.mcp.length === 1 ? '' : 's'}${log.kit.claude_md ? ', a CLAUDE.md' : ''}${log.kit.budget_usd != null ? `, a $${log.kit.budget_usd.toFixed(2)} budget` : ''}${log.kit.repo ? `, from <a href="${esc(log.kit.repo)}" rel="nofollow noopener noreferrer">${esc(log.kit.repo)}</a>` : ''}.</p><p class="m">What it asks for:</p>${li(log.kit.permissions, esc)}` : ''}
<footer><p><b>Made with Plexiform — remix this.</b> ${kitUrl ? `In Plexiform, open Discover → Starters → Remix from a link and paste <code>${esc(kitUrl)}</code>. Nothing is installed until you review every file and permission.` : ''}</p><p class="m">${remixes} remix${remixes === 1 ? '' : 'es'} · Shared by its author, who can unpublish it at any time.</p></footer>
</body></html>`;
}

export class BuildLogs {
  constructor(hub) { this.hub = hub; this.db = hub.db; }
  writer(member) { if (!can(member, 'card.write')) throw new HubError('FORBIDDEN', 'viewers cannot publish build logs'); }
  row(member, id) {
    const r = typeof id === 'string' ? this.db.get('SELECT * FROM build_logs WHERE id = ? AND org_id = ?', id, member.org_id) : null;
    if (!r) throw new HubError('NOT_FOUND', 'no such build log');
    return r;
  }
  summary(r) { return { id: r.id, slug: r.slug, title: r.title, author_member_id: r.author_member_id, remix_count: r.remix_count, report_count: r.report_count, hidden: !!r.hidden, created_at: r.created_at, path: `/b/${r.slug}` }; }
  list(member) {
    if (!can(member, 'team.read')) throw new HubError('FORBIDDEN', 'not a team member');
    return { logs: this.db.all('SELECT * FROM build_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT 200', member.org_id).map((r) => this.summary(r)) };
  }
  publish(member, body) {
    this.writer(member);
    if (!obj(body) || Object.keys(body).some((k) => !['request_id', 'log'].includes(k))) bad('body takes request_id and log');
    const log = validateLog(body.log);
    const json = JSON.stringify(log);
    const bytes = Buffer.byteLength(json);
    if (bytes > LIMITS.bytes) bad('the build log is too large');
    // The app scrubs and the person reviews; this is the last check, and it refuses rather than edits.
    if (hasCredential(json)) bad('the build log still contains something that looks like a password, key or token: remove it and try again');
    if (this.db.get('SELECT COUNT(*) AS n FROM build_logs WHERE org_id = ?', member.org_id).n >= LIMITS.perOrg) throw new HubError('QUOTA_EXCEEDED', 'this team has published the most build logs it can; unpublish one first', { resource: 'build_logs', limit: LIMITS.perOrg });
    const row = { id: randomUUID(), org_id: member.org_id, author_member_id: member.id, author_user_id: member.user_id, slug: randomBytes(16).toString('base64url'), title: log.title, body: json, bytes, created_at: this.hub.iso() };
    this.db.insert('build_logs', row);
    return { log: this.summary({ ...row, remix_count: 0, report_count: 0, hidden: 0 }) };
  }
  unpublish(member, id) {
    const r = this.row(member, id);
    if (r.author_member_id !== member.id && !isAdmin(member)) throw new HubError('FORBIDDEN', 'only its author or a team admin can unpublish a build log');
    this.db.tx(() => { this.db.run('DELETE FROM build_log_reports WHERE log_id = ?', r.id); this.db.run('DELETE FROM build_logs WHERE id = ?', r.id); });
    return { ok: true, id: r.id };
  }
  restore(member, id) {
    const r = this.row(member, id);
    if (!isAdmin(member)) throw new HubError('FORBIDDEN', 'only a team admin can restore a reported build log');
    this.db.tx(() => { this.db.run('DELETE FROM build_log_reports WHERE log_id = ?', r.id); this.db.run('UPDATE build_logs SET hidden = 0, report_count = 0 WHERE id = ?', r.id); });
    return { log: this.summary({ ...r, hidden: 0, report_count: 0 }) };
  }

  // Live only while its team, author account and membership are.
  live(slug) {
    if (!SLUG.test(slug)) return null;
    return this.db.get(`SELECT l.*, m.display_name FROM build_logs l JOIN orgs o ON o.id = l.org_id JOIN members m ON m.id = l.author_member_id JOIN users u ON u.id = l.author_user_id
      WHERE l.slug = ? AND l.hidden = 0 AND o.deleted_at IS NULL AND m.removed_at IS NULL AND u.deleted_at IS NULL`, slug) ?? null;
  }
  reporter(ip) { return createHmac('sha256', this.hub.secret).update(`build-log-report:${ipKey(ip)}`).digest('base64url').slice(0, 32); }

  // GET /b/<slug>, GET /b/<slug>/kit.json, POST /b/<slug>/remix, POST /b/<slug>/report.
  // Returns {status, type, body} or null when the path is not ours.
  async handlePublic({ method, pathname, ip, base, readBody }) {
    const m = /^\/b\/([^/]+)(\/kit\.json|\/remix|\/report)?$/.exec(pathname);
    if (!m) return null;
    const [, slug, sub = ''] = m;
    const notFound = { status: 404, type: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'this build log is not available' } }) };
    const take = (bucket) => { const t = this.hub.limiter.take(bucket, ipKey(ip)); if (!t.ok) throw new HubError('RATE_LIMITED', 'too many requests', { retry_after_s: Math.max(1, Math.ceil(t.retry_after_ms / 1000)) }); };
    take('build_log_public_ip');
    if (method === 'GET' && (sub === '' || sub === '/kit.json')) {
      const r = this.live(slug);
      if (!r) return sub === '' ? { status: 404, type: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>Not available</title><p>This build log is not available. Its author may have unpublished it.</p>', csp: PAGE_CSP } : notFound;
      const log = JSON.parse(r.body);
      const author = r.display_name || 'A Plexiform user';
      if (sub === '/kit.json') return { status: 200, type: 'application/json', body: JSON.stringify({ schema: 1, slug: r.slug, title: log.title, author, remix_count: r.remix_count, summary: log.summary, kit: log.kit }) };
      return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(log, { author, remixes: r.remix_count, kitUrl: base ? `${base}/b/${r.slug}` : null }), csp: PAGE_CSP };
    }
    if (method !== 'POST' || !sub || sub === '/kit.json') return null;
    const r = this.live(slug);
    if (!r) return notFound;
    if (sub === '/remix') {
      take('build_log_remix_ip');
      this.db.run('UPDATE build_logs SET remix_count = remix_count + 1 WHERE id = ?', r.id);
      return { status: 200, type: 'application/json', body: JSON.stringify({ ok: true, remix_count: r.remix_count + 1 }) };
    }
    take('build_log_report_ip');
    const raw = await readBody(2048);
    let reason = '';
    try { const b = JSON.parse(raw || '{}'); reason = typeof b.reason === 'string' ? b.reason.replace(HIDDEN, '').slice(0, 500) : ''; } catch { reason = ''; }
    const who = this.reporter(ip);
    this.db.tx(() => {
      const added = this.db.run('INSERT OR IGNORE INTO build_log_reports (log_id, reporter, reason, created_at) VALUES (?, ?, ?, ?)', r.id, who, reason, this.hub.iso());
      if (added.changes) this.db.run(`UPDATE build_logs SET report_count = report_count + 1, hidden = CASE WHEN report_count + 1 >= ${LIMITS.reportsToHide} THEN 1 ELSE hidden END WHERE id = ?`, r.id);
    });
    return { status: 200, type: 'application/json', body: JSON.stringify({ ok: true, message: 'Thanks. The team that published it has been told; after several reports it is hidden until they review it.' }) };
  }
}

export function registerBuildLogRoutes(route, { hub }) {
  const b = hub.buildLogs;
  if (!b) return;
  route('GET', '/api/build-logs', ({ member }) => b.list(member));
  route('POST', '/api/build-logs', ({ member, body }) => b.publish(member, body), { maxBody: LIMITS.bytes + 4096 });
  route('DELETE', '/api/build-logs/:log_id', ({ member, params }) => b.unpublish(member, params.log_id));
  route('POST', '/api/build-logs/:log_id/restore', ({ member, params }) => b.restore(member, params.log_id));
}
