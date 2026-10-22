'use strict';
// AC11 (board/AGENT-BUS.md): Electron main does no synchronous SQLite and no
// protected-path stat for the agent bus. bus.db, the guard and the dispatcher
// live in the tasks utilityProcess; main's pieces only relay, asynchronously.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SYNC = /\b(?:DatabaseSync|node:sqlite|[a-zA-Z]+Sync\s*\()/;
// The slice of a file between two markers: the bus part of a shared module.
const slice = (text, from, to) => { const a = text.indexOf(from); assert.ok(a >= 0, from); const b = text.indexOf(to, a + from.length); return text.slice(a, b < 0 ? undefined : b); };

test('src/agent-bus-main.js requires nothing: no fs, no SQLite, no engine module', () => {
  const t = read('src/agent-bus-main.js');
  assert.deepEqual([...t.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), []);
  assert.ok(!SYNC.test(t));
});

test('main.js never loads the bus engine modules or SQLite for the bus; its bus lines do no sync work', () => {
  const t = read('main.js');
  assert.ok(!/tasks-engine\/bus\//.test(t), 'main never imports the bus engine');
  for (const line of t.split('\n').filter((l) => /AgentBus|agentBus/.test(l))) assert.ok(!SYNC.test(line), line.trim().slice(0, 120));
});

test('the /bus relay and tasks-service.bus are async only', () => {
  const relay = slice(read('src/signal-server.js'), "if (req.url === '/bus')", 'if (hookRoute)');
  assert.ok(!SYNC.test(relay), 'relay');
  assert.match(relay, /Promise\.race/);
  const scrub = slice(read('src/signal-server.js'), 'function busScrub', '\n}\n');
  assert.ok(!SYNC.test(scrub), 'scrub');
  const svc = slice(read('src/tasks-service.js'), 'async function bus(', '\n  }\n');
  assert.ok(!SYNC.test(svc), 'tasks-service.bus');
});

test('the bus engine side stays in the utility process: bus.db is opened only by local-log.js, imported only by the dispatcher', () => {
  const engineDir = path.join(ROOT, 'board', 'tasks-engine');
  const users = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'test') walk(p); else if (e.name.endsWith('.js') && /node:sqlite/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(ROOT, p)); } };
  walk(engineDir);
  assert.deepEqual(users, [path.join('board', 'tasks-engine', 'bus', 'local-log.js')]);
  // The utility process entry is the only way in: main forks it (src/tasks-process.js), never imports it.
  assert.match(read('main.js'), /board', 'tasks-engine', 'utility-entry\.js'/);
});

// AW10 (plan-agent-awareness): the awareness roster builder and the exclusion resolver run in main, so they use
// only fs.promises and async execFile; main's awareness lines do no sync work.
test('agent awareness in main is async only: src/agent-awareness.js, hooks/repo-scope.js and main\'s awareness lines', () => {
  const builder = read('src/agent-awareness.js');
  assert.ok(!SYNC.test(builder), 'src/agent-awareness.js');
  assert.deepEqual([...builder.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]).sort(), ["'../hooks/awareness.js'", "'../hooks/repo-scope.js'", "'child_process'", "'crypto'", "'fs'", "'path'"].sort());
  assert.match(builder, /require\('fs'\)\.promises/);
  assert.match(builder, /execFile = require\('child_process'\)\.execFile/);
  assert.ok(!SYNC.test(read('hooks/repo-scope.js')), 'hooks/repo-scope.js');
  const t = read('main.js');
  const lines = t.split('\n').filter((l) => /AgentAwareness|agentAwareness|agent-awareness/.test(l));
  assert.ok(lines.length >= 4);
  for (const line of lines) assert.ok(!SYNC.test(line), line.trim().slice(0, 120));
});
