// TEST ONLY (never packaged): stands in for the core's src/work-scope.js so
// the specs can give sessions each scope state. main loads it only in a dev
// run with CLAUDE_TRAFFIC_LIGHT_WORK_SCOPE_MOCK=<dir>.
//   <dir>/fixture.json  { "<sessionId>": { state, board, repo } }   read on every call
//   <dir>/calls.json    every set*Scope call, appended, for the spec to check
const fs = require('fs');
const path = require('path');

function create(dir) {
  const fixtureFile = path.join(dir, 'fixture.json');
  const callsFile = path.join(dir, 'calls.json');
  const sessionMarks = new Map();
  const repoMarks = new Map();
  const listeners = [];
  const record = (fn, args) => {
    let calls = [];
    try { calls = JSON.parse(fs.readFileSync(callsFile, 'utf8')); } catch { /* first */ }
    calls.push({ fn, args });
    fs.writeFileSync(callsFile, JSON.stringify(calls));
  };
  const fixture = () => { try { return JSON.parse(fs.readFileSync(fixtureFile, 'utf8')); } catch { return {}; } };
  return {
    setSessionScope(sessionId, mode) { record('setSessionScope', [sessionId, mode]); if (mode === 'personal') sessionMarks.set(sessionId, true); else sessionMarks.delete(sessionId); },
    setRepoScope(url, mode) { record('setRepoScope', [url, mode]); if (mode === 'personal') repoMarks.set(url, true); else repoMarks.delete(url); },
    sessionScopes: () => Object.fromEntries([...sessionMarks.keys()].map((k) => [k, 'personal'])),
    repoScopes: () => Object.fromEntries([...repoMarks.keys()].map((k) => [k, 'personal'])),
    scopeFor(session) {
      const f = fixture()[session.sessionId];
      if (f === undefined) return null;
      if (!f) return f;
      if (sessionMarks.has(session.sessionId) || (f.repo && repoMarks.has(f.repo.canonicalUrl))) return { ...f, state: 'personal' };
      return f;
    },
    onChange(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  };
}

module.exports = { create };
