// PresenceReporter (D37b) timing and gating against a stub supervisor: at
// most one changed frame per min interval, a keepalive, the clear on disable
// (sent on reconnect when offline), and default deny against the allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PresenceReporter, presenceSummary } from '../presence.js';
import { assertNoForeignBytes } from '../../shared/scope.js';
import { CANON, REPO_ID, waitFor } from './helpers.js';

function stubSup() {
  const sup = new EventEmitter();
  sup.connected = true;
  sup.allowlist = [{ repo_id: REPO_ID, canonical_url: CANON, aliases: [] }];
  sup.sent = [];
  sup.sendRaw = (bytes) => { if (!sup.connected) return false; sup.sent.push({ at: Date.now(), f: JSON.parse(bytes) }); return true; };
  return sup;
}

const where = { '/w/app': { toplevel: '/w/app', remote_url: 'git@github.com:acme/app.git', branch: 'main' }, '/w/other': { toplevel: '/w/other', remote_url: 'git@github.com:acme/other.git', branch: 'main' } };
const resolve = async (cwd) => where[cwd] ?? null;
const s = (over = {}) => ({ session_id: 'a', agent: 'claude', cwd: '/w/app', state: 'working', since: '2026-09-30T10:00:00Z', ...over });

test('presence reporter: throttled changes, keepalive, default deny, clear on disable', async () => {
  const sup = stubSup();
  const p = new PresenceReporter(sup, { minMs: 300, keepaliveMs: 100_000, resolve });
  try {
    await p.update({ enabled: true, sessions: [s(), s({ session_id: 'b', cwd: '/w/other' }), s({ session_id: 'c', cwd: '/nowhere' }), s({ session_id: 'd', since: 1_790_000_000_000 }), s({ session_id: 'e', since: 'yesterday' })] });
    assert.equal(sup.sent.length, 1, 'first change goes at once');
    assert.deepEqual(sup.sent[0].f.sessions.map((x) => x.repo_id), [REPO_ID], 'other repos and non-ISO since are dropped');
    assert.equal(sup.sent[0].f.sessions[0].since, '2026-09-30T10:00:00Z');

    await p.update({ enabled: true, sessions: [s({ state: 'waiting' })] });
    await p.update({ enabled: true, sessions: [s({ state: 'idle' })] });
    assert.equal(sup.sent.length, 1, 'held back inside the min interval');
    await waitFor(() => sup.sent.length === 2, { what: 'throttled send' });
    assert.ok(sup.sent[1].at - sup.sent[0].at >= 280, 'at most one frame per min interval');
    assert.equal(sup.sent[1].f.sessions[0].state, 'idle', 'only the latest state is sent');

    await p.update({ enabled: true, sessions: [s({ state: 'idle' })] });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sup.sent.length, 2, 'unchanged → nothing new');

    sup.connected = false;
    await p.update({ enabled: false, sessions: [] });
    assert.equal(sup.sent.length, 2);
    sup.connected = true;
    sup.emit('connected');
    await waitFor(() => sup.sent.length === 3, { what: 'clear after reconnect' });
    assert.deepEqual(sup.sent[2].f.sessions, []);
    sup.emit('connected');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sup.sent.length, 3, 'disabled: nothing more');
  } finally {
    p.stop();
  }
});

test('presence reporter: keepalive re-sends while enabled; never enabled sends nothing', async () => {
  const sup = stubSup();
  const p = new PresenceReporter(sup, { minMs: 10, keepaliveMs: 100, resolve });
  const idle = new PresenceReporter(stubSup(), { minMs: 10, keepaliveMs: 50, resolve });
  try {
    await p.update({ enabled: true, sessions: [s()] });
    await waitFor(() => sup.sent.length >= 3, { what: 'keepalives' });
    assert.ok(sup.sent.every((x) => x.f.sessions.length === 1));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(idle.sup.sent.length, 0);
  } finally {
    p.stop();
    idle.stop();
  }
});

test('presence summary: off unless share_summaries; paths never survive (file://, <, |, {, any /-rooted run)', async () => {
  const sup = stubSup();
  const p = new PresenceReporter(sup, { minMs: 0, keepaliveMs: 100_000, resolve });
  try {
    await p.update({ enabled: true, sessions: [s({ summary: 'fixing the parser' })] });
    assert.equal(sup.sent.length, 1);
    assert.equal('summary' in sup.sent[0].f.sessions[0], false, 'enabled alone shares no summary');
    await p.update({ enabled: true, share_summaries: 'yes', sessions: [s({ summary: 'fixing the parser' })] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sup.sent.length, 1, 'only share_summaries:true opts in');
    await p.update({ enabled: true, share_summaries: true, sessions: [s({ summary: 'see file:///Users/callum/secret.txt' })] });
    await waitFor(() => sup.sent.length === 2, { what: 'summary frame' });
    assert.equal(sup.sent[1].f.sessions[0].summary, 'see file://<path>');
  } finally {
    p.stop();
  }
  for (const text of ['file:///Users/callum/secret.txt', 'cat</Users/callum/.aws/credentials', 'x|/home/bob/x', '{/Users/callum/a}', 'x/Users/callum/a', 'read /opt/acme-internal/customer-list.csv']) {
    const out = presenceSummary(text, '/w/app');
    assert.doesNotMatch(out, /callum|bob|credentials|acme-internal|secret\.txt/, text);
    assert.match(out, /<path>/, text);
    assert.doesNotThrow(() => assertNoForeignBytes({ repo_id: 'r', summary: out }, { repo_id: 'r' }), text);
  }
  assert.equal(presenceSummary('editing /w/app/src/parser.js', '/w/app'), 'editing src/parser.js', 'repo paths stay relative');
});
