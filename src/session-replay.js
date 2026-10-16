'use strict';

// "Export replay": one session timeline (src/session-timeline.js) as a single
// self-contained HTML file the person saves where they choose. Nothing is
// uploaded or hosted; the file has no script, no links and no external
// assets, and its CSP forbids loading any. Only allow-listed fields are
// copied, then scrubbed: secrets and personal numbers redacted (src/scrub.js,
// src/secret-patterns.js), the home folder shown as ~, user names, emails,
// IP addresses and this computer's name removed, paths made relative to the
// project. Prompts and the AI's replies are left out unless includePrompts.

const { redactSecretsPass, PATTERNS } = require('./scrub.js');
const Timeline = require('./session-timeline.js');

const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0']);
const PROVIDER = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cleaner({ home = null, user = null, hostname = null } = {}) {
  const h = typeof home === 'string' ? home.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const homeRe = h.length > 1 ? new RegExp(`(?:file://)?${escapeRe(h)}(?![\\w.-])`, 'gi') : null;
  const encoded = h.length > 1 ? h.replace(/[/.:]/g, '-') : '';
  const encRe = encoded.length > 1 ? new RegExp(`${escapeRe(encoded)}(?![\\w.])`, 'gi') : null;
  const userRe = typeof user === 'string' && user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}`, 'gi') : null;
  const short = typeof hostname === 'string' ? hostname.split('.')[0] : '';
  const hostRe = short.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(short)}(?:\\.[\\w-]+)*`, 'gi') : null;
  return (s) => {
    let t = redactSecretsPass(String(s ?? '')).replace(/\\/g, '/');
    if (homeRe) t = t.replace(homeRe, '~');
    if (encRe) t = t.replace(encRe, '~');
    t = t.replace(/(?<![\w.-])((?:[A-Za-z]:)?\/(?:Users|home))\/(?!\[user\])[^/\s'"`]+/gi, '$1/[user]');
    t = t.replace(/(?<![\w-])-(Users|home)-[\w.-]+/gi, '-$1-[user]');
    t = t.replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"`]+@/gi, '$1[user]@');
    t = t.replace(PATTERNS.EMAIL, '[email]');
    t = t.replace(PATTERNS.IPV4, (m) => (KEEP_IPS.has(m) ? m : '[ip]'));
    if (hostRe) t = t.replace(hostRe, '[host]');
    if (userRe) t = t.replace(userRe, '[user]');
    return t;
  };
}

const FILE_KEYS = ['path', 'status', 'add', 'del'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// timeline → the export model: allow-listed, scrubbed, prompts dropped unless asked for.
function prepare(timeline, { includePrompts = false, home = null, user = null, hostname = null, now = Date.now() } = {}) {
  const clean = cleaner({ home, user, hostname });
  const t = timeline || {};
  const events = (t.events || []).map((e) => {
    const x = pick(e, ['at', 'kind', 'answer', 'turn', 'approx', 'failed', 'spendUsd']);
    if (e.path != null) x.path = clean(e.path);
    if (Array.isArray(e.paths)) x.paths = e.paths.map(clean);
    if (e.tool != null) x.tool = clean(e.tool);
    if (Array.isArray(e.files)) x.files = e.files.map((f) => ({ ...pick(f, FILE_KEYS), path: clean(f.path) }));
    if (e.kind === 'command' && e.text != null) x.text = clean(e.text);
    if (['prompt', 'turn-end', 'delegation', 'delegation-result'].includes(e.kind) && includePrompts && e.text != null) {
      x.text = clean(e.text);
      // Target ids are intentionally excluded, just like the parent session id.
    }
    return x;
  });
  return {
    v: 1, includePrompts: !!includePrompts, exportedAt: new Date(now).toISOString(),
    provider: PROVIDER[t.adapter] || clean(t.adapter || 'AI session'), project: clean(t.project || ''), branch: t.branch ? clean(t.branch) : null,
    status: clean(t.status || 'Unknown'), startedAt: t.startedAt || null, lastActive: t.lastActive || null, source: t.source, partial: !!t.partial,
    spend: t.spend && Number.isFinite(t.spend.usd) ? { usd: t.spend.usd, partial: !!t.spend.partial } : null,
    counts: { ...(t.counts || {}) },
    files: (t.files || []).filter((f) => f.edits || f.add || f.del).map((f) => ({ ...pick(f, ['edits', 'add', 'del']), path: clean(f.path) })),
    commands: (t.commands || []).map(clean),
    events,
  };
}

// The "what is included" list shown before saving, and printed at the top of the file.
function summary(model) {
  const c = model.counts || {};
  const n = (k, one, many = `${one}s`) => `${c[k] || 0} ${(c[k] || 0) === 1 ? one : many}`;
  const included = [
    `${model.events.length} timeline event${model.events.length === 1 ? '' : 's'} with times`,
    `Files edited: ${model.files.length}, as paths inside the project folder, with +/- line counts where checkpoints have them`,
    `Commands run: ${c.commands || 0}, as typed, with secrets redacted`,
    `Approvals: ${n('approvals', 'asked', 'asked')}, ${c.answered || 0} answered, ${c.denied || 0} denied`,
    model.spend ? `Spend so far: ${Timeline.usd(model.spend.usd)} (API-equivalent estimate${model.spend.partial ? ', at least: the transcript was read in part' : ''})` : 'Spend: not known for this session',
    `Final status: ${model.status}`,
    `${model.provider}, project folder name "${model.project || 'unknown'}"${model.branch ? `, branch ${model.branch}` : ''}`,
  ];
  if (model.includePrompts) included.push(`What the AI was asked and its replies: ${n('prompts', 'prompt')}, including recorded subagent requests and tool results (secrets redacted; read them before you share this file)`);
  const excluded = [
    ...(model.includePrompts ? [] : ['What the AI was asked and its replies, including subagent request and result text (tick the box to include them)']),
    'File contents and diffs', 'Full folder paths, your user name, email addresses, IP addresses and this computer\'s name', 'The session id', 'Anything not listed above',
  ];
  return { included, excluded };
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : 'unknown'; };

const CSS = `:root{color-scheme:light dark;--bg:#faf9f7;--panel:#fff;--line:#e4e0da;--text:#1f1d1a;--muted:#6b665d;--accent:#b4532e;--add:#1d7a35;--del:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1a1f;--panel:#221f27;--line:#35313d;--text:#ece8e2;--muted:#a8a293;--accent:#da7756;--add:#4cc35c;--del:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px}h1{margin:0;font-size:20px}h2{font-size:15px;margin:0 0 8px}
.sub,.muted{color:var(--muted)}section{margin-top:16px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px;margin:0}dt{color:var(--muted);font-size:12px}dd{margin:0;font-weight:600}
ul,ol{margin:0;padding-left:18px}ol.events{list-style:none;padding:0}ol.events li{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
ol.events li:first-child{border-top:0}time{color:var(--muted);font:12px ui-monospace,monospace}.label{font-weight:600}.k-prompt .label{color:var(--accent)}
code,.mono{font:12px/1.45 ui-monospace,monospace;overflow-wrap:anywhere;white-space:pre-wrap}.text{white-space:pre-wrap;overflow-wrap:anywhere}
.add{color:var(--add)}.del{color:var(--del)}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:4px 8px;border-top:1px solid var(--line);font-size:13px}th{color:var(--muted);font-weight:400}
@media (max-width:600px){ol.events li{grid-template-columns:1fr;gap:2px}}`;

const counts = (f) => `${f.add != null ? `<span class="add">+${f.add}</span>` : ''}${f.add != null && f.del != null ? ' ' : ''}${f.del != null ? `<span class="del">−${f.del}</span>` : ''}`;

function eventHtml(e) {
  const d = Timeline.describe(e);
  const body = [];
  if (d.text != null) body.push(`<div class="${d.mono ? 'mono' : 'text'}">${esc(d.text)}</div>`);
  if (d.hidden) body.push('<div class="muted">Prompt text not included</div>');
  if (d.spend) body.push(`<div class="muted">${esc(d.spend)}</div>`);
  if (d.files && d.files.length) body.push(`<ul>${d.files.map((f) => `<li><code>${esc(f.path)}</code> ${counts(f)}</li>`).join('')}</ul>`);
  return `<li class="k-${esc(e.kind)}"><time datetime="${esc(e.at)}">${esc(stamp(e.at))}</time><div><span class="label">${esc(d.label)}</span>${body.join('')}</div></li>`;
}

// The export model → the file's text. Static: no script, no links, no external anything.
function html(model) {
  const s = summary(model);
  const title = `Session replay: ${model.project || model.provider}`;
  const facts = [['Status', model.status], ['Started', stamp(model.startedAt)], ['Last activity', stamp(model.lastActive)], ['Spend so far', model.spend ? Timeline.usd(model.spend.usd) : 'Not known'], ['Files edited', model.files.length], ['Commands run', model.counts.commands || 0], ['Approvals asked', model.counts.approvals || 0]];
  const files = model.files.length ? `<section><h2>Files edited</h2><table><thead><tr><th>File</th><th>Edits</th><th>Lines</th></tr></thead><tbody>${model.files.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.edits || 0)}</td><td>${counts(f) || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></section>` : '';
  const cmds = model.commands.length ? `<section><h2>Recent commands (times not recorded)</h2><ul>${model.commands.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">${esc(model.provider)}${model.branch ? ` · branch ${esc(model.branch)}` : ''} · exported ${esc(stamp(model.exportedAt))} from Plexiform on the exporter's computer. Facts recorded locally, not written by the AI.</p>
<section><dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
<section><h2>What this file contains</h2><ul>${s.included.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="muted">Not included: ${esc(s.excluded.join('; '))}.</p></section>
${files}${cmds}<section><h2>Timeline</h2>${model.events.length ? `<ol class="events">${model.events.map(eventHtml).join('')}</ol>` : '<p class="muted">No timed events were recorded.</p>'}</section>
</main></body></html>
`;
}

// timeline + options → { html, summary, model }.
function exportReplay(timeline, opts = {}) {
  const model = prepare(timeline, opts);
  return { model, summary: summary(model), html: html(model) };
}

// A file name for the save dialog: the project's (scrubbed) name, never a path.
const fileName = (model) => `${String(model.project || 'session').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'session'}-replay.html`;

module.exports = { exportReplay, prepare, summary, html, cleaner, fileName };
