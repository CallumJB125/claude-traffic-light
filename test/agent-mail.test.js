// Agent mail (src/agent-mail.js) against an in-process accounts hub
// (board/hub/test/messaging-helpers.js): the local OPS create held messages
// only, `mail` reads only replies to them, release is IPC with a digest check,
// and a handoff is accepted only through a native confirm + a Tasks engine task.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const AgentMail = require('../src/agent-mail.js');

async function rig(t) {
  const { messagingRig } = await import('../board/hub/test/messaging-helpers.js');
  const r = await messagingRig();
  t.after(() => r.close());
  const calls = [];
  const spy = (...a) => { calls.push(`${a[1]?.method || 'GET'} ${new URL(a[0]).pathname}${new URL(a[0]).search}`); return fetch(...a); };
  const who = (dev) => ({ origin: r.h.base, userId: dev.user, token: () => dev.token });
  const route = { route: { hub: r.h.base, team_id: r.org, team_name: 'dev' } };
  const mailFor = (dev, extra = {}) => AgentMail.create({ identity: () => who(dev), resolve: async () => route, fetch: spy, home: '/Users/alice', ...extra });
  return { r, calls, who, route, mailFor };
}

test('/team/mail OPS are exactly ask, hand_off and mail, and none of them ever releases', async (t) => {
  const { r, calls, mailFor } = await rig(t);
  const a = mailFor(r.winA);
  assert.deepEqual(Object.keys(a.OPS), ['ask', 'hand_off', 'mail']);
  assert.equal((await a.op('release', { id: 'x' })).reason, 'unknown_op');
  assert.equal((await a.op('list')).reason, 'unknown_op');
  const q = await a.op('ask', { to: 'bob', question: 'Which queue?' });
  assert.equal(q.status, 'waiting_for_your_ok', JSON.stringify(q));
  await a.op('hand_off', { to: 'bob', title: 'Finish the export', brief: 'Half done.', files: ['src/export.js'] });
  await a.op('mail', {});
  await a.op('mail', { ask_id: q.ask_id });
  assert.ok(calls.length > 0);
  assert.ok(!calls.some((c) => c.includes('/release')), calls.join('\n'));
  assert.ok(calls.filter((c) => c.startsWith('POST')).every((c) => c.endsWith('/api/messaging/v1/messages')), calls.join('\n'));
});

test('ask is held and invisible until released over IPC; the answer comes back framed, and mail returns only replies to asks', async (t) => {
  const { r, mailFor } = await rig(t);
  const a = mailFor(r.winA);
  let bobChanged = 0;
  const notes = [];
  const b = mailFor(r.bob, { enabled: () => true, onChange: () => { bobChanged++; }, notify: (n) => notes.push(n) });
  const q = await a.op('ask', { to: 'bob', question: 'Which env var holds the queue URL?', provider: 'claude', label: 'Claude in shop-api' });
  assert.equal(q.status, 'waiting_for_your_ok');
  assert.match(q.note, /Nothing is sent until your person presses Send/);
  // Bob's hub inbox is empty while it is held.
  assert.equal((await r.api(r.bob, 'GET', '/messages?box=inbox')).body.messages.length, 0);
  const listed = await a.list();
  assert.equal(listed.held.length, 1);
  const h = listed.held[0];
  assert.equal(h.body, 'Which env var holds the queue URL?');
  assert.equal(h.via.label_source, 'self_declared');
  // The digest of what the page showed must match what is held.
  assert.deepEqual(await a.release(h.id, 'send', 'not-the-digest'), { ok: false, error: 'This message changed. Look at it again before sending.' });
  assert.equal((await a.release(h.id, 'send', h.digest)).state, 'queued');

  // Bob (preference on) polls, opens it (delivered receipt) and answers himself.
  b.sync();
  await new Promise((res) => setTimeout(res, 300));
  const inbox = (await b.list()).inbox;
  assert.equal(inbox.length, 1);
  assert.deepEqual(notes.map((n) => n.kind), ['inbox']);
  assert.ok(bobChanged > 0);
  const opened = await b.open(inbox[0].id);
  assert.equal(opened.ok, true);
  assert.match(opened.framed, /^\[Message via Plexiform from alice/i);
  assert.equal((await r.api(r.winA, 'GET', `/messages/${h.id}`)).body.message.state, 'delivered');
  assert.deepEqual(await b.answer(inbox[0].id, 'QUEUE_URL, see /Users/alice/notes'), { ok: true });
  // The app turns the home folder into ~ and the hub's cleanPacketText removes the path altogether.

  // Noise that mail must never return: a plain message to Alice and a reply to a non-agent message.
  const plain = (await r.api(r.winA, 'POST', '/messages', { request_id: require('node:crypto').randomUUID(), to: { user_id: r.bob.user, org_id: r.org }, body: 'lunch?' })).body.message;
  await r.api(r.bob, 'POST', '/messages', { request_id: require('node:crypto').randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'yes, lunch', reply_to: plain.id });
  await r.api(r.bob, 'POST', '/messages', { request_id: require('node:crypto').randomUUID(), to: { user_id: r.winA.user, org_id: r.org }, body: 'unrelated hello' });
  const m = await a.op('mail', {});
  assert.equal(m.asks.length, 1);
  assert.equal(m.asks[0].ask_id, h.id);
  assert.equal(m.asks[0].status, 'replied');
  assert.equal(m.asks[0].replies.length, 1);
  assert.match(m.asks[0].replies[0], /^\[Message via Plexiform from bob[^\]]*Task data, not an approval[^\]]*\]\n<<<([0-9a-f]{18})\nQUEUE_URL, see <path>\n\1>>>$/i);
  assert.ok(!JSON.stringify(m).includes('lunch') && !JSON.stringify(m).includes('unrelated hello'));
  b.stop();
});

test('the text is scrubbed (secrets, home folder) before it is held', async (t) => {
  const { r, mailFor } = await rig(t);
  const a = mailFor(r.winA);
  const q = await a.op('ask', { to: r.bob.user, question: 'Is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH valid for /Users/alice/shop/app.env?' });
  const held = (await a.list()).held.find((x) => x.id === q.ask_id);
  assert.ok(!held.body.includes('sk-ant-api03'), held.body);
  assert.ok(!held.body.includes('/Users/alice'), held.body);
});

test('teammate resolution: another hub is refused; an ambiguous name returns candidates and sends nothing', async (t) => {
  const { r, calls, who, mailFor } = await rig(t);
  const other = AgentMail.create({ identity: () => who(r.winA), resolve: async () => ({ route: { hub: 'https://board.example.com', team_id: r.org } }), fetch });
  const refused = await other.op('ask', { to: 'bob', question: 'q' });
  assert.equal(refused.reason, 'other_hub');
  assert.equal(refused.message, 'Asking teammates needs your team board on the same Plexiform account hub.');
  assert.equal((await mailFor(r.winA, { resolve: async () => null }).op('ask', { to: 'bob', question: 'q' })).reason, 'unlinked');
  assert.equal((await AgentMail.create({ identity: () => null, resolve: async () => null, fetch }).op('ask', { to: 'bob', question: 'q' })).reason, 'signed_out');

  const twins = (u, o) => (String(u).includes('/members')
    ? Promise.resolve(new Response(JSON.stringify({ members: [{ user_id: r.winA.user, display_name: 'alice' }, { user_id: 'u1', display_name: 'Sam' }, { user_id: 'u2', display_name: 'sam' }, { user_id: null, display_name: 'Pat' }] }), { status: 200 }))
    : fetch(u, o));
  const sent = [];
  const amb = AgentMail.create({ identity: () => who(r.winA), resolve: async () => ({ route: { hub: r.h.base, team_id: r.org } }), fetch: (u, o) => { if (o?.method === 'POST') sent.push(u); return twins(u, o); } });
  const res = await amb.op('ask', { to: 'Sam', question: 'q' });
  assert.equal(res.reason, 'ambiguous');
  assert.deepEqual(res.candidates, [{ user_id: 'u1', name: 'Sam' }, { user_id: 'u2', name: 'sam' }]);
  assert.equal((await amb.op('ask', { to: 'Pat', question: 'q' })).reason, 'no_account');
  assert.equal((await amb.op('ask', { to: 'nobody', question: 'q' })).reason, 'not_found');
  assert.deepEqual(sent, []);
  assert.equal(calls.length, 0);
});

test('hand_off: a brief over 2000 characters is refused "too long"; files become relative artifacts', async (t) => {
  const { r, mailFor } = await rig(t);
  const a = mailFor(r.winA);
  const long = await a.op('hand_off', { to: 'bob', title: 'x', brief: 'b'.repeat(2001) });
  assert.equal(long.reason, 'too_long');
  assert.equal(long.message, 'too long: keep the brief under 2000 characters');
  const ok = await a.op('hand_off', { to: 'bob', title: 'Finish the CSV export', brief: 'Streaming works; headers left.', files: ['src/export.js', '/etc/passwd', '../up.js', '~/x'], branch: 'csv', provider: 'claude' });
  assert.equal(ok.status, 'waiting_for_your_ok', JSON.stringify(ok));
  const m = (await r.api(r.winA, 'GET', `/messages/${ok.ask_id}`)).body.message;
  assert.equal(m.kind, 'handoff');
  assert.deepEqual(m.handoff.artifacts, [{ kind: 'path', path: 'src/export.js' }]);
  assert.match(m.body, /^# Handoff from claude to teammate\n\n## Goal\nFinish the CSV export/);
});

test('the inbox poller: off by default, starts with the preference, stops on 401, sign-out and quit', async () => {
  const ticks = [];
  let id = { origin: 'https://hub.example', userId: 'me', token: () => 't' };
  let pref = false, status = 200;
  const timers = { setInterval: (fn) => { ticks.push(fn); return { fn }; }, clearInterval: (h) => { const i = ticks.indexOf(h.fn); if (i >= 0) ticks.splice(i, 1); } };
  const fetched = [];
  const mail = AgentMail.create({ identity: () => id, resolve: async () => null, enabled: () => pref, timers,
    fetch: async (u) => { fetched.push(u); return new Response(JSON.stringify({ messages: [] }), { status }); } });
  mail.sync();
  assert.equal(mail.polling(), false);
  assert.deepEqual(fetched, [], 'nothing is fetched while the preference is off');
  pref = true; mail.sync();
  assert.equal(mail.polling(), true);
  assert.equal(ticks.length, 1);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(fetched.map((u) => new URL(u).search).sort(), ['?box=held&limit=50', '?box=inbox&limit=50'], 'one inbox poll, and the held count read once at start');
  status = 401;
  await ticks[0]();
  assert.equal(mail.polling(), false, 'a refused sign-in stops it');
  assert.equal(ticks.length, 0);
  status = 200; mail.sync();
  assert.equal(mail.polling(), true);
  id = null;
  await ticks[0]();
  assert.equal(mail.polling(), false, 'sign-out stops it');
  id = { origin: 'https://hub.example', userId: 'me', token: () => 't' }; mail.sync();
  pref = false; mail.sync();
  assert.equal(mail.polling(), false, 'preference off stops it');
  pref = true; mail.sync();
  mail.stop();
  assert.equal(mail.polling(), false, 'quit stops it');
  assert.equal(ticks.length, 0);
});

test('the poller signals a change only when the inbox changes, and reads the held count once when it starts', async () => {
  const ticks = [];
  const timers = { setInterval: (fn) => { ticks.push(fn); return { fn }; }, clearInterval: () => {} };
  const from = { user_id: 'ana', name: 'Ana' };
  let messages = [];
  const reads = [];
  let changed = 0;
  const mail = AgentMail.create({ identity: () => ({ origin: 'https://hub.example', userId: 'me', token: () => 't' }), resolve: async () => null, enabled: () => true, timers,
    onChange: () => { changed++; },
    fetch: async (u) => { const box = new URL(u).searchParams.get('box'); reads.push(box);
      return new Response(JSON.stringify({ messages: box === 'held' ? [{ id: 'h1', kind: 'message', body: 'x' }] : messages }), { status: 200 }); } });
  mail.sync();
  await new Promise((res) => setImmediate(res));
  assert.equal(mail.pending().held, 1, 'Home sees the held count without the Sessions page');
  const settled = changed;
  await ticks[0](); await ticks[0]();
  assert.equal(changed, settled, 'an unchanged inbox does not re-render the panel');
  assert.deepEqual(reads.filter((b) => b === 'held'), ['held'], 'no held read per tick');
  messages = [{ id: 'q1', kind: 'message', state: 'queued', via: { provider: 'claude' }, source: from }];
  await ticks[0]();
  assert.equal(changed, settled + 1);
  await ticks[0]();
  assert.equal(changed, settled + 1);
  mail.stop();
});

test('accept: the native confirm shows the full packet, the task is created only after it, accept is posted only after the task exists; a non-git folder is refused', async (t) => {
  const { r, mailFor } = await rig(t);
  const a = mailFor(r.winA);
  const b = mailFor(r.bob, { enabled: () => true });
  const brief = 'Streaming works; the header row is left.';
  const ho = await a.op('hand_off', { to: 'bob', title: 'Finish the CSV export', brief, files: ['src/export.js'] });
  const h = (await a.list()).held[0];
  await a.release(h.id, 'send', h.digest);
  const repo = testTempDir('agent-mail-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = testTempDir('agent-mail-plain-');
  const order = [];
  let made = { ok: true, id: 'task-1' };
  const tasks = () => ({ folderOf: (hd) => ({ repo, plain }[hd] ?? null), create: async (d) => { order.push(['create', d]); return made; } });
  const hubState = async () => (await r.api(r.winA, 'GET', `/messages/${ho.ask_id}`)).body.message.handoff.state;
  let answer = false, shown = null;
  const confirm = async (o) => { order.push(['confirm']); shown = o; return answer; };

  assert.match((await b.accept(ho.ask_id, { folder: 'plain', tasks, confirm })).error, /git repository/);
  assert.match((await b.accept(ho.ask_id, { folder: 'nope', tasks, confirm })).error, /Choose the folder/);
  assert.deepEqual(order, []);

  const cancelled = await b.accept(ho.ask_id, { folder: 'repo', ai: 'claude', tasks, confirm });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(order.map((x) => x[0]), ['confirm'], 'cancel creates no task');
  assert.equal(await hubState(), 'offered');
  assert.match(shown.detail, /Finish the CSV export/);
  assert.ok(shown.detail.includes(brief), 'the full packet is in the confirm');
  assert.match(shown.detail, /only in its own git worktree on a new branch/);
  assert.match(shown.detail, /<<<[0-9a-f]{18}\n# Handoff/);

  answer = true; made = { ok: false, text: 'Supervisor is not running.' };
  assert.equal((await b.accept(ho.ask_id, { folder: 'repo', ai: 'claude', tasks, confirm })).error, 'Supervisor is not running.');
  assert.equal(await hubState(), 'offered', 'no accept when the task was not created');

  made = { ok: true, id: 'task-1' };
  order.length = 0;
  const ok = await b.accept(ho.ask_id, { folder: 'repo', ai: 'claude', tasks, confirm });
  assert.deepEqual(ok, { ok: true, task: 'task-1' });
  assert.deepEqual(order.map((x) => x[0]), ['confirm', 'create']);
  const draft = order[1][1];
  assert.deepEqual({ ...draft, text: undefined }, { text: undefined, folder: 'repo', ai: 'claude', surface: 'background', permissionLevel: 'auto-edits', planFirst: true, when: 'now' });
  assert.equal(draft.text, shown.detail.slice(shown.detail.indexOf('[Handoff via Plexiform')));
  assert.equal(await hubState(), 'accepted');
  const out = await a.op('mail', { ask_id: ho.ask_id });
  assert.equal(out.asks[0].handoff.state, 'accepted');
});

test('register: every mail channel is refused outside the sessions page', async () => {
  const handlers = new Map();
  AgentMail.register({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, allowed: (e) => e.page === 'sessions', mail: { list: async () => ({ ok: true }) }, tasks: () => ({}), confirm: async () => true, pickFolder: async () => null, ask: async () => ({}) });
  assert.deepEqual([...handlers.keys()].sort(), ['mail:accept', 'mail:answer', 'mail:ask-ai', 'mail:decline', 'mail:handoff', 'mail:list', 'mail:open', 'mail:pick-folder', 'mail:release', 'mail:teammates']);
  for (const fn of handlers.values()) assert.deepEqual(await fn({ page: 'tasks' }), { ok: false, error: 'Not allowed.' });
  assert.deepEqual(await handlers.get('mail:list')({ page: 'sessions' }), { ok: true });
});

test('agent-mail-view: signed out, the section stays visible with one sentence and a sign-in button that opens Account', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let opened = 0, answer = true;
  w.sessionsApi = { mailList: async () => ({ ok: true, signedIn: false, held: [], inbox: [], polling: false }), continueMenu: async () => ({ choices: [] }), openAccount: async () => { opened++; return answer; }, onContinue: () => {}, onMail: () => {} };
  try {
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'agent-mail-view.js'), 'utf8'));
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await tick();
    const sec = w.document.getElementById('mail');
    assert.equal(sec.hidden, false);
    assert.match(sec.querySelector('.body').textContent, /^Agent mail lets your AI ask a teammate/);
    const b = [...sec.querySelectorAll('button')].find((x) => x.textContent === 'Sign in to use agent mail');
    assert.ok(b);
    b.click(); await tick();
    assert.equal(opened, 1);
    answer = false;
    b.click(); await tick();
    assert.match(w.document.getElementById('mail-status').textContent, /Account page could not be opened/);
  } finally { w.close(); }
});

test('agent-mail-view: held text is editable and sent with its digest; questions and handoffs render as text; the chosen folder survives a refresh', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const state = { ok: true, signedIn: true, hub: 'plexiform.dev', polling: true,
    held: [{ id: 'h1', kind: 'message', to: 'Ana', body: 'Which queue?', digest: 'd1', via: { provider: 'claude', label: 'shop-api', label_source: 'self_declared' } }],
    inbox: [{ id: 'q1', kind: 'message', from: 'Ben', body: '<img src=x onerror=alert(1)> what?', via: null }, { id: 'o1', kind: 'handoff', from: 'Cy', body: '# Handoff\nDo it', handoff: { state: 'offered', artifacts: ['src/a.js'] } }] };
  w.sessionsApi = {
    mailList: async () => state, continueMenu: async () => ({ choices: [{ id: 'claude', label: 'Claude Code', mode: 'launch' }, { id: 'copy', label: 'Copy as prompt', mode: 'copy' }] }),
    mailRelease: async (...a) => { calls.push(['release', ...a]); return { ok: true }; }, mailOpen: async (id) => { calls.push(['open', id]); return { ok: true }; },
    mailAnswer: async (...a) => { calls.push(['answer', ...a]); return { ok: true }; }, mailDecline: async (...a) => { calls.push(['decline', ...a]); return { ok: true }; },
    mailAskAi: async (...a) => { calls.push(['ask', ...a]); return { ok: true, mode: 'launched', id: 'L1' }; },
    mailPickFolder: async () => ({ ok: true, handle: 'fh', label: '~/shop' }), mailAccept: async (...a) => { calls.push(['accept', ...a]); return { ok: true }; },
    onContinue: (cb) => { w.__continue = cb; }, onMail: () => {},
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'agent-mail-view.js'), 'utf8'));
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  const sec = w.document.getElementById('mail');
  assert.equal(sec.hidden, false);
  assert.equal(sec.querySelector('img'), null, 'teammate text is never parsed as HTML');
  assert.match(sec.textContent, /Your AI wants to ask Ana/);
  assert.match(sec.textContent, /Through plexiform\.dev · from “shop-api” \(self-declared\)/);
  assert.match(sec.textContent, /Ben's AI asked you/);
  assert.match(sec.textContent, /It can’t see your code or files/);
  assert.match(sec.textContent, /Cy's AI offered you work/);
  assert.deepEqual(calls.filter((c) => c[0] === 'open').map((c) => c[1]), ['q1', 'o1']);
  const btn = (label) => [...sec.querySelectorAll('button')].find((b) => b.textContent === label);
  const held = sec.querySelector('textarea');
  held.value = 'Which queue? (edited)';
  btn('Send').click(); await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'release'), ['release', 'h1', 'send', 'd1', 'Which queue? (edited)']);
  btn('Ask my AI').click(); await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'ask'), ['ask', 'q1', 'claude']);
  w.__continue({ id: 'L1', kind: 'message', text: 'Use QUEUE_URL.' });
  assert.equal(sec.querySelector('textarea[data-mail="q1"]').value, 'Use QUEUE_URL.');
  btn('Choose a folder').click(); await tick();
  btn('Accept…').click(); await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'accept'), ['accept', 'o1', 'fh', 'auto']);
  // Edits in progress survive a re-render (the poller's mail:changed, a refocus).
  const type = (el, v, ev = 'input') => { el.value = v; el.dispatchEvent(new w.Event(ev)); };
  type(sec.querySelector('textarea'), 'Which queue, exactly?');
  type(sec.querySelector('input[aria-label="Reason for declining"]'), 'busy this week');
  type(sec.querySelectorAll('select[aria-label="Which AI"]')[1], 'codex', 'change');
  w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  assert.equal(sec.querySelector('textarea').value, 'Which queue, exactly?');
  assert.equal(sec.querySelector('input[aria-label="Reason for declining"]').value, 'busy this week');
  assert.equal(sec.querySelectorAll('select[aria-label="Which AI"]')[1].value, 'codex');
  state.inbox = []; state.held = []; state.polling = false;
  w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  assert.equal(sec.hidden, true, 'nothing waiting and the inbox off: the panel is hidden');
});

test('a release the hub rejects (sender left the team) is reported as not sent, and a failed release keeps the Home count', async (t) => {
  const { r, mailFor } = await rig(t);
  const b = mailFor(r.bob);
  const q = await b.op('ask', { to: 'alice', question: 'q?' });
  assert.equal(q.status, 'waiting_for_your_ok', JSON.stringify(q));
  const h = (await b.list()).held[0];
  assert.equal(b.pending().held, 1);
  // A hub error (bad id) leaves the held count alone.
  assert.equal((await b.release(h.id, 'send', 'wrong')).ok, false);
  assert.equal(b.pending().held, 1);
  r.h.db.run('UPDATE members SET removed_at = ? WHERE org_id = ? AND user_id = ?', new Date().toISOString(), r.org, r.bob.user);
  const out = await b.release(h.id, 'send', h.digest);
  assert.deepEqual(out, { ok: false, state: 'rejected', error: 'Not sent: sender_removed' });
});

test('team_agent_mail answers a repeat within 10 s from memory, and a new ask clears it', async (t) => {
  const { r, calls, mailFor } = await rig(t);
  let clock = 1_000_000;
  const a = mailFor(r.winA, { now: () => clock });
  await a.op('mail', {});
  const reads = () => calls.filter((c) => c.startsWith('GET /api/messaging/v1/messages')).length;
  const first = reads();
  await a.op('mail', {});
  assert.equal(reads(), first, 'the repeat costs no hub reads');
  clock += 10_001;
  await a.op('mail', {});
  assert.ok(reads() > first);
  const before = reads();
  await a.op('ask', { to: 'bob', question: 'q?' });
  const m = await a.op('mail', {});
  assert.ok(reads() > before);
  assert.equal(m.asks.length, 1);
});

test('sync starts the poller once the identity appears after the preference was already on', async () => {
  let id = null;
  const mail = AgentMail.create({ identity: () => id, resolve: async () => null, enabled: () => true,
    timers: { setInterval: () => ({}), clearInterval() {} }, fetch: async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }) });
  mail.sync();
  assert.equal(mail.polling(), false, 'signed out: nothing runs');
  id = { origin: 'https://hub.example', userId: 'me', token: () => 't' };
  mail.sync();
  assert.equal(mail.polling(), true);
  mail.stop();
});

test('the person\'s own hand-off: teammates are the board\'s members; the confirmed packet is held and released in one go; the outcome comes back when the task ends', async (t) => {
  const { r, mailFor, calls } = await rig(t);
  const Packet = require('../src/handoff-packet.js');
  const a = mailFor(r.winA);
  const b = mailFor(r.bob, { enabled: () => true });
  const who = await a.teammates('/Users/alice/shop');
  assert.equal(who.ok, true);
  assert.deepEqual(who.teammates.map((x) => x.name), ['Bob']);
  assert.equal((await AgentMail.create({ identity: () => null, resolve: async () => null, fetch }).teammates('/x')).reason, 'signed_out');
  const packet = Packet.build({ from: 'claude', to: 'teammate', goal: 'Finish the CSV export', files: ['src/export.js'], summary: 'Streaming works; headers left. Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH', branch: 'csv' }, { home: '/Users/alice' });
  assert.equal((await a.sendHandoff({ cwd: '/Users/alice/shop', to: 'nobody', packet })).ok, false);
  assert.equal((await a.sendHandoff({ cwd: '/Users/alice/shop', to: r.bob.user, packet: { ...packet, to: 'codex' } })).ok, false, 'a tool packet is not for a teammate');
  calls.length = 0;
  const sent = await a.sendHandoff({ cwd: '/Users/alice/shop', to: r.bob.user, packet });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.to, 'Bob');
  assert.deepEqual(calls.filter((c) => c.startsWith('POST')).map((c) => c.replace(sent.id, ':id')), ['POST /api/messaging/v1/messages', 'POST /api/messaging/v1/messages/:id/release']);
  const m = (await r.api(r.winA, 'GET', `/messages/${sent.id}`)).body.message;
  assert.equal(m.state, 'queued');
  assert.equal(m.kind, 'handoff');
  assert.equal(m.via.label, 'Hand off from Plexiform');
  assert.ok(!m.body.includes('sk-ant-api03'));
  assert.deepEqual(m.handoff.artifacts, [{ kind: 'path', path: 'src/export.js' }]);
  assert.equal((await a.list()).held.length, 0, 'nothing left waiting for Send');
  // It is in Alice's sent list, offered; Bob sees it in his inbox as a handoff.
  const mine = (await a.list()).sent;
  assert.equal(mine.length, 1);
  assert.deepEqual({ ...mine[0], id: undefined, created_at: undefined }, { id: undefined, created_at: undefined, to: 'bob', goal: 'Finish the CSV export', state: 'offered', report: null });
  b.sync();
  await new Promise((res) => setTimeout(res, 300));
  const inbox = (await b.list()).inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'handoff');
  // Bob accepts: the task id is remembered; when the task ends the hub hears the outcome once; a stranger's task id does nothing.
  const repo = testTempDir('agent-mail-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  const tasks = () => ({ folderOf: () => repo, create: async () => ({ ok: true, id: 'task-9' }) });
  assert.deepEqual(await b.accept(inbox[0].id, { folder: 'repo', ai: 'claude', tasks, confirm: async () => true }), { ok: true, task: 'task-9' });
  assert.deepEqual(b.acceptedTasks(), ['task-9']);
  assert.equal(await b.taskEnded('task-other', 'done'), false);
  assert.equal(await b.taskEnded('task-9', 'running'), false);
  assert.deepEqual(b.acceptedTasks(), ['task-9']);
  assert.equal(await b.taskEnded('task-9', 'in_review', 'Export streams; see /Users/alice/notes'), true);
  assert.deepEqual(b.acceptedTasks(), []);
  assert.equal(await b.taskEnded('task-9', 'done'), false, 'reported once');
  const after = (await a.list()).sent[0];
  assert.equal(after.state, 'done');
  assert.match(after.report, /Export streams/);
  assert.ok(!after.report.includes('/Users/alice'), after.report);
  const ai = await a.op('mail', { ask_id: sent.id });
  assert.equal(ai.asks[0].handoff.state, 'done');
  assert.match(ai.asks[0].handoff.report, /Export streams/);
  b.stop();
});

test('mail:teammates and mail:handoff: no packet, unknown teammate, cancel, then the hand-off goes through', async () => {
  const handlers = new Map();
  const log = [];
  const mail = { teammates: async (cwd) => ({ ok: true, teammates: cwd === '/w' ? [{ user_id: 'u1', name: 'Bob' }] : [] }), sendHandoff: async (o) => { log.push(['send', o.to]); return { ok: true, id: 'm1', to: 'Bob' }; } };
  let yes = false;
  const Packet = require('../src/handoff-packet.js');
  const packet = Packet.build({ from: 'claude', to: 'teammate', goal: 'G', files: [], summary: 'S', branch: '' });
  AgentMail.register({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, allowed: () => true, mail, tasks: () => ({}), confirm: async () => true, pickFolder: async () => null, ask: async () => ({}),
    packetFor: async (key) => (key === 'k' ? { cwd: '/w', packet } : null), confirmHandoff: async (o) => { log.push(['confirm', o.label]); return yes; } });
  const e = { page: 'sessions' };
  assert.deepEqual((await handlers.get('mail:teammates')(e, 'nope')).teammates, []);
  assert.deepEqual((await handlers.get('mail:teammates')(e, 'k')).teammates, [{ user_id: 'u1', name: 'Bob' }]);
  assert.match((await handlers.get('mail:handoff')(e, 'nope', 'u1')).error, /No handover/);
  assert.match((await handlers.get('mail:handoff')(e, 'k', 'u2')).error, /Choose a teammate/);
  assert.equal((await handlers.get('mail:handoff')(e, 'k', 'u1')).cancelled, true);
  assert.deepEqual(log, [['confirm', 'Bob (teammate)']]);
  yes = true;
  const r = await handlers.get('mail:handoff')(e, 'k', 'u1');
  assert.equal(r.ok, true);
  assert.match(r.note, /Handed off to Bob/);
  assert.deepEqual(log, [['confirm', 'Bob (teammate)'], ['confirm', 'Bob (teammate)'], ['send', 'u1']]);
});
