// Property-based fuzzing of "does the widget know what's happening".
//
// Long random runs of realistic hook events go through the REAL code paths:
// hooks/set-status.js (executed in-process against a virtual clock, so a run
// of 80 events and five idle minutes takes milliseconds, not minutes),
// main.js's own readSessions / workingAgentsStale / syncAgents (lifted out of
// main.js's source, since main.js needs Electron to load), agents.js's team
// scan and rules.js's resolve. Invariants are checked at every event and on
// the app's 2 s poll grid.
//
//   FUZZ_SEQUENCES=2000 npm run fuzz      more runs
//   FUZZ_SEED=1234 npm run fuzz           replay the one run a failure names
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FUZZ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-fuzz-'));
// delegate.js (required by the hook) fixes its root at load; keep it off ~.
process.env.CLAUDE_TRAFFIC_LIGHT_HOME = path.join(FUZZ_HOME, 'delegate-root');

const Rules = require('../rules.js');
const Agents = require('../agents.js');

const ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const SET_STATUS = path.join(HOOKS_DIR, 'set-status.js');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const SIGNAL_IDS = new Set(Rules.SIGNALS.map((s) => s.id));
const OMC_POLL_MS = Number(/const OMC_POLL_MS = (\d+);/.exec(MAIN_SRC)[1]);
const CONFIG = {
  workingStaleMinutes: Number(/workingStaleMinutes: (\d+)/.exec(MAIN_SRC)[1]),
  waitingStaleHours: Number(/waitingStaleHours: (\d+)/.exec(MAIN_SRC)[1]),
};
const HOST = os.hostname().split('.')[0];

// ── Virtual clock ─────────────────────────────────────────────────────────
function fakeDate(clock) {
  const Real = Date;
  return class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  };
}

// ── set-status.js, in-process ─────────────────────────────────────────────
// The script reads stdin with fs.readSync(0), replies with fs.writeSync(1)
// and ends with process.exit; those three are the only seams replaced.
const HOOK_FN = new Function('require', 'process', 'Date', '__dirname', '__filename', fs.readFileSync(SET_STATUS, 'utf8').replace(/^#!.*\n/, ''));
const EXIT = Symbol('exit');
function runHook(home, clock, args, payload) {
  const stdin = payload == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  let sent = false;
  const fakeFs = {
    ...fs,
    readSync(fd, buf, off, len, pos) {
      if (fd !== 0) return fs.readSync(fd, buf, off, len, pos);
      if (sent) return 0;
      sent = true;
      return stdin.copy(buf, off);
    },
    writeSync(fd, buf, ...rest) { return fd === 1 ? buf.length - (rest[0] || 0) : fs.writeSync(fd, buf, ...rest); },
  };
  const proc = {
    argv: ['node', SET_STATUS, ...args],
    env: { CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0' },
    stdin: { isTTY: false }, stderr: { write() {} }, pid: 4242, ppid: 1, platform: 'fuzz',
    exit(code) { throw { [EXIT]: code ?? 0 }; },
    cwd: () => '/fuzz',
  };
  const req = (m) => (m === 'fs' ? fakeFs : m.startsWith('.') ? require(path.join(HOOKS_DIR, m)) : require(m));
  try {
    HOOK_FN(req, proc, fakeDate(clock), HOOKS_DIR, SET_STATUS);
  } catch (e) {
    if (!(e && typeof e === 'object' && EXIT in e)) throw e;
  }
}

// ── main.js's session pipeline, lifted from its source ────────────────────
function extractFn(name) {
  const start = MAIN_SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `main.js no longer has function ${name}`);
  let depth = 0;
  for (let i = MAIN_SRC.indexOf('{', MAIN_SRC.indexOf(')', start)); i < MAIN_SRC.length; i += 1) {
    if (MAIN_SRC[i] === '{') depth += 1;
    else if (MAIN_SRC[i] === '}' && --depth === 0) return MAIN_SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const MAIN_PIPELINE = new Function('fs', 'path', 'Rules', 'Agents', 'SESSIONS_DIR', 'Date', 'process', `
  const sessionFileCache = new Map();
  const WAITING_SIGNALS = Rules.WAITING_ON_YOU;
  ${/const AGENT_KEEPALIVE_MS = [^;]+;/.exec(MAIN_SRC)[0]}
  function logTransition() {}
  function wakeWhenHoldEnds() {}
  ${['readSessionFile', 'writeJsonAtomic', 'workingAgentsStale', 'readSessions', 'syncAgents'].map(extractFn).join('\n')}
  return { readSessions, syncAgents, sessionFileCache };
`);

// ── Seeded randomness ─────────────────────────────────────────────────────
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INVARIANTS = {
  crash: 'no exception for any sequence',
  knownSignal: 'every session file and every presented signal is a known SIGNAL',
  monotonic: 'updatedAt and agentsAt never go backwards in a session file',
  notFinishedWhileWorking: 'never "Task finished" while a shown agent is working',
  transientAsk: 'a notification ask is never shown before TRANSIENT_ASK_MS',
  offline: 'offline loses only to the two locked rules',
  teammateIdle: 'a quiet teammate turns waiting after IDLE_AFTER_MS, within one poll, never earlier',
};

const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Agent', 'Agent', 'AskUserQuestion', 'mcp__github__search', 'WebFetch'];
const AGENT_IDS = ['ag-1', 'ag-2', 'ag-3', 'ag-4'];
const FAILS = [
  { error: 'rate_limit', error_details: '429 Too Many Requests' },
  { error: 'server_error', error_details: 'overloaded_error 529' },
  { error: 'unknown', error_details: 'fetch failed: ECONNRESET' },
  { error: 'unknown' },
  {},
];

function runSequence(seed) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo));
  const home = fs.mkdtempSync(path.join(FUZZ_HOME, `s${seed}-`));
  const sessionsDir = path.join(home, 'sessions');
  const teamsDir = path.join(home, 'teams');
  const projectsDir = path.join(home, 'projects');
  const stateDir = path.join(home, 'omc-state');
  const clock = { now: 1789040000000 + seed * 1000 };
  const FDate = fakeDate(clock);
  const transcripts = new Map();
  const agentsShim = { ...Agents, scanAgents: (s) => Agents.scanAgents(s, { teamsDir, projectsDir, stateDir, now: clock.now, transcripts }) };
  const main = MAIN_PIPELINE(fs, path, Rules, agentsShim, sessionsDir, FDate, process);
  const rules = Rules.defaultRules();

  const sessions = Array.from({ length: between(1, 4) }, (_, k) => ({
    id: `${(seed * 7919 + k * 104729).toString(16).padStart(8, '0').slice(-8)}-${k}aaa-bbbb`,
    cwd: `/work/p${k}`,
  }));
  const lead = sessions[0];
  const fileOf = (s) => path.join(sessionsDir, `${HOST}-${s.id}.json`);
  const teamOn = rnd() < 0.5;
  const teamName = `session-${lead.id.slice(0, 8)}`;
  const members = [];
  let memberSeq = 0;
  let offline = false;
  const log = [];
  const last = new Map(); // file → { updatedAt, agentsAt }
  const beatAtSync = new Map(); // member id → heartbeat ms the last sync saw
  let lastSync = -Infinity;
  const violations = [];
  const checks = Object.fromEntries(Object.keys(INVARIANTS).map((k) => [k, 0]));
  const exercised = new Set();
  const fail = (inv, msg) => violations.push({ inv, seed, msg, at: clock.now - (1789040000000 + seed * 1000), tail: log.slice(-12) });

  function writeTeam() {
    const dir = path.join(teamsDir, teamName);
    fs.mkdirSync(dir, { recursive: true });
    const leader = { agentId: 'team-lead@t', name: 'team-lead', agentType: 'team-lead', tmuxPaneId: 'leader', joinedAt: clock.now - 1 };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: teamName, leadSessionId: lead.id, members: [leader, ...members.map(({ lastBeat, transcript, activeSince, ...m }) => m)] }));
  }
  function touch(m) {
    m.lastBeat = clock.now;
    fs.utimesSync(m.transcript, clock.now / 1000, clock.now / 1000);
  }

  function teamEvent() {
    const r = rnd();
    const live = members.filter((m) => m.isActive !== false);
    if (r < 0.3 || !members.length) {
      memberSeq += 1;
      const name = `mate${memberSeq}`;
      const proj = path.join(projectsDir, lead.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(proj, { recursive: true });
      const transcript = path.join(proj, `${name}-sid.jsonl`);
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', teamName, agentName: name, cwd: lead.cwd })}\n`);
      const m = { agentId: `${name}@t`, name, agentType: 'executor', tmuxPaneId: `%${memberSeq}`, joinedAt: clock.now, isActive: rnd() < 0.85 ? true : undefined, transcript, activeSince: clock.now };
      touch(m);
      members.push(m);
      log.push(`team join ${name}`);
    } else if (r < 0.5) {
      const m = pick(members);
      m.isActive = m.isActive === false;
      if (m.isActive) m.activeSince = clock.now;
      log.push(`team ${m.name} isActive=${m.isActive}`);
    } else if (r < 0.6) {
      const m = members.splice(Math.floor(rnd() * members.length), 1)[0];
      log.push(`team leave ${m.name}`);
    } else if (live.length) {
      const m = pick(live);
      touch(m);
      log.push(`team beat ${m.name}`);
      return;
    }
    writeTeam();
  }

  function hookEvent() {
    const s = pick(sessions);
    const base = { session_id: s.id, cwd: s.cwd };
    const r = rnd() * 100;
    let args;
    let payload = base;
    const tool = pick(TOOLS);
    const fromAgent = rnd() < 0.2 ? { agent_id: pick(AGENT_IDS) } : {};
    if (r < 8) args = ['prompt-submit'];
    else if (r < 30) { args = ['tool-use']; payload = { ...base, hook_event_name: 'PreToolUse', tool_name: tool, ...fromAgent }; }
    else if (r < 42) { args = ['tool-done']; payload = { ...base, hook_event_name: 'PostToolUse', tool_name: tool, ...fromAgent }; }
    else if (r < 46) { args = ['tool-failed']; payload = { ...base, tool_name: tool, ...fromAgent }; }
    else if (r < 51) { args = ['subagent-start']; payload = { ...base, agent_id: pick(AGENT_IDS), agent_type: 'oh-my-claudecode:executor' }; }
    else if (r < 57) { args = ['subagent-done']; payload = { ...base, agent_id: pick(AGENT_IDS), agent_type: 'oh-my-claudecode:executor' }; }
    else if (r < 63) { args = ['notification']; payload = { ...base, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }; }
    else if (r < 67) { args = ['notification']; payload = { ...base, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }; }
    else if (r < 68) { args = ['notification']; payload = { ...base, notification_type: pick(['elicitation_dialog', 'auth_success', 'elicitation_complete']) }; }
    else if (r < 70) { args = ['notification']; payload = { ...base, message: pick(['Claude usage limit reached', 'Please approve this', 'Hello']) }; }
    else if (r < 72) { args = ['permission-request']; payload = { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }; }
    else if (r < 74) args = ['permission-denied'];
    else if (r < 81) args = ['stop'];
    else if (r < 83) { args = ['session-start']; payload = { ...base, model: 'claude-opus-5' }; }
    else if (r < 84) args = ['compact'];
    else if (r < 88) { args = ['turn-failed']; payload = { ...base, ...pick(FAILS) }; }
    else if (r < 91) args = [pick(['task-created', 'task-done'])];
    else if (r < 91.5) args = ['session-end'];
    else if (r < 92) args = ['green', 'tool-use'];
    else if (r < 94) { offline = !offline; exercised.add('offline'); log.push(`offline=${offline}`); return; }
    else if (teamOn) { teamEvent(); return; }
    else args = ['tool-use'];
    log.push(`${s.id.slice(0, 4)} ${args.join(' ')}${payload.tool_name ? ` ${payload.tool_name}` : ''}${payload.agent_id ? ` @${payload.agent_id}` : ''}${payload.notification_type ? ` ${payload.notification_type}` : ''}`);
    runHook(home, clock, args, payload);
    if (args[0] === 'session-end') last.delete(fileOf(s));
  }

  function sync() {
    main.syncAgents();
    lastSync = clock.now;
    for (const m of members) beatAtSync.set(m.agentId, m.lastBeat);
  }

  function observe() {
    // Raw session files: what the hooks and the watcher wrote.
    const raw = new Map();
    for (const s of sessions) {
      let d;
      try { d = JSON.parse(fs.readFileSync(fileOf(s), 'utf8')); } catch { continue; }
      raw.set(s.id, d);
      checks.knownSignal += 1;
      if (!SIGNAL_IDS.has(d.signal)) fail('knownSignal', `${s.id.slice(0, 4)} file signal ${JSON.stringify(d.signal)}`);
      checks.monotonic += 1;
      const prev = last.get(fileOf(s));
      if (prev) {
        if (Date.parse(d.updatedAt) < Date.parse(prev.updatedAt)) fail('monotonic', `updatedAt ${prev.updatedAt} → ${d.updatedAt}`);
        if (prev.agentsAt && d.agentsAt && Date.parse(d.agentsAt) < Date.parse(prev.agentsAt)) fail('monotonic', `agentsAt ${prev.agentsAt} → ${d.agentsAt}`);
      }
      last.set(fileOf(s), { updatedAt: d.updatedAt, agentsAt: d.agentsAt });
    }
    // What the app shows: main.js's own pipeline, then the rules. The mtime
    // cache is cleared so two same-size writes inside one filesystem tick
    // can't hand the fuzzer a stale parse.
    main.sessionFileCache.clear();
    const shown = main.readSessions(CONFIG, []);
    const now = clock.now;
    const { owned } = Rules.resolve(rules, shown, now, { offline });
    for (const s of shown) {
      checks.knownSignal += 1;
      if (!SIGNAL_IDS.has(s.signal)) fail('knownSignal', `presented ${JSON.stringify(s.signal)}`);
    }

    checks.notFinishedWhileWorking += 1;
    const working = Rules.liveAgents(shown).filter((a) => a.status === 'working');
    if (owned.lamp === 'done' && working.length) {
      fail('notFinishedWhileWorking', `"Task finished" with ${working.map((a) => `${a.name}(${a.kind})`).join(', ')} working; shown signals ${shown.map((s) => `${s.signal}${s.tool ? `/${s.tool}` : ''}`).join(', ')}`);
    }
    if (working.length) exercised.add('working-agents');

    for (const s of shown) {
      const d = raw.get(s.sessionId);
      if (s.signal !== 'permission-ask' || !d) continue;
      checks.transientAsk += 1;
      exercised.add('ask-shown');
      if (d.askKind === 'question' || d.askKind === 'request') continue;
      const age = now - Date.parse(d.signalSince || d.updatedAt);
      if (age < Rules.TRANSIENT_ASK_MS) fail('transientAsk', `${s.sessionId.slice(0, 4)} notification ask shown at ${age} ms (askKind ${d.askKind})`);
    }
    if ([...raw.values()].some((d) => d.signal === 'permission-ask' && d.askKind === 'notification' && now - Date.parse(d.signalSince) < Rules.TRANSIENT_ASK_MS)) exercised.add('ask-held');

    if (offline) {
      checks.offline += 1;
      const allowed = { limit: 'limit-hit', permission: 'permission-ask' };
      if (owned.lamp !== 'offline' && !(allowed[owned.lamp] && shown.some((s) => s.signal === allowed[owned.lamp]))) {
        fail('offline', `offline but the lamp is owned by ${owned.lamp}; shown ${shown.map((s) => s.signal).join(', ') || 'nothing'}`);
      }
    }

    const leadFile = raw.get(lead.id);
    if (teamOn && leadFile && lastSync > -Infinity) {
      for (const m of members) {
        if (m.isActive === false) continue;
        const a = (leadFile.agents || []).find((x) => x.id === m.agentId);
        if (!a) continue;
        checks.teammateIdle += 1;
        const seen = beatAtSync.get(m.agentId) ?? m.lastBeat;
        const quietAtSync = lastSync - seen;
        if (a.status === 'waiting') {
          exercised.add('teammate-waiting');
          if (quietAtSync <= Agents.IDLE_AFTER_MS - 1) fail('teammateIdle', `${m.name} waiting after only ${quietAtSync} ms quiet`);
        }
        // Anything the watcher learns (a heartbeat, an isActive flip) shows
        // on its next poll, so "within one poll" runs from the later of the two.
        if (now - m.lastBeat > Agents.IDLE_AFTER_MS + OMC_POLL_MS + 1 && now - m.activeSince > OMC_POLL_MS + 1 && a.status !== 'waiting') {
          fail('teammateIdle', `${m.name} still ${a.status} ${now - m.lastBeat} ms after its last heartbeat`);
        }
      }
    }
  }

  // Time moves in hook-sized steps with the occasional long pause. The app's
  // watcher runs on a fixed OMC_POLL_MS grid and its result depends only on
  // what is on disk at that moment, so instead of every grid point of a
  // five-minute pause the latest one runs before anything touches the session
  // files: the same files the full grid would leave. The widget is looked at
  // after each event, either side of the transient-ask hold, and either side
  // of each teammate's idle threshold.
  const grid0 = clock.now;
  function catchUp() {
    if (!teamOn) return;
    const g = grid0 + Math.floor((clock.now - grid0) / OMC_POLL_MS) * OMC_POLL_MS;
    if (g <= lastSync) return;
    const t = clock.now;
    clock.now = g;
    sync();
    clock.now = t;
  }
  function look() { catchUp(); observe(); }
  function advanceTo(target) {
    const from = clock.now;
    const at = [from + Rules.TRANSIENT_ASK_MS - 5, from + Rules.TRANSIENT_ASK_MS + 5];
    for (const m of members) {
      if (m.isActive === false) continue;
      const idle = m.lastBeat + Agents.IDLE_AFTER_MS;
      at.push(idle - 1, idle + 1, idle + OMC_POLL_MS + 2, m.activeSince + OMC_POLL_MS + 2);
    }
    for (const t of [...new Set(at)].filter((x) => x > from && x < target).sort((a, b) => a - b)) {
      clock.now = t;
      look();
    }
    clock.now = target;
  }

  const n = between(20, 81);
  try {
    for (let i = 0; i < n; i += 1) {
      catchUp();
      hookEvent();
      look();
      const g = rnd();
      const gap = g < 0.7 ? between(0, 400) : g < 0.9 ? between(400, 3000) : g < 0.98 ? between(3000, 60000) : between(60000, 300000);
      advanceTo(clock.now + gap);
    }
    checks.crash += 1;
  } catch (e) {
    checks.crash += 1;
    fail('crash', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  fs.rmSync(home, { recursive: true, force: true });
  return { violations, checks, exercised, events: n };
}

let RESULT = null;
function results() {
  if (RESULT) return RESULT;
  const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: Number(process.env.FUZZ_SEQUENCES || 200) }, (_, i) => i + 1);
  const out = { sequences: 0, events: 0, violations: [], checks: Object.fromEntries(Object.keys(INVARIANTS).map((k) => [k, 0])), exercised: {} };
  for (const seed of seeds) {
    const r = runSequence(seed);
    out.sequences += 1;
    out.events += r.events;
    out.violations.push(...r.violations);
    for (const [k, v] of Object.entries(r.checks)) out.checks[k] += v;
    for (const e of r.exercised) out.exercised[e] = (out.exercised[e] || 0) + 1;
  }
  const bySeq = (inv) => new Set(out.violations.filter((v) => v.inv === inv).map((v) => v.seed)).size;
  console.log(`[fuzz] ${out.sequences} sequences, ${out.events} events; checks ${JSON.stringify(out.checks)}; sequences exercising ${JSON.stringify(out.exercised)}; failing sequences ${JSON.stringify(Object.fromEntries(Object.keys(INVARIANTS).map((k) => [k, bySeq(k)])))}`);
  RESULT = out;
  return out;
}
test.after(() => fs.rmSync(FUZZ_HOME, { recursive: true, force: true }));

const report = (inv) => {
  const v = results().violations.filter((x) => x.inv === inv);
  if (!v.length) return '';
  const first = v[0];
  const kinds = [...new Set(v.map((x) => x.msg.replace(/\d+ ms/g, 'N ms').replace(/mate\d+/g, 'mateN')))].slice(0, 6);
  return `${v.length} violation(s) in ${new Set(v.map((x) => x.seed)).size} sequence(s). Replay: FUZZ_SEED=${first.seed} npm run fuzz\n  at +${first.at} ms: ${first.msg}\n  last events:\n    ${first.tail.join('\n    ')}\n  distinct:\n    ${kinds.join('\n    ')}`;
};

for (const [inv, desc] of Object.entries(INVARIANTS)) {
  test(`fuzz: ${desc}`, () => {
    const r = results();
    assert.equal(report(inv), '', report(inv));
    const min = process.env.FUZZ_SEED ? 0 : r.sequences;
    if (inv === 'crash') assert.equal(r.checks.crash, r.sequences);
    else assert.ok(r.checks[inv] >= min, `${inv} was only checked ${r.checks[inv]} times`);
  });
}

test('fuzz: the generator reaches the states the invariants are about', () => {
  const r = results();
  if (process.env.FUZZ_SEED) return;
  for (const k of ['offline', 'working-agents', 'ask-shown', 'ask-held', 'teammate-waiting']) {
    assert.ok((r.exercised[k] || 0) >= r.sequences / 20, `only ${r.exercised[k] || 0} sequences reached ${k}`);
  }
});
