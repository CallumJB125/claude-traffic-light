'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Gate = require('../hooks/policy-gate.js');
const Packs = require('../hooks/policy-packs.js');
const Policy = require('../src/policy.js');
const Overview = require('../src/session-overview.js');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return fs.realpathSync(d); };
const at = (root, cwd = root) => ({ cwd, root, home: '/Users/me' });
const check = (policy, tool, input, where) => Gate.checkTool(policy, { tool, input, ...where });
const bash = (policy, command, where = at('/repo')) => check(policy, 'Bash', { command }, where);

function repoWith(t, policyText) {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  if (policyText !== undefined) {
    fs.mkdirSync(path.join(repo, '.plexiform'));
    fs.writeFileSync(path.join(repo, '.plexiform', 'policy.json'), typeof policyText === 'string' ? policyText : JSON.stringify(policyText));
  }
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  return { dir, repo, data };
}

// ── Pattern matching ─────────────────────────────────────────────────────────

test('patterns: Tool, Tool(arg glob) and wildcard tool names', () => {
  assert.deepEqual(Gate.parsePattern('Bash(git push*)'), { tool: 'Bash', arg: 'git push*' });
  assert.deepEqual(Gate.parsePattern('WebFetch'), { tool: 'WebFetch', arg: null });
  assert.equal(Gate.parsePattern('not a pattern!'), null);
  const p = { version: 1, name: 'x', tools: { deny: ['mcp__github__*', 'WebFetch(https://evil.example/*)', 'Read(*.secret)'] } };
  assert.match(check(p, 'mcp__github__create_issue', {}, at('/r')), /mcp__github__create_issue tool is denied/);
  assert.equal(check(p, 'mcp__slack__post', {}, at('/r')), null);
  assert.match(check(p, 'WebFetch', { url: 'https://evil.example/a' }, at('/r')), /denied/);
  assert.equal(check(p, 'WebFetch', { url: 'https://ok.example/a' }, at('/r')), null);
  assert.match(check(p, 'Read', { file_path: 'x.secret' }, at('/r')), /denied/);
});

test('patterns: a Bash deny hits any part of a compound command, after wrappers and env', () => {
  const p = { version: 1, name: 'x', tools: { deny: ['Bash(git reset --hard*)'] } };
  for (const c of ['git reset --hard HEAD~1', 'cd sub && git reset --hard', 'npm test; git reset --hard', 'FOO=1 sudo git reset --hard', 'echo $(git reset --hard)', "bash -c 'x' | git reset --hard"]) {
    assert.match(bash(p, c), /git reset --hard\*" is denied/, c);
  }
  assert.equal(bash(p, 'git reset --soft HEAD~1'), null);
  assert.equal(bash(p, 'echo "git reset --hard"'), null, 'quoted text is not a command');
});

test('patterns: an allow list admits only what it names, and every part of a Bash command must match', () => {
  const p = { version: 1, name: 'x', tools: { allow: ['Read', 'Grep', 'Bash(git log*)', 'Bash(ls*)'] } };
  assert.equal(check(p, 'Read', { file_path: 'a' }, at('/r')), null);
  assert.equal(bash(p, 'git log --oneline && ls -la'), null);
  assert.match(bash(p, 'git log && rm -rf x'), /not on the allowed list/);
  assert.match(check(p, 'Write', { file_path: 'a' }, at('/r')), /Write is not on the allowed list/);
  assert.equal(check(p, 'AskUserQuestion', {}, at('/r')), null, 'asking the person is never refused');
});

test('patterns: protected path globs', () => {
  assert.ok(Gate.pathMatches('.env', '/repo/.env', '/repo'));
  assert.ok(Gate.pathMatches('.env.*', '/repo/app/.env.local', '/repo'), 'a glob without / matches at any depth');
  assert.ok(Gate.pathMatches('secrets/**', '/repo/secrets/a/b.json', '/repo'));
  assert.ok(Gate.pathMatches('config/*.yml', '/repo/config/prod.yml', '/repo'));
  assert.ok(!Gate.pathMatches('config/*.yml', '/repo/config/deep/prod.yml', '/repo'), '* stays in one folder');
  assert.ok(Gate.pathMatches('id_rsa*', '/Users/me/.ssh/id_rsa.pub', '/repo'), 'names match outside the repo too');
  assert.ok(!Gate.pathMatches('.env', '/repo/src/env.js', '/repo'));
});

// ── Malformed files: ignored with a warning, never enforced, never thrown ────

test('malformed policy files are ignored with a warning and allow the call', (t) => {
  for (const [text, why] of [['{ not json', /not valid JSON/], ['[]', /not a JSON object/], ['{"version":2}', /version 2/], ['"x"', /not a JSON object/], [' '.repeat(70 * 1024), /64 KB/]]) {
    const { repo, data } = repoWith(t, text);
    const loaded = Gate.loadFor({ rootDir: data, cwd: path.join(repo, 'src') });
    assert.equal(loaded.policy, null);
    assert.match(loaded.warnings.join(' '), why);
    assert.equal(Gate.decide({ rootDir: data, signal: 'tool-use', data: { cwd: repo, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } }), null);
    const prompt = Gate.decide({ rootDir: data, signal: 'prompt-submit', data: { cwd: repo, prompt: 'hi' } });
    assert.match(prompt.systemMessage, /Plexiform policy: .*ignored/);
    assert.equal(prompt.decision, undefined, 'a warning, never a block');
  }
});

test('a malformed repo file falls back to the default; bad fields are dropped, the rest applies', (t) => {
  const { repo, data } = repoWith(t, '{oops');
  fs.writeFileSync(path.join(data, Gate.DEFAULT_FILE), JSON.stringify({ version: 1, name: 'Mine', readOnly: 'yes', tools: { deny: ['WebSearch', 42] }, prompts: { secrets: 'maybe' }, dailySpendCapUsd: -3 }));
  const loaded = Gate.loadFor({ rootDir: data, cwd: repo });
  assert.equal(loaded.source, 'default');
  assert.deepEqual(loaded.policy.tools.deny, ['WebSearch']);
  assert.equal(loaded.policy.readOnly, undefined);
  assert.equal(loaded.policy.dailySpendCapUsd, undefined);
  assert.match(loaded.warnings.join(' '), /policy\.json is not valid JSON, so it is ignored/);
  assert.match(loaded.warnings.join(' '), /"readOnly" is not true or false/);
  assert.match(loaded.warnings.join(' '), /prompts\.secrets/);
});

test('decide never throws: odd payloads and unreadable folders allow', () => {
  for (const data of [null, {}, { tool_name: 42 }, { cwd: 7, tool_name: 'Bash', tool_input: 'x' }, { cwd: '/definitely/not/here', tool_name: 'Bash' }]) {
    assert.doesNotThrow(() => Gate.decide({ rootDir: '/definitely/not/here', signal: 'tool-use', data }));
  }
  assert.equal(Gate.decide({ rootDir: '/x', signal: 'stop', data: {} }), null);
});

// ── The packs ────────────────────────────────────────────────────────────────

test('pack Careful: destructive git and rm outside the repo are denied; keys and .env are protected', () => {
  const p = Packs.packPolicy('careful');
  const w = at('/repo', '/repo/src');
  for (const c of ['git push origin main --force', 'git push -f', 'git push origin -f', 'git clean -fdx', 'git branch -D feature', 'git reset --hard origin/main']) assert.ok(bash(p, c, w), c);
  assert.match(bash(p, 'rm -rf /etc/thing', w), /no deleting outside this repo \(\/etc\/thing\)/);
  assert.match(bash(p, 'rm -rf ~/Documents', w), /outside this repo/);
  assert.match(bash(p, 'rm -rf ../../elsewhere', w), /outside this repo/);
  assert.match(bash(p, 'rm -rf $TARGET', w), /outside this repo/, 'a path it cannot know is treated as outside');
  assert.equal(bash(p, 'rm -rf build ../dist', w), null, 'inside the repo is fine');
  assert.match(check(p, 'Edit', { file_path: '../.env' }, w), /\.env is a protected path/);
  assert.match(check(p, 'Write', { file_path: '/repo/certs/server.pem' }, w), /protected path \(\*\.pem\)/);
  assert.match(bash(p, 'echo KEY=1 >> .env', at('/repo')), /protected path/);
  assert.match(bash(p, 'sed -i s/a/b/ .env.production', at('/repo')), /protected path/);
  assert.equal(check(p, 'Edit', { file_path: '/repo/src/app.js' }, w), null);
  assert.equal(bash(p, 'git push origin main && npm test', w), null);
  assert.equal(check(p, 'Read', { file_path: '/repo/.env' }, w), null, 'reading is not editing');
  assert.match(check(p, 'Write', { file_path: '/repo/.plexiform/policy.json' }, w), /protected path \(\.plexiform\/\*\*\)/, 'a session cannot rewrite its own policy');
  assert.match(bash(p, 'rm .plexiform/policy.json', at('/repo')), /protected path/);
});

test('pack Fintech / POPIA: secrets and SA ID, IBAN, card and MRZ numbers in prompts are refused', () => {
  const p = Packs.packPolicy('fintech-popia');
  const cases = [
    ['the client ID number is 8001015009087', /South African ID/],
    ['pay into GB82 WEST 1234 5698 7654 32 today', /IBAN/],
    ['card 4111 1111 1111 1111 declined', /card number/],
    ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10', /passport MRZ/],
    ['use key sk-ant-api03-Zq8xVb7Lm2Nc4Kd9Rt6Yw1Pf3Hs5Jg0', /never put secrets in prompts/],
  ];
  for (const [prompt, re] of cases) {
    const r = Gate.checkPrompt(p, prompt);
    assert.equal(r?.action, 'deny', prompt);
    assert.match(r.rule, re);
  }
  assert.equal(Gate.checkPrompt(p, 'refactor the IBAN validator and add tests for card numbers'), null);
  assert.ok(Packs.KEY_FILES.every((g) => p.protectedPaths.includes(g)));
  assert.equal(p.dailySpendCapUsd, 25);
});

test('pack Fintech / POPIA: warn mode warns instead, and missing detectors warn but never block', () => {
  const warn = { version: 1, name: 'W', prompts: { pii: 'warn' } };
  assert.deepEqual(Gate.checkPrompt(warn, 'id 8001015009087'), { action: 'warn', rule: 'no personal numbers in prompts (found a South African ID number)' });
  const r = Gate.checkPrompt(Packs.packPolicy('fintech-popia'), 'id 8001015009087', { detectors: null });
  assert.equal(r.action, 'warn');
  assert.ok(r.unchecked);
});

test('pack Read-only reviewer: no edits, no write commands, no network', () => {
  const p = Packs.packPolicy('read-only-reviewer');
  const w = at('/repo');
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(check(p, tool, { file_path: '/repo/a', url: 'https://x' }, w), tool);
  for (const c of ['git commit -am x', 'npm install left-pad', 'touch a', 'git log > out.txt', 'find . -name x -delete', 'curl https://example.com', 'git fetch', 'ssh host']) assert.ok(bash(p, c, w), c);
  for (const c of ['git log --oneline | head -5', 'git diff HEAD~1', 'ls -la 2>/dev/null', 'grep -rn foo src', 'cat README.md']) assert.equal(bash(p, c, w), null, c);
  for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(check(p, tool, { file_path: '/repo/a' }, w), null, tool);
});

// ── The deny message, end to end through the hook ────────────────────────────

test('the deny message is plain: "Blocked by policy: <rule>", where it came from, and how to change it', (t) => {
  const { repo, data } = repoWith(t, Packs.packPolicy('careful'));
  const out = Gate.decide({ rootDir: data, signal: 'tool-use', data: { session_id: 's-1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push --force' } } });
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'deny');
  assert.equal(h.permissionDecisionReason, 'Blocked by policy: Bash "git push*--force*" is denied. ("Careful" in .plexiform/policy.json; Change it in Plexiform → Settings → Privacy and data → Policies.)');
  const row = Policy.rowInfo({ sessionId: 's-1', cwd: path.join(repo, 'src') }, data);
  assert.equal(row.name, 'Careful');
  assert.equal(row.source, 'repo');
  assert.equal(row.blocked.text, 'Blocked by policy: Bash "git push*--force*" is denied');
  assert.equal(row.blocked.tool, 'Bash');
});

function runHook(data, signal, payload) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'set-status.js'), signal], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: data, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0' }, encoding: 'utf8', timeout: 15000 });
}

test('set-status.js prints the policy deny for PreToolUse and blocks a prompt without touching the session', (t) => {
  const { repo, data } = repoWith(t, Packs.packPolicy('fintech-popia'));
  const tool = runHook(data, 'tool-use', { session_id: 'hook-1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, '.env') } });
  assert.equal(tool.status, 0);
  assert.match(JSON.parse(tool.stdout).hookSpecificOutput.permissionDecisionReason, /^Blocked by policy: \.env is a protected path/);
  const before = fs.readdirSync(path.join(data, 'sessions'));
  const prompt = runHook(data, 'prompt-submit', { session_id: 'hook-2', cwd: repo, prompt: 'customer ID 8001015009087' });
  assert.equal(prompt.status, 0);
  const out = JSON.parse(prompt.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^Blocked by policy: no personal numbers in prompts/);
  assert.equal(out.block, undefined);
  assert.deepEqual(fs.readdirSync(path.join(data, 'sessions')), before, 'a refused prompt starts no turn');
  const fine = runHook(data, 'prompt-submit', { session_id: 'hook-3', cwd: repo, prompt: 'tidy the README' });
  assert.equal(fine.status, 0);
  assert.equal(fine.stdout, '');
});

test('set-status.js with a malformed policy warns on the prompt and allows the tool call', (t) => {
  const { repo, data } = repoWith(t, '{"version":1,');
  const tool = runHook(data, 'tool-use', { session_id: 'm-1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push --force' } });
  assert.equal(tool.status, 0);
  assert.equal(tool.stdout, '');
  const prompt = runHook(data, 'prompt-submit', { session_id: 'm-1', cwd: repo, prompt: 'hello' });
  assert.match(JSON.parse(prompt.stdout).systemMessage, /not valid JSON, so it is ignored/);
});

// ── App side ─────────────────────────────────────────────────────────────────

test('apply writes only the exact content that was reviewed', (t) => {
  const { repo, data } = repoWith(t);
  const pv = Policy.preview(data, { target: repo, pack: 'careful' });
  assert.equal(pv.path, path.join(repo, '.plexiform', 'policy.json'));
  assert.equal(pv.current, null);
  assert.deepEqual(JSON.parse(pv.content), Packs.packPolicy('careful'));
  assert.match(Policy.apply(data, { target: repo, pack: 'careful' }).error, /Review it again/);
  assert.match(Policy.apply(data, { target: repo, pack: 'careful', content: pv.content.replace('Careful', 'Lax') }).error, /Review it again/);
  assert.ok(!fs.existsSync(pv.path), 'nothing written without the confirmed content');
  assert.deepEqual(Policy.apply(data, { target: repo, pack: 'careful', content: pv.content }), { ok: true, path: pv.path });
  assert.equal(fs.readFileSync(pv.path, 'utf8'), pv.content);
  assert.equal(Policy.preview(data, { target: repo, pack: 'careful' }).current, pv.content);
  assert.match(Policy.preview(data, { target: '/', pack: 'careful' }).error, /folder/);
  assert.match(Policy.preview(data, { target: 'relative', pack: 'careful' }).error, /folder/);
  assert.match(Policy.preview(data, { target: repo, pack: 'nope' }).error, /packs/);
  const def = Policy.preview(data, { target: 'default', pack: 'read-only-reviewer' });
  assert.ok(Policy.apply(data, { target: 'default', pack: 'read-only-reviewer', content: def.content }).ok);
  assert.equal(Policy.state(data).default.name, 'Read-only reviewer');
});

test('the per-repo daily cap: over-cap repos are written to the gate the hook reads', (t) => {
  const { repo, data } = repoWith(t, { version: 1, name: 'Capped', dailySpendCapUsd: 5 });
  const now = Date.now();
  const turns = [{ ts: now - 1000, cwd: path.join(repo, 'src') }, { ts: now - 2000, cwd: repo }, { ts: now - 3 * 86400000, cwd: repo }];
  const repos = Policy.overCaps({ rootDir: data, turns, now, costOf: () => 3 });
  assert.deepEqual(Object.keys(repos), [repo]);
  assert.match(repos[repo], /daily spend cap of \$5\.00 is reached \(\$6\.00 today\)/);
  Policy.writeSpendGate(data, repos, now);
  const out = Gate.decide({ rootDir: data, signal: 'tool-use', now, data: { cwd: repo, tool_name: 'Read', tool_input: { file_path: 'a' } } });
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Blocked by policy: this repo's daily spend cap/);
  assert.equal(Gate.decide({ rootDir: data, signal: 'tool-use', now: now + Gate.MAX_TTL_MS + 1, data: { cwd: repo, tool_name: 'Read' } }), null, 'a stale gate allows');
  Policy.writeSpendGate(data, {}, now);
  assert.ok(!fs.existsSync(path.join(data, Gate.SPEND_FILE)));
  assert.deepEqual(Policy.overCaps({ rootDir: data, turns, now, costOf: () => 1 }), {});
});

test('Sessions rows carry the policy name and the latest refusal; none when there is no policy', () => {
  const snap = Overview.snapshot({
    sessions: [{ sessionId: 'a', cwd: '/w/one', updatedAt: new Date().toISOString(), signal: 'tool-use' }, { sessionId: 'b', cwd: '/w/two', updatedAt: new Date().toISOString(), signal: 'tool-use' }],
    policy: (row) => (row.sessionId === 'a' ? { name: 'Careful', source: 'repo', warning: null, blocked: { text: 'Blocked by policy: x', tool: 'Bash', at: 1 }, raw: 'never shown' } : null),
  });
  const a = snap.sessions.find((s) => s.project === 'one');
  assert.deepEqual(a.policy, { name: 'Careful', source: 'repo', warning: null, blocked: { text: 'Blocked by policy: x', tool: 'Bash', at: 1 } });
  assert.equal(snap.sessions.find((s) => s.project === 'two').policy, undefined);
  assert.doesNotThrow(() => Overview.snapshot({ sessions: [{ sessionId: 'a', cwd: '/w' }], policy: () => { throw new Error('x'); } }));
});

test('startHold: only a policy that opts in holds new tasks, for a repo cap or the overall budget', (t) => {
  const { repo, data } = repoWith(t, { version: 1, name: 'Held', dailySpendCapUsd: 5, weeklySpendCapUsd: 20, holdTasksAtLimit: true });
  const now = Date.now();
  const costOf = () => 3;
  const hold = (turns, budget) => Policy.startHold({ rootDir: data, cwd: path.join(repo, 'src'), turns, now, costOf, budget });
  assert.equal(hold([{ ts: now - 1000, cwd: repo }]), null, 'under both caps');
  const day = hold([{ ts: now - 1000, cwd: repo }, { ts: now - 2000, cwd: repo }]);
  assert.match(day.text, /on hold: this repo's daily cap of \$5\.00 is reached \(\$6\.00 today\)\. Tasks already running are not affected/);
  const budget = hold([], { level: 'exceeded', which: 'week', text: '$80 of $75 this week' });
  assert.match(budget.text, /your weekly spend limit is reached \(\$80 of \$75 this week\)/);
  assert.equal(hold([], { level: 'warning', which: 'day' }), null, 'a warning is not a limit');
  assert.equal(hold([{ ts: now - 1000, cwd: '/elsewhere' }, { ts: now - 1000, cwd: '/elsewhere' }]), null, 'other repos do not count');
});

test('startHold: without holdTasksAtLimit nothing is held, even over a cap', (t) => {
  const { repo, data } = repoWith(t, { version: 1, name: 'Soft', dailySpendCapUsd: 1 });
  const now = Date.now();
  assert.equal(Policy.startHold({ rootDir: data, cwd: repo, turns: [{ ts: now - 1, cwd: repo }], now, costOf: () => 9, budget: { level: 'exceeded', which: 'day' } }), null);
  assert.equal(Policy.startHold({ rootDir: data, cwd: '/definitely/not/here', turns: [], now, costOf: () => 1 }), null);
});

test('the weekly cap and hold flag are read; a bad value is dropped with a warning', () => {
  const ok = Gate.normalize({ version: 1, weeklySpendCapUsd: 40, holdTasksAtLimit: true });
  assert.equal(ok.policy.weeklySpendCapUsd, 40);
  assert.equal(ok.policy.holdTasksAtLimit, true);
  const bad = Gate.normalize({ version: 1, weeklySpendCapUsd: 0, holdTasksAtLimit: 'yes' });
  assert.equal(bad.policy.weeklySpendCapUsd, undefined);
  assert.equal(bad.policy.holdTasksAtLimit, undefined);
  assert.equal(bad.warnings.length, 2);
});
