'use strict';
// TEAM end to end: a real accounts-mode board hub on loopback, two persons (A, B) and two teams (X, Y). A owns team X
// and is a member of team Y; B owns team Y. github.com/teamx/app is linked to X's board, github.com/teamy/site to Y's.
// Each person has a Mac (test/e2e/helpers/mac.js): A's Claude Code session X works in teamx/app, A's Codex thread T in
// teamy/site and A's Claude Code session Z in an unlinked repo; B's Claude Code session X works in teamy/site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMac, startTeamHub, until, git } = require('./helpers/mac.js');
const { routeKey } = require('../../src/work-capture.js');
const { testTempDir } = require('../helpers/tmp');

const FAKE_KEY = `sk-ant-api03-${'Q'.repeat(86)}AA`;
const SECRET_PROMPT = `Fix login: password hunter2xyz and key ${FAKE_KEY}`;
const SECRET_BITS = ['hunter2xyz', 'sk-ant-api03', 'QQQQQQQQ'];
let n = 0;
const rid = (p) => `${p}-${process.pid}-${++n}-${Date.now().toString(36)}`;
const store = (mac) => Object.values(JSON.parse(fs.readFileSync(path.join(mac.w.dir, 'userData', 'work-capture.json'), 'utf8')).tasks);
const shown = (e) => `${e.provider}/${e.session_id ?? ''}/${e.task_id ?? ''}: ${e.destination?.kind}:${e.destination?.board_id ?? ''} ${e.why}${e.pointer ? ' pointer' : ''}${e.agent ? ' agent' : ''}${e.pending_route ? ' pending' : ''}`;

async function teams(t) {
  const dir = fs.realpathSync(testTempDir('pf-e2e-hub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = await startTeamHub(dir);
  t.after(() => hub.stop());
  const A = await hub.signIn('a@e2e.test');
  const B = await hub.signIn('b@e2e.test');
  const X = await hub.call(A.token, 'POST', '/api/teams', { name: 'Team X' });
  const Y = await hub.call(B.token, 'POST', '/api/teams', { name: 'Team Y' });
  assert.ok(X.team?.id && X.board?.id && Y.team?.id && Y.board?.id, JSON.stringify([X, Y]));
  const repoX = await hub.call(A.token, 'POST', '/api/repos', { url: 'https://github.com/teamx/app.git' }, X.team.id);
  const repoY = await hub.call(B.token, 'POST', '/api/repos', { url: 'https://github.com/teamy/site.git' }, Y.team.id);
  assert.equal((await hub.call(A.token, 'POST', `/api/boards/${X.board.id}/repos`, { repo_id: repoX.repo.id }, X.team.id)).ok, true);
  assert.equal((await hub.call(B.token, 'POST', `/api/boards/${Y.board.id}/repos`, { repo_id: repoY.repo.id }, Y.team.id)).ok, true);
  const inv = await hub.call(B.token, 'POST', `/api/teams/${Y.team.id}/invites`, { email: 'a@e2e.test', role: 'member' }, Y.team.id);
  assert.equal((await hub.call(A.token, 'POST', `/api/account/invites/${inv.invite.id}/accept`, {})).status, 200);
  return { hub, A, B, X, Y };
}

test('TEAM: linked repo, unlinked repo, cross-team hand-off withheld, hub offline then back, personal mark, excluded folder, $HOME, secrets', async (t) => {
  const { hub, A, B, X, Y } = await teams(t);
  const a = await startMac(t, { hub, person: A, remotes: { repoA: 'https://github.com/teamx/app.git', repoB: 'https://github.com/teamy/site.git', repoC: 'https://github.com/a-person/docs.git' } });
  const b = await startMac(t, { hub, person: B, remotes: { repoA: 'https://github.com/teamy/site.git' } });
  const sessionA = (id) => a.w.state.sessions.find((s) => s.sessionId === id);
  sessionA('X').taskTitle = SECRET_PROMPT;
  b.w.state.sessions = b.w.state.sessions.filter((s) => s.sessionId === 'X');
  b.w.state.sessions[0].taskTitle = 'Polish the site header';
  const boardCards = async (who, team, board) => (await hub.cards(who, team.team.id, board.board.id)).map((c) => ({ title: c.title, text: JSON.stringify(c) }));

  await t.test('T1 a linked repo goes to its team board (linked_repo), for A on X and Y and for B on Y; the real hub has the cards', async () => {
    await a.pump(); await b.pump();
    await until(async () => { await a.pump(); return store(a).filter((e) => e.card_id).length >= 3; }, { label: 'A cards' });
    const byId = Object.fromEntries(store(a).map((e) => [e.session_id, e]));
    assert.equal(byId.X.destination.board_id, X.board.id, shown(byId.X));
    assert.equal(byId.X.why, 'linked_repo');
    assert.equal(byId[a.w.T].destination.board_id, Y.board.id, shown(byId[a.w.T]));
    assert.equal(byId[a.w.T].why, 'linked_repo');
    const bx = store(b).find((e) => e.session_id === 'X');
    assert.equal(bx.destination.board_id, Y.board.id, shown(bx));
    assert.ok((await boardCards(A, X, X)).length >= 1, 'a card on team X\'s board');
    assert.ok((await boardCards(B, Y, Y)).length >= 2, 'A\'s Codex card and B\'s card on team Y\'s board');
    const hello = await a.call('X', 'hello', { provider: 'claude' });
    assert.equal(hello.board?.kind, 'team', JSON.stringify(hello.board));
    assert.equal(hello.board.why, 'linked_repo');
    assert.equal(hello.board.name, 'Team X');
  });

  await t.test('T2 an unlinked repo goes to My board (no_link)', async () => {
    const z = store(a).find((e) => e.session_id === 'Z');
    assert.equal(z.destination.kind, 'local', shown(z));
    assert.equal(z.why, 'no_link');
    const peers = await a.call('Z', 'peers');
    assert.deepEqual([peers.board?.kind, peers.board?.why], ['personal', 'no_link'], JSON.stringify(peers.board));
  });

  await t.test('T3 a hand-off from A\'s team-X session into team Y\'s repo is withheld: My board, and X gets a pointer with no details; Y gets nothing of it', async () => {
    a.bin.setCodex({ delayMs: 1500, text: 'Rotated the teamy keys in site/config.' });
    const before = (await boardCards(B, Y, Y)).length;
    const off = await a.call('X', 'handoff', { request_id: rid('t3'), to: { provider: 'codex' }, repo: a.w.repoB, title: 'Rotate the teamy keys', brief: 'Rotate keys in site/config.' });
    assert.equal(off.state, 'offered', JSON.stringify(off));
    const run = await a.runOf(off.handoff_id, () => true, 'cross-team run');
    assert.equal(fs.realpathSync(run.repo.root), fs.realpathSync(a.w.repoB), 'the run is in team Y\'s repo');
    assert.equal(run.sourceMeta.originBoard, routeKey({ hub: hub.origin, user_id: A.userId, team_id: X.team.id, board_id: X.board.id, repo_id: store(a).find((e) => e.session_id === 'X').destination.repo_id }), 'the asker\'s board rides on the run');
    let main;
    let pointer;
    await until(async () => {
      await a.pump();
      main = store(a).find((e) => e.task_id === run.id && !e.pointer);
      pointer = store(a).find((e) => e.pointer);
      return main?.card_id && pointer?.card_id;
    }, { label: 'withheld card + pointer' });
    assert.equal(main.destination.kind, 'local', shown(main));
    assert.equal(main.why, 'withheld');
    assert.equal(pointer.destination.board_id, X.board.id, shown(pointer));
    const onX = (await boardCards(A, X, X)).filter((c) => /hand-off running in another team/.test(c.title));
    assert.equal(onX.length, 1, JSON.stringify(await boardCards(A, X, X)));
    assert.equal(onX[0].title, 'Codex · hand-off running in another team\'s repo');
    assert.doesNotMatch(onX[0].text, /teamy|site|Rotate|keys|config/i, 'the pointer carries no title, folder, repo or summary');
    const wireToX = a.team.wire.filter((x) => x.board_id === X.board.id).map((x) => JSON.stringify(x.body)).join('\n');
    assert.doesNotMatch(wireToX, /teamy|Rotate|keys/i, 'nothing of Y\'s work was sent to X');
    const yCards = await boardCards(B, Y, Y);
    assert.equal(yCards.length, before, `team Y's board gets no card for A's withheld run: ${yCards.map((c) => c.title)}`);
    assert.ok(!a.team.wire.some((x) => x.board_id === Y.board.id && x.body.task_id === run.id), 'the run itself was never sent to Y');
    await a.call('X', 'wait', { handoff_id: off.handoff_id, timeout_s: 60 });
  });

  await t.test('T4 hub offline: an AI-added card waits on My board (deferred, pending_route), then moves to the team board once the hub is back', async () => {
    await hub.stop();
    const added = await a.call('X', 'card_add', { title: 'Write the migration notes', details: 'for the login change', request_id: rid('t4') });
    assert.ok(!added.reason, JSON.stringify(added));
    assert.deepEqual([added.board?.kind, added.board?.why, added.board?.pending_route], ['personal', 'deferred', true], JSON.stringify(added.board));
    const pending = store(a).find((e) => e.agent && e.pending_route);
    assert.ok(pending, store(a).map(shown).join('\n'));
    assert.equal(pending.destination.kind, 'local');
    await hub.start();
    await until(async () => { await a.pump(); const e = store(a).find((x) => x.agent && x.title?.includes('migration')); return e && !e.pending_route && e.destination.kind === 'team' && e; }, { ms: 20000, label: 're-routed' });
    const moved = store(a).find((x) => x.agent && x.title?.includes('migration'));
    assert.equal(moved.destination.board_id, X.board.id, shown(moved));
    assert.equal(moved.why, 'linked_repo');
    assert.ok((await boardCards(A, X, X)).some((c) => c.title.includes('Write the migration notes')), 'the card is on team X\'s board');
    assert.ok(a.myBoard.wire.some((w) => w.status === 'ended' && /Moved to the team board/.test(w.summary ?? '')), 'the My board copy is closed with one line');
  });

  await t.test('T5 personal mark: work-capture puts a personal session on My board (personal_mark); bus_peers says My board', async () => {
    sessionA('Z').scope = { state: 'personal' };
    await a.pump();
    await a.aw.refresh(); // main rebuilds the roster on every session change
    assert.deepEqual(a.wc.boardFor(sessionA('Z')), { kind: 'personal', why: 'personal_mark' });
    const peers = await a.call('Z', 'peers');
    assert.equal(peers.board?.kind, 'personal', JSON.stringify(peers.board));
    assert.ok(!a.team.wire.some((x) => x.body.session_id === 'Z'), 'never sent to a team');
  });

  // PRODUCT BUG (todo): main's sessions carry the person's mark (main.js:667 withScope), but src/agent-awareness.js:52
  // SESSION_FIELDS copies each session without `scope`, so the relay asks src/work-capture.js boardFor/addAgentCard
  // about an unmarked session. A linked repo's stored team card hides it (T5c); an unlinked one shows it: bus_peers says
  // no_link, and the AI's bus_card_add is accepted onto My board instead of refused PERSONAL.
  await t.test('T5b a personal session in an unlinked repo: bus_peers says personal_mark and its AI\'s bus_card_add is refused PERSONAL', { todo: 'product bug: src/agent-awareness.js:52 SESSION_FIELDS drops `scope`, so the relay never sees a personal mark' }, async () => {
    const peers = await a.call('Z', 'peers');
    const card = await a.call('Z', 'card_add', { title: 'Anything', request_id: rid('t5b') });
    assert.deepEqual([peers.board?.why, card.reason], ['personal_mark', 'PERSONAL'], JSON.stringify({ board: peers.board, card }));
  });

  await t.test('T6 excluded folder: no card, no update; bus_peers and bus_card_add answer EXCLUDED', async () => {
    a.w.state.config = { agentBus: { exclude: [a.w.repoC] } };
    fs.writeFileSync(path.join(a.w.root, 'config.json'), JSON.stringify(a.w.state.config));
    a.aw.invalidate?.();
    a.wc.forgetExclusions();
    const sentBefore = a.myBoard.wire.length + a.team.wire.length;
    sessionA('Z').signal = 'permission-ask';
    sessionA('Z').updatedAt = new Date().toISOString();
    await a.pump();
    const zWire = [...a.myBoard.wire.slice(sentBefore), ...a.team.wire].filter((x) => (x.body ?? x).session_id === 'Z');
    assert.equal(zWire.length, 0, 'the excluded session\'s card is not updated');
    assert.equal((await a.call('Z', 'peers')).reason, 'EXCLUDED');
    assert.equal((await a.call('Z', 'card_add', { title: 'x', request_id: rid('t6') })).reason, 'EXCLUDED');
  });

  await t.test('T7 a session in $HOME (a dotfiles checkout of a linked repo) gets a My board card, never a team card', async () => {
    git(a.w.home, 'init', '-q', '-b', 'main');
    git(a.w.home, 'remote', 'add', 'origin', 'https://github.com/teamx/app.git');
    a.w.state.sessions.push({ source: 'hermes', sessionId: 'HOME1', host: 'testhost', cwd: a.w.home, signal: 'tool-use', updatedAt: new Date().toISOString(), taskTitle: 'Tidy my downloads folder' });
    await until(async () => { await a.pump(); return store(a).find((e) => e.session_id === 'HOME1')?.card_id; }, { label: '$HOME card' });
    const e = store(a).find((x) => x.session_id === 'HOME1');
    assert.equal(e.destination.kind, 'local', shown(e));
    assert.equal(e.why, 'no_repo');
    assert.ok(!a.team.wire.some((x) => x.body.session_id === 'HOME1'), 'never sent to a team');
  });

  const secretWork = { card: null, off: null };
  await t.test('T8 the fake API key in a prompt, an AI-added card and a hand-off never reaches a team card, a hub payload or the trace', async () => {
    secretWork.card = await a.call('X', 'card_add', { title: 'Rotate password hunter2xyz now', details: `key ${FAKE_KEY}`, request_id: rid('t8') });
    assert.ok(!secretWork.card.reason, JSON.stringify(secretWork.card));
    secretWork.off = await a.call('X', 'handoff', { request_id: rid('t8h'), to: { provider: 'claude' }, title: 'Use password hunter2xyz', brief: `The key is ${FAKE_KEY}.` });
    assert.equal(secretWork.off.state, 'offered', JSON.stringify(secretWork.off));
    await a.call('X', 'wait', { handoff_id: secretWork.off.handoff_id, timeout_s: 60 });
    await until(async () => { await a.pump(); return store(a).some((e) => e.task_id === a.taskOf(secretWork.off.handoff_id)?.id && e.card_id); }, { label: 'run card' });
    const wire = JSON.stringify([...a.team.wire, ...b.team.wire, ...hub.wire]);
    for (const bit of ['sk-ant-api03', 'QQQQQQQQ']) assert.ok(!wire.includes(bit), `a hub payload has ${bit}`);
    for (const [who, team] of [[A, X], [B, Y], [A, Y]]) {
      const cards = JSON.stringify(await boardCards(who, team, team));
      for (const bit of ['sk-ant-api03', 'QQQQQQQQ']) assert.ok(!cards.includes(bit), `a team card has ${bit}`);
    }
    const trace = JSON.stringify(await a.traceLines());
    for (const bit of [...SECRET_BITS, a.w.home, '/Users/', '/private/', '/var/folders']) assert.ok(!trace.includes(bit), `trace has ${bit}`);
  });

  // PRODUCT BUG (todo): "password hunter2xyz" mid-sentence matches no pattern in src/secret-patterns.js (netrc_line, :156,
  // only at a line start; said_password, :152, only with "is"; keyed only with ":" or "="), so the session card title from
  // the prompt and the AI-added card title reach team X's board as written (the sk-ant key in the same titles is
  // redacted). Known in flight on bus-harden (card-title secret redaction).
  await t.test('T8b a password written in a prompt or an AI-added card title never reaches a team card or hub payload', { todo: 'product bug: team card titles keep "password hunter2xyz" (src/secret-patterns.js:156 netrc_line is line-anchored, :152 said_password needs "is"; team titles go through src/work-capture.js:36 hubTitle → src/scrub.js:495 scrubTitle with only those patterns)' }, async () => {
    const wire = [...a.team.wire, ...b.team.wire, ...hub.wire].map((x) => JSON.stringify(x));
    assert.deepEqual(wire.filter((x) => x.includes('hunter2xyz')), [], 'hub payloads with the password');
    const cards = (await boardCards(A, X, X)).map((c) => c.title);
    assert.deepEqual(cards.filter((c) => c.includes('hunter2xyz')), [], 'team X cards with the password');
  });

  await t.test('T5c a personal mark on a session in a linked repo holds through the relay: no team board, bus_card_add PERSONAL, a hand-off carries My board', async () => {
    sessionA('X').scope = { state: 'personal' };
    await a.pump();
    await a.aw.refresh();
    const p = await a.call('X', 'peers');
    assert.notEqual(p.board?.kind, 'team', JSON.stringify(p.board));
    const h = await a.call('X', 'hello', { provider: 'claude' });
    assert.notEqual(h.board?.kind, 'team', JSON.stringify(h.board));
    const before = (await boardCards(A, X, X)).length;
    const c = await a.call('X', 'card_add', { title: 'My private follow-up', request_id: rid('t5c') });
    assert.equal(c.reason, 'PERSONAL', JSON.stringify(c));
    const off = await a.call('X', 'handoff', { request_id: rid('t5ch'), to: { provider: 'codex' }, title: 'Private task', brief: 'x' });
    assert.equal(off.state, 'offered', JSON.stringify(off));
    const run = await a.runOf(off.handoff_id, () => true, 'personal run');
    assert.equal(run.sourceMeta.originBoard, 'local', 'a personal session\'s hand-off stays on My board');
    await a.call('X', 'wait', { handoff_id: off.handoff_id, timeout_s: 60 });
    await a.pump();
    assert.equal((await boardCards(A, X, X)).length, before, 'nothing new on team X\'s board');
  });
});
