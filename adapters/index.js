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
// Adapters whose config is a file of Plexiform's own (or, for Aider, marked
// lines in a YAML file) rather than entries in the agent's JSON hooks block:
// reachable by id and connected from the AI tools page, but not in list(),
// which the rename walk and uninstall-all read as JSON hooks files.
const EXTRAS = [require('./copilot.js'), require('./goose.js'), require('./cline.js'), require('./opencode.js'), require('./aider.js')];
// generic.js has no config file of ours, so it is reachable by id (emit.js,
// POST /hook/generic) but is not in list(), which uninstall and the rename walk.
const BY_ID = new Map([...ADAPTERS, ...EXTRAS, require('./generic.js')].map((a) => [a.id, a]));

const get = (id) => BY_ID.get(String(id || '')) || null;
const list = () => ADAPTERS.slice();
const extras = () => EXTRAS.slice();

module.exports = { get, list, extras, Runtime: require('./runtime.js') };
