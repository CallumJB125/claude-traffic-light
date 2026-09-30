// One module per agent Buddy can watch. Each exports:
//   id, label, capabilities: { working, yourTurn, blocked, answer, subagents, limits, cost }
//   detect({ home, exists }) → whether the agent looks installed here
//   install / uninstall / isInstalled({ home, runtime, … }) — idempotent,
//     marker-matched: only ever touches its own entries
//   transport: 'command' | 'http' | 'poll'
//   commandFor(event, runtime) → the hook command (string, or argv array)
//   normalize(event, payload) → [{ signal, sessionId, cwd, tool, pid, extra }]
//   answer?(decision) / reply?(event) → what the hook prints back, if anything
// normalize() feeds both `emit.js --adapter <id>` and the app's
// POST /hook/:adapter route.
const ADAPTERS = [require('./claude-code.js'), require('./cursor.js'), require('./codex.js'), require('./gemini.js')];
const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

const get = (id) => BY_ID.get(String(id || '')) || null;
const list = () => ADAPTERS.slice();

module.exports = { get, list, Runtime: require('./runtime.js') };
