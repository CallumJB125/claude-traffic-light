'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Links = require('../src/session-links.js');
const Share = require('../src/handover-share.js');
const Handover = require('../src/session-handover.js');
const BurstHandover = require('../src/burst-handover.js');

const DOC = `${Handover.MARKER}\n# Session handover\n- Working folder: /Users/me/work/app\n- token sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`;
const DEST = { kind: 'team', hub: 'https://hub.example.test', team_id: 't1', board_id: 'b1' };
function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hshare-'));
  const links = Links.create({ file: path.join(dir, 'links.json') });
  const calls = []; let time = 1_000_000;
  const share = Share.create({
    writer: { text: () => DOC }, links, rows: () => links.rows(), rootOf: async () => '/Users/me/work/app',
    getRoute: async () => ({ role: 'member' }), send: async (d, id, p) => { calls.push({ d, id, p }); return { ok: true }; },
    home: '/Users/me', now: () => time, ...over,
  });
  return { dir, links, calls, share, advance: (n) => { time += n; } };
}
const session = { sessionId: 's1', source: 'codex', cwd: '/Users/me/work/app' };
const key = BurstHandover.repoKey('/Users/me/work/app');

test('nothing is sent while the repo opt-in is off, even for an attached team card', async () => {
  const r = rig(); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: DEST });
  await r.share.pump([session]); assert.equal(r.calls.length, 0);
});
test('opted in: one scrubbed send to the attached card, then nothing until it changes and the gap passes', async () => {
  const r = rig(); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: DEST }); r.links.setShare(key, true);
  await r.share.pump([session]);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].id, 'c1');
  assert.doesNotMatch(r.calls[0].p.text, /sk-ant|\/Users\/me/);
  r.advance(Share.GAP_MS + 1); await r.share.pump([session]); assert.equal(r.calls.length, 1, 'unchanged text is not resent');
});
test('local board cards, viewers, unlinked repos and unattached sessions send nothing', async () => {
  let r = rig(); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: { kind: 'local' } }); r.links.setShare(key, true);
  await r.share.pump([session]); assert.equal(r.calls.length, 0);
  r = rig({ getRoute: async () => ({ role: 'viewer' }) }); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: DEST }); r.links.setShare(key, true);
  await r.share.pump([session]); assert.equal(r.calls.length, 0);
  r = rig({ getRoute: async () => null }); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: DEST }); r.links.setShare(key, true);
  await r.share.pump([session]); assert.equal(r.calls.length, 0);
  r = rig(); r.links.setShare(key, true); await r.share.pump([session]); assert.equal(r.calls.length, 0);
});
test('a failed send is not retried inside the gap, and the hourly limit holds', async () => {
  const r = rig({ send: async () => ({ ok: false }), perHour: 2 }); r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', destination: DEST }); r.links.setShare(key, true);
  await r.share.pump([session]); await r.share.pump([session]); assert.equal(r.calls.length, 0);
});
test('links store: attach validates, survives a restart, shares are 16-hex repo keys only', () => {
  const r = rig();
  assert.equal(r.links.attach({ provider: 'codex', session_id: 's1', card_id: '../x', destination: DEST }), false);
  assert.equal(r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', title: 'T', destination: { kind: 'team', hub: 'https://h.test/path', team_id: 't', board_id: 'b' } }), false);
  assert.equal(r.links.attach({ provider: 'codex', session_id: 's1', card_id: 'c1', title: 'T', destination: DEST }), true);
  assert.equal(r.links.setShare('nope', true), false); assert.equal(r.links.setShare(key, true), true);
  const again = Links.create({ file: path.join(r.dir, 'links.json') });
  assert.equal(again.forSession('codex', 's1').card_id, 'c1'); assert.deepEqual(again.shared(), { [key]: true });
  assert.equal(Handover.forCard({ text: () => DOC }, 'c1', again.rows()).markdown.includes('Session handover'), true);
  assert.equal(fs.statSync(path.join(r.dir, 'links.json')).mode & 0o077, 0);
});
