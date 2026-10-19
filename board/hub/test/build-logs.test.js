// Published build logs (build-logs.js): publish, the public link page and kit,
// remix count, reports hiding a log, unpublish, and the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { validateLog } from '../build-logs.js';

const log = (extra = {}) => ({ schema: 1, title: 'Todo app in an afternoon', summary: 'A <b>small</b> app', project: 'todo', tools: ['Claude Code'], started_at: '2026-10-19T09:00:00.000Z', ended_at: '2026-10-19T12:00:00.000Z', cost_usd: 3.456, deployed_url: 'https://todo.example.com/', before: 'nothing', after: 'a deployed app', timeline: [{ at: '2026-10-19T09:00:00.000Z', kind: 'prompt', text: 'Build a todo app' }], prompts: [{ at: null, text: 'Build a todo app <script>alert(1)</script>' }], files: [{ path: 'src/app.js', edits: 3, add: 40, del: 2 }], kit: { repo: 'https://github.com/example/todo', claude_md: '# House rules', skills: [{ name: 'tidy', content: 'Tidy up.' }], mcp: [{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'], url: null }], budget_usd: 5, permissions: ['Writes CLAUDE.md'] }, ...extra });

test('a writer publishes; the link page and kit are public; remix counts; unpublish removes it', async () => {
  const fx = await tenancy();
  try {
    const team = { 'x-board-team': fx.A.team };
    const pub = await fx.as(fx.users.amember, 'POST', '/api/build-logs', { request_id: randomUUID(), log: log() }, team);
    assert.equal(pub.status, 200, pub.text);
    const { id, slug, path } = pub.body.log;
    assert.match(slug, /^[A-Za-z0-9_-]{22}$/);
    const page = await fx.h.call('GET', path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(page.text, /Made with Plexiform — remix this/);
    assert.ok(!page.text.includes('<script>'), 'prompt text is escaped');
    assert.match(page.text, /\$3\.46/);
    const kit = await fx.h.call('GET', `${path}/kit.json`);
    assert.equal(kit.status, 200);
    assert.equal(kit.body.kit.skills[0].name, 'tidy');
    assert.equal(kit.body.remix_count, 0);
    const remix = await fx.h.call('POST', `${path}/remix`);
    assert.equal(remix.body.remix_count, 1);
    const listed = await fx.as(fx.users.ua, 'GET', '/api/build-logs', undefined, team);
    assert.equal(listed.body.logs[0].remix_count, 1);
    // A team member who is not its author nor an admin cannot unpublish it.
    const other = await fx.as(fx.users.s, 'DELETE', `/api/build-logs/${id}`, { request_id: randomUUID() }, team);
    assert.equal(other.status, 403);
    const del = await fx.as(fx.users.amember, 'DELETE', `/api/build-logs/${id}`, { request_id: randomUUID() }, team);
    assert.equal(del.status, 200, del.text);
    assert.equal((await fx.h.call('GET', path)).status, 404);
    assert.equal((await fx.h.call('GET', `${path}/kit.json`)).status, 404);
  } finally { await fx.h.close(); }
});

test('refusals: viewers, credentials, unknown fields, local paths', async () => {
  const fx = await tenancy();
  try {
    const team = { 'x-board-team': fx.A.team };
    const send = (u, l) => fx.as(u, 'POST', '/api/build-logs', { request_id: randomUUID(), log: l }, team);
    assert.equal((await send(fx.users.aviewer, log())).status, 403);
    const secret = await send(fx.users.amember, log({ prompts: [{ at: null, text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] }));
    assert.equal(secret.status, 400);
    assert.match(secret.text, /looks like a password, key or token/);
    assert.equal((await send(fx.users.amember, log({ extra: 1 }))).status, 400);
    assert.equal((await send(fx.users.amember, log({ files: [{ path: '/Users/me/app.js', edits: 1, add: null, del: null }] }))).status, 400);
    assert.equal((await send(fx.users.amember, log({ deployed_url: 'http://insecure.example.com' }))).status, 400);
    assert.throws(() => validateLog({ ...log(), kit: { ...log().kit, mcp: [{ name: 'x', command: null, args: [], url: null }] } }), /command or an https url/);
  } finally { await fx.h.close(); }
});

test('three distinct reporters hide a log until an admin restores it', async () => {
  const fx = await tenancy();
  try {
    const team = { 'x-board-team': fx.A.team };
    const pub = await fx.as(fx.users.amember, 'POST', '/api/build-logs', { request_id: randomUUID(), log: log() }, team);
    const { id, path } = pub.body.log;
    // One address counts once, however often it reports.
    for (let i = 0; i < 2; i++) assert.equal((await fx.h.call('POST', `${path}/report`, { body: { reason: 'spam' } })).status, 200);
    assert.deepEqual({ ...fx.db.get('SELECT report_count, hidden FROM build_logs WHERE id = ?', id) }, { report_count: 1, hidden: 0 });
    // Two earlier reporters from elsewhere; this address's report is then the third.
    fx.db.run('DELETE FROM build_log_reports WHERE log_id = ?', id);
    for (const who of ['r1', 'r2']) fx.db.run("INSERT INTO build_log_reports (log_id, reporter, reason, created_at) VALUES (?, ?, '', ?)", id, who, fx.h.hub.iso());
    fx.db.run('UPDATE build_logs SET report_count = 2 WHERE id = ?', id);
    await fx.h.call('POST', `${path}/report`, { body: { reason: 'spam' } });
    assert.equal(fx.db.get('SELECT hidden FROM build_logs WHERE id = ?', id).hidden, 1);
    assert.equal((await fx.h.call('GET', path)).status, 404);
    assert.equal((await fx.as(fx.users.amember, 'POST', `/api/build-logs/${id}/restore`, { request_id: randomUUID() }, team)).status, 403);
    const restored = await fx.as(fx.users.aadmin, 'POST', `/api/build-logs/${id}/restore`, { request_id: randomUUID() }, team);
    assert.equal(restored.status, 200, restored.text);
    assert.equal((await fx.h.call('GET', path)).status, 200);
  } finally { await fx.h.close(); }
});

test('an unknown or malformed slug is a plain 404', async () => {
  const fx = await tenancy();
  try {
    assert.equal((await fx.h.call('GET', '/b/not-a-slug')).status, 404);
    assert.equal((await fx.h.call('GET', `/b/${'A'.repeat(22)}`)).status, 404);
    assert.equal((await fx.h.call('POST', `/b/${'A'.repeat(22)}/remix`)).status, 404);
  } finally { await fx.h.close(); }
});
