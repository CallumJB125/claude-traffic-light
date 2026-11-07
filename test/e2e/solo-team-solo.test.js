'use strict';
// SOLO end to end (no hub, no team): two interactive Claude Code sessions (X in app, Z in docs) and a Codex TUI thread
// (T in site) on one Mac, through the real bus path (test/e2e/helpers/mac.js). Fake CLIs only; temp HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMac, until } = require('./helpers/mac.js');
const { BOARD_WHY } = require('../../src/bus-contract.js');

const QUOTA = "ERROR: You've hit your usage limit. Upgrade to Pro or try again at Nov 12th, 2026 7:42 PM.";
const REMOTES = { repoA: 'https://github.com/solo-dev/app.git', repoB: 'https://github.com/solo-dev/site.git', repoC: 'https://github.com/solo-dev/docs.git' };
const SECRETS = ['hunter2xyz', 'sk-ant-api03-'];
const FAKE_KEY = `sk-ant-api03-${'Q'.repeat(86)}AA`;
const SET_STATUS = path.join(__dirname, '..', '..', 'hooks', 'set-status.js');

// The real Claude Code hook for one event, as Claude Code runs it (a child with the session's env); its notice text.
function claudeHook(w, sessionId, cwd, signal) {
  const payload = signal === 'tool-done'
    ? { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'PRIVATE OUTPUT' } }
    : { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE PROMPT' };
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, [SET_STATUS, signal], { cwd: w.root, env: { PATH: process.env.PATH, HOME: w.home, CLAUDE_TRAFFIC_LIGHT_HOME: w.root, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_TRAFFIC_LIGHT_LOOKUP_MS: '500' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { kid.kill('SIGKILL'); reject(new Error(`hook timed out: ${err}`)); }, 15_000);
    kid.stdout.on('data', (d) => { out += d; });
    kid.stderr.on('data', (d) => { err += d; });
    kid.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${err}`));
      const text = out.trim();
      resolve(text ? (JSON.parse(text).hookSpecificOutput || {}).additionalContext || null : null);
    });
    kid.stdin.end(JSON.stringify(payload));
  });
}

let reqN = 0;
const rid = (p) => `${p}-${process.pid}-${++reqN}-${Date.now().toString(36)}`;
const noHubWords = (label, v) => assert.doesNotMatch(JSON.stringify(v ?? null), /\bhub\b|offline|unreachable|sign in|deferred|pending_route/i, `${label} mentions a hub in solo mode: ${JSON.stringify(v)}`);

test('SOLO: discovery, hello, Claude→Codex hand-off with the result back, mid-turn note, quota fallback, blocked approval, My board cards, trace', async (t) => {
  const mac = await startMac(t, { remotes: REMOTES });
  const { w } = mac;
  const h = await mac.handles();
  assert.ok(h.X && h.Z && h.T, `three handles: ${JSON.stringify(h)}`);

  await t.test('S1 bus_peers: each session sees the other two, with what each takes', async () => {
    const fromX = await mac.call('X', 'peers');
    assert.equal(fromX.bound, true, JSON.stringify(fromX));
    const seen = (r) => r.peers.map((p) => p.handle).sort();
    assert.deepEqual(seen(fromX), [h.T, h.Z].sort());
    assert.deepEqual(seen(await mac.call('T', 'peers')), [h.X, h.Z].sort());
    assert.deepEqual(seen(await mac.call('Z', 'peers')), [h.T, h.X].sort());
    assert.ok(fromX.peers.every((p) => p.takes_notes), 'all three take notes');
    noHubWords('bus_peers', fromX);
  });

  await t.test('S2 bus_hello: Claude and Codex sessions are local_attested, their repo is on the bus, their board is My board with a why', async () => {
    const x = await mac.call('X', 'hello', { provider: 'claude' });
    assert.equal(x.tier, 'local_attested', JSON.stringify(x));
    assert.equal(x.policy_summary.repo_enabled, true, JSON.stringify(x.policy_summary));
    assert.equal(x.board?.kind, 'personal', JSON.stringify(x.board));
    assert.equal(x.board.why, BOARD_WHY.NO_LINK ?? 'no_link');
    const tt = await mac.call('T', 'hello', { provider: 'codex' });
    assert.equal(tt.tier, 'local_attested', JSON.stringify(tt));
    assert.equal(tt.board?.kind, 'personal');
    noHubWords('bus_hello', [x, tt]);
  });

  let first;
  let quotaRun;
  await t.test('S3 hand-off Claude X → Codex: a Codex run starts in a new worktree, and the result comes back to X as a note and through bus_wait', async () => {
    mac.bin.setCodex({ delayMs: 300, text: 'Parser fixed; 3 tests pass.' });
    first = await mac.call('X', 'handoff', { request_id: rid('s3'), to: { provider: 'codex' }, title: 'Fix the parser', brief: 'Grammar done, tests not.' });
    assert.equal(first.state, 'offered', JSON.stringify(first));
    assert.equal(first.provider, 'codex');
    const run = await mac.runOf(first.handoff_id, () => true, 'codex run created');
    assert.equal(run.source, 'bus');
    assert.equal(run.ai?.id ?? run.ai, 'codex');
    const res = await mac.call('X', 'wait', { handoff_id: first.handoff_id, timeout_s: 60 });
    assert.equal(res.state, 'done', JSON.stringify(res).slice(0, 600));
    assert.match(res.result.text, /Parser fixed; 3 tests pass\./);
    const ran = mac.taskOf(first.handoff_id);
    assert.ok(ran.worktree && ran.worktree !== w.repoA && !ran.worktree.startsWith(`${w.repoA}/`), `a new worktree, never the asker's checkout: ${ran.worktree}`);
    assert.ok(mac.bin.codexLog().some((x) => x.kind === 'start' && x.argv.includes('exec')), 'the stub codex on PATH was started');
    assert.deepEqual(res.result.from, { provider: 'codex', tier: 'run_capability' });
    // The result note to the asker (G5), and only to the asker.
    await until(async () => { await mac.aw.syncNotes(); await mac.aw.refresh(); const r = JSON.parse(fs.readFileSync(path.join(w.root, 'awareness', 'roster.json'), 'utf8')); return r.self['claude|X'].notices.length > 0; }, { label: 'result notice for X' });
    const notes = await mac.call('X', 'notes');
    const mine = notes.notes.find((n) => JSON.stringify(n).includes(first.handoff_id));
    assert.ok(mine, JSON.stringify(notes).slice(0, 800));
    assert.match(JSON.stringify(mine), /is done, by Codex running in Plexiform/);
    const zNotes = await mac.call('Z', 'notes');
    assert.ok(!JSON.stringify(zNotes).includes(first.handoff_id), 'Z hears nothing of X\'s hand-off');
  });

  await t.test('S4 mid-turn note: T notes a working Z; Z\'s real PostToolUse hook prints one notice line with no body; Z reads the body with bus_notes', async () => {
    w.state.sessions.find((s) => s.sessionId === 'Z').signal = 'tool-use';
    const sent = await mac.call('T', 'note', { to: h.Z, text: `Heads up: I changed the lexer; ${FAKE_KEY} was in the log.`, request_id: rid('s4') });
    assert.equal(sent.state, 'queued', JSON.stringify(sent));
    await mac.aw.refresh();
    const ctx = await claudeHook(w, 'Z', w.repoC, 'tool-done');
    assert.ok(ctx && /1 note waiting from/.test(ctx), `notice: ${ctx}`);
    assert.ok(!/lexer|sk-ant|PRIVATE/.test(ctx), 'never the body');
    const got = await mac.call('Z', 'notes');
    const note = got.notes.find((n) => n.note_id === sent.note_id);
    assert.ok(note, JSON.stringify(got).slice(0, 500));
    assert.match(JSON.stringify(note), /changed the lexer/);
    assert.ok(!JSON.stringify(note).includes(FAKE_KEY), 'the fake key is scrubbed from the note');
  });

  await t.test('S5 Codex out of quota: PROVIDER_UNAVAILABLE for an explicit codex hand-off; "any" goes to Claude', async () => {
    // The person puts Codex first (Preferences fallbackOrder), so "any" picks Codex while it has quota.
    w.state.config = { ...w.state.config, agentBus: { fallbackOrder: ['codex', 'claude'] } };
    mac.bin.setCodex({ error: QUOTA });
    const q = await mac.call('X', 'handoff', { request_id: rid('s5'), to: { provider: 'any' }, title: 'Quota run', brief: 'x' });
    assert.equal(q.state, 'offered', JSON.stringify(q));
    assert.equal(q.provider, 'codex', 'the person\'s order picks Codex first');
    quotaRun = q.handoff_id;
    const r = await mac.call('X', 'wait', { handoff_id: q.handoff_id, timeout_s: 60 });
    assert.notEqual(r.state, 'done', JSON.stringify(r).slice(0, 500));
    // D4: the dispatcher gives it to the next AI once; that run finishes on Claude and the asker hears both.
    const moved = r.result?.fallback ?? r.fallback ?? null;
    let fb = moved?.handoff_id;
    if (!fb) {
      await until(async () => { await mac.aw.syncNotes(); const n = await mac.call('X', 'notes'); const m = JSON.stringify(n).match(/gave it to Claude as (hof_[0-9a-f]+)/); fb = m?.[1]; return fb; }, { label: 'fallback note' });
    }
    const fbDone = await mac.call('X', 'wait', { handoff_id: fb, timeout_s: 60 });
    assert.equal(fbDone.state, 'done', JSON.stringify(fbDone).slice(0, 500));
    assert.deepEqual(fbDone.result.from, { provider: 'claude', tier: 'run_capability' });
    const status = await mac.call('X', 'status');
    const codex = status.providers?.find((p) => p.provider === 'codex');
    assert.equal(codex?.state, 'open', JSON.stringify(status.providers));
    assert.equal(codex.reason, 'QUOTA');
    const refused = await mac.call('X', 'handoff', { request_id: rid('s5b'), to: { provider: 'codex' }, title: 'Again', brief: 'x' });
    assert.equal(refused.reason, 'PROVIDER_UNAVAILABLE', JSON.stringify(refused));
    assert.equal(refused.provider, 'codex');
    assert.ok(Number.isFinite(refused.retry_at), 'retry_at');
    assert.doesNotMatch(JSON.stringify(refused), /Upgrade to Pro/, 'never the CLI\'s text');
    const any = await mac.call('X', 'handoff', { request_id: rid('s5c'), to: { provider: 'any' }, title: 'Any AI', brief: 'x' });
    assert.equal(any.state, 'offered', JSON.stringify(any));
    assert.equal(any.provider, 'claude');
    const done = await mac.call('X', 'wait', { handoff_id: any.handoff_id, timeout_s: 60 });
    assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 500));
    assert.deepEqual(done.result.from, { provider: 'claude', tier: 'run_capability' });
  });

  await t.test('S6 blocked approval: a Claude run waiting on a tool approval sends the asker one note naming only the hand-off and the AI', async () => {
    mac.bin.setClaude({ steps: [{ tool: 'Bash', input: { command: 'git commit -m "secret plan"' }, approval: true }, { result: 'success', text: 'ok' }] });
    const b = await mac.call('X', 'handoff', { request_id: rid('s6'), to: { provider: 'claude' }, title: 'Blocked job TITLE-S6', brief: 'BRIEF-S6' });
    assert.equal(b.state, 'offered', JSON.stringify(b));
    const run = await mac.runOf(b.handoff_id, (x) => x.state === 'blocked', 'blocked on approval');
    assert.equal(run.blockedKind, 'permission');
    let note;
    await until(async () => {
      await mac.aw.syncNotes();
      const got = await mac.call('X', 'notes');
      note = got.notes.find((n) => JSON.stringify(n).includes(b.handoff_id));
      return note;
    }, { label: 'blocked note' });
    const text = JSON.stringify(note);
    assert.match(text, /waiting for your person to get a step approved/);
    for (const bit of ['TITLE-S6', 'BRIEF-S6', 'git commit', 'secret plan', w.home]) assert.ok(!text.includes(bit), `blocked note has ${bit}`);
    await mac.stopRun(run.id);
    mac.bin.setClaude({ steps: [{ result: 'success', text: 'Claude finished the hand-off.' }] });
  });

  await t.test('S7 cards: every session, run and AI-added card is on My board with its why; no team card, no hub error', async () => {
    w.state.sessions.find((s) => s.sessionId === 'X').taskTitle = `Fix login; password hunter2xyz and key ${FAKE_KEY}`;
    const added = await mac.call('X', 'card_add', { title: 'Follow up on the parser', details: 'one line', request_id: rid('s7') });
    assert.ok(!added.reason, JSON.stringify(added));
    assert.equal(added.board?.kind, 'personal', JSON.stringify(added));
    noHubWords('bus_card_add', added);
    await mac.pump();
    // Every entry work-capture keeps (sessions, hand-off runs, the AI-added card), straight from its private store.
    const entries = () => Object.values(JSON.parse(fs.readFileSync(path.join(w.dir, 'userData', 'work-capture.json'), 'utf8')).tasks);
    await until(async () => { await mac.pump(); return entries().filter((e) => e.card_id).length >= 6; }, { label: 'cards for 3 sessions, the runs and the AI card' });
    const all = entries();
    const shown = (e) => `${e.provider}/${e.session_id ?? ''}/${e.task_id ?? ''}: ${e.destination?.kind} ${e.why}`;
    for (const e of all) {
      assert.equal(e.destination?.kind, 'local', `on My board: ${shown(e)}`);
      assert.ok(Object.values(BOARD_WHY).includes(e.why), `a contract why: ${shown(e)}`);
      assert.ok(e.card_id, `made on the hub: ${shown(e)}`);
    }
    const sessionsWhy = all.filter((e) => ['X', 'Z', w.T].includes(e.session_id) && !e.agent).map((e) => e.why);
    assert.deepEqual(sessionsWhy, ['no_link', 'no_link', 'no_link'], all.map(shown).join('\n'));
    const runs = all.filter((e) => /^tsk_/.test(e.task_id ?? '') || /^tsk_/.test(e.session_id ?? ''));
    assert.ok(runs.length >= 3, `hand-off runs carded: ${all.map(shown).join('\n')}`);
    assert.ok(runs.every((e) => e.why === 'inherited'), `a hand-off from a My board session stays on My board as inherited: ${runs.map(shown).join('\n')}`);
    assert.equal(all.filter((e) => e.agent).map((e) => e.why).join(), 'no_link', 'the AI-added card');
    assert.deepEqual(mac.team.wire, [], 'nothing was sent to any team');
    assert.equal(mac.wc.notice?.() ?? null, null, 'no capture notice');
    assert.ok(mac.myBoard.cards().length >= 4, 'the cards exist on the real My board hub');
  });

  await t.test('S8 trace: one line per op, accurate results, no absolute path, title, body or secret', async () => {
    const lines = await mac.traceLines();
    const ops = new Set(lines.map((l) => l.op));
    for (const op of ['peers', 'hello', 'handoff', 'claim', 'start', 'result', 'returned', 'note', 'notes', 'wait']) assert.ok(ops.has(op), `trace has ${op}: ${[...ops]}`);
    const refused = lines.find((l) => l.op === 'handoff' && l.reason === 'PROVIDER_UNAVAILABLE');
    assert.ok(refused, 'the refused codex hand-off is traced with its reason');
    assert.notEqual(refused.result, 'ok', `a refusal is not traced ok: ${JSON.stringify(refused)}`);
    const failed = lines.filter((l) => l.ref === quotaRun && l.op === 'result'); // 'returned' is the note's delivery, ok when delivered
    assert.ok(failed.length, 'the quota run\'s result is traced');
    for (const l of failed) assert.notEqual(l.result, 'ok', `a failed run is not traced ok: ${JSON.stringify(l)}`);
    assert.ok(lines.some((l) => l.op === 'breaker' && l.provider === 'codex'), 'the breaker opening is traced');
    const ok = lines.find((l) => l.op === 'handoff' && l.ref === first.handoff_id);
    assert.equal(ok?.result, 'ok', JSON.stringify(ok));
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    for (const bit of [...SECRETS, w.home, w.dir, '/Users/', '/private/', '/var/folders', 'Fix the parser', 'Grammar done', 'lexer', 'Parser fixed']) assert.ok(!text.includes(bit), `trace has ${bit}`);
    assert.doesNotMatch(text, /"(?:\/|~\/)[^"]*"/, 'no path value');
  });
});
