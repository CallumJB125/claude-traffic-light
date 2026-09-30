// The local HTTP signal endpoint and the pending permission-request reader,
// extracted verbatim from main.js. A factory so the server can resolve state
// (aggregateState) and re-broadcast (broadcastStatus) without importing the
// core.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app } = require('electron');
const Rules = require('../rules.js');
const SessionState = require('../hooks/session-state.js');
const Adapters = require('../adapters/index.js');
const Answer = require('../hooks/answer-file.js');
const { describeRequest } = require('./request-view.js');

const SIGNAL_PORT = Number(process.env.CLAUDE_TRAFFIC_LIGHT_PORT || 47172);
const SIGNAL_TOKEN = crypto.randomBytes(32).toString('hex');
const SIGNAL_TOKEN_HEADER = 'x-buddy-token';
const KNOWN_SIGNALS = new Set(Rules.SIGNALS.filter((x) => x.hook).map((x) => x.id).concat(['session-end']));

function tokenMatches(sent) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(SIGNAL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// `rootDir`, `sessionsDir`, `requestsDir` are the same paths main.js computes;
// `aggregateState` and `broadcastStatus` are the live core callbacks.
module.exports = ({ rootDir, sessionsDir, requestsDir, aggregateState, broadcastStatus }) => {
  // Per-request answer keys from the blocking hooks: memory only, never on
  // disk, so nothing that can write requests/ can also sign an answer.
  const requestKeys = Answer.requestKeys();
  function readBody(req, done, then) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return done(400, { error: 'bad json' }); }
      if (!d || typeof d !== 'object' || Array.isArray(d)) return done(400, { error: 'bad json' });
      then(d);
    });
  }

  // POST /hook/:adapter[?event=<name>] with the agent's own hook payload:
  // the adapter's normalize() turns it into signals, exactly as
  // `emit.js --adapter <id>` does from a command hook.
  function hookEvent(id, event, payload, done) {
    const adapter = Adapters.get(id);
    if (!adapter) return done(404, { error: 'unknown adapter', known: Adapters.list().map((a) => a.id) });
    const events = adapter.normalize(event, payload).filter((e) => KNOWN_SIGNALS.has(e.signal));
    const host = os.hostname().split('.')[0];
    for (const e of events) SessionState.applyAdapterEvent(sessionsDir, { host, source: adapter.id, event: e, fallbackSession: 'default', waitMs: 250 });
    if (events.length) broadcastStatus();
    const reply = adapter.reply ? adapter.reply(event, payload) : null;
    return done(200, { ok: true, signals: events.map((e) => e.signal), ...(reply ? { reply } : {}) });
  }

  function startSignalServer() {
    const tokenFile = path.join(rootDir, 'token');
    const server = http.createServer((req, res) => {
      const done = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (req.headers.origin !== undefined || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return done(403, { error: 'browser requests are not accepted' });
      if (req.method === 'GET' && req.url === '/status') { const st = aggregateState(); return done(200, { look: st.look, sessions: st.sessions.map((x) => ({ source: x.source || 'claude', signal: x.signal, cwd: x.cwd, updatedAt: x.updatedAt })), spend: st.spend ? { level: st.spend.budget.level, runaway: st.spend.runaway.length } : null }); }
      const hookRoute = /^\/hook\/([\w-]+)(?:\?event=([\w-]*))?$/.exec(req.url || '');
      if (req.method !== 'POST' || (req.url !== '/signal' && req.url !== '/request-key' && !hookRoute)) return done(404, { error: 'POST /signal, POST /hook/:adapter or GET /status' });
      if (!tokenMatches(req.headers[SIGNAL_TOKEN_HEADER])) return done(401, { error: `send header ${SIGNAL_TOKEN_HEADER} with the contents of ${tokenFile}` });
      if (hookRoute) return readBody(req, done, (d) => hookEvent(hookRoute[1], hookRoute[2] || d.hook_event_name || '', d, done));
      if (req.url === '/request-key') return readBody(req, done, (d) => (requestKeys.register(d.id, d.key) ? done(200, { ok: true }) : done(409, { error: 'bad or duplicate request key' })));
      readBody(req, done, (d) => {
        if (!KNOWN_SIGNALS.has(d.signal)) return done(400, { error: 'unknown signal', known: [...KNOWN_SIGNALS] });
        const source = String(d.source || 'custom').replace(/[^\w.-]/g, '').slice(0, 24) || 'custom';
        const session = String(d.session || 'default').replace(/[^\w.-]/g, '').slice(0, 80) || 'default';
        const file = path.join(sessionsDir, `${os.hostname().split('.')[0]}-${source}-${session}.json`);
        if (d.signal === 'session-end') { fs.rmSync(file, { force: true }); broadcastStatus(); return done(200, { ok: true }); }
        const hostApp = typeof d.hostApp === 'string' ? d.hostApp : undefined;
        const cwd = typeof d.cwd === 'string' ? d.cwd.slice(0, 500) : '';
        const tool = typeof d.tool === 'string' ? d.tool.slice(0, 80) : null;
        // Waits briefly rather than skipping: a dropped signal is a wrong light.
        SessionState.withLock(file, () => {
          const next = SessionState.applyBareSignal(SessionState.readJson(file), { sessionId: session, host: os.hostname().split('.')[0], source, cwd, signal: d.signal, tool, hostApp });
          // A caller may also report its own agents, mode, iteration or tasks.
          if (d.tasks && typeof d.tasks === 'object') next.tasks = d.tasks;
          if (Array.isArray(d.agents)) next.agents = d.agents;
          if (typeof d.mode === 'string') next.mode = d.mode;
          if (Number.isFinite(d.iteration)) next.iteration = d.iteration;
          SessionState.writeJsonAtomic(file, next);
        }, 250);
        broadcastStatus();
        done(200, { ok: true });
      });
    });
    server.on('error', (e) => console.log('[signal server]', e.message));
    const portFile = path.join(rootDir, 'port');
    server.on('listening', () => {
      // The token first, so whoever sees the port can already read it; chmod
      // too, since the mode only applies when the file is created.
      try { fs.writeFileSync(tokenFile, SIGNAL_TOKEN, { mode: 0o600 }); fs.chmodSync(tokenFile, 0o600); } catch {}
      try { fs.writeFileSync(portFile, String(server.address().port)); } catch {}
      // Only the instance that bound the port owns these files.
      app.on('will-quit', () => { try { fs.rmSync(portFile, { force: true }); fs.rmSync(tokenFile, { force: true }); } catch {} });
    });
    server.listen(SIGNAL_PORT, '127.0.0.1');
    return server;
  }

  // ── Pending permission requests (from the PermissionRequest hook) ──────────
  function readRequests() {
    Answer.sweep(requestsDir);
    let files = [];
    try { files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(requestsDir, f), 'utf8'));
        if (Date.now() - new Date(r.createdAt).getTime() > 90000) continue; // hook has long since timed out
        // Edited since the hook wrote it: never shown, so never clicked.
        if (!Answer.requestIntact(r)) continue;
        out.push({ ...r, view: describeRequest(r) });
      } catch { /* partial write */ }
    }
    return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  // First answer wins (desk or phone); see hooks/answer-file.js. The bare
  // allow/deny path (gestures, the old answerRequest IPC) answers tool
  // permissions only: a plan, question or elicitation needs its own option
  // (answerInput), never a blind "allow".
  function answerRequest(id, decision) {
    if (decision !== 'allow' && decision !== 'deny') return false;
    const req = readRequests().find((r) => r.id === String(id));
    if (!req || (req.kind !== undefined && req.kind !== 'permission')) return false;
    return Answer.writeAnswer(requestsDir, req.id, decision, { by: 'desk', key: requestKeys.get(req.id), decisionHash: req.decisionHash }).ok;
  }

  return { SIGNAL_PORT, startSignalServer, readRequests, answerRequest, keyFor: (id) => requestKeys.get(id) };
};
