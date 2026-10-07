const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Waste = require('../src/waste');

// A Claude Code transcript, one object per line, as the CLI writes it.
function transcript() {
  const lines = [];
  let n = 0;
  const sid = 'sess-1';
  const base = { sessionId: sid, cwd: '/work/app', timestamp: '2026-10-07T10:00:00Z' };
  return {
    lines,
    prompt(text) { lines.push({ ...base, type: 'user', message: { role: 'user', content: text } }); return lines.length; },
    use(name, input, { model = 'claude-sonnet-4-5', usage } = {}) {
      const id = `tu-${++n}`;
      lines.push({ ...base, type: 'assistant', message: { id: `m-${n}`, model, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], ...(usage ? { usage } : {}) } });
      return { id, line: lines.length };
    },
    result(id, { error = false, content = 'ok' } = {}) { lines.push({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content }] } }); },
    assistant(model, usage) { lines.push({ ...base, type: 'assistant', message: { id: `m-${++n}`, model, role: 'assistant', content: [{ type: 'text', text: 'done' }], usage } }); return lines.length; },
    write(dir, name = `${sid}.jsonl`) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      return file;
    },
  };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waste-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the same file read 4 times with no edit between is a reread, with file:line and turn evidence', async (t) => {
  const tr = transcript();
  tr.prompt('fix the bug');
  const lines = [];
  for (let i = 0; i < 2; i += 1) { const u = tr.use('Read', { file_path: '/work/app/src/a.js' }); lines.push(u.line); tr.result(u.id, { content: 'x'.repeat(400) }); }
  tr.prompt('again');
  for (let i = 0; i < 2; i += 1) { const u = tr.use('Read', { file_path: '/work/app/src/a.js' }); lines.push(u.line); tr.result(u.id, { content: 'x'.repeat(400) }); }
  const file = tr.write(tmp(t));
  const found = await Waste.scanFile(file);
  const r = found.find((f) => f.kind === 'reread');
  assert.ok(r, 'reread found');
  assert.equal(r.path, '/work/app/src/a.js');
  assert.equal(r.count, 4);
  assert.equal(r.sessionId, 'sess-1');
  assert.deepEqual(r.evidence.map((e) => [e.file, e.line, e.turn]), [['sess-1.jsonl', lines[0], 1], ['sess-1.jsonl', lines[1], 1], ['sess-1.jsonl', lines[2], 2], ['sess-1.jsonl', lines[3], 2]]);
  // three of the four re-sent their 400 characters
  assert.equal(r.approxTokens, 300);
});

test('an edit between reads resets the count, and different slices are different reads', async (t) => {
  const tr = transcript();
  tr.prompt('go');
  for (let i = 0; i < 3; i += 1) { const u = tr.use('Read', { file_path: '/w/a.js' }); tr.result(u.id); }
  const e = tr.use('Edit', { file_path: '/w/a.js', old_string: 'a', new_string: 'b' }); tr.result(e.id);
  for (let i = 0; i < 3; i += 1) { const u = tr.use('Read', { file_path: '/w/a.js' }); tr.result(u.id); }
  for (let i = 0; i < 5; i += 1) { const u = tr.use('Read', { file_path: '/w/big.js', offset: i * 100, limit: 100 }); tr.result(u.id); }
  const found = await Waste.scanFile(tr.write(tmp(t)));
  assert.deepEqual(found.filter((f) => f.kind === 'reread'), []);
});

test('the same call failing 3 times in a row is a fail loop; a success in between resets it', async (t) => {
  const tr = transcript();
  tr.prompt('run the tests');
  const lines = [];
  for (let i = 0; i < 3; i += 1) { const u = tr.use('Bash', { command: 'npm  test' }); lines.push(u.line); tr.result(u.id, { error: true, content: 'Exit code 1' }); }
  tr.prompt('other');
  for (let i = 0; i < 2; i += 1) { const u = tr.use('Bash', { command: 'make' }); tr.result(u.id, { error: true }); }
  const ok = tr.use('Bash', { command: 'make' }); tr.result(ok.id);
  const again = tr.use('Bash', { command: 'make' }); tr.result(again.id, { error: true });
  const found = await Waste.scanFile(tr.write(tmp(t)));
  const loops = found.filter((f) => f.kind === 'failloop');
  assert.equal(loops.length, 1);
  assert.equal(loops[0].tool, 'Bash');
  assert.equal(loops[0].count, 3);
  assert.deepEqual(loops[0].evidence.map((e) => [e.line, e.turn]), lines.map((l) => [l, 1]));
  // whitespace in the input doesn't make it a different call
  assert.equal(Waste.normalise({ command: 'npm  test' }), Waste.normalise({ command: ' npm test ' }));
});

test('routine Opus turns are overkill, priced against Sonnet; substantial ones are not', async (t) => {
  const tr = transcript();
  tr.prompt('small things');
  const routine = { input_tokens: 100, output_tokens: 120, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 };
  for (let i = 0; i < Waste.OVERKILL_MIN; i += 1) tr.assistant('claude-opus-4-1', routine);
  tr.assistant('claude-opus-4-1', { input_tokens: 9000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const found = await Waste.scanFile(tr.write(tmp(t)));
  const o = found.find((f) => f.kind === 'overkill');
  assert.ok(o);
  assert.equal(o.count, Waste.OVERKILL_MIN);
  assert.equal(o.of, Waste.OVERKILL_MIN + 1);
  assert.ok(o.saving.high > 0 && o.saving.low <= o.saving.high);
  assert.equal(o.evidence[0].turn, 1);
});

test('scan reads only transcripts written since `since`, newest first, and totals the findings', async (t) => {
  const dir = tmp(t);
  const tr = transcript();
  tr.prompt('x');
  for (let i = 0; i < 3; i += 1) { const u = tr.use('Grep', { pattern: 'q' }); tr.result(u.id, { error: true }); }
  const fresh = tr.write(dir, 'fresh.jsonl');
  const old = tr.write(dir, 'old.jsonl');
  const past = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(old, past, past);
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{not json\n');
  const r = await Waste.scan({ root: dir, since: Date.now() - 86400000 });
  assert.equal(r.files, 2);
  assert.equal(r.totals.failloop, 1);
  assert.equal(r.findings[0].file, path.basename(fresh));
});

test('a missing root scans nothing rather than throwing', async () => {
  const r = await Waste.scan({ root: path.join(os.tmpdir(), 'no-such-waste-root'), since: 0 });
  assert.deepEqual(r.findings, []);
});
