// Exit (f): a non-scoped session and an out-of-repo (`cd ..`) path produce
// zero bytes at the serializer: spy on the socket (every byte the hub got)
// and the outbox file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, hookCall, REPO_ID } from './helpers.js';

function outboxBytes(sup) {
  try { return fs.readFileSync(sup.outbox.file, 'utf8'); } catch { return ''; }
}

test('offer for a repo whose checkout does not scope (remote not on the allowlist) → zero bytes', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root, { remoteUrl: 'https://github.com/someone/private.git' });
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ result: 'success' }] } });
  try {
    // The advertise already carries nothing about it beyond the allowlist match (it is opted in by id only).
    // The runner sends advertise + hb as it connects; on a loaded machine the
    // hub reads them after `connected` is true, so wait for them before counting.
    await waitFor(() => hub.frames.some((f) => f.type === 'advertise') && hub.frames.some((f) => f.type === 'hb'), { what: 'connect frames at the hub' });
    const rawBefore = hub.raw.length;
    const bytesBefore = hub.bytes;
    const obBefore = outboxBytes(sup);
    hub.send(offerFor({ key: 'APP-60' }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(hub.raw.length, rawBefore, 'no frame at all after the offer');
    assert.equal(hub.bytes, bytesBefore);
    assert.equal(outboxBytes(sup), obBefore, 'outbox untouched');
    assert.equal(sup.runs.size, 0);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('a scoped run: cd .. paths and local absolute paths never reach the wire or the outbox', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-61' }));
    fs.writeFileSync(path.join(root, 'outside-secret.txt'), 'x');
    // Facts from hooks with paths outside the repo toplevel.
    await hookCall(run, 'post', { tool_name: 'Read', tool_input: { file_path: `${root}/outside-secret.txt` }, tool_response: {} });
    await hookCall(run, 'post', { tool_name: 'Write', tool_input: { file_path: '../../outside-secret.txt' }, tool_response: {} });
    await hookCall(run, 'post', { tool_name: 'Bash', tool_input: { command: `cd .. && cat ${root}/outside-secret.txt && npm test` }, tool_response: { stdout: `reading ${root}/outside-secret.txt\nkey=sk-ant-api03-abcdefghijklmnop` } });
    await hookCall(run, 'postfail', { tool_name: 'Bash', tool_input: { command: 'cat /Users/someone/.aws/credentials' }, error: 'cat: /Users/someone/.aws/credentials: No such file' });
    await hookCall(run, 'substop', { last_assistant_message: `I looked in ${root} and /Users/someone/Documents` });
    // Agent-written text via board tools.
    await run.tool('board_append_progress', { text: `checked ${root}/outside-secret.txt with token ghp_abcdefghijklmnopqrstuvwxyz0123456789` });
    await run.tool('board_write_handover', { patch: { hypothesis: `bug is in ${run.worktree}/src/a.js not /Users/x/y` } });
    // A message that still carries a local path is refused by the serializer: zero bytes.
    const before = hub.bytes;
    const obBefore = outboxBytes(sup);
    assert.equal(run.emit({ kind: 'progress.append', text: `/Users/someone/private/${'x'}` }), null);
    run.flushFacts();
    await waitFor(() => sup.outbox.acked === sup.outbox.head, { what: 'acked' });
    const wire = hub.raw.join('\n');
    const ob = outboxBytes(sup) + obBefore;
    for (const hay of [wire, ob]) {
      assert.ok(!hay.includes(root), 'no local absolute path (tmp root)');
      assert.ok(!hay.includes('outside-secret'), 'no out-of-repo path in facts, commands or tails');
      assert.ok(!hay.includes('/Users/someone'), 'redacted user paths');
      assert.ok(!hay.includes('sk-ant-api03'), 'no anthropic key');
      assert.ok(!hay.includes('ghp_abcdefghij'), 'no github token');
    }
    const files = hub.facts('file');
    assert.equal(files.length, 0, 'out-of-repo file facts are dropped');
    assert.match(hub.outs('handover.write')[0].patch.hypothesis, /src\/a\.js/);
    assert.ok(hub.bytes >= before);
    assert.ok(hub.of('out').every((f) => f.msg.repo_id === REPO_ID));
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
