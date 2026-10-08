'use strict';
// The per-platform capability matrix (src/provider-capabilities.json,
// board/PROVIDERS.md): every platform label Plexiform advertises must have a
// recorded result, and the owned ACP agents it lists must stay unavailable with
// the exact reason. ACP runs here are against the FAKE ACP fixture, not proof.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const MATRIX = require('../src/provider-capabilities.json');
const { createInteractionHub } = require('../src/session-interaction');
const { createGeminiAcp } = require('../src/gemini-acp');
const { ACP_AGENTS, createAcpAgent, findAcpBin } = require('../src/acp-agents');
const { ownedAdapters } = require('../src/interaction-main');
const { createOverviewService } = require('../src/overview-service');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FAKE_ACP = path.join(__dirname, 'fixtures', 'fake-gemini-acp.js');
const ACTOR = 'overview:1:1';
const STATUSES = Object.keys(MATRIX.statuses);
const norm = (s) => String(s).toLowerCase().replace(/\s*\((this computer|.*?)\)\s*$/, '').trim();
const known = new Map();
for (const p of MATRIX.platforms) for (const n of [p.id, p.label, ...p.aliases]) known.set(norm(n), p.id);
const resolve = (label) => known.get(norm(label)) ?? null;
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('matrix: every platform records every column, handoff, reasons and evidence', () => {
  assert.equal(MATRIX.schema, 1);
  const ids = new Set();
  for (const p of MATRIX.platforms) {
    assert(!ids.has(p.id), `duplicate ${p.id}`); ids.add(p.id);
    assert.match(p.id, /^[a-z][a-z0-9-]{0,79}$/);
    for (const k of ['label', 'hosting', 'management', 'channel', 'prerequisite', 'tos']) assert(typeof p[k] === 'string' && p[k].length > 0, `${p.id}.${k}`);
    assert.deepEqual(Object.keys(p.matrix).sort(), [...MATRIX.columns].sort(), `${p.id} columns`);
    for (const [c, cell] of Object.entries(p.matrix)) {
      assert(STATUSES.includes(cell.status), `${p.id}.${c}: ${cell.status}`);
      assert(typeof cell.how === 'string' && cell.how.length > 0, `${p.id}.${c}.how`);
    }
    assert.equal(typeof p.handoff.midTurn, 'boolean'); assert.equal(typeof p.handoff.betweenTurns, 'boolean');
    for (const k of ['channel', 'ack', 'existingSessions']) assert(typeof p.handoff[k] === 'string' && p.handoff[k], `${p.id}.handoff.${k}`);
    // A mid-turn handoff is only claimed where a steer channel is built.
    if (p.handoff.midTurn) assert.equal(p.matrix.steer.status, 'built', `${p.id}: midTurn needs a built steer`);
    for (const k of ['owned', 'notInstalled', 'existing']) assert(typeof p.reasons[k] === 'string' && p.reasons[k].length <= 600, `${p.id}.reasons.${k}`);
    assert(p.reasons.existing.length > 0 && p.reasons.notInstalled.length > 0);
    assert(Array.isArray(p.evidence) && p.evidence.length > 0);
    for (const e of p.evidence) assert.match(e, /^(https:\/\/|local: |test: |real: |README\.md|docs\/)/, `${p.id} evidence ${e}`);
  }
  for (const id of Object.keys(ACP_AGENTS)) assert(ids.has(id), `ACP agent ${id} in matrix`);
});

test('matrix: a hook or MCP connection never counts as inbound control of an existing session', () => {
  for (const p of MATRIX.platforms) {
    if (p.matrix.receive.status !== 'built') continue;
    // Built receive is owned-only (or a pull model) and the existing-session reason says so.
    assert.match(p.management, /owned|neither/, p.id);
    assert.doesNotMatch(p.reasons.existing, /^$/);
  }
});

// Lint: every label in a place Plexiform advertises platforms must resolve in the matrix.
async function advertisedLabels() {
  const labels = new Map();
  const add = (where, v) => { if (typeof v === 'string' && v) labels.set(`${where}:${v}`, v); };
  for (const a of require('../adapters').list()) { add('adapters', a.id); add('adapters', a.label); }
  const backends = await import(path.join(ROOT, 'board/runner/backends/index.js'));
  for (const k of Object.keys(backends.BACKENDS)) add('runner-backends', k);
  const protocol = await import(path.join(ROOT, 'board/shared/protocol.js'));
  for (const k of protocol.PRESENCE_AGENTS) add('presence', k);
  const { PROVIDERS } = require('../src/overview-service');
  for (const [k, v] of Object.entries(PROVIDERS)) { add('overview', k); add('overview', v); }
  const objectKeys = (file, name) => {
    const m = read(file).match(new RegExp(`${name}\\s*=\\s*(?:Object\\.freeze\\()?\\{([^}]*)\\}`));
    assert(m, `${file} ${name}`);
    for (const [, k, v] of m[1].matchAll(/['"]?([A-Za-z0-9.-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) { add(file, k); add(file, v); }
  };
  objectKeys('src/session-overview.js', 'PROVIDERS');
  objectKeys('board/web/js/render-team.js', 'AGENT_LABEL');
  objectKeys('board/web/js/render-capture.js', 'PROVIDERS');
  for (const f of ['src/work-capture.js', 'board/hub/work-capture.js']) {
    const m = read(f).match(/PROVIDERS\s*=\s*new Set\(\[([^\]]*)\]/); assert(m, f);
    for (const [, k] of m[1].matchAll(/'([^']+)'/g)) add(f, k);
  }
  for (const d of require('../src/local-models').DISCOVERY) { add('local-models', d.id); add('local-models', d.label); }
  const owned = ownedAdapters({ env: { HOME: '/nonexistent-home', PATH: '' } });
  for (const [k, a] of Object.entries(owned)) { add('owned', k); add('owned', a.label); a.stop?.(); }
  const agentSelect = read('lights.html').split('\n').find((l) => l.includes('>any agent<'));
  assert(agentSelect, 'lights.html agent filter');
  for (const [, v, l] of agentSelect.matchAll(/<option value="([a-z-]+)">([^<]+)<\/option>/g)) { add('lights', v); add('lights', l); }
  return labels;
}
// Platform names that, if they appear in a user-facing surface, must be recorded.
const VOCABULARY = ['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'Gemini', 'Hermes', 'OpenCode', 'Copilot', 'ChatGPT', 'Windsurf', 'Aider',
  'Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'litellm', 'Cline', 'Roo Code', 'Kilo Code', 'Continue.dev', 'Amp Code', 'Augment Code', 'Devin', 'Jules',
  'Kiro', 'Qwen Code', 'Junie', 'Tabnine', 'Codeium', 'Sourcegraph Cody', 'Crush', 'Goose agent', 'Factory Droid', 'Warp AI', 'Zed AI'];
const SURFACES = () => ['README.md', 'PRIVACY.md', 'MCP.md', 'lights.html', 'overview.html', 'overview.js', 'settings.html', 'tasks.html', 'sessions.html',
  ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'site/src'), { recursive: true }).filter((f) => /\.(html|md|js|json)$/.test(f)).map((f) => `site/src/${f}`)]
  .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

test('lint: every advertised platform label has a recorded capability result', async () => {
  const missing = [];
  for (const [where, label] of await advertisedLabels()) if (resolve(label) === null) missing.push(where);
  for (const f of SURFACES()) {
    const text = read(f);
    for (const word of VOCABULARY) if (new RegExp(`(^|[^A-Za-z-])${word.replace(/[.]/g, '\\.')}($|[^A-Za-z-])`).test(text) && resolve(word) === null) missing.push(`${f}:${word}`);
  }
  assert.deepEqual(missing, [], 'add these to src/provider-capabilities.json and board/PROVIDERS.md');
});

test('lint: host apps that are AI IDEs are recorded', () => {
  const hosts = Object.keys(require('../hostapp.js').APP_ALIASES ?? {});
  const ai = hosts.filter((h) => VOCABULARY.includes(h));
  for (const h of ai) assert.notEqual(resolve(h), null, h);
});

test('lint: board/PROVIDERS.md has a row for every platform', () => {
  const doc = read('board/PROVIDERS.md');
  for (const p of MATRIX.platforms) assert(doc.includes(`| **${p.label}**`), `PROVIDERS.md row for ${p.label}`);
});

test('ACP agents not installed: listed unavailable with the exact recorded reason; launch refused', async () => {
  const adapters = ownedAdapters({ env: { HOME: '/nonexistent-home', PATH: '' } });
  const hub = createInteractionHub({ adapters, boardCurrent: (b) => b === null });
  try {
    for (const id of Object.keys(ACP_AGENTS)) {
      const c = hub.capabilities().find((x) => x.provider === id);
      const p = MATRIX.platforms.find((x) => x.id === id);
      assert.equal(c.available, false, id); assert.equal(c.reason, p.reasons.notInstalled, id);
      assert.equal(c.label, ACP_AGENTS[id].label);
      assert.equal(c.capabilities.steer, false); assert.equal(c.capabilities.existingSessions, false);
      assert.equal(c.capabilities.existingSessionsReason, p.reasons.existing);
      const r = await hub.launch({ provider: id }, ACTOR);
      assert.equal(r.status, 'unavailable'); assert.equal(r.error, p.reasons.notInstalled);
    }
  } finally { hub.stopAll(); }
});

test('ACP agents found on disk stay unavailable with the recorded isolation reason, whatever the caller passes', async () => {
  for (const id of Object.keys(ACP_AGENTS)) {
    const spawned = [];
    const a = createAcpAgent(id, { env: { HOME: '/h' }, exists: (p) => p.startsWith('/h/') || p.startsWith('/opt/homebrew/'), verified: true, spawn: (...x) => { spawned.push(x); throw new Error('must not spawn'); } });
    assert.equal(a.available, false, id);
    assert.equal(a.reason, MATRIX.platforms.find((x) => x.id === id).reasons.owned);
    const hub = createInteractionHub({ adapters: { [id]: a }, boardCurrent: (b) => b === null });
    assert.equal((await hub.launch({ provider: id }, ACTOR)).status, 'unavailable');
    assert.deepEqual(spawned, [], 'an unavailable agent is never started');
    hub.stopAll();
  }
  assert.equal(findAcpBin('cursor', { env: { HOME: '/h' }, exists: (p) => p === '/h/.local/bin/agent' }), '/h/.local/bin/agent');
  assert.equal(findAcpBin('nope', { env: { HOME: '/h' }, exists: () => true }), null);
  assert.equal(findAcpBin('hermes', { env: {}, exists: (p) => p === '/opt/homebrew/bin/hermes' }), '/opt/homebrew/bin/hermes', 'no HOME: only absolute candidates');
});

test('FAKE ACP as another provider id: delivery reaches only the selected session; foreign updates never ack; env allowlist', async () => {
  const ENV = { HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: os.tmpdir(), CURSOR_API_KEY: 'must-not-pass', GITHUB_TOKEN: 'must-not-pass' };
  const spawnSeen = [];
  const spawn = (bin, args, opts) => { spawnSeen.push({ args, env: Object.keys(opts.env) }); return require('node:child_process').spawn(bin, args, opts); };
  const a = createGeminiAcp({ bin: FAKE_ACP, args: ACP_AGENTS.cursor.args, env: ENV, spawn, requestMs: 800, verified: true, provider: 'cursor', label: 'Cursor CLI' });
  const hub = createInteractionHub({ adapters: { cursor: a }, workspace: () => fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-acp-')), boardCurrent: (b) => b === null });
  try {
    const A = (await hub.launch({ provider: 'cursor' }, ACTOR)).state, B = (await hub.launch({ provider: 'cursor' }, ACTOR)).state;
    assert.match(A.label, /Started by Plexiform · Cursor CLI/); assert.equal(A.provider.id, 'cursor');
    assert.equal((await hub.send({ session: A.session, generation: 1, text: 'ping' }, ACTOR)).status, 'acknowledged');
    const d = await until(() => hub.state({ session: A.session }, ACTOR).deliveries.find((v) => v.state === 'completed'));
    assert.equal(d.response, 'echo:ping');
    assert.equal(hub.state({ session: B.session }, ACTOR).deliveries.length, 0);
    assert.equal((await hub.send({ session: B.session, generation: 1, text: 'FOREIGN' }, ACTOR)).status, 'unavailable');
    assert.equal(hub.state({ session: B.session }, ACTOR).deliveries[0].response, '');
    assert.equal((await hub.send({ session: A.session, generation: 1, text: 'x' }, 'overview:2:2')).status, 'forbidden');
    assert.equal(spawnSeen.length, 1, 'one agent process for both sessions');
    assert.deepEqual(spawnSeen[0].args, ['acp']);
    assert.deepEqual(spawnSeen[0].env.sort(), ['HOME', 'PATH', 'TMPDIR']);
  } finally { hub.stopAll(); }
});

test('Overview: a session Plexiform did not start shows its platform\'s exact recorded reason', async () => {
  const time = Date.parse('2026-10-02T10:00:00Z');
  const row = (source) => ({ sessionId: `s-${source}`, source, signal: 'tool-use', updatedAt: new Date(time - 10).toISOString(), cwd: '/w' });
  const svc = createOverviewService({ sessions: () => ['cursor', 'gemini', 'codex', 'claude', 'hermes', 'mystery'].map(row), work: async () => ({ sources: [], capture: [] }), current: () => true, now: () => time });
  const snap = await svc.snapshot();
  const reasonOf = (label) => snap.sessions.find((s) => s.provider.label.startsWith(label)).capabilities.message.reason;
  for (const [label, id] of [['Cursor', 'cursor'], ['Gemini', 'gemini'], ['Codex', 'codex'], ['Claude Code', 'claude'], ['Hermes', 'hermes']]) {
    assert.equal(reasonOf(label), MATRIX.platforms.find((p) => p.id === id).reasons.existing, label);
  }
  assert.equal(reasonOf('Local AI'), 'A current owned runner with messaging is required.', 'unknown source keeps the generic reason');
  for (const s of snap.sessions) assert.equal(s.capabilities.message.enabled, false);
});
